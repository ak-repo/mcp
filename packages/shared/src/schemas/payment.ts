import { z } from 'zod';
import { IdSchema, PaiseSchema, TextSchema } from './common.js';

export const PaymentStatusSchema = z.enum([
  'pending',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export const PaymentMethodSchema = z.enum(['upi', 'card', 'cod', 'wallet']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentSchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  method: PaymentMethodSchema,
  status: PaymentStatusSchema,
  amount_paise: PaiseSchema,
  txn_ref: TextSchema.nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;
