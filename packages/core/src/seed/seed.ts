import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { AppError, ErrorCode } from '@foodops/shared';
import { openWritable, type DatabaseConnection } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createSeedData, EDGE_CASE_IDS, SEED_NOW } from './factories.js';
import { checkSeedInvariants, type InvariantReport } from './invariants.js';
import { insertSeedData, readSeedData, seedContentHash, SEED_TABLES } from './storage.js';

export const WORKSPACE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export interface SeedReport extends InvariantReport {
  anchor: string;
  edgeCaseIds: typeof EDGE_CASE_IDS;
  alreadySeeded: boolean;
}
function failure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const result = new AppError(
    ErrorCode.INTERNAL,
    'Database seeding failed',
    'Check the database path and seed invariants; no seed transaction changes were committed',
  );
  result.cause = error;
  return result;
}

/** Replays an unchanged seed without writes; other existing application data requires --reset. */
export function seedDatabase(db: DatabaseConnection): SeedReport {
  try {
    migrate(db);
    const expected = createSeedData();
    const expectedHash = seedContentHash(expected);
    return db
      .transaction(() => {
        const current = readSeedData(db);
        const populated = SEED_TABLES.some((table) => current[table].length !== 0);
        if (populated && seedContentHash(current) !== expectedHash) {
          throw new AppError(
            ErrorCode.CONFLICT,
            'The database contains data different from this deterministic seed',
            'Use pnpm seed --reset to replace the demo database',
          );
        }
        if (!populated) insertSeedData(db, expected);
        const report = checkSeedInvariants(db);
        if (report.contentHash !== expectedHash)
          throw new AppError(
            ErrorCode.INTERNAL,
            'Persisted seed content differs from the generated dataset',
            'Inspect the seed storage mapping and database triggers',
          );
        return {
          ...report,
          anchor: SEED_NOW,
          edgeCaseIds: EDGE_CASE_IDS,
          alreadySeeded: populated,
        };
      })
      .immediate();
  } catch (error) {
    throw failure(error);
  }
}

export function resolveSeedPath(
  options: { root?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): string {
  const root = options.root ?? WORKSPACE_ROOT;
  const env = options.env ?? process.env;
  const envPath = resolve(root, '.env');
  let file: Record<string, string | undefined> = {};
  try {
    if (existsSync(envPath)) file = parseEnv(readFileSync(envPath, 'utf8'));
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Could not read the workspace .env file',
      'Use a readable .env file with valid KEY=value entries',
    );
  }
  // Explicit process settings take precedence over .env; DB_PATH is preferred within each source.
  const configured =
    env['DB_PATH'] ??
    env['DATABASE_PATH'] ??
    file['DB_PATH'] ??
    file['DATABASE_PATH'] ??
    './data/foodops.sqlite';
  if (configured.trim() === '' || configured.includes('\0') || configured === ':memory:') {
    throw new AppError(
      ErrorCode.VALIDATION,
      'DB_PATH must name a persistent SQLite file',
      'Set DB_PATH in the workspace .env; relative paths resolve from the workspace root',
    );
  }
  return resolve(root, configured);
}

function validateFilePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.trim() === '' ||
    path.includes('\0') ||
    path === ':memory:'
  ) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'A persistent SQLite file path is required',
      'Set DB_PATH to a non-empty SQLite file path',
    );
  }
}

export function resetDatabaseFile(path: string): void {
  validateFilePath(path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat !== undefined) {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new AppError(
        ErrorCode.VALIDATION,
        'Reset requires a regular SQLite file',
        'Point DB_PATH at the database file rather than a directory or symlink',
      );
    const descriptor = openSync(path, 'r');
    const header = Buffer.alloc(16);
    try {
      readSync(descriptor, header, 0, header.length, 0);
    } finally {
      closeSync(descriptor);
    }
    if (header.toString('utf8') !== 'SQLite format 3\0') {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Refusing to reset a file that is not SQLite',
        'Set DB_PATH to the intended SQLite database file',
      );
    }
    const db = openWritable(path);
    try {
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (
        checkpoint.some((row) => row.busy !== 0) ||
        db.pragma('journal_mode = DELETE', { simple: true }) !== 'delete'
      ) {
        throw new AppError(
          ErrorCode.CONFLICT,
          'The database is in use and cannot be reset',
          'Close other database connections and retry pnpm seed --reset',
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const problem = new AppError(
        ErrorCode.CONFLICT,
        'The database could not be prepared for reset',
        'Close other database connections and retry pnpm seed --reset',
      );
      problem.cause = error;
      throw problem;
    } finally {
      db.close();
    }
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}

export function seedFile(path: string, reset = false): SeedReport {
  let db: DatabaseConnection | undefined;
  try {
    validateFilePath(path);
    if (reset) resetDatabaseFile(path);
    db = openWritable(path);
    return seedDatabase(db);
  } catch (error) {
    throw failure(error);
  } finally {
    db?.close();
  }
}

export function runSeedCli(args: readonly string[] = process.argv.slice(2)): void {
  try {
    if (args.some((arg) => arg !== '--reset') || args.length > 1) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Unsupported seed arguments',
        'Run pnpm seed or pnpm seed --reset',
      );
    }
    const path = resolveSeedPath();
    const report = seedFile(path, args.includes('--reset'));
    // stderr is deliberate: importing seed helpers must never pollute an MCP stdio channel.
    process.stderr.write(`${JSON.stringify({ database: path, ...report }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${failure(error).toToolText()}\n`);
    process.exitCode = 1;
  }
}
const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) runSeedCli();
