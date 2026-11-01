import {
  decodeCursor,
  IdempotencyKeySchema,
  ToolCallLogSchema,
  type IdempotencyKey,
  type Pagination,
  type ToolCallLog,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { many, one, page } from './common.js';
export function createAuditRepository(db: DatabaseConnection) {
  return {
    key: (key: string) =>
      one(
        db,
        'SELECT key, operation, request_hash, response_json, created_at FROM idempotency_keys WHERE key = ?',
        [key],
        IdempotencyKeySchema,
      ),
    insertKey(record: IdempotencyKey) {
      const r = IdempotencyKeySchema.parse(record);
      db.prepare(
        'INSERT INTO idempotency_keys (key, operation, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(r.key, r.operation, r.request_hash, r.response_json, r.created_at);
    },
    record(call: ToolCallLog) {
      const r = ToolCallLogSchema.parse(call);
      db.prepare(
        'INSERT INTO tool_call_log (id, session_id, tool, args_json, status, error_code, latency_ms, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        r.id,
        r.session_id,
        r.tool,
        r.args_json,
        r.status,
        r.error_code,
        r.latency_ms,
        r.actor,
        r.at,
      );
    },
    list(filters: Pagination) {
      const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
      return page(
        many(
          db,
          `SELECT id, session_id, tool, args_json, status, error_code, latency_ms, actor, at FROM tool_call_log
        WHERE (? IS NULL OR at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`,
          [
            cursor?.placed_at ?? null,
            cursor?.placed_at ?? null,
            cursor?.placed_at ?? null,
            cursor?.id ?? null,
            filters.limit + 1,
          ],
          ToolCallLogSchema,
        ),
        filters.limit,
        (row) => row.at,
      );
    },
  };
}
