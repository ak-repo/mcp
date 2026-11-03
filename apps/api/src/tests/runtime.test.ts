import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as connection from '@foodops/core/db/connection';
import { seedDatabase } from '@foodops/core/seed/seed';
import { loadConfig } from '../config.js';
import { openRuntime } from '../runtime.js';
import { fixture, TOKEN, type Fixture } from './helpers.js';
const directories: string[] = [];
let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe('runtime ownership', () => {
  it('opens services, checks readiness, and closes handles idempotently', async () => {
    f = fixture();
    expect(f.runtime.services.catalog.searchRestaurants({ limit: 1 }).items).toHaveLength(1);
    expect(() => f?.runtime.checkReady()).not.toThrow();
    await f.runtime.shutdown();
    await f.runtime.shutdown();
    expect(() => f?.runtime.checkReady()).toThrow();
  });
  it('does not create missing databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'foodops-api-runtime-'));
    directories.push(directory);
    const path = join(directory, 'missing.sqlite');
    const config = loadConfig({ root: directory, env: { ADMIN_TOKEN: TOKEN, DB_PATH: path } });
    expect(() => openRuntime(config)).toThrow('Initialized database file was not found');
    expect(existsSync(path)).toBe(false);
  });
  it('closes the writable handle if opening the read handle fails', () => {
    f = fixture();
    const realOpen = connection.openWritable;
    const opened: connection.DatabaseConnection[] = [];
    vi.spyOn(connection, 'openWritable').mockImplementation((path) => {
      const db = realOpen(path);
      opened.push(db);
      return db;
    });
    vi.spyOn(connection, 'openReadOnly').mockImplementation(() => {
      throw new Error('read open failed');
    });
    expect(() => openRuntime(f!.config)).toThrow('read open failed');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.open).toBe(false);
  });
  it('closes both handles if preparing services fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'foodops-api-empty-'));
    directories.push(directory);
    const path = join(directory, 'empty.sqlite');
    connection.openWritable(path).close();
    const opened: connection.DatabaseConnection[] = [];
    const realWrite = connection.openWritable;
    const realRead = connection.openReadOnly;
    vi.spyOn(connection, 'openWritable').mockImplementation((name) => {
      const db = realWrite(name);
      opened.push(db);
      return db;
    });
    vi.spyOn(connection, 'openReadOnly').mockImplementation((name) => {
      const db = realRead(name);
      opened.push(db);
      return db;
    });
    const config = loadConfig({
      root: directory,
      env: { ADMIN_TOKEN: TOKEN, DB_PATH: path, LOG_LEVEL: 'silent' },
    });
    expect(() => openRuntime(config)).toThrow();
    expect(opened).toHaveLength(2);
    expect(opened.every((db) => !db.open)).toBe(true);
    // Startup never attempts to repair or migrate the database.
    const db = realWrite(path);
    try {
      expect(() => seedDatabase(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

it('close deactivates both loops synchronously and waits for an in-flight tick before closing DBs', async () => {
  vi.useFakeTimers();
  f = fixture({ SIMULATOR: 'on', SIMULATOR_INTERVAL_MS: 1000 });
  const runtime = f.runtime;
  const read = runtime.services.order.listProgressable;
  let closing: Promise<void> | undefined;
  let observedOpen = false;
  vi.spyOn(runtime.services.order, 'listProgressable').mockImplementationOnce((input) => {
    closing = runtime.close();
    expect(runtime.shutdown()).toBe(closing);
    runtime.checkReady();
    observedOpen = true;
    expect(() => runtime.tickets.issue()).toThrow(/stopping/);
    return read(input);
  });
  runtime.start();
  await vi.advanceTimersByTimeAsync(1100);
  await closing;
  expect(observedOpen).toBe(true);
  expect(() => runtime.checkReady()).toThrow();
  expect(f.logs.filter((line) => /"level":(40|50|60)/.test(line))).toEqual([]);
  const ticks = runtime.simulator.status().ticks;
  runtime.start();
  await vi.advanceTimersByTimeAsync(10000);
  expect(runtime.simulator.status().ticks).toBe(ticks);
  vi.useRealTimers();
});
