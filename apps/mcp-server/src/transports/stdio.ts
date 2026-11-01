import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../lib/create-server.js';
import { withLogContext, type LogContext } from '../lib/logger.js';
import type { Config } from '../lib/config.js';
import {
  correlation,
  drain,
  DRAIN_TIMEOUT_MS,
  installSignals,
  isMain,
  openRuntime,
  runCli,
  type Runtime,
} from './runtime.js';

export interface StdioOptions {
  config: Config;
  runtime?: Runtime;
  stdin?: Readable;
  stdout?: Writable;
  signals?: boolean;
  drainMs?: number;
}
export interface StdioApplication {
  shutdown(): Promise<void>;
  runtime: Runtime;
}
export async function startStdio(options: StdioOptions): Promise<StdioApplication> {
  const runtime = options.runtime ?? openRuntime(options.config);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const sdk = new StdioServerTransport(stdin, stdout, { maxBufferSize: 1024 * 1024 });
  const server = createServer(runtime);
  const pending = new Map<RequestId, { context: LogContext; at: number }>();
  const runId = randomUUID();
  const waiters = new Set<() => void>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  let uninstall = () => {};
  const settle = (id: RequestId) => {
    pending.delete(id);
    if (pending.size === 0) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
  };
  const transport: Transport = {
    start: async () => {
      sdk.onmessage = (message) => {
        if (stopping) {
          if (isJSONRPCRequest(message))
            void sdk.send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: 'Server is shutting down' },
            });
          return;
        }
        const meta = 'params' in message ? message.params?._meta : undefined;
        const proposedRunId =
          meta && typeof meta === 'object' && 'run_id' in meta ? meta.run_id : undefined;
        const context = { request_id: randomUUID(), run_id: correlation(proposedRunId, runId) };
        if (isJSONRPCRequest(message)) pending.set(message.id, { context, at: performance.now() });
        withLogContext(context, () => {
          if ('method' in message) runtime.logger.info({ method: message.method }, 'RPC received');
          transport.onmessage?.(message);
        });
      };
      sdk.onerror = () => {
        runtime.logger.warn('Invalid stdio protocol message');
      };
      sdk.onclose = () => transport.onclose?.();
      await sdk.start();
    },
    async send(message) {
      await sdk.send(message);
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id !== undefined
      ) {
        const call = pending.get(message.id);
        if (call)
          withLogContext(call.context, () =>
            runtime.logger.info(
              { latency_ms: Math.round(performance.now() - call.at) },
              'RPC completed',
            ),
          );
        settle(message.id);
      }
    },
    close: () => sdk.close(),
  };
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    stdin.pause();
    closing = (async () => {
      runtime.logger.info('Stdio shutdown started');
      const completed = await drain(
        () =>
          pending.size === 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => waiters.add(resolve)),
        options.drainMs ?? DRAIN_TIMEOUT_MS,
      );
      try {
        await server.close();
      } finally {
        runtime.close();
        uninstall();
        stdin.off('end', onEnd);
      }
      runtime.logger.info({ drained: completed }, 'Stdio shutdown completed');
      if (!completed) throw new Error('Stdio shutdown drain timed out');
    })();
    return closing;
  };
  const onEnd = () => {
    void shutdown().catch(() => {
      runtime.logger.error('Stdio shutdown failed');
      process.exitCode = 1;
    });
  };
  try {
    stdin.on('end', onEnd);
    await server.connect(transport);
    if (options.signals !== false) uninstall = installSignals(shutdown, runtime.logger);
    runtime.logger.info('Stdio MCP server ready');
    return { shutdown, runtime };
  } catch (error) {
    stdin.off('end', onEnd);
    await server.close();
    runtime.close();
    uninstall();
    throw error;
  }
}
if (isMain(import.meta.url)) await runCli((config) => startStdio({ config }));
