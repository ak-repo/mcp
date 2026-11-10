import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ErrorCode, type OrderStatus, type DeliveryStatus } from '@foodops/shared';
import { fixture, type Fixture } from './test-helpers.js';

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());
function hash(): string {
  const tables = f.write
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return createHash('sha256')
    .update(
      JSON.stringify(
        tables.map(({ name }) => f.write.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()),
      ),
    )
    .digest('hex');
}
const options = { actor: 'ai' as const, reason: 'Reviewed operation' };
it.each([
  ['placed', 'accepted', 'assigned'],
  ['accepted', 'preparing', 'assigned'],
  ['preparing', 'ready', 'assigned'],
  ['ready', 'picked_up', 'assigned'],
  ['picked_up', 'out_for_delivery', 'picked_up'],
  ['out_for_delivery', 'delivered', 'out_for_delivery'],
  ['placed', 'cancelled', 'assigned'],
  ['accepted', 'cancelled', 'assigned'],
  ['preparing', 'cancelled', 'assigned'],
  ['ready', 'cancelled', 'assigned'],
] satisfies [OrderStatus, OrderStatus, DeliveryStatus][])(
  'previews %s -> %s with no writes and matches execution effects',
  (status, toStatus, delivery) => {
    const orderId = f.addOrder({ status, delivery });
    const before = hash();
    const preview = f.services.order.previewAdvanceStatus({ ...options, orderId, toStatus });
    expect(hash()).toBe(before);
    expect(preview).toMatchObject({
      order_id: orderId,
      from_status: status,
      to_status: toStatus,
      invoice_will_be_issued: toStatus === 'delivered',
      refund_amount_paise: toStatus === 'cancelled' ? 1000 : 0,
    });
    const result = f.services.order.advanceStatus({ ...options, orderId, toStatus });
    expect(result.order.status).toBe(preview.to_status);
    expect(result.delivery?.status).toBe(preview.delivery_status_after);
    expect(result.refund?.amount_paise ?? 0).toBe(preview.refund_amount_paise);
    expect(Boolean(result.invoice)).toBe(preview.invoice_will_be_issued);
  },
);
it('rejects illegal transitions and delivery inconsistencies in both preview and execution', () => {
  const orderId = f.addOrder({ status: 'ready', partnerId: null });
  for (const method of [f.services.order.previewAdvanceStatus, f.services.order.advanceStatus]) {
    expect(() => method({ ...options, orderId, toStatus: 'accepted' })).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION }),
    );
    expect(() => method({ ...options, orderId, toStatus: 'picked_up' })).toThrow(
      expect.objectContaining({
        code: ErrorCode.CONFLICT,
        message: 'No delivery partner is assigned',
        hint: 'Reassign an available partner before advancing to picked_up',
      }),
    );
  }
});
it('previews do not reserve invoice numbers and detect exhausted numbering', () => {
  const orderId = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const other = f.addOrder({ status: 'delivered', delivery: 'delivered' });
  f.write
    .prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'I-existing',
      other,
      `INV-${date}-9007199254740991`,
      1000,
      0,
      0,
      0,
      1000,
      new Date().toISOString(),
    );
  const before = hash();
  for (const method of [f.services.order.previewAdvanceStatus, f.services.order.advanceStatus]) {
    expect(() => method({ ...options, orderId, toStatus: 'delivered' })).toThrow(
      expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }),
    );
    expect(hash()).toBe(before);
  }
});
it('execution revalidates partner state after a successful preview', () => {
  const orderId = f.addOrder({ status: 'ready' });
  f.services.order.previewAdvanceStatus({ ...options, orderId, toStatus: 'picked_up' });
  f.write.prepare("UPDATE delivery_partners SET status='available' WHERE id='DP-1'").run();
  expect(() =>
    f.services.order.advanceStatus({ ...options, orderId, toStatus: 'picked_up' }),
  ).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
});
