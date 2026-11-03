import type { AgentEvent } from '@foodops/shared';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { ProviderManager } from '../llm/registry.js';
import type { McpConnection } from '../mcp/client.js';
import { createApprovals } from './approvals.js';
import { createSessions } from './store.js';
import { runAgent, type AgentInput } from './run.js';
/** Trusted server-side owner. Future routes may resolve approvals; models cannot. */
export function createAgentHost(config: Config, mcp: McpConnection, logger: Logger) {
  const providers = new ProviderManager(config);
  const approvals = createApprovals();
  const sessions = createSessions();
  const active = new Map<AsyncGenerator<AgentEvent>, AbortController>();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    providers,
    approvals,
    run(input: AgentInput, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const model = providers.publicView().model ?? '(unset)';
      const inner = runAgent(
        { config, mcp, logger, provider: providers.provider, model, approvals, sessions },
        input,
        combined,
      );
      async function* consume(): AsyncGenerator<AgentEvent> {
        if (closed) throw new Error('Agent host is closed');
        active.set(inner, controller);
        try {
          yield* inner;
        } finally {
          active.delete(inner);
        }
      }
      return consume();
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        approvals.close();
        for (const controller of active.values()) controller.abort();
        closing = Promise.all(
          [...active.keys()].map((iterator) => iterator.return(undefined)),
        ).then(() => {
          sessions.close();
        });
      }
      return closing;
    },
  };
}
export type AgentHost = ReturnType<typeof createAgentHost>;
