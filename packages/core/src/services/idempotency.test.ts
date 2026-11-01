import { afterEach, beforeEach, expect, it } from 'vitest';
import { fixture, type Fixture } from './test-helpers.js';
let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());
const meta = { actor: 'ai' as const, reason: 'Approved' };
it('replay reads return stored results before terminal state checks and enforce conflicts', () => {
  const orderId = f.addOrder();
  const input = { ...meta, orderId, idempotencyKey: 'key' };
  expect(f.services.order.replayCancel(input)).toBeUndefined();
  const result = f.services.order.executeCancel(input);
  expect(f.services.order.replayCancel(input)).toEqual(result);
  expect(() => f.services.order.replayCancel({ ...input, reason: 'Changed' })).toThrow(
    /different request/,
  );
});
it('rechecks a cancellation preview while holding the transaction lock and rolls back', () => {
  const orderId = f.addOrder();
  const input = { ...meta, orderId, idempotencyKey: 'key' };
  const expectedPreview = f.services.order.previewCancel(input);
  f.write.prepare("UPDATE payments SET status='pending' WHERE order_id=?").run(orderId);
  expect(() => f.services.order.executeCancel(input, { expectedPreview })).toThrow(
    expect.objectContaining({ details: { precondition: 'preview_changed' } }),
  );
  expect(f.services.order.getOrder(orderId).order.status).toBe('placed');
  expect(f.count('order_events')).toBe(0);
  expect(f.count('idempotency_keys')).toBe(0);
});
it('checks advance, refund and reassignment preconditions and replay', () => {
  const orderId = f.addOrder({ status: 'ready' });
  const reassign = { ...meta, orderId, partnerId: 'DP-2', idempotencyKey: 'reassign' };
  const expectedPreview = f.services.delivery.previewReassign(reassign);
  const result = f.services.delivery.executeReassign(reassign, { expectedPreview });
  expect(f.services.delivery.replayReassign(reassign)).toEqual(result);
  const advance = { ...meta, orderId, toStatus: 'picked_up' as const, idempotencyKey: 'advance' };
  const advanced = f.services.order.advanceStatus(advance, {
    expectedPreview: f.services.order.previewAdvanceStatus(advance),
  });
  expect(f.services.order.replayAdvanceStatus(advance)).toEqual(advanced);
  const delivered = f.addOrder({ status: 'delivered', delivery: 'delivered', partnerId: null });
  const refund = { ...meta, orderId: delivered, amountPaise: 1, idempotencyKey: 'refund' };
  const refunded = f.services.refund.executeRefund(refund, {
    expectedPreview: f.services.refund.previewRefund(refund),
  });
  expect(f.services.refund.replayRefund(refund)).toEqual(refunded);
});
