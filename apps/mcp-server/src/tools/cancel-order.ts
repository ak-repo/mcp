import { TextSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  CancelPreviewSchema,
  OrderMutationSchema,
  writeResultSchema,
  writeAnnotations,
  approvalError,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'cancel_order',
  description:
    "Cancel an order before pickup. Use after reviewing the order and the user's cancellation reason. Without confirm:true returns a preview and any automatic remaining refund; captured payments require explicit approval. With confirm:true executes the cancellation and refund atomically and returns their records. Use idempotency_key for retries.",
  inputSchema: WriteInputSchema.extend({ reason: TextSchema }),
  dataSchema: writeResultSchema(CancelPreviewSchema, OrderMutationSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services) => {
    const request = defined({
      orderId: input.order_id,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return input.confirm === true
      ? { confirm_required: false, result: services.order.executeCancel(request) }
      : { confirm_required: true, preview: services.order.previewCancel(request) };
  },
  resultError: (data) =>
    data.confirm_required &&
    (data.preview.requiresConfirmation || data.preview.requiresPaymentConfirmation)
      ? approvalError()
      : undefined,
  summarize: (data) =>
    data.confirm_required
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
