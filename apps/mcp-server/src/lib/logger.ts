import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

export function createLogger(level: Config['LOG_LEVEL'] = 'info'): Logger {
  return pino(
    {
      level,
      base: { service: 'foodops-mcp' },
      redact: {
        paths: ['MCP_AUTH_TOKEN', 'token', 'authorization', 'headers.authorization'],
        censor: '[REDACTED]',
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}
