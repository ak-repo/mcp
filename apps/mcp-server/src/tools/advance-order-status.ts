import { TextSchema, OrderStatusSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  AdvancePreviewSchema,
  OrderMutationSchema,
  writeResultSchema,
  writeAnnotations,
  approvalError,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'advance_order_status',
  description:
    'Advance an order to an allowed status, including cancellation. Use after inspecting the order and obtaining explicit user approval. Without confirm:true returns a read-only preview of status, delivery, invoice, and refund effects; with approval executes atomically. Pass idempotency_key to safely replay the same confirmed request.',
  inputSchema: WriteInputSchema.extend({
    to_status: OrderStatusSchema,
    reason: TextSchema.default('MCP status advancement'),
  }),
  dataSchema: writeResultSchema(AdvancePreviewSchema, OrderMutationSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services) => {
    const request = defined({
      orderId: input.order_id,
      toStatus: input.to_status,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return input.confirm === true
      ? { confirm_required: false, result: services.order.advanceStatus(request) }
      : { confirm_required: true, preview: services.order.previewAdvanceStatus(request) };
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
