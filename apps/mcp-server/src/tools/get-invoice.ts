import { defineTool } from '../lib/define-tool.js';
import { z } from 'zod';
import { IdSchema } from '@foodops/shared';
import { InvoiceDetailsSchema } from './schemas.js';

export const tool = defineTool({
  name: 'get_invoice',
  description:
    'Read an immutable invoice by order ID. Use to inspect billing for a delivered order. Returns invoice number, original line items, paise totals, and formatted INR; returns NOT_FOUND when no invoice has been issued.',
  inputSchema: z.strictObject({ order_id: IdSchema }),
  dataSchema: InvoiceDetailsSchema,
  hint: 'Use list_orders with narrow filters to inspect the order summary instead.',
  execute: (input, services) => services.invoice.getInvoice(input.order_id),
  summarize: (data) => `Invoice ${data.invoice.invoice_no}: ${data.invoice.total_display}.`,
});
