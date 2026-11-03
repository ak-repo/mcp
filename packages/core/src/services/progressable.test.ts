import { afterEach, expect, it } from 'vitest';
import { fixture, type Fixture } from './test-helpers.js';
let f: Fixture;
afterEach(() => f?.close());
it('returns oldest untouched progressable orders per status with stable ties and excludes failed payments', () => {
  f = fixture();
  f.addOrder({ id: 'OLD', placedAt: '2026-10-01T00:00:00.000Z' });
  f.addOrder({ id: 'NEW', placedAt: '2026-11-01T00:00:00.000Z' });
  f.addOrder({ id: 'FAILED', placedAt: '2026-09-01T00:00:00.000Z', paymentStatus: 'failed' });
  expect(
    f.services.order.listProgressable({ statuses: ['placed'], limitPerStatus: 1 }).map((o) => o.id),
  ).toEqual(['OLD']);
  f.services.order.advanceStatus({
    orderId: 'OLD',
    toStatus: 'accepted',
    actor: 'system',
    reason: 'test',
  });
  expect(
    f.services.order.listProgressable({ statuses: ['placed'], limitPerStatus: 1 }).map((o) => o.id),
  ).toEqual(['NEW']);
  expect(f.services.order.countActive()).toBe(3);
  expect(() => f.services.order.listProgressable({ statuses: ['delivered'] })).toThrow();
});
it('frees a delivered partner transactionally for another ready order', () => {
  f = fixture();
  const id = f.addOrder({
    status: 'out_for_delivery',
    delivery: 'out_for_delivery',
    partnerId: 'DP-1',
  });
  const result = f.services.order.advanceStatus({
    orderId: id,
    toStatus: 'delivered',
    actor: 'system',
    reason: 'Delivered',
  });
  expect(result.partner?.status).toBe('available');
  expect(result.delivery?.status).toBe('delivered');
  const ready = f.addOrder({ status: 'ready', delivery: 'pending', partnerId: null });
  expect(
    f.services.delivery.executeReassign({
      orderId: ready,
      partnerId: 'DP-1',
      actor: 'system',
      reason: 'Assign released partner',
    }).partner.status,
  ).toBe('busy');
});
