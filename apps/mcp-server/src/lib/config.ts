import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { AppError, ErrorCode } from '@foodops/shared';
import { z } from 'zod';

export const ConfigSchema = z.object({
  DB_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== ':memory:' && !value.includes('\0')),
  MCP_AUTH_TOKEN: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});
export type Config = z.infer<typeof ConfigSchema>;
export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export function loadConfig(options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const root = options.root ?? WORKSPACE_ROOT;
  const env = options.env ?? process.env;
  try {
    const path = resolve(root, '.env');
    const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
    const parsed = ConfigSchema.safeParse({
      DB_PATH: env['DB_PATH'] ?? file['DB_PATH'] ?? './data/foodops.sqlite',
      MCP_AUTH_TOKEN: (env['MCP_AUTH_TOKEN'] ?? file['MCP_AUTH_TOKEN']) || undefined,
      PORT: env['PORT'] ?? env['MCP_PORT'] ?? file['PORT'] ?? file['MCP_PORT'],
      LOG_LEVEL: env['LOG_LEVEL'] ?? file['LOG_LEVEL'],
    });
    if (!parsed.success) throw new Error('Invalid configuration');
    return { ...parsed.data, DB_PATH: resolve(root, parsed.data.DB_PATH) };
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid MCP configuration',
      'Check DB_PATH, MCP_AUTH_TOKEN, PORT (1–65535), and LOG_LEVEL in the environment',
    );
  }
}
