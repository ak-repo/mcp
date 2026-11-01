import { AppError, ErrorCode, decodeCursor, encodeCursor } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';

export interface Schema<T> {
  parse(value: unknown): T;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export const ID_CURSOR_TIME = '1970-01-01T00:00:00.000Z';

export function dto<T>(schema: Schema<T>, raw: unknown, booleans: readonly string[] = []): T {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing row');
    const row: Record<string, unknown> = { ...raw };
    for (const column of booleans) {
      if (row[column] !== 0 && row[column] !== 1) throw new Error('Invalid SQLite boolean');
      row[column] = row[column] === 1;
    }
    return schema.parse(row);
  } catch {
    throw new AppError(
      ErrorCode.INTERNAL,
      'Stored data does not match its DTO contract',
      'Repair the invalid database record before retrying',
    );
  }
}
export function one<T>(
  db: DatabaseConnection,
  sql: string,
  args: unknown[],
  schema: Schema<T>,
  booleans: readonly string[] = [],
): T | null {
  const raw: unknown = db.prepare<unknown[], unknown>(sql).get(...args);
  return raw === undefined ? null : dto(schema, raw, booleans);
}
export function many<T>(
  db: DatabaseConnection,
  sql: string,
  args: unknown[],
  schema: Schema<T>,
  booleans: readonly string[] = [],
): T[] {
  return db
    .prepare<unknown[], unknown>(sql)
    .all(...args)
    .map((raw) => dto(schema, raw, booleans));
}
export function page<T extends { id: string }>(
  rows: T[],
  limit: number,
  timestamp: (row: T) => string = () => ID_CURSOR_TIME,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor({ placed_at: timestamp(last), id: last.id }) : null,
  };
}
export function idCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded.placed_at !== ID_CURSOR_TIME) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Cursor belongs to a different list',
      'Use the next_cursor returned by this list',
    );
  }
  return decoded.id;
}
export function dateBounds(
  from?: string,
  to?: string,
): { from: string | null; to: string | null; exclusive: boolean } {
  const exclusive = to !== undefined && to.length === 10;
  return {
    from: from === undefined ? null : new Date(from).toISOString(),
    to:
      to === undefined ? null : new Date(Date.parse(to) + (exclusive ? 86400000 : 0)).toISOString(),
    exclusive,
  };
}
