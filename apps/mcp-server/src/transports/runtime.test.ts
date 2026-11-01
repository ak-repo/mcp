import { PassThrough, Writable } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openRuntime, correlation } from './runtime.js';
import { startStdio } from './stdio.js';
import { seedFixture, INITIALIZE } from './test-helpers.js';
let fixture: ReturnType<typeof seedFixture>;
beforeEach(() => {
  fixture = seedFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
});
it('checks a seeded database and closes both handles idempotently', () => {
  const runtime = openRuntime(fixture.config);
  runtime.checkHealth();
  runtime.close();
  runtime.close();
  expect(() => runtime.checkHealth()).toThrow();
});
it('rejects uninitialized and invalid files without changing their contents', () => {
  const path = join(fixture.directory, 'not-sqlite.txt');
  writeFileSync(path, 'not a database');
  expect(() => openRuntime({ ...fixture.config, DB_PATH: path })).toThrow();
});
it('accepts bounded run IDs and replaces invalid values', () => {
  expect(correlation('run-123')).toBe('run-123');
  expect(correlation('secret\nvalue', 'fallback')).toBe('fallback');
  expect(correlation('x'.repeat(129), 'fallback')).toBe('fallback');
});
it('drains stdio output backpressure before closing the database', async () => {
  const runtime = openRuntime(fixture.config);
  const close = vi.spyOn(runtime, 'close');
  const stdin = new PassThrough();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let output = '';
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _, callback) {
      output += chunk.toString();
      release = callback;
      started();
    },
  });
  const app = await startStdio({ config: fixture.config, runtime, stdin, stdout, signals: false });
  stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  await pending;
  const stopped = app.shutdown();
  expect(close).not.toHaveBeenCalled();
  release();
  await stopped;
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(output)).toMatchObject({ id: 1, result: expect.any(Object) });
  stdin.destroy();
  stdout.destroy();
});
