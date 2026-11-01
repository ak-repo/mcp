import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CANCELLATION_ALLOWED_STATUSES,
  REFUND_ALLOWED_STATUSES,
  CAPTURED_PAYMENT_STATUSES,
  REASSIGNMENT_PARTNER_STATUS,
  LARGE_REFUND_PAISE,
  ORDER_TRANSITIONS,
} from '@foodops/core';
import { formatINR } from '@foodops/shared';
import { fixture, type Fixture } from '../tools/test-helpers.js';
import { policyText } from './policies.js';
import { dataDictionary } from './schema.js';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});
function text(value: unknown): string {
  return z.object({ contents: z.array(z.object({ text: z.string() })).min(1) }).parse(value)
    .contents[0]!.text;
}
it('lists two static resources and the invoice URI template', async () => {
  expect((await f.client.listResources()).resources.map((resource) => resource.uri).sort()).toEqual(
    ['food://policies/cancellation-refund', 'food://schema'],
  );
  const templates = (await f.client.listResourceTemplates()).resourceTemplates;
  expect(templates).toHaveLength(1);
  expect(templates[0]).toMatchObject({
    uriTemplate: 'food://orders/{order_id}/invoice',
    mimeType: 'text/plain',
  });
});
it('reads the data dictionary generated from shared schemas and core transitions', async () => {
  const before = f.businessHash();
  const dictionary = JSON.parse(text(await f.client.readResource({ uri: 'food://schema' })));
  expect(dictionary).toEqual(dataDictionary());
  expect(Object.keys(dictionary.entities)).toHaveLength(14);
  expect(dictionary.entities.orders).toMatchObject({
    type: 'object',
    additionalProperties: false,
    properties: { total_paise: { type: 'integer', minimum: 0 } },
  });
  expect(dictionary.order_transitions).toEqual(ORDER_TRANSITIONS);
  expect(dictionary.money.output).toContain('*_display');
  expect(f.businessHash()).toBe(before);
});
it('generates cancellation/refund policy text from canonical core constants', async () => {
  const value = text(await f.client.readResource({ uri: 'food://policies/cancellation-refund' }));
  expect(value).toBe(policyText());
  for (const status of [
    ...CANCELLATION_ALLOWED_STATUSES,
    ...REFUND_ALLOWED_STATUSES,
    ...CAPTURED_PAYMENT_STATUSES,
  ])
    expect(value).toContain(status);
  expect(value).toContain(REASSIGNMENT_PARTNER_STATUS);
  expect(value).toContain(`${LARGE_REFUND_PAISE} paise (${formatINR(LARGE_REFUND_PAISE)})`);
  expect(value).toContain('prior refunds');
  expect(value).toContain('CONFIRMATION_REQUIRED');
});
it('prints original invoice line items and totals and remains identical after a refund', async () => {
  const id = 'O-EDGE-PARTIAL-REFUND';
  const details = f.services.invoice.getInvoice(id);
  const uri = `food://orders/${id}/invoice`;
  const before = f.businessHash();
  const first = text(await f.client.readResource({ uri }));
  expect(first).toContain(details.invoice.invoice_no);
  expect(first).toContain(
    `Total: ${details.invoice.total_display} (${details.invoice.total_paise} paise)`,
  );
  for (const item of details.items) {
    expect(first).toContain(JSON.stringify(item.name_snapshot));
    expect(first).toContain(`quantity ${item.qty} @ ${item.unit_price_display}`);
  }
  expect(f.businessHash()).toBe(before);
  expect(
    (
      await f.call('issue_refund', {
        order_id: id,
        amount_paise: 1,
        reason: 'Approved adjustment',
        confirm: true,
        idempotency_key: 'invoice-unchanged',
      })
    ).isError,
  ).not.toBe(true);
  expect(text(await f.client.readResource({ uri }))).toBe(first);
});
it.each(['missing', 'O-EDGE-UNASSIGNED'])(
  'reports missing invoices for %s without leaking internals',
  async (id) => {
    await expect(f.client.readResource({ uri: `food://orders/${id}/invoice` })).rejects.toThrow(
      /NOT_FOUND:.*Hint:/,
    );
  },
);
it('sanitizes unexpected invoice service errors', async () => {
  vi.spyOn(f.services.invoice, 'getInvoice').mockImplementation(() => {
    throw new Error('SECRET_SQL_STACK');
  });
  await expect(
    f.client.readResource({ uri: 'food://orders/O-EDGE-PARTIAL-REFUND/invoice' }),
  ).rejects.toThrow(/INTERNAL:/);
  await expect(
    f.client.readResource({ uri: 'food://orders/O-EDGE-PARTIAL-REFUND/invoice' }),
  ).rejects.not.toThrow(/SECRET_SQL_STACK/);
});
