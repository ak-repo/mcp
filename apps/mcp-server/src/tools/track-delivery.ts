import { defineTool } from '../lib/define-tool.js';
import { z } from 'zod';
import { IdSchema, DeliveryTrackingSchema } from '@foodops/shared';

export const tool = defineTool({
  name: 'track_delivery',
  description:
    'Track delivery for an order ID. Use to investigate assignments, progress, or lateness. Returns order and delivery statuses, assigned partner or null, ETA, timestamps, and is_late.',
  inputSchema: z.strictObject({ order_id: IdSchema }),
  dataSchema: DeliveryTrackingSchema,
  hint: 'Use list_orders with narrow filters to inspect the order summary instead.',
  execute: (input, services) => services.delivery.trackDelivery(input.order_id),
  summarize: (data) =>
    `Delivery for ${data.order_id}: ${data.delivery?.status ?? 'not created'}; late: ${data.is_late}.`,
});
