import {
  decodeCursor,
  ChangeSchema,
  ToolCallFeedSchema,
  IdempotencyKeySchema,
  ToolCallLogSchema,
  type IdempotencyKey,
  type ToolCallListFilters,
  type ToolCallLog,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { many, one, page } from './common.js';
export function createAuditRepository(db: DatabaseConnection) {
  return {
    changesAfter: (id: number, limit: number) =>
      many(
        db,
        'SELECT id, entity, entity_id, order_id, op, at FROM change_log WHERE id > ? ORDER BY id LIMIT ?',
        [id, limit],
        ChangeSchema,
      ),
    changeBounds() {
      return db
        .prepare<[], { min: number; max: number }>(
          "SELECT coalesce(min(id),0) AS min, coalesce((SELECT seq FROM sqlite_sequence WHERE name='change_log'),0) AS max FROM change_log",
        )
        .get()!;
    },
    pruneChanges(at: string) {
      return db.prepare('DELETE FROM change_log WHERE at < ?').run(at).changes;
    },
    pruneCalls(at: string) {
      return db.prepare('DELETE FROM tool_call_log WHERE at < ?').run(at).changes;
    },
    maxCallRowId() {
      return db
        .prepare<[], { id: number }>(
          "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='tool_call_feed_sequence'),0) AS id",
        )
        .get()!.id;
    },
    callsAfterRowId(id: number, limit: number) {
      return many(
        db,
        'SELECT s.seq AS rowid, c.tool, c.status, c.error_code, c.latency_ms, c.at FROM tool_call_feed_sequence s JOIN tool_call_log c ON c.id = s.call_id WHERE s.seq > ? ORDER BY s.seq LIMIT ?',
        [id, limit],
        ToolCallFeedSchema,
      );
    },
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
    list(filters: ToolCallListFilters) {
      const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
      return page(
        many(
          db,
          `SELECT id, session_id, tool, args_json, status, error_code, latency_ms, actor, at FROM tool_call_log
        WHERE (? IS NULL OR tool = ?) AND (? IS NULL OR status = ?)
          AND (? IS NULL OR at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?`,
          [
            filters.tool ?? null,
            filters.tool ?? null,
            filters.status ?? null,
            filters.status ?? null,
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
