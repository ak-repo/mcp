import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent } from '@foodops/shared';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { LLMProvider, NormalizedMessage, ToolCall } from '../llm/types.js';
import { LLMError, redact } from '../llm/errors.js';
import { McpClientError, type McpConnection } from '../mcp/client.js';
import type { Approvals } from './approvals.js';
import type { Sessions } from './store.js';
import { agentTools, cleanData, CONTROL_FIELDS, modelResult, stripControls } from './tools.js';
import { trimHistory, trimMessages } from './history.js';
import { systemPrompt } from './prompts.js';
const previewSchema = z.object({
  data: z.object({
    requires_user_approval: z.literal(true),
    preview: z.json(),
    confirmation_token: z.string().min(1),
    expires_at: z.iso.datetime(),
  }),
  truncated: z.literal(false),
});
export interface AgentDependencies {
  config: Config;
  provider: LLMProvider;
  model: string;
  mcp: McpConnection;
  approvals: Approvals;
  sessions: Sessions;
  logger: Logger;
  shutdownSignal?: AbortSignal;
  now?: () => number;
  redactText?: (text: string) => string;
}
export interface AgentInput {
  session_id?: string;
  run_id?: string;
  message: string;
}
class AgentFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
function abortableExecution<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Execution interrupted'));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    void Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
export async function* runAgent(
  deps: AgentDependencies,
  input: AgentInput,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const runId = input.run_id ?? randomUUID();
  const sessionId = input.session_id ?? randomUUID();
  const now = deps.now ?? Date.now;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.config.AGENT_RUN_TIMEOUT_MS);
  const executionSignal = deps.shutdownSignal
    ? AbortSignal.any([deadline.signal, deps.shutdownSignal])
    : deadline.signal;
  const combined = signal ? AbortSignal.any([signal, executionSignal]) : executionSignal;
  let session: ReturnType<Sessions['acquire']> | undefined;
  let messages: NormalizedMessage[] = [];
  let iterations = 0;
  let toolCount = 0;
  const usage = { promptTokens: 0, completionTokens: 0 };
  const secrets = [deps.config.LLM_API_KEY, deps.config.MCP_AUTH_TOKEN].filter((s): s is string =>
    Boolean(s),
  );
  type Result = ReturnType<typeof modelResult>;
  const recorded = new Set<ToolCall>();
  const executions = new Map<ToolCall, Promise<Result>>();
  const append = (call: ToolCall, result: Result) => {
    if (recorded.has(call)) return;
    recorded.add(call);
    messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result.text });
  };
  const unknown = (): Result => ({
    text: JSON.stringify({
      status: 'unknown_outcome',
      note: 'The write may have committed; inspect current state before any new write.',
    }),
    summary: 'Write outcome is unknown; inspect current state before any new write.',
    status: 'error',
    truncated: false,
  });
  const safe = (value: unknown) => cleanData(value, secrets, deps.redactText);
  const check = () => {
    if (combined.aborted)
      throw new AgentFailure(
        deadline.signal.aborted ? 'limit' : 'aborted',
        deadline.signal.aborted
          ? 'Run time limit reached; outstanding work was not completed.'
          : 'Run cancelled; an in-flight write may have committed. Inspect the order before retrying.',
      );
  };
  try {
    yield {
      type: 'run.started',
      run_id: runId,
      session_id: sessionId,
      provider: deps.provider.id,
      model: deps.model,
    };
    check();
    if (!input.message.trim()) throw new AgentFailure('validation', 'A user message is required');
    session = deps.sessions.acquire(sessionId);
    const tools = agentTools(await deps.mcp.listTools({ signal: combined }));
    const definitions = [...tools.values()].map((tool) => tool.definition);
    try {
      messages = trimHistory(
        systemPrompt(new Date(now())),
        session.history,
        input.message,
        definitions,
        deps.config.LLM_CONTEXT_BUDGET_TOKENS,
      );
    } catch {
      throw new AgentFailure(
        'context_overflow',
        'Mandatory conversation context exceeds the configured budget',
      );
    }
    let limited = false;
    while (iterations < deps.config.AGENT_MAX_ITERATIONS) {
      check();
      iterations++;
      try {
        messages = trimMessages(messages, definitions, deps.config.LLM_CONTEXT_BUDGET_TOKENS);
      } catch {
        throw new AgentFailure(
          'context_overflow',
          'Current turn exceeds the configured context budget',
        );
      }
      let content = '';
      let done = false;
      const calls: ToolCall[] = [];
      const ids = new Set<string>();
      for await (const event of deps.provider.chat(messages, definitions, { signal: combined })) {
        check();
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          const text = String(safe(event.delta));
          if (event.type === 'text_delta') content += text;
          if (content.length > 1024 * 1024)
            throw new AgentFailure('limit', 'Assistant output exceeded the run buffer limit');
          yield { type: event.type === 'text_delta' ? 'text.delta' : 'thinking.delta', text };
        } else if (event.type === 'tool_call') {
          if (!event.id || ids.has(event.id))
            throw new AgentFailure(
              'protocol',
              'Provider returned duplicate or invalid tool call identifiers',
            );
          ids.add(event.id);
          if (calls.length >= deps.config.AGENT_MAX_TOOL_CALLS) {
            limited = true;
            continue;
          }
          const parsed = z.record(z.string(), z.json()).safeParse(event.arguments);
          if (!parsed.success)
            throw new AgentFailure('protocol', 'Provider returned invalid tool arguments');
          if (Object.keys(event.arguments).some((key) => CONTROL_FIELDS.has(key)))
            deps.logger.warn(
              { run_id: runId, call_id: event.id, tool: event.name },
              'Stripped model-supplied write controls',
            );
          calls.push({ id: event.id, name: event.name, arguments: stripControls(parsed.data) });
        } else if (event.type === 'usage') {
          usage.promptTokens += event.promptTokens;
          usage.completionTokens += event.completionTokens;
        } else if (event.type === 'done') done = true;
      }
      if (!done)
        throw new AgentFailure('protocol', 'Provider stream ended without a completion event');
      messages.push({ role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) });
      if (!calls.length && !limited) {
        yield { type: 'run.completed', usage, iterations };
        return;
      }
      for (const call of calls) {
        check();
        if (toolCount >= deps.config.AGENT_MAX_TOOL_CALLS || limited) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: '{"status":"not_executed","reason":"tool_call_limit"}',
          });
          limited = true;
          continue;
        }
        toolCount++;
        const tool = tools.get(call.name);
        const started = performance.now();
        yield {
          type: 'tool.call',
          call_id: call.id,
          name: call.name,
          arguments: z.record(z.string(), z.json()).parse(safe(call.arguments)),
          kind: tool?.kind ?? 'write',
        };
        let result: ReturnType<typeof modelResult>;
        if (!tool)
          result = {
            text: '{"error":"Unknown tool; use the discovered catalog"}',
            summary: 'Unknown tool',
            status: 'error',
            truncated: false,
          };
        else {
          const raw = await deps.mcp.callTool(
            call.name,
            { ...call.arguments, ...(tool.kind === 'write' ? { action: 'preview' } : {}) },
            { signal: combined, retry: true },
          );
          check();
          if (tool.kind === 'write' && !raw.isError) {
            const parsed = previewSchema.safeParse(raw.structuredContent);
            if (
              !parsed.success ||
              Date.parse(parsed.data.data.expires_at) <= now() ||
              Date.parse(parsed.data.data.expires_at) - now() > 300000
            )
              throw new AgentFailure(
                'protocol',
                'MCP write returned an invalid or expired approval preview',
              );
            const preview = parsed.data.data;
            secrets.push(preview.confirmation_token);
            const idempotencyKey = randomUUID();
            secrets.push(idempotencyKey);
            const publicPreview = z.json().parse(safe(preview.preview));
            const launch = () => {
              // The registry invokes this synchronously at approval resolution, even if the SSE consumer has detached.
              const work = (async (): Promise<Result> => {
                let outcome: Result;
                try {
                  const executed = await abortableExecution(
                    () =>
                      deps.mcp.callTool(
                        call.name,
                        {
                          ...call.arguments,
                          action: 'execute',
                          confirmation_token: preview.confirmation_token,
                          idempotency_key: idempotencyKey,
                        },
                        { signal: executionSignal, retry: true },
                      ),
                    executionSignal,
                  );
                  if (!executed.isError && executed.structuredContent?.truncated !== true) {
                    const completed = z
                      .object({
                        data: z.object({
                          requires_user_approval: z.literal(false),
                          result: z.json(),
                        }),
                        truncated: z.literal(false),
                      })
                      .safeParse(executed.structuredContent);
                    if (!completed.success) throw new Error('Uncertain write response');
                  }
                  outcome = modelResult(executed, secrets, deps.redactText);
                } catch {
                  outcome = unknown();
                }
                append(call, outcome);
                return outcome;
              })();
              executions.set(call, work);
            };
            const decisionPromise = deps.approvals.wait(
              {
                runId,
                callId: call.id,
                name: call.name,
                args: call.arguments,
                preview: preview.preview,
                token: preview.confirmation_token,
                expiresAt: preview.expires_at,
                idempotencyKey,
              },
              combined,
              launch,
            );
            yield {
              type: 'approval.required',
              call_id: call.id,
              name: call.name,
              preview: publicPreview,
              expires_at: preview.expires_at,
            };
            const decision = await decisionPromise;
            yield { type: 'approval.resolved', call_id: call.id, decision };
            if (decision !== 'approved') {
              check();
              result = {
                text: JSON.stringify({
                  status: decision === 'rejected' ? 'rejected_by_user' : decision,
                }),
                summary: `Write ${decision}`,
                status: 'ok',
                truncated: false,
              };
            } else {
              result = await executions.get(call)!;
            }
          } else {
            result = modelResult(raw, secrets, deps.redactText);
          }
        }
        append(call, result);
        yield {
          type: 'tool.result',
          call_id: call.id,
          name: call.name,
          status: result.status,
          latency_ms: Math.round(performance.now() - started),
          summary: result.summary,
          truncated: result.truncated,
        };
        if (executions.has(call) && result.text.includes('"status":"unknown_outcome"'))
          throw new AgentFailure(
            'unknown_outcome',
            'The write may have committed; inspect current state before any new write.',
          );
        check();
      }
      if (limited || toolCount >= deps.config.AGENT_MAX_TOOL_CALLS) {
        limited = true;
        break;
      }
    }
    const text = limited
      ? 'Tool-call limit reached. Outstanding requests were not completed; inspect their current state before continuing.'
      : 'Iteration limit reached. Further investigation or actions remain unfinished.';
    messages.push({ role: 'assistant', content: text });
    yield { type: 'text.delta', text };
    yield { type: 'run.completed', usage, iterations };
  } catch (error) {
    if (deadline.signal.aborted) {
      const text =
        'Run time limit reached. Outstanding work remains unfinished; an in-flight write may have committed.';
      yield { type: 'text.delta', text };
      yield { type: 'run.completed', usage, iterations };
    } else {
      const known =
        error instanceof AgentFailure ||
        error instanceof LLMError ||
        error instanceof McpClientError;
      yield {
        type: 'run.error',
        kind: signal?.aborted ? 'aborted' : known ? error.kind : 'internal',
        message: signal?.aborted
          ? 'Run cancelled; inspect any in-flight write before retrying.'
          : known
            ? (deps.redactText ?? ((text: string) => text))(redact(error.message, secrets))
            : 'The agent could not complete this run',
        retryable: known ? error.retryable : false,
      };
    }
  } finally {
    deps.approvals.cancelRun(runId);
    await Promise.all(executions.values());
    clearTimeout(timer);
    deadline.abort();
    // Reconcile each assistant group independently: providers can reuse call IDs across turns.
    const reconciled: NormalizedMessage[] = [];
    let pending: ToolCall[] = [];
    const flush = () => {
      for (const call of pending)
        reconciled.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: executions.has(call) ? unknown().text : '{"status":"cancelled"}',
        });
      pending = [];
    };
    for (const message of messages) {
      if (message.role !== 'tool') flush();
      reconciled.push(message);
      if (message.role === 'assistant') pending = [...(message.toolCalls ?? [])];
      if (message.role === 'tool') {
        const index = pending.findIndex((call) => call.id === message.toolCallId);
        if (index >= 0) pending.splice(index, 1);
      }
    }
    flush();
    messages = reconciled;
    session?.release(
      messages.length ? messages.filter((message) => message.role !== 'system') : undefined,
    );
  }
}
