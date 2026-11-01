import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { AppError, ErrorCode } from '@foodops/shared';
import { z } from 'zod';

export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const host = z
  .string()
  .min(1)
  .refine(
    (value) =>
      isIP(value) !== 0 ||
      (/^(?=.{1,253}$)[a-zA-Z0-9.-]+$/.test(value) &&
        value
          .split('.')
          .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))),
  );
const origins = z.string().transform((value, context) => {
  const entries = value.split(',').map((entry) => entry.trim());
  const valid = entries.every((entry) => {
    try {
      const url = new URL(entry);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        url.origin === entry &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });
  if (!valid) {
    context.addIssue({ code: 'custom', message: 'Expected comma-separated exact HTTP(S) origins' });
    return z.NEVER;
  }
  return [...new Set(entries)];
});
const positiveInteger = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
export const ConfigSchema = z.object({
  DB_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== ':memory:' && !value.includes('\0'))
    .default('./data/foodops.sqlite'),
  API_HOST: host.default('127.0.0.1'),
  API_PORT: positiveInteger.pipe(z.number().max(65535)).default(3002),
  ADMIN_TOKEN: z
    .string()
    .min(32)
    .refine((value) => !/\s/.test(value)),
  WEB_ORIGIN: origins.prefault('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SIMULATOR: z.enum(['off', 'on']).default('off'),
  CHANGE_FEED_POLL_MS: positiveInteger.pipe(z.number().min(100).max(60000)).default(500),
  SSE_MAX_STREAMS: positiveInteger.pipe(z.number().max(1000)).default(50),
  SSE_REPLAY_LIMIT: positiveInteger.pipe(z.number().max(10000)).default(1000),
  RATE_LIMIT_PER_MIN: positiveInteger.default(120),
});
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(options: { root?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const root = options.root ?? WORKSPACE_ROOT;
  const env = options.env ?? process.env;
  let file: Record<string, string | undefined>;
  try {
    const path = resolve(root, '.env');
    file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Could not read API configuration',
      'Check the workspace .env file permissions and syntax',
    );
  }
  const values = Object.fromEntries(
    Object.keys(ConfigSchema.shape).map((key) => [key, env[key] ?? file[key]]),
  );
  const parsed = ConfigSchema.safeParse(values);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AppError(
      ErrorCode.VALIDATION,
      `Invalid API configuration: ${keys.join(', ')}`,
      'Check the API environment table; configuration values are never logged',
    );
  }
  if (parsed.data.SIMULATOR === 'on')
    throw new AppError(
      ErrorCode.VALIDATION,
      'SIMULATOR=on is not supported until the simulator phase',
      'Set SIMULATOR=off',
    );
  return { ...parsed.data, DB_PATH: resolve(root, parsed.data.DB_PATH) };
}
