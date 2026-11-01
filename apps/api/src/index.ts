import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createLogger, openRuntime, type Runtime } from './runtime.js';
export { buildApp } from './app.js';
export { loadConfig, ConfigSchema, type Config } from './config.js';
export { openRuntime, type Runtime } from './runtime.js';
export const DRAIN_TIMEOUT_MS = 10000;
export interface ApiApplication {
  app: FastifyInstance;
  runtime: Runtime;
  url: string;
  shutdown(): Promise<void>;
}
export async function startApi(options: {
  config: Config;
  runtime?: Runtime;
  port?: number;
  signals?: boolean;
  drainMs?: number;
}): Promise<ApiApplication> {
  const runtime = options.runtime ?? openRuntime(options.config);
  let app: FastifyInstance;
  try {
    app = buildApp({ config: options.config, runtime });
  } catch (error) {
    runtime.close();
    throw error;
  }
  let stopping = false;
  app.addHook('preClose', async () => {
    stopping = true;
  });
  app.addHook('onSend', async (_request, reply) => {
    if (stopping) reply.header('Connection', 'close');
  });
  app.addHook('onResponse', async () => {
    if (stopping) app.server.closeIdleConnections();
  });
  app.addHook('onClose', async () => {
    runtime.close();
  });
  let closing: Promise<void> | undefined;
  const handler = () => {
    void shutdown().catch((error: unknown) => {
      runtime.logger.error({ err: error }, 'API shutdown failed');
      // A timed-out handler must never resume against closed DB handles.
      process.exit(1);
    });
  };
  const uninstall = () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      runtime.logger.info('API shutdown started');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              app.server.closeAllConnections();
              reject(new Error('API shutdown drain timed out'));
            }, options.drainMs ?? DRAIN_TIMEOUT_MS);
          }),
        ]);
        runtime.logger.info('API shutdown completed');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        uninstall();
      }
    })();
    return closing;
  };
  try {
    const url = await app.listen({
      host: options.config.API_HOST,
      port: options.port ?? options.config.API_PORT,
    });
    if (options.signals !== false) {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
    }
    return { app, runtime, url, shutdown };
  } catch (error) {
    try {
      await app.close();
    } finally {
      runtime.close();
      uninstall();
    }
    throw error;
  }
}
const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  try {
    await startApi({ config: loadConfig() });
  } catch (error) {
    createLogger().error({ err: error }, 'API startup failed');
    process.exitCode = 1;
  }
}
