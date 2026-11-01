import { TextSchema, IdSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  ReassignPreviewSchema,
  ReassignResultSchema,
  writeResultSchema,
  writeAnnotations,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'reassign_delivery',
  description:
    'Reassign a delivery before pickup to an available partner. Use after listing available partners and obtaining user approval. Without confirm:true returns the proposed assignment and partner status changes; with confirm:true assigns the target and frees the previous partner. Returns the delivery and affected partners; supports idempotency_key replay.',
  inputSchema: WriteInputSchema.extend({ partner_id: IdSchema, reason: TextSchema }),
  dataSchema: writeResultSchema(ReassignPreviewSchema, ReassignResultSchema),
  annotations: { ...writeAnnotations, destructiveHint: false },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services) => {
    const request = defined({
      orderId: input.order_id,
      partnerId: input.partner_id,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return input.confirm === true
      ? { confirm_required: false, result: services.delivery.executeReassign(request) }
      : { confirm_required: true, preview: services.delivery.previewReassign(request) };
  },
  summarize: (data) =>
    data.confirm_required
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
