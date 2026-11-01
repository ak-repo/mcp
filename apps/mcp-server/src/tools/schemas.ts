import { z } from 'zod';
import {
  OrderSchema,
  OrderItemSchema,
  MenuItemSchema,
  InvoiceSchema,
  PaymentSchema,
  CustomerSchema,
  AddressSchema,
  DeliverySchema,
  OrderEventSchema,
} from '@foodops/shared';

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

/** Omit absent options while retaining required service inputs. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Defined<T>;
}
