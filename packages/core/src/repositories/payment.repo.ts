import { PaymentSchema, type Payment } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { many } from './common.js';
export function createPaymentRepository(db: DatabaseConnection) {
  return {
    insert(value: Payment) {
      const row = PaymentSchema.parse(value);
      const columns = Object.keys(PaymentSchema.shape);
      db.prepare(
        `INSERT INTO payments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...columns.map((key) => row[key as keyof Payment]));
    },
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
