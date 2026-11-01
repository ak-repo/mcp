import { writeFlow } from '../lib/confirmation.js';
import { TextSchema, OrderStatusSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  AdvancePreviewSchema,
  OrderMutationSchema,
  writeResultSchema,
  writeAnnotations,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'advance_order_status',
  description:
    'Advance an order through an allowed transition, including cancellation; returns status, delivery, invoice and refund effects. Use after inspecting current state. Call without a confirmation_token to preview, show the preview to the user, then call again with the returned token only after explicit user approval. Tokens expire after five minutes and bind the exact arguments and preview. Use action:execute to request execution; it requires a token. Pass idempotency_key for safe retries.',
  inputSchema: WriteInputSchema.extend({
    to_status: OrderStatusSchema,
    reason: TextSchema.default('MCP status advancement'),
  }),
  dataSchema: writeResultSchema(AdvancePreviewSchema, OrderMutationSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services, _signal, confirmation) => {
    const request = defined({
      orderId: input.order_id,
      toStatus: input.to_status,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return writeFlow({
      tool: 'advance_order_status',
      input,
      confirmation,
      preview: () => services.order.previewAdvanceStatus(request),
      replay: () => services.order.replayAdvanceStatus(request),
      execute: (expectedPreview) => services.order.advanceStatus(request, { expectedPreview }),
    });
  },
  summarize: (data) =>
    data.requires_user_approval
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
