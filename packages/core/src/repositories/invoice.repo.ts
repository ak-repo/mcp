import { InvoiceSchema, type Invoice } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { one } from './common.js';
export function createInvoiceRepository(db: DatabaseConnection) {
  return {
    forOrder: (id: string) =>
      one(
        db,
        'SELECT id, order_id, invoice_no, subtotal_paise, tax_paise, fees_paise, discount_paise, total_paise, issued_at FROM invoices WHERE order_id = ?',
        [id],
        InvoiceSchema,
      ),
    maxSequence(date: string): bigint {
      const row: unknown = db
        .prepare(
          'SELECT COALESCE(MAX(CAST(substr(invoice_no, 14) AS INTEGER)), 0) AS sequence FROM invoices WHERE invoice_no LIKE ?',
        )
        .safeIntegers(true)
        .get(`INV-${date}-%`);
      if (
        !row ||
        typeof row !== 'object' ||
        !('sequence' in row) ||
        typeof row.sequence !== 'bigint'
      )
        throw new Error('Invalid invoice sequence');
      return row.sequence;
    },
    insert(invoice: Invoice) {
      const r = InvoiceSchema.parse(invoice);
      db.prepare(
        'INSERT INTO invoices (id, order_id, invoice_no, subtotal_paise, tax_paise, fees_paise, discount_paise, total_paise, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        r.id,
        r.order_id,
        r.invoice_no,
        r.subtotal_paise,
        r.tax_paise,
        r.fees_paise,
        r.discount_paise,
        r.total_paise,
        r.issued_at,
      );
    },
  };
}
