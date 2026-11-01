import { writeFlow } from '../lib/confirmation.js';
import { TextSchema, PaiseSchema } from '@foodops/shared';
import { defineTool } from '../lib/define-tool.js';
import { defined } from './schemas.js';
import {
  WriteInputSchema,
  RefundPreviewSchema,
  RefundResultSchema,
  writeResultSchema,
  writeAnnotations,
} from './write-schemas.js';

export const tool = defineTool({
  name: 'issue_refund',
  description:
    'Refund a positive amount within the remaining captured balance of a delivered or cancelled order; returns payment and refund records. Use after inspecting current state. Call without a confirmation_token to preview, show the preview to the user, then call again with the returned token only after explicit user approval. Tokens expire after five minutes and bind the exact arguments and preview. Use action:execute to request execution; it requires a token. Pass idempotency_key for safe retries.',
  inputSchema: WriteInputSchema.extend({
    amount_paise: PaiseSchema.positive(),
    reason: TextSchema,
  }),
  dataSchema: writeResultSchema(RefundPreviewSchema, RefundResultSchema),
  annotations: { ...writeAnnotations, destructiveHint: true },
  hint: 'Inspect the order with get_order; retry confirmed writes with the same idempotency_key.',
  execute: (input, services, _signal, confirmation) => {
    const request = defined({
      orderId: input.order_id,
      amountPaise: input.amount_paise,
      reason: input.reason,
      actor: 'ai' as const,
      idempotencyKey: input.idempotency_key,
    });
    return writeFlow({
      tool: 'issue_refund',
      input,
      confirmation,
      preview: () => services.refund.previewRefund(request),
      replay: () => services.refund.replayRefund(request),
      execute: (expectedPreview) => services.refund.executeRefund(request, { expectedPreview }),
    });
  },
  summarize: (data) =>
    data.requires_user_approval
      ? 'Preview only. Explicit user approval is required before execution.'
      : 'Confirmed operation completed.',
});
