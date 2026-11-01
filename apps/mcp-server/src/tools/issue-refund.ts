import { TextSchema, PaiseSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  RefundPreviewSchema,
  RefundResultSchema,
  writeResultSchema,
  writeAnnotations,
  approvalError,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'issue_refund',
  description:
    'Issue a positive refund within the remaining captured balance for a delivered or cancelled order. Use after reviewing the order, policy, and user approval. Without confirm:true returns refund and remaining balance previews; large refunds return CONFIRMATION_REQUIRED with the preview. With confirm:true executes and returns payment/refund records. Use idempotency_key for retries.',
  inputSchema: WriteInputSchema.extend({
    amount_paise: PaiseSchema.positive(),
    reason: TextSchema,
  }),
  dataSchema: writeResultSchema(RefundPreviewSchema, RefundResultSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services) => {
    const request = defined({
      orderId: input.order_id,
      amountPaise: input.amount_paise,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return input.confirm === true
      ? { confirm_required: false, result: services.refund.executeRefund(request) }
      : { confirm_required: true, preview: services.refund.previewRefund(request) };
  },
  resultError: (data) =>
    data.confirm_required && data.preview.requiresConfirmation ? approvalError() : undefined,
  summarize: (data) =>
    data.confirm_required
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
