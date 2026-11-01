import { defineTool } from '../lib/define-tool.js';
import { PartnerListFiltersSchema, DeliveryPartnerSchema, createPageSchema } from '@foodops/shared';
import { defined } from './schemas.js';

export const tool = defineTool({
  name: 'list_delivery_partners',
  description:
    'List delivery partners, optionally filtering availability status. Use before proposing a delivery reassignment. Returns a cursor page of partner IDs, contact details, vehicles, and current status.',
  inputSchema: PartnerListFiltersSchema,
  dataSchema: createPageSchema(DeliveryPartnerSchema),
  hint: 'Narrow filters or reduce limit, then follow next_cursor.',
  execute: (input, services) =>
    services.delivery.listDeliveryPartners(
      defined({ status: input.status, cursor: input.cursor, limit: input.limit }),
    ),
  summarize: (data) => `Returned ${data.items.length} delivery partners.`,
});
