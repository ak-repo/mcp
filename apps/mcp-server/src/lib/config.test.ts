import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AppError, ErrorCode } from '@foodops/shared';
import { loadConfig } from './config.js';
import { mapToolError } from './error-mapper.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foodops-config-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('loads defaults relative to the workspace rather than the current directory', () => {
  expect(loadConfig({ root, env: {} })).toEqual({
    DB_PATH: join(root, 'data/foodops.sqlite'),
    PORT: 3001,
    LOG_LEVEL: 'info',
  });
});
it('loads quoted .env values with process precedence and supports MCP_PORT fallback', () => {
  writeFileSync(
    join(root, '.env'),
    'DB_PATH="data/local.sqlite"\nMCP_PORT=4000\nLOG_LEVEL=debug\nMCP_AUTH_TOKEN="file-token"\n',
  );
  expect(loadConfig({ root, env: {} })).toMatchObject({
    DB_PATH: join(root, 'data/local.sqlite'),
    PORT: 4000,
    LOG_LEVEL: 'debug',
    MCP_AUTH_TOKEN: 'file-token',
  });
  expect(
    loadConfig({
      root,
      env: {
        DB_PATH: '/tmp/override.sqlite',
        PORT: '5000',
        MCP_PORT: '6000',
        MCP_AUTH_TOKEN: 'env-token',
        LOG_LEVEL: 'warn',
      },
    }),
  ).toEqual({
    DB_PATH: '/tmp/override.sqlite',
    PORT: 5000,
    MCP_AUTH_TOKEN: 'env-token',
    LOG_LEVEL: 'warn',
  });
  expect(loadConfig({ root, env: { MCP_AUTH_TOKEN: '' } }).MCP_AUTH_TOKEN).toBeUndefined();
  expect(loadConfig({ root, env: { MCP_PORT: '7000' } }).PORT).toBe(7000);
});
it.each([
  { PORT: '0' },
  { PORT: '65536' },
  { PORT: '1.5' },
  { PORT: 'abc' },
  { DB_PATH: '' },
  { DB_PATH: ':memory:' },
  { LOG_LEVEL: 'verbose' },
  { MCP_AUTH_TOKEN: ' ' },
])('rejects invalid configuration without leaking values: %j', (env) => {
  expect(() => loadConfig({ root, env })).toThrow(AppError);
  expect(() => loadConfig({ root, env })).toThrow('Invalid MCP configuration');
});
it('maps AppError text exactly and sanitizes unknown errors', () => {
  const error = new AppError(ErrorCode.NOT_FOUND, 'Order was not found', 'Check the order ID');
  expect(mapToolError(error)).toEqual({
    isError: true,
    content: [{ type: 'text', text: error.toToolText() }],
  });
  expect(JSON.stringify(mapToolError(new Error('SECRET SQL')))).not.toContain('SECRET');
  expect(mapToolError(null)).toMatchObject({
    isError: true,
    content: [{ text: expect.stringMatching(/^INTERNAL:/) }],
  });
});
it('writes Pino JSON exclusively to stderr and redacts tokens in the built package', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { createLogger } from './dist/lib/logger.js'; createLogger().info({ MCP_AUTH_TOKEN: 'SECRET', headers: { authorization: 'SECRET' } }, 'test');",
    ],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('SECRET');
  expect(JSON.parse(result.stderr)).toMatchObject({
    msg: 'test',
    MCP_AUTH_TOKEN: '[REDACTED]',
    headers: { authorization: '[REDACTED]' },
  });
});
