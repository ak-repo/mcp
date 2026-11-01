import { z } from 'zod';
import { IdSchema, TextSchema, TimestampSchema } from './common.js';
import { OrderStatusSchema } from './order.js';
import { PaginationSchema } from './pagination.js';

export const DeliveryStatusSchema = z.enum([
  'pending',
  'assigned',
  'picked_up',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;
export const PartnerStatusSchema = z.enum(['available', 'busy', 'offline']);
export type PartnerStatus = z.infer<typeof PartnerStatusSchema>;

export const DeliveryPartnerSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  phone: TextSchema,
  vehicle: TextSchema,
  status: PartnerStatusSchema,
});
export type DeliveryPartner = z.infer<typeof DeliveryPartnerSchema>;

export const DeliverySchema = z.strictObject({
  id: IdSchema,
  order_id: IdSchema,
  partner_id: IdSchema.nullable(),
  status: DeliveryStatusSchema,
  eta_min: z.number().int().nonnegative().nullable(),
  assigned_at: TimestampSchema.nullable(),
  picked_up_at: TimestampSchema.nullable(),
  delivered_at: TimestampSchema.nullable(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const PartnerListFiltersSchema = PaginationSchema.extend({
  status: PartnerStatusSchema.optional(),
});
export type PartnerListFilters = z.infer<typeof PartnerListFiltersSchema>;
export const DeliveryListFiltersSchema = PaginationSchema.extend({
  status: DeliveryStatusSchema.optional(),
  partner_id: IdSchema.optional(),
});
export type DeliveryListFilters = z.infer<typeof DeliveryListFiltersSchema>;

export const DeliveryTrackingSchema = z.strictObject({
  order_id: IdSchema,
  order_status: OrderStatusSchema,
  delivery: DeliverySchema.nullable(),
  partner: DeliveryPartnerSchema.nullable(),
  is_late: z.boolean(),
});
export type DeliveryTracking = z.infer<typeof DeliveryTrackingSchema>;
