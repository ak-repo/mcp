import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError, ErrorCode } from '@foodops/shared';
import { openWritable, type DatabaseConnection } from './connection.js';

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}
interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

function readMigrations(directory: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  const versions = new Set<number>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const match = /^(\d+)_[a-zA-Z0-9_-]+\.sql$/.exec(entry.name);
    const version = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(version) || version < 1 || versions.has(version)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `Invalid or duplicate migration number: ${entry.name}`,
      );
    }
    versions.add(version);
    const bytes = readFileSync(join(directory, entry.name));
    files.push({
      version,
      name: entry.name,
      sql: bytes.toString('utf8'),
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return files.sort((a, b) => a.version - b.version);
}

function validateHistory(db: DatabaseConnection, files: MigrationFile[]): AppliedMigration[] {
  const history = db
    .prepare<[], AppliedMigration>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    .all();
  for (const applied of history) {
    const file = files.find((candidate) => candidate.version === applied.version);
    if (!file || file.name !== applied.name || file.checksum !== applied.checksum) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Applied migration changed or is missing: ${applied.name}`,
        'Restore the original migration and add a new numbered file',
      );
    }
  }
  const latest = history.at(-1)?.version ?? 0;
  if (
    files.some(
      (file) =>
        file.version < latest && !history.some((applied) => applied.version === file.version),
    )
  ) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'A pending migration predates the applied migration history',
      'Add migrations with a new increasing number',
    );
  }
  return history;
}

/** Apply numbered files once, checking history even when there are no pending files. */
export function migrate(
  db: DatabaseConnection,
  directory = DEFAULT_MIGRATIONS_DIRECTORY,
): string[] {
  if (db.readonly || db.inTransaction) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Migrations require a writable connection outside a transaction',
    );
  }
  const files = readMigrations(directory);
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT`);
    validateHistory(db, files);
  }).immediate();

  const applied: string[] = [];
  for (const file of files) {
    const didApply = db
      .transaction(() => {
        // Recheck while holding the write lock in case another process migrated first.
        const history = validateHistory(db, files);
        if (history.some((row) => row.version === file.version)) return false;
        db.exec(file.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(file.version, file.name, file.checksum, new Date().toISOString());
        return true;
      })
      .immediate();
    if (didApply) applied.push(file.name);
  }
  return applied;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  let db: DatabaseConnection | undefined;
  try {
    const path =
      process.env['DATABASE_PATH'] ??
      fileURLToPath(new URL('../../../../data/foodops.sqlite', import.meta.url));
    db = openWritable(path);
    const applied = migrate(db);
    process.stderr.write(`Migrations complete: ${applied.length} applied.\n`);
  } catch (error) {
    const message =
      error instanceof AppError
        ? error.toToolText()
        : 'INTERNAL: Database migration failed. Check the database path and migration SQL.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
