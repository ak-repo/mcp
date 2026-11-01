import { PaymentSchema, type Payment } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { many } from './common.js';
export function createPaymentRepository(db: DatabaseConnection) {
  return {
    forOrder: (id: string) =>
      many(
        db,
        'SELECT id, order_id, method, status, amount_paise, txn_ref FROM payments WHERE order_id = ? ORDER BY id',
        [id],
        PaymentSchema,
      ),
    update(payment: Payment) {
      const row = PaymentSchema.parse(payment);
      db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(row.status, row.id);
    },
  };
}
