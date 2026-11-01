import { z } from 'zod';
import { definePrompt } from './define-prompt.js';

export const prompt = definePrompt({
  name: 'daily_ops_report',
  description:
    'Prepare an evidence-based UTC daily operations report without changing business data.',
  inputSchema: z.strictObject({ date: z.iso.date() }),
  instructions: (input) =>
    `Prepare the UTC operations report for ${JSON.stringify(input.date)}. Call get_sales_summary with from and to equal to that date, grouped by day, restaurant, and status. Report order counts, delivered-order GMV and average order value before refunds, cancellation fraction, and average completed delivery time in minutes. Use list_orders for that date, follow pagination, and use get_order and track_delivery to investigate cancellations, failed payments, and late deliveries. Distinguish current lateness from historical delivery timing; state data limitations instead of inventing historical counts. Summarize observed issues and propose actions only; do not execute writes as part of reporting.`,
});
