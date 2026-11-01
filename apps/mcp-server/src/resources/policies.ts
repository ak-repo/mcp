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
    'Cancellation restores no inventory, delivery state, or partner availability.',
    `Standalone refunds are allowed only for: ${REFUND_ALLOWED_STATUSES.join(', ')}.`,
    'A refund must be greater than zero and no greater than captured payment minus prior refunds. Refunds do not alter issued invoices.',
    `Refunds above ${LARGE_REFUND_PAISE} paise (${formatINR(LARGE_REFUND_PAISE)}) require explicit user confirmation.`,
    'Cancellation involving a captured payment also requires explicit user confirmation.',
    `Delivery reassignment is allowed in cancellation-eligible statuses only, to a partner whose status is ${REASSIGNMENT_PARTNER_STATUS}; the previous partner becomes ${REASSIGNMENT_PARTNER_STATUS}.`,
    'All write tools require explicit user approval before confirm:true. Without it, they return previews and change no business records.',
    'An unconfirmed large refund or captured-payment cancellation returns CONFIRMATION_REQUIRED together with its preview.',
    'Previews are advisory snapshots; execution revalidates current state transactionally. Use an idempotency_key to replay a confirmed operation safely.',
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
