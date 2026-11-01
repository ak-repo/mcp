import { z } from 'zod';
import {
  ActorSchema,
  DateBoundarySchema,
  IdSchema,
  PaiseSchema,
  TextSchema,
  TimestampSchema,
  validateDateRange,
} from './common.js';
import { PaginationSchema } from './pagination.js';

export const OrderStatusSchema = z.enum([
  'placed',
  'accepted',
  'preparing',
  'ready',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.strictObject({
  id: IdSchema,
  customer_id: IdSchema,
  restaurant_id: IdSchema,
  address_id: IdSchema,
  status: OrderStatusSchema,
  subtotal_paise: PaiseSchema,
  tax_paise: PaiseSchema,
  delivery_fee_paise: PaiseSchema,
  platform_fee_paise: PaiseSchema,
  discount_paise: PaiseSchema,
  total_paise: PaiseSchema,
  notes: z.string().nullable(),
  cancel_reason: TextSchema.nullable(),
  placed_at: TimestampSchema,
  updated_at: TimestampSchema,
});
export type Order = z.infer<typeof OrderSchema>;

export const OrderItemSchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  menu_item_id: IdSchema,
  name_snapshot: TextSchema,
  unit_price_paise: PaiseSchema,
  qty: z.number().int().positive(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderEventSchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  from_status: OrderStatusSchema.nullable(),
  to_status: OrderStatusSchema,
  actor: ActorSchema,
  reason: TextSchema,
  at: TimestampSchema,
});
export type OrderEvent = z.infer<typeof OrderEventSchema>;

export const OrderListFiltersSchema = PaginationSchema.extend({
  status: OrderStatusSchema.optional(),
  customer_id: IdSchema.optional(),
  restaurant_id: IdSchema.optional(),
  from: DateBoundarySchema.optional(),
  to: DateBoundarySchema.optional(),
}).superRefine(validateDateRange);
export type OrderListFilters = z.infer<typeof OrderListFiltersSchema>;
