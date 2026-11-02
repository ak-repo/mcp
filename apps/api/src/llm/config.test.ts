import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config.js';
import { createLogger } from '../runtime.js';
const base = { ADMIN_TOKEN: 'a'.repeat(32) };
describe('LLM configuration', () => {
  it('boots without a model or key and normalizes empty optional values', () => {
    expect(ConfigSchema.parse({ ...base, LLM_MODEL: '', LLM_API_KEY: '' })).toMatchObject({
      LLM_MODEL: undefined,
      LLM_API_KEY: undefined,
      LLM_PROVIDER: 'ollama',
      LLM_BASE_URL: 'https://ollama.com',
    });
  });
  it.each([
    'http://localhost:11434',
    'http://192.168.1.10',
    'http://10.0.0.1/prefix/',
    'https://ollama.com',
    'http://[::1]:11434',
  ])('accepts %s', (LLM_BASE_URL) => {
    expect(ConfigSchema.safeParse({ ...base, LLM_BASE_URL }).success).toBe(true);
  });
  it.each([
    'ftp://host',
    'https://user:pass@host',
    'http://169.254.1.1',
    'http://2851995905',
    'http://[::ffff:169.254.1.1]',
    'http://[fe80::1]',
    'http://metadata.google.internal',
    'http://host?secret=1',
    'http://host/#x',
  ])('rejects unsafe URL %s', (LLM_BASE_URL) => {
    expect(ConfigSchema.safeParse({ ...base, LLM_BASE_URL }).success).toBe(false);
  });
  it.each([
    ['LLM_PROVIDER', 'wrong'],
    ['LLM_TOOL_MODE', 'wrong'],
    ['LLM_NUM_CTX', '0'],
    ['LLM_TEMPERATURE', '3'],
    ['LLM_FIRST_BYTE_TIMEOUT_MS', '-1'],
    ['LLM_IDLE_TIMEOUT_MS', '0'],
    ['LLM_MAX_CONCURRENCY', '0'],
    ['LLM_MAX_RETRIES', '11'],
    ['LLM_THINK', 'yes'],
    ['LLM_CONTEXT_BUDGET_TOKENS', '1.5'],
    ['LLM_API_KEY', 'a\r\nb'],
  ])('rejects invalid %s', (key, value) => {
    expect(ConfigSchema.safeParse({ ...base, [key]: value }).success).toBe(false);
  });
  it('redacts known structured log fields', () => {
    let output = '';
    const logger = createLogger('info', {
      write(line: string) {
        output += line;
      },
    });
    logger.info(
      {
        LLM_API_KEY: 'secret',
        config: { LLM_API_KEY: 'secret' },
        apiKey: 'secret',
        headers: { authorization: 'Bearer secret' },
      },
      'Provider configured',
    );
    expect(output).not.toContain('secret');
    expect(output).toContain('[REDACTED]');
  });
});
