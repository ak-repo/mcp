import { writeFlow } from '../lib/confirmation.js';
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
    'Reassign a delivery before pickup to an available partner; returns assignment and affected partner states. Use after inspecting current state. Call without a confirmation_token to preview, show the preview to the user, then call again with the returned token only after explicit user approval. Tokens expire after five minutes and bind the exact arguments and preview. Use action:execute to request execution; it requires a token. Pass idempotency_key for safe retries.',
  inputSchema: WriteInputSchema.extend({ partner_id: IdSchema, reason: TextSchema }),
  dataSchema: writeResultSchema(ReassignPreviewSchema, ReassignResultSchema),
  annotations: { ...writeAnnotations, destructiveHint: false },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services, _signal, confirmation) => {
    const request = defined({
      orderId: input.order_id,
      partnerId: input.partner_id,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return writeFlow({
      tool: 'reassign_delivery',
      input,
      confirmation,
      preview: () => services.delivery.previewReassign(request),
      replay: () => services.delivery.replayReassign(request),
      execute: (expectedPreview) => services.delivery.executeReassign(request, { expectedPreview }),
    });
  },
  summarize: (data) =>
    data.requires_user_approval
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
