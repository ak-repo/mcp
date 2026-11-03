import { z } from 'zod';
import { IdSchema, TextSchema, PaiseSchema, OrderStatusSchema } from '@foodops/shared';
export const IdParamsSchema = z.strictObject({ id: IdSchema });
export const OrderIdParamsSchema = z.strictObject({ orderId: IdSchema });
export const EmptyQuerySchema = z.strictObject({});
export const CancelBodySchema = z.strictObject({ reason: TextSchema });
export const AdvanceBodySchema = CancelBodySchema.extend({ to_status: OrderStatusSchema });
export const RefundBodySchema = CancelBodySchema.extend({ amount_paise: PaiseSchema.positive() });
export const ReassignBodySchema = CancelBodySchema.extend({ partner_id: IdSchema });
const confirmation = { confirmation_token: z.string().max(2048).optional() };
export const confirmedPreview = <S extends z.ZodObject>(schema: S) =>
  schema.extend({ confirmation_token: z.string(), expires_at: z.string().datetime() });
export const CancelExecuteSchema = CancelBodySchema.extend(confirmation);
export const AdvanceExecuteSchema = AdvanceBodySchema.extend(confirmation);
export const RefundExecuteSchema = RefundBodySchema.extend(confirmation);
export const ReassignExecuteSchema = ReassignBodySchema.extend(confirmation);
export const IdempotencyHeaderSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
export function responseSchema(schema: z.ZodType) {
  return { response: { 200: z.toJSONSchema(schema, { target: 'draft-7' }) } };
}
