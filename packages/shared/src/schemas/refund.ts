import { z } from 'zod';
import { ActorSchema, IdSchema, PaiseSchema, TextSchema, TimestampSchema } from './common.js';

export const RefundSchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  payment_id: IdSchema,
  amount_paise: PaiseSchema.positive(),
  reason: TextSchema,
  actor: ActorSchema,
  idempotency_key: TextSchema.nullable(),
  created_at: TimestampSchema,
});
export type Refund = z.infer<typeof RefundSchema>;
