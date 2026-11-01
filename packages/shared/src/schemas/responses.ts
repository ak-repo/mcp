import { z } from 'zod';
import { OrderSchema, OrderItemSchema, OrderEventSchema, OrderStatusSchema } from './order.js';
import { MenuItemSchema } from './menu.js';
import { InvoiceSchema } from './invoice.js';
import { PaymentSchema, PaymentStatusSchema } from './payment.js';
import { CustomerSchema, AddressSchema } from './customer.js';
import {
  DeliverySchema,
  DeliveryStatusSchema,
  PartnerStatusSchema,
  DeliveryPartnerSchema,
  DeliveryTrackingSchema,
} from './delivery.js';
import { IdSchema, TextSchema, PaiseSchema } from './common.js';
import { RefundSchema } from './refund.js';
import { RestaurantSchema } from './restaurant.js';
import { ToolCallLogSchema } from './audit.js';
import { SalesSummarySchema } from './metrics.js';
import { CursorSchema } from './pagination.js';

const display = z.string().min(1);
export const PresentedOrderSchema = OrderSchema.extend({
  subtotal_display: display,
  tax_display: display,
  delivery_fee_display: display,
  platform_fee_display: display,
  discount_display: display,
  total_display: display,
});
export const PresentedItemSchema = OrderItemSchema.extend({ unit_price_display: display });
export const PresentedMenuItemSchema = MenuItemSchema.extend({ price_display: display });
export const PresentedInvoiceSchema = InvoiceSchema.extend({
  subtotal_display: display,
  tax_display: display,
  fees_display: display,
  discount_display: display,
  total_display: display,
});
export const PresentedPaymentSchema = PaymentSchema.extend({ amount_display: display });
export const OrderDetailsSchema = z.strictObject({
  order: PresentedOrderSchema,
  items: z.array(PresentedItemSchema),
  customer: CustomerSchema,
  address: AddressSchema,
  payment: PresentedPaymentSchema.nullable(),
  delivery: DeliverySchema.nullable(),
  timeline: z.array(OrderEventSchema),
});
export const InvoiceDetailsSchema = z.strictObject({
  invoice: PresentedInvoiceSchema,
  items: z.array(PresentedItemSchema),
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

export function createRestPageSchema<S extends z.ZodType>(item: S) {
  return z.strictObject({ data: z.array(item), next_cursor: CursorSchema.nullable() });
}
export const RestaurantPageSchema = createRestPageSchema(RestaurantSchema);
export const MenuPageSchema = createRestPageSchema(PresentedMenuItemSchema);
export const OrderPageSchema = createRestPageSchema(PresentedOrderSchema);
export const DeliveryPageSchema = createRestPageSchema(
  DeliveryTrackingSchema.extend({ delivery: DeliverySchema }),
);
export const PartnerPageSchema = createRestPageSchema(DeliveryPartnerSchema);
export const ToolCallPageSchema = createRestPageSchema(ToolCallLogSchema);
export { SalesSummarySchema };
