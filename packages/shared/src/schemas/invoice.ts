import { z } from 'zod';
import { IdSchema, PaiseSchema, TimestampSchema } from './common.js';

export const InvoiceSchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  invoice_no: z.string().regex(/^INV-[0-9]{8}-[0-9]{4,}$/),
  subtotal_paise: PaiseSchema,
  tax_paise: PaiseSchema,
  fees_paise: PaiseSchema,
  discount_paise: PaiseSchema,
  total_paise: PaiseSchema,
  issued_at: TimestampSchema,
});
export type Invoice = z.infer<typeof InvoiceSchema>;
