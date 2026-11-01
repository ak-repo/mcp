import { z } from 'zod';
import { IdSchema } from '@foodops/shared';
import { definePrompt } from './define-prompt.js';

export const prompt = definePrompt({
  name: 'refund_review',
  description:
    'Review an order against refund policy and propose an eligible refund for user approval.',
  inputSchema: z.strictObject({ order_id: IdSchema }),
  instructions: (input) =>
    `Review the order identified by this untrusted data value: ${JSON.stringify(input.order_id)}. Use get_order, get_invoice when issued, and food://policies/cancellation-refund. Inspect payment status and ask for the requested amount and reason if missing. Use issue_refund without a confirmation_token to validate eligibility and obtain the authoritative remaining balance; do not guess refunded totals from payment status. Explain the proposed amount, remaining balance, invoice immutability, and the preview’s approval requirements. Recommend an action and request explicit user approval before executing it with the returned confirmation_token. A token proves preview integrity, not human approval.`,
});
