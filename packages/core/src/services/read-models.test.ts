import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, AppError } from '@foodops/shared';
import { fixture, type Fixture, PLACED_AT } from './test-helpers.js';
let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
  vi.useRealTimers();
});
describe('extended read services', () => {
  it('searches order IDs, customer and restaurant names, and literal notes before pagination', () => {
    f.addOrder({ id: 'O-z' });
    f.addOrder({ id: 'O-y' });
    f.addOrder({ id: 'O-x' });
    f.write.prepare('UPDATE orders SET notes = ? WHERE id = ?').run('100%_operator note', 'O-x');
    expect(f.services.order.listOrders({ query: 'o-X' }).items.map((row) => row.id)).toEqual([
      'O-x',
    ]);
    expect(f.services.order.listOrders({ query: '%_' }).items.map((row) => row.id)).toEqual([
      'O-x',
    ]);
    expect(f.services.order.listOrders({ query: "' OR 1=1 --" }).items).toHaveLength(0);
    for (const query of ['customer', 'CAFE 1']) {
      const first = f.services.order.listOrders({ query, limit: 2 });
      expect(first.items.map((row) => row.id)).toEqual(['O-z', 'O-y']);
      expect(first.next_cursor).not.toBeNull();
      const next = f.services.order.listOrders({ query, cursor: first.next_cursor!, limit: 2 });
      expect(next.items.map((row) => row.id)).toEqual(['O-x']);
      expect(next.next_cursor).toBeNull();
    }
  });
  it('returns active delivery DTOs in order keyset order, with null partner/ETA and the tracking lateness rule', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T14:00:00.000Z'));
    f.addOrder({ id: 'O-z', status: 'ready', delivery: 'assigned', partnerId: 'DP-1' });
    f.addOrder({ id: 'O-y', status: 'accepted', delivery: 'pending', partnerId: null });
    f.addOrder({ id: 'O-x', status: 'delivered', delivery: 'delivered' });
    f.addOrder({ id: 'O-w', status: 'cancelled', delivery: 'pending' });
    f.addOrder({ id: 'O-v', status: 'accepted', delivery: 'cancelled' });
    const first = f.services.delivery.listDeliveries({ limit: 1 });
    expect(first.items.map((row) => row.order_id)).toEqual(['O-z']);
    expect(first.items[0]).toEqual(f.services.delivery.trackDelivery('O-z'));
    expect(first.items[0]?.is_late).toBe(true);
    const next = f.services.delivery.listDeliveries({ limit: 1, cursor: first.next_cursor! });
    expect(next.items.map((row) => row.order_id)).toEqual(['O-y']);
    expect(next.items[0]?.partner).toBeNull();
    expect(next.next_cursor).toBeNull();
    expect(f.services.delivery.listDeliveries({ status: 'delivered' }).items).toHaveLength(0);
    expect(
      f.services.delivery
        .listDeliveries({ partnerId: 'DP-1', status: 'assigned' })
        .items.map((row) => row.order_id),
    ).toEqual(['O-z']);
    expect(f.services.delivery.listDeliveries({ partnerId: 'missing' }).items).toHaveLength(0);
  });
  it('filters audit rows and paginates timestamp ties by ID', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PLACED_AT));
    for (const [tool, status] of [
      ['get_order', 'success'],
      ['cancel_order', 'error'],
      ['get_order', 'success'],
    ] as const)
      f.services.audit.recordCall({ tool, status, actor: 'ai', argsJson: '{}', latencyMs: 1 });
    const first = f.services.audit.listCalls({ tool: 'get_order', status: 'success', limit: 1 });
    const next = f.services.audit.listCalls({
      tool: 'get_order',
      status: 'success',
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(first.items).toHaveLength(1);
    expect(next.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id);
    expect(next.next_cursor).toBeNull();
    expect(f.services.audit.listCalls({ tool: 'get' }).items).toHaveLength(0);
    expect(f.services.audit.listCalls({ status: 'error' }).items).toHaveLength(1);
  });
  it('maps invalid filters to AppError VALIDATION', () => {
    for (const read of [
      () => f.services.order.listOrders({ query: ' ' }),
      () => f.services.delivery.listDeliveries({ limit: 51 }),
      () => f.services.audit.listCalls({ cursor: 'invalid' }),
    ]) {
      try {
        read();
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ErrorCode.VALIDATION);
      }
    }
  });
});
