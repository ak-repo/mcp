import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWritable } from '@foodops/core/db/connection';
import { seedDatabase } from '@foodops/core/seed/seed';
import { buildApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createLogger, openRuntime } from '../runtime.js';
export const TOKEN = 'foodops-api-test-secret-32-characters';
export const AUTH = { authorization: `Bearer ${TOKEN}` };
export function fixture(
  overrides: Partial<Config> = {},
  options: NonNullable<Parameters<typeof openRuntime>[1]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'foodops-api-'));
  const dbPath = join(directory, 'db.sqlite');
  const db = openWritable(dbPath);
  try {
    seedDatabase(db);
  } finally {
    db.close();
  }
  const config = {
    ...loadConfig({
      root: directory,
      env: { ADMIN_TOKEN: TOKEN, DB_PATH: dbPath, LOG_LEVEL: 'silent' },
    }),
    ...overrides,
  };
  const logs: string[] = [];
  const logger = createLogger('info', {
    write: (line: string) => {
      logs.push(line);
    },
  });
  const runtime = openRuntime(config, { ...options, logger });
  const app = buildApp({ config, runtime });
  return {
    directory,
    dbPath,
    config,
    runtime,
    app,
    logs,
    async close() {
      try {
        await app.close();
      } finally {
        await runtime.shutdown();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
export type Fixture = ReturnType<typeof fixture>;
