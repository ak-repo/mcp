import { RefundSchema, type Refund } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { many } from './common.js';
export function createRefundRepository(db: DatabaseConnection) {
  return {
    forPayment: (id: string) =>
      many(
        db,
        'SELECT id, order_id, payment_id, amount_paise, reason, actor, idempotency_key, created_at FROM refunds WHERE payment_id = ? ORDER BY created_at, id',
        [id],
        RefundSchema,
      ),
    insert(refund: Refund) {
      const r = RefundSchema.parse(refund);
      db.prepare(
        'INSERT INTO refunds (id, order_id, payment_id, amount_paise, reason, actor, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        r.id,
        r.order_id,
        r.payment_id,
        r.amount_paise,
        r.reason,
        r.actor,
        r.idempotency_key,
        r.created_at,
      );
    },
  };
}
