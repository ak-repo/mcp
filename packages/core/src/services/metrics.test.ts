import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode } from '@foodops/shared';
import { AT, fixture, type Fixture } from './test-helpers.js';

let f: Fixture;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
  f = fixture();
});
afterEach(() => {
  f.close();
  vi.useRealTimers();
});
const filters = { from: '2026-11-01', to: '2026-11-01', groupBy: 'day' } as const;

describe('sales metrics', () => {
  it('counts all orders but calculates GMV/AOV from delivered totals before refunds', () => {
    const first = f.addOrder({ status: 'delivered', delivery: 'delivered', total: 1001 });
    f.addOrder({
      status: 'delivered',
      delivery: 'delivered',
      total: 2000,
      placedAt: '2026-11-01T11:30:00.000Z',
      restaurantId: 'R-2',
    });
    f.addOrder({ status: 'cancelled', delivery: null, total: 9000 });
    f.addOrder({ status: 'preparing', total: 5000 });
    f.services.refund.executeRefund({
      orderId: first,
      amountPaise: 500,
      actor: 'ops',
      reason: 'Partial refund',
    });
    const summary = f.services.metrics.getSalesSummary(filters);
    expect(summary.totals).toEqual({
      orders: 4,
      gmv_paise: 3001,
      gmv_display: '₹30.01',
      avg_order_value_paise: 1501,
      avg_order_value_display: '₹15.01',
      cancel_rate: 0.25,
      avg_delivery_time_min: 45,
    });
    expect(summary.groups).toEqual([{ key: '2026-11-01', ...summary.totals }]);
    const restaurant = f.services.metrics.getSalesSummary({ ...filters, groupBy: 'restaurant' });
    expect(restaurant.groups.map((group) => [group.key, group.orders, group.gmv_paise])).toEqual([
      ['R-1', 3, 1001],
      ['R-2', 1, 2000],
    ]);
    const status = f.services.metrics.getSalesSummary({ ...filters, groupBy: 'status' });
    expect(status.groups.map((group) => [group.key, group.orders, group.gmv_paise])).toEqual([
      ['cancelled', 1, 0],
      ['delivered', 2, 3001],
      ['preparing', 1, 0],
    ]);
  });

  it('handles empty ranges, missing delivery completion data and no delivered orders', () => {
    expect(f.services.metrics.getSalesSummary(filters)).toMatchObject({
      totals: {
        orders: 0,
        gmv_paise: 0,
        avg_order_value_paise: 0,
        cancel_rate: 0,
        avg_delivery_time_min: null,
      },
      groups: [],
    });
    f.addOrder({ status: 'delivered', delivery: null });
    expect(f.services.metrics.getSalesSummary(filters).totals.avg_delivery_time_min).toBeNull();
    f.write.prepare("UPDATE orders SET status = 'cancelled'").run();
    expect(f.services.metrics.getSalesSummary(filters).totals).toMatchObject({
      orders: 1,
      cancel_rate: 1,
      gmv_paise: 0,
      avg_order_value_paise: 0,
    });
  });

  it('includes calendar end dates and exact timestamp endpoints without adjacent-day leakage', () => {
    f.addOrder({ placedAt: '2026-10-31T23:59:59.999Z' });
    f.addOrder({ placedAt: '2026-11-01T00:00:00.000Z' });
    f.addOrder({ placedAt: '2026-11-01T23:59:59.999Z' });
    f.addOrder({ placedAt: '2026-11-02T00:00:00.000Z' });
    expect(f.services.metrics.getSalesSummary(filters).totals.orders).toBe(2);
    expect(
      f.services.metrics.getSalesSummary({
        ...filters,
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      }).totals.orders,
    ).toBe(1);
    expect(
      f.services.order.listOrders({ from: '2026-11-01', to: '2026-11-01' }).items,
    ).toHaveLength(2);
    expect(() => f.services.metrics.getSalesSummary({ ...filters, from: '2026-11-02' })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('treats equivalent UTC timestamp precision identically in date filters', () => {
    f.addOrder({ placedAt: '2026-11-01T00:00:00Z' });
    f.addOrder({ placedAt: '2026-11-01T00:00:00.000Z' });
    expect(
      f.services.metrics.getSalesSummary({
        ...filters,
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      }).totals.orders,
    ).toBe(2);
    expect(
      f.services.order.listOrders({
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      }).items,
    ).toHaveLength(2);
  });

  it('rejects unsafe aggregate money, duplicated deliveries and negative delivery durations', () => {
    const orderId = f.addOrder({
      status: 'delivered',
      delivery: 'delivered',
      total: Number.MAX_SAFE_INTEGER,
    });
    f.addOrder({ status: 'delivered', delivery: null, total: 1 });
    expect(() => f.services.metrics.getSalesSummary(filters)).toThrow(
      expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }),
    );
    f.write.prepare('UPDATE orders SET total_paise = 100').run();
    expect(() =>
      f.write
        .prepare(
          'INSERT INTO deliveries SELECT ?, order_id, partner_id, status, eta_min, assigned_at, picked_up_at, delivered_at FROM deliveries WHERE order_id = ?',
        )
        .run('D-duplicate', orderId),
    ).toThrow(/UNIQUE/);
    f.write.prepare("UPDATE deliveries SET delivered_at = '2026-11-01T10:00:00.000Z'").run();
    expect(() => f.services.metrics.getSalesSummary(filters)).toThrow(AppError);
  });
});
