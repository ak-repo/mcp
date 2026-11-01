import { defineTool } from '../lib/define-tool.js';
import { SalesSummaryFiltersSchema, SalesSummarySchema } from '@foodops/shared';
import { defined } from './schemas.js';

export const tool = defineTool({
  name: 'get_sales_summary',
  description:
    'Summarize operations over a required placement date range, grouped by UTC day, restaurant ID, or order status. Use for daily reports and comparisons. Returns order counts, delivered-order GMV and average value before refunds, cancellation fraction, and average completed delivery time in minutes; money includes paise and INR display.',
  inputSchema: SalesSummaryFiltersSchema,
  dataSchema: SalesSummarySchema,
  hint: 'Narrow the date range.',
  execute: (input, services) =>
    services.metrics.getSalesSummary(
      defined({ from: input.from, to: input.to, groupBy: input.group_by }),
    ),
  summarize: (data) => `Summarized ${data.totals.orders} orders; GMV ${data.totals.gmv_display}.`,
});
