import { defineTool } from '../lib/define-tool.js';
import { OrderListFiltersSchema, createPageSchema } from '@foodops/shared';
import { PresentedOrderSchema } from './schemas.js';
import { defined } from './schemas.js';

export const tool = defineTool({
  name: 'list_orders',
  description:
    'List orders by status, customer, restaurant, or placement date range. Use to find orders for operational review. Returns newest-first order summaries and next_cursor; use that cursor to continue without offsets.',
  inputSchema: OrderListFiltersSchema,
  dataSchema: createPageSchema(PresentedOrderSchema),
  hint: 'Narrow filters or reduce limit, then follow next_cursor.',
  execute: (input, services) =>
    services.order.listOrders(
      defined({
        status: input.status,
        customerId: input.customer_id,
        restaurantId: input.restaurant_id,
        from: input.from,
        to: input.to,
        cursor: input.cursor,
        limit: input.limit,
      }),
    ),
  summarize: (data) => `Returned ${data.items.length} orders.`,
});
