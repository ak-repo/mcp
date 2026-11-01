import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError, ErrorCode } from '@foodops/shared';

export type DatabaseConnection = Database.Database;

function configure(db: DatabaseConnection): DatabaseConnection {
  try {
    if (db.readonly) {
      // journal_mode persists in the file. A read-only connection cannot enable WAL.
      if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
        throw new AppError(
          ErrorCode.CONFLICT,
          'Read-only database is not in WAL mode',
          'Open it with openWritable first',
        );
      }
      db.pragma('query_only = ON');
    } else {
      const mode = db.pragma('journal_mode = WAL', { simple: true });
      if (mode !== 'wal' && db.name !== ':memory:' && db.name !== '') {
        throw new AppError(ErrorCode.INTERNAL, 'Could not enable WAL mode');
      }
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function validatePath(path: string): void {
  if (typeof path !== 'string' || path.trim().length === 0 || path.includes('\0')) {
    throw new AppError(ErrorCode.VALIDATION, 'A non-empty database path is required');
  }
}

export function openWritable(path: string): DatabaseConnection {
  validatePath(path);
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  return configure(new Database(path, { timeout: 5000 }));
}

export function openReadOnly(path: string): DatabaseConnection {
  validatePath(path);
  return configure(new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 }));
}
