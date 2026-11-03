import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { TOKEN } from './helpers.js';
const directories: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), 'foodops-api-config-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe('API configuration', () => {
  it('uses defaults and workspace-relative DB paths', () => {
    const directory = root();
    expect(loadConfig({ root: directory, env: { ADMIN_TOKEN: TOKEN } })).toEqual({
      DB_PATH: join(directory, 'data/foodops.sqlite'),
      ADMIN_TOKEN: TOKEN,
      API_HOST: '127.0.0.1',
      API_PORT: 3002,
      API_CONFIRM_SECRET: undefined,
      WEB_ORIGIN: ['http://localhost:5173'],
      LOG_LEVEL: 'info',
      SIMULATOR: 'off',
      RATE_LIMIT_PER_MIN: 120,
      CHANGE_FEED_POLL_MS: 500,
      SSE_MAX_STREAMS: 50,
      SSE_REPLAY_LIMIT: 1000,
      SIMULATOR_INTERVAL_MS: 5000,
      SIMULATOR_SEED: 42,
    });
  });
  it('process values override .env without mutating process environment', () => {
    const directory = root();
    writeFileSync(
      join(directory, '.env'),
      `ADMIN_TOKEN=${TOKEN}\nAPI_PORT=4000\nDB_PATH=file.sqlite\nWEB_ORIGIN=http://localhost:5173,https://ops.example\n`,
    );
    expect(loadConfig({ root: directory, env: { API_PORT: '4001' } })).toMatchObject({
      API_PORT: 4001,
      DB_PATH: join(directory, 'file.sqlite'),
      WEB_ORIGIN: ['http://localhost:5173', 'https://ops.example'],
    });
  });
  it.each([
    ['ADMIN_TOKEN', ''],
    ['ADMIN_TOKEN', 'x'.repeat(31)],
    ['ADMIN_TOKEN', 'x'.repeat(32) + ' '],
    ['API_PORT', '0'],
    ['API_PORT', '65536'],
    ['API_PORT', '1.5'],
    ['API_PORT', ''],
    ['API_HOST', 'http://localhost'],
    ['API_HOST', '-bad'],
    ['API_HOST', ''],
    ['DB_PATH', ':memory:'],
    ['DB_PATH', ''],
    ['DB_PATH', 'bad\0file'],
    ['WEB_ORIGIN', '*'],
    ['WEB_ORIGIN', 'null'],
    ['WEB_ORIGIN', 'http://localhost:5173/'],
    ['WEB_ORIGIN', 'https://user:secret@example.com'],
    ['WEB_ORIGIN', 'https://example.com/path'],
    ['WEB_ORIGIN', 'http://localhost:5173,'],
    ['WEB_ORIGIN', ''],
    ['LOG_LEVEL', 'verbose'],
    ['SIMULATOR', 'true'],
    ['CHANGE_FEED_POLL_MS', '99'],
    ['CHANGE_FEED_POLL_MS', '60001'],
    ['SSE_MAX_STREAMS', '0'],
    ['SSE_MAX_STREAMS', '1001'],
    ['SSE_REPLAY_LIMIT', '10001'],
    ['SIMULATOR_INTERVAL_MS', '999'],
    ['SIMULATOR_INTERVAL_MS', '60001'],
    ['SIMULATOR_SEED', ''],
    ['SIMULATOR_SEED', '-1'],
    ['SIMULATOR_SEED', '4294967296'],
    ['RATE_LIMIT_PER_MIN', '0'],
    ['RATE_LIMIT_PER_MIN', '-1'],
    ['RATE_LIMIT_PER_MIN', '1.5'],
    ['RATE_LIMIT_PER_MIN', '9007199254740992'],
  ])('rejects %s=%s without leaking the value', (key, value) => {
    expect(() => loadConfig({ root: root(), env: { ADMIN_TOKEN: TOKEN, [key]: value } })).toThrow();
  });
  it('requires a token and accepts exactly 32 characters', () => {
    expect(() => loadConfig({ root: root(), env: {} })).toThrow('ADMIN_TOKEN');
    expect(
      loadConfig({ root: root(), env: { ADMIN_TOKEN: 'x'.repeat(32) } }).ADMIN_TOKEN,
    ).toHaveLength(32);
  });
  it('accepts non-loopback and IPv6 bind addresses', () => {
    for (const API_HOST of ['0.0.0.0', '::1', '::', 'ops.example'])
      expect(loadConfig({ root: root(), env: { ADMIN_TOKEN: TOKEN, API_HOST } }).API_HOST).toBe(
        API_HOST,
      );
  });
});

it('accepts simulator startup and bounded live-update configuration', () => {
  expect(
    loadConfig({
      root: root(),
      env: { ADMIN_TOKEN: TOKEN, SIMULATOR: 'on', SIMULATOR_SEED: '0', SSE_REPLAY_LIMIT: '10000' },
    }),
  ).toMatchObject({ SIMULATOR: 'on', SIMULATOR_SEED: 0, SSE_REPLAY_LIMIT: 10000 });
});
