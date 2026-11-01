import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

export interface LogContext {
  request_id: string;
  run_id: string;
}
const logContext = new AsyncLocalStorage<LogContext>();
export function withLogContext<T>(context: LogContext, operation: () => T): T {
  return logContext.run(context, operation);
}

export function createLogger(level: Config['LOG_LEVEL'] = 'info'): Logger {
  return pino(
    {
      level,
      mixin: () => ({ ...logContext.getStore() }),
      base: { service: 'foodops-mcp' },
      redact: {
        paths: [
          'MCP_AUTH_TOKEN',
          'MCP_CONFIRM_SECRET',
          'confirmation_token',
          'token',
          'authorization',
          'headers.authorization',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}
