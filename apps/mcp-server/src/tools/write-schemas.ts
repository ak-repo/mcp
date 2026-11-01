import { z } from 'zod';
import {
  AppError,
  ErrorCode,
  IdSchema,
  TextSchema,
  PaiseSchema,
  OrderStatusSchema,
  PaymentStatusSchema,
  DeliveryStatusSchema,
  PartnerStatusSchema,
  OrderEventSchema,
  DeliverySchema,
  DeliveryPartnerSchema,
  RefundSchema,
} from '@foodops/shared';
import { PresentedOrderSchema, PresentedPaymentSchema, PresentedInvoiceSchema } from './schemas.js';

export const WriteInputSchema = z.strictObject({
  order_id: IdSchema,
  confirm: z.boolean().optional(),
  idempotency_key: TextSchema.optional(),
});
const refundMoney = { refund_amount_paise: PaiseSchema, refund_amount_display: TextSchema };
const confirmation = { requiresConfirmation: z.boolean() };
export const CancelPreviewSchema = z.strictObject({
  delivery_status_after: DeliveryStatusSchema.nullable(),
  partner_id: IdSchema.nullable(),
  partner_status_after: PartnerStatusSchema.nullable(),
  order_id: IdSchema,
  from_status: OrderStatusSchema,
  to_status: z.literal('cancelled'),
  cancel_reason: TextSchema,
  payment_id: IdSchema.nullable(),
  payment_status_after: PaymentStatusSchema.nullable(),
  ...refundMoney,
  ...confirmation,
  requiresPaymentConfirmation: z.boolean(),
});
export const AdvancePreviewSchema = z.strictObject({
  order_id: IdSchema,
  from_status: OrderStatusSchema,
  to_status: OrderStatusSchema,
  reason: TextSchema,
  delivery_status_after: DeliveryStatusSchema.nullable(),
  partner_id: IdSchema.nullable(),
  partner_status_after: PartnerStatusSchema.nullable(),
  invoice_will_be_issued: z.boolean(),
  payment_status_after: PaymentStatusSchema.nullable(),
  ...refundMoney,
  ...confirmation,
  requiresPaymentConfirmation: z.boolean(),
});
export const RefundPreviewSchema = z.strictObject({
  order_id: IdSchema,
  payment_id: IdSchema,
  ...refundMoney,
  remaining_before_paise: PaiseSchema,
  remaining_before_display: TextSchema,
  remaining_after_paise: PaiseSchema,
  remaining_after_display: TextSchema,
  payment_status_after: PaymentStatusSchema,
  ...confirmation,
});
export const ReassignPreviewSchema = z.strictObject({
  order_id: IdSchema,
  delivery_id: IdSchema,
  previous_partner_id: IdSchema.nullable(),
  partner_id: IdSchema,
  previous_partner_status_after: z.literal('available').nullable(),
  partner_status_after: z.literal('busy'),
  delivery_status_after: z.literal('assigned'),
  ...refundMoney,
  ...confirmation,
});
export const PresentedRefundSchema = RefundSchema.extend({ amount_display: TextSchema });
export const OrderMutationSchema = z.strictObject({
  partner: DeliveryPartnerSchema.nullable(),
  order: PresentedOrderSchema,
  event: OrderEventSchema,
  payment: PresentedPaymentSchema.nullable(),
  refund: PresentedRefundSchema.nullable(),
  invoice: PresentedInvoiceSchema.nullable(),
  delivery: DeliverySchema.nullable(),
});
export const RefundResultSchema = z.strictObject({
  order_id: IdSchema,
  payment: PresentedPaymentSchema,
  refund: PresentedRefundSchema,
});
export const ReassignResultSchema = z.strictObject({
  order_id: IdSchema,
  delivery: DeliverySchema,
  previous_partner: DeliveryPartnerSchema.nullable(),
  partner: DeliveryPartnerSchema,
});
export function writeResultSchema<P extends z.ZodType, R extends z.ZodType>(preview: P, result: R) {
  return z.discriminatedUnion('confirm_required', [
    z.strictObject({ confirm_required: z.literal(true), preview }),
    z.strictObject({ confirm_required: z.literal(false), result }),
  ]);
}
export function approvalError(): AppError {
  return new AppError(
    ErrorCode.CONFIRMATION_REQUIRED,
    'Explicit user approval is required',
    'Review the preview, obtain user approval, then repeat the request with confirm:true',
  );
}
export const writeAnnotations = { readOnlyHint: false, idempotentHint: true, openWorldHint: false };
