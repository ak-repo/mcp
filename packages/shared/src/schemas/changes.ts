import { z } from 'zod';
import { IdSchema, TimestampSchema, TextSchema, ActorSchema } from './common.js';
import { PaymentMethodSchema } from './payment.js';
export const ChangeSchema = z.strictObject({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entity: z.enum(['order', 'delivery', 'partner', 'payment', 'refund', 'invoice']),
  entity_id: IdSchema,
  order_id: IdSchema.nullable(),
  op: z.enum(['insert', 'update']),
  at: TimestampSchema,
});
export type Change = z.infer<typeof ChangeSchema>;
export const PlaceOrderInputSchema = z.strictObject({
  customerId: IdSchema,
  restaurantId: IdSchema,
  addressId: IdSchema,
  items: z
    .array(
      z.strictObject({
        menuItemId: IdSchema,
        qty: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(100),
  paymentMethod: PaymentMethodSchema,
  notes: z.string().max(10000).optional(),
  actor: ActorSchema,
  reason: TextSchema,
  idempotencyKey: TextSchema.optional(),
});
export type PlaceOrderInput = z.infer<typeof PlaceOrderInputSchema>;
export const ToolCallFeedSchema = z.strictObject({
  rowid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tool: TextSchema,
  status: z.enum(['success', 'error']),
  error_code: z
    .enum([
      'NOT_FOUND',
      'VALIDATION',
      'INVALID_TRANSITION',
      'LIMIT_EXCEEDED',
      'CONFIRMATION_REQUIRED',
      'CONFLICT',
      'INTERNAL',
    ])
    .nullable(),
  latency_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: TimestampSchema,
});
