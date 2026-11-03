import { randomUUID } from 'node:crypto';
import { ErrorCode, type AgentEvent } from '@foodops/shared';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ProviderManager } from '../llm/registry.js';
import type { ProviderDependencies } from '../llm/adapters/common.js';
import type { LLMProvider } from '../llm/types.js';
import type { McpConnection } from '../mcp/client.js';
import { HttpError } from '../lib/http-errors.js';
import { createApprovals } from './approvals.js';
import { createSessions } from './store.js';
import { runAgent, type AgentInput } from './run.js';
export interface AgentHostDependencies {
  provider?: LLMProvider;
  providerDependencies?: ProviderDependencies;
}
interface RunRecord {
  id: string;
  sessionId: string;
  controller: AbortController;
  iterator: AsyncGenerator<AgentEvent>;
  done: boolean;
  cancelled: boolean;
  at: number;
  finish: () => Promise<void>;
}
/** Trusted owner of admission, controls, and retained run identity; never a model tool. */
export function createAgentHost(
  config: Config,
  mcp: McpConnection,
  logger: Logger,
  dependencies: AgentHostDependencies = {},
) {
  const providers = new ProviderManager(config, dependencies.providerDependencies);
  const approvals = createApprovals();
  const sessions = createSessions();
  const runs = new Map<string, RunRecord>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const sweep = () => {
    for (const [id, record] of runs)
      if (record.done && Date.now() - record.at >= 1800000) runs.delete(id);
    const completed = [...runs.values()].filter((run) => run.done).sort((a, b) => a.at - b.at);
    for (const record of completed.slice(0, Math.max(0, completed.length - 100)))
      runs.delete(record.id);
  };
  const find = (id: string) => {
    sweep();
    const record = runs.get(id);
    if (!record)
      throw new HttpError(
        404,
        ErrorCode.NOT_FOUND,
        'Run was not found',
        'Use a run_id from run.started; completed runs are retained for thirty minutes',
      );
    return record;
  };
  function start(input: AgentInput, signal?: AbortSignal) {
    sweep();
    if (closed)
      throw new HttpError(503, ErrorCode.INTERNAL, 'Agent host is closed', 'Retry after restart');
    const active = [...runs.values()].filter((run) => !run.done);
    if (active.length >= config.AGENT_MAX_CONCURRENT_RUNS)
      throw new HttpError(
        429,
        ErrorCode.LIMIT_EXCEEDED,
        'Concurrent run limit reached',
        'Wait for a run to finish or cancel one before retrying',
      );
    const sessionId = input.session_id ?? randomUUID();
    if (active.some((run) => run.sessionId === sessionId))
      throw new HttpError(
        409,
        ErrorCode.CONFLICT,
        'Session already has an active run',
        'Finish or cancel that run before sending another message',
      );
    const id = randomUUID();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const captured = providers.capture();
    const model = captured.publicConfig.model ?? '(unset)';
    const inner = runAgent(
      {
        config,
        mcp,
        logger,
        provider: dependencies.provider ?? captured.provider,
        redactText: captured.redact,
        model,
        approvals,
        sessions,
      },
      { ...input, session_id: sessionId, run_id: id },
      combined,
    );
    let finishing: Promise<void> | undefined;
    const finish = () => {
      if (!finishing)
        finishing = inner.return(undefined).then(() => {
          record.done = true;
          record.at = Date.now();
          sweep();
        });
      return finishing;
    };
    async function* consume(): AsyncGenerator<AgentEvent> {
      try {
        for await (const event of inner) yield event;
      } finally {
        await finish();
      }
    }
    const iterator = consume();
    const record: RunRecord = {
      id,
      sessionId,
      controller,
      iterator,
      done: false,
      cancelled: false,
      at: Date.now(),
      finish,
    };
    runs.set(id, record);
    return {
      runId: id,
      events: iterator,
      abort() {
        record.cancelled = true;
        controller.abort();
      },
      async close() {
        controller.abort();
        await iterator.return(undefined);
        await finish();
      },
    };
  }
  return {
    providers,
    approvals,
    start,
    async *run(input: AgentInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      const run = start(input, signal);
      try {
        yield* run.events;
      } finally {
        await run.close();
      }
    },
    resolve(runId: string, callId: string, decision: 'approved' | 'rejected') {
      find(runId);
      const previous = approvals.inspect(runId, callId);
      if (previous === undefined)
        throw new HttpError(
          404,
          ErrorCode.NOT_FOUND,
          'Approval call was not found',
          'Use call_id from approval.required for this run',
        );
      if (previous === decision) return { run_id: runId, call_id: callId, decision };
      if (previous !== 'pending')
        throw new HttpError(
          409,
          ErrorCode.CONFLICT,
          'Approval is already resolved or expired',
          'Inspect current state; start a new preview if another action is needed',
        );
      if (
        !approvals.resolve(runId, callId, decision) ||
        approvals.inspect(runId, callId) !== decision
      )
        throw new HttpError(
          409,
          ErrorCode.CONFLICT,
          'Approval expired',
          'Start a new preview before approving',
        );
      return { run_id: runId, call_id: callId, decision };
    },
    cancel(runId: string) {
      const record = find(runId);
      if (record.cancelled) return { run_id: runId, status: 'cancelled' as const };
      if (record.done)
        throw new HttpError(
          409,
          ErrorCode.CONFLICT,
          'Run has already completed',
          'Start a new run if more work is needed',
        );
      record.cancelled = true;
      record.controller.abort();
      approvals.cancelRun(runId);
      return { run_id: runId, status: 'cancelled' as const };
    },
    get activeCount() {
      return [...runs.values()].filter((run) => !run.done).length;
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        approvals.close();
        for (const run of runs.values())
          if (!run.done) {
            run.cancelled = true;
            run.controller.abort();
          }
        closing = Promise.all(
          [...runs.values()]
            .filter((run) => !run.done)
            .map(async (run) => {
              await run.iterator.return(undefined);
              await run.finish();
            }),
        ).then(() => {
          sessions.close();
        });
      }
      return closing;
    },
  };
}
export type AgentHost = ReturnType<typeof createAgentHost>;
