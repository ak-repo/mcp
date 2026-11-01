import { isIP } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { AppError, ErrorCode } from '@foodops/shared';
import { z } from 'zod';

/** Normalize explicit host:port authorities, never URLs or wildcard patterns. */
export function normalizeAuthority(value: string): string | null {
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):([0-9]{1,5})$/.exec(
    value,
  );
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}
export function defaultAllowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}
const allowedHostsSchema = z.string().transform((value, context) => {
  const entries = value.split(',').map((item) => normalizeAuthority(item.trim()));
  if (entries.some((item) => item === null)) {
    context.addIssue({ code: 'custom', message: 'Expected a comma-separated host:port allowlist' });
    return z.NEVER;
  }
  return [...new Set(entries.filter((item): item is string => item !== null))];
});
export const ConfigSchema = z.object({
  DB_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== ':memory:' && !value.includes('\0')),
  MCP_HOST: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        isIP(value) !== 0 ||
        (/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) &&
          value
            .split('.')
            .every(
              (label) =>
                label.length > 0 &&
                label.length <= 63 &&
                !label.startsWith('-') &&
                !label.endsWith('-'),
            )),
    )
    .default('127.0.0.1'),
  ALLOWED_HOSTS: allowedHostsSchema.optional(),
  MCP_CONFIRM_SECRET: z
    .string()
    .min(32)
    .refine((value) => value.trim() === value)
    .optional(),
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
      MCP_HOST: env['MCP_HOST'] ?? file['MCP_HOST'],
      ALLOWED_HOSTS: (env['ALLOWED_HOSTS'] ?? file['ALLOWED_HOSTS']) || undefined,
      MCP_CONFIRM_SECRET: (env['MCP_CONFIRM_SECRET'] ?? file['MCP_CONFIRM_SECRET']) || undefined,
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
      'Check DB_PATH, MCP_AUTH_TOKEN, MCP_CONFIRM_SECRET (32+ characters), MCP_HOST, ALLOWED_HOSTS (host:port list), PORT (1–65535), and LOG_LEVEL',
    );
  }
}
