import { z } from 'zod';
import { AppError, ErrorCode } from '../errors.js';
import { IdSchema, TimestampSchema } from './common.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const LimitSchema = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);

/** Orders use a stable (placed_at, id) keyset rather than a mutable row offset. */
export const CursorPositionSchema = z.strictObject({ placed_at: TimestampSchema, id: IdSchema });
export type CursorPosition = z.infer<typeof CursorPositionSchema>;

export function encodeCursor(position: CursorPosition): string {
  const parsed = CursorPositionSchema.safeParse(position);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid cursor position',
      'Use the next_cursor returned by the previous page',
    );
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.length > 3072) throw new AppError(ErrorCode.VALIDATION, 'Cursor is too large');
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (encoded.length > 4096) throw new AppError(ErrorCode.VALIDATION, 'Cursor is too large');
  return encoded;
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('Invalid encoding');
    }
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (ch) => ch.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(json);
    const parsed = CursorPositionSchema.parse(value);
    if (encodeCursor(parsed) !== cursor) throw new Error('Non-canonical encoding');
    return parsed;
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid pagination cursor',
      'Use the next_cursor returned by the previous page',
    );
  }
}

export const CursorSchema = z.string().superRefine((value, ctx) => {
  try {
    decodeCursor(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid pagination cursor' });
  }
});
export const PaginationSchema = z.strictObject({
  cursor: CursorSchema.optional(),
  limit: LimitSchema,
});
export type Pagination = z.infer<typeof PaginationSchema>;

export function createPageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), next_cursor: CursorSchema.nullable() });
}
