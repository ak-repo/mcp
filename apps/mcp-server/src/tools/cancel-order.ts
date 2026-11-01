import { writeFlow } from '../lib/confirmation.js';
import { TextSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  CancelPreviewSchema,
  OrderMutationSchema,
  writeResultSchema,
  writeAnnotations,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'cancel_order',
  description:
    'Cancel an order before pickup and refund the remaining captured payment atomically; returns order, delivery, partner, event and payment/refund records. Use after inspecting current state. Call without a confirmation_token to preview, show the preview to the user, then call again with the returned token only after explicit user approval. Tokens expire after five minutes and bind the exact arguments and preview. Use action:execute to request execution; it requires a token. Pass idempotency_key for safe retries.',
  inputSchema: WriteInputSchema.extend({ reason: TextSchema }),
  dataSchema: writeResultSchema(CancelPreviewSchema, OrderMutationSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services, _signal, confirmation) => {
    const request = defined({
      orderId: input.order_id,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return writeFlow({
      tool: 'cancel_order',
      input,
      confirmation,
      preview: () => services.order.previewCancel(request),
      replay: () => services.order.replayCancel(request),
      execute: (expectedPreview) => services.order.executeCancel(request, { expectedPreview }),
    });
  },
  summarize: (data) =>
    data.requires_user_approval
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
