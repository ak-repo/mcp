import {
  CANCELLATION_ALLOWED_STATUSES,
  REFUND_ALLOWED_STATUSES,
  CAPTURED_PAYMENT_STATUSES,
  REASSIGNMENT_PARTNER_STATUS,
  LARGE_REFUND_PAISE,
} from '@foodops/core';
import { formatINR } from '@foodops/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function policyText(): string {
  return [
    'FoodOps cancellation and refund policies',
    `Cancellation is allowed only in these statuses: ${CANCELLATION_ALLOWED_STATUSES.join(', ')}.`,
    `Captured payment statuses: ${CAPTURED_PAYMENT_STATUSES.join(', ')}. Cancellation refunds the remaining captured balance in the same transaction.`,
    'Cancellation cancels a nonterminal delivery and releases its busy partner only when no other active delivery uses that partner; inventory is unchanged.',
    `Standalone refunds are allowed only for: ${REFUND_ALLOWED_STATUSES.join(', ')}.`,
    'A refund must be greater than zero and no greater than captured payment minus prior refunds. Refunds do not alter issued invoices.',
    `Refunds above ${LARGE_REFUND_PAISE} paise (${formatINR(LARGE_REFUND_PAISE)}) require explicit user confirmation.`,
    'Cancellation involving a captured payment also requires explicit user confirmation.',
    `Delivery reassignment is allowed in cancellation-eligible statuses only, to a partner whose status is ${REASSIGNMENT_PARTNER_STATUS}; the previous partner becomes ${REASSIGNMENT_PARTNER_STATUS}.`,
    'All write tools return successful previews without a confirmation_token and change no business records. Show the preview to the user and obtain explicit approval before executing with its token.',
    'Paid cancellation and large-refund previews are successful. CONFIRMATION_REQUIRED applies only to execution with a missing, invalid, expired, or stale token.',
    'Tokens expire after five minutes and bind the exact request and preview. Execution checks that preview transactionally. The host must enforce human approval; possession of a token does not prove approval. Use an idempotency_key for safe replay.',
    'Every tool call, including a preview, writes an audit record.',
  ].join('\n');
}
export function registerPolicyResource(server: McpServer): void {
  server.registerResource(
    'cancellation_refund_policy',
    'food://policies/cancellation-refund',
    {
      description:
        'Cancellation, refund, reassignment, and approval policies derived from core policy constants.',
      mimeType: 'text/plain',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: policyText() }] }),
  );
}
