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
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const llmBaseUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    if (
      /^169\.254\./.test(hostname) ||
      /^fe[89ab][0-9a-f]:/i.test(hostname) ||
      hostname === 'metadata.google.internal' ||
      hostname === 'metadata.google.internal.'
    )
      return false;
    if (hostname.startsWith('::ffff:')) {
      const parts = hostname.slice(7).split(':');
      if (parts[0] === 'a9fe' || /^169\.254\./.test(parts.join(':'))) return false;
    }
    return true;
  } catch {
    return false;
  }
});
export const ConfigFieldsSchema = z.object({
  AGENT_MAX_ITERATIONS: positiveInteger.pipe(z.number().max(100)).default(6),
  AGENT_MAX_TOOL_CALLS: positiveInteger.pipe(z.number().max(100)).default(12),
  AGENT_RUN_TIMEOUT_MS: positiveInteger.pipe(z.number().max(2147483647)).default(300000),
  MCP_URL: llmBaseUrl.default('http://127.0.0.1:3001/mcp'),
  MCP_AUTH_TOKEN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).regex(/^\S+$/).optional(),
  ),
  MCP_CALL_TIMEOUT_MS: positiveInteger.pipe(z.number().max(2147483647)).default(10000),
  MCP_TOOLS_TTL_MS: positiveInteger.pipe(z.number().max(2147483647)).default(60000),
  LLM_PROVIDER: z.enum(['ollama', 'openai-compatible', 'anthropic']).default('ollama'),
  LLM_BASE_URL: llmBaseUrl.optional(),
  LLM_MODEL: optionalText,
  LLM_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(1)
      .refine((value) =>
        [...value].every(
          (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
        ),
      )
      .optional(),
  ),
  LLM_TOOL_MODE: z.enum(['auto', 'native', 'prompted']).default('auto'),
  LLM_NUM_CTX: positiveInteger.default(16384),
  LLM_TEMPERATURE: z.coerce.number().finite().min(0).max(2).default(0.2),
  LLM_FIRST_BYTE_TIMEOUT_MS: positiveInteger.pipe(z.number().max(2147483647)).default(60000),
  LLM_IDLE_TIMEOUT_MS: positiveInteger.pipe(z.number().max(2147483647)).default(30000),
  LLM_MAX_CONCURRENCY: positiveInteger.default(1),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  LLM_THINK: z.enum(['off', 'on']).default('off'),
  LLM_CONTEXT_BUDGET_TOKENS: positiveInteger.default(12000),
  DB_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== ':memory:' && !value.includes('\0'))
    .default('./data/foodops.sqlite'),
  API_CONFIRM_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(32)
      .refine((value) => !/\s/.test(value))
      .optional(),
  ),
  API_HOST: host.default('127.0.0.1'),
  API_PORT: positiveInteger.pipe(z.number().max(65535)).default(3002),
  ADMIN_TOKEN: z
    .string()
    .min(32)
    .refine((value) => !/\s/.test(value)),
  WEB_ORIGIN: origins.prefault('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SIMULATOR_INTERVAL_MS: positiveInteger.pipe(z.number().min(1000).max(60000)).default(5000),
  SIMULATOR_SEED: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]+$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(0).max(4294967295))
    .default(42),
  SIMULATOR_MAX_ACTIVE: positiveInteger.default(60),
  SIMULATOR: z.enum(['off', 'on']).default('off'),
  CALL_LOG_RETENTION_DAYS: positiveInteger.pipe(z.number().max(1000000)).default(30),
  CHANGE_FEED_POLL_MS: positiveInteger.pipe(z.number().min(100).max(60000)).default(500),
  SSE_MAX_STREAMS: positiveInteger.pipe(z.number().max(1000)).default(50),
  SSE_REPLAY_LIMIT: positiveInteger.pipe(z.number().max(10000)).default(1000),
  RATE_LIMIT_PER_MIN: positiveInteger.default(1200),
  RATE_LIMIT_WRITE_PER_MIN: positiveInteger.default(60),
  RATE_LIMIT_TICKET_PER_MIN: positiveInteger.default(60),
});
export const PROVIDER_BASE_URLS = {
  ollama: 'https://ollama.com',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
} as const;
export const LLMSettingsSchema = ConfigFieldsSchema.pick({
  LLM_PROVIDER: true,
  LLM_BASE_URL: true,
  LLM_MODEL: true,
  LLM_API_KEY: true,
  LLM_TOOL_MODE: true,
  LLM_NUM_CTX: true,
  LLM_TEMPERATURE: true,
  LLM_FIRST_BYTE_TIMEOUT_MS: true,
  LLM_IDLE_TIMEOUT_MS: true,
  LLM_MAX_CONCURRENCY: true,
  LLM_MAX_RETRIES: true,
  LLM_THINK: true,
  LLM_CONTEXT_BUDGET_TOKENS: true,
}).transform((value) => ({
  ...value,
  LLM_BASE_URL: value.LLM_BASE_URL ?? PROVIDER_BASE_URLS[value.LLM_PROVIDER],
}));
export const ConfigSchema = ConfigFieldsSchema.transform((value) => ({
  ...value,
  LLM_BASE_URL: value.LLM_BASE_URL ?? PROVIDER_BASE_URLS[value.LLM_PROVIDER],
}));
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
    Object.keys(ConfigFieldsSchema.shape).map((key) => [key, env[key] ?? file[key]]),
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
  return { ...parsed.data, DB_PATH: resolve(root, parsed.data.DB_PATH) };
}
