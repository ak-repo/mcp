import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWritable } from '../db/connection.js';
import { fixture, type Fixture } from './test-helpers.js';
import { type PlaceOrderInput } from '@foodops/shared';
let f: Fixture;
afterEach(() => f?.close());
const input: PlaceOrderInput = {
  customerId: 'C-1',
  restaurantId: 'R-1',
  addressId: 'A-1',
  items: [{ menuItemId: 'M-1', qty: 2 }],
  paymentMethod: 'upi',
  actor: 'system',
  reason: 'Test placement',
  idempotencyKey: 'placement-test',
};
describe('order placement and durable changes', () => {
  it('snapshots prices, initializes all records and replays without new changes', () => {
    f = fixture();
    const before = f.services.audit.maxChangeId();
    const result = f.services.order.placeOrder(input);
    expect(result.order).toMatchObject({
      status: 'placed',
      subtotal_paise: 200,
      tax_paise: 10,
      total_paise: 3710,
    });
    expect(result.payment.status).toBe('paid');
    expect(result.delivery).toMatchObject({ status: 'pending', partner_id: null });
    expect(result.timeline[0]).toMatchObject({
      from_status: null,
      to_status: 'placed',
      actor: 'system',
    });
    f.write.prepare("UPDATE menu_items SET price_paise=999 WHERE id='M-1'").run();
    expect(f.services.order.placeOrder(input)).toEqual(result);
    expect(f.services.audit.listChangesAfter(before).map((x) => x.entity)).toEqual([
      'order',
      'payment',
      'delivery',
    ]);
    expect(() => f.services.order.placeOrder({ ...input, notes: 'different' })).toThrow(
      /Idempotency/,
    );
  });
  it.each([
    { customerId: 'missing' },
    { addressId: 'missing' },
    { restaurantId: 'missing' },
    { restaurantId: 'R-2' },
    { items: [] },
    { items: [{ menuItemId: 'missing', qty: 1 }] },
    { items: [{ menuItemId: 'M-2', qty: 1 }] },
    { items: [{ menuItemId: 'M-1', qty: 0 }] },
    { items: [{ menuItemId: 'M-1', qty: 1.5 }] },
    {
      items: [
        { menuItemId: 'M-1', qty: 1 },
        { menuItemId: 'M-1', qty: 2 },
      ],
    },
    { items: [{ menuItemId: 'M-1', qty: Number.MAX_SAFE_INTEGER }] },
  ])('rejects invalid placement %j atomically', (patch) => {
    f = fixture();
    const before = f.services.audit.maxChangeId();
    expect(() => f.services.order.placeOrder({ ...input, ...patch })).toThrow();
    expect(f.count('orders')).toBe(0);
    expect(f.services.audit.maxChangeId()).toBe(before);
  });
  it('rejects foreign addresses and menu items', () => {
    f = fixture();
    f.write
      .prepare(
        "INSERT INTO customers VALUES ('C-2','Other','123','other@example.com','2026-11-01T12:00:00.000Z')",
      )
      .run();
    expect(() => f.services.order.placeOrder({ ...input, customerId: 'C-2' })).toThrow(
      /Address belongs/,
    );
    f.write.prepare("UPDATE menu_items SET restaurant_id='R-2' WHERE id='M-1'").run();
    expect(() => f.services.order.placeOrder(input)).toThrow(/another restaurant/);
  });
  it('rolls back rows, events, idempotency and changes if delivery insertion fails', () => {
    f = fixture();
    const before = f.services.audit.maxChangeId();
    f.write.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'forced'); END;",
    );
    expect(() => f.services.order.placeOrder(input)).toThrow();
    for (const table of [
      'orders',
      'order_items',
      'order_events',
      'payments',
      'deliveries',
      'idempotency_keys',
    ])
      expect(f.count(table)).toBe(0);
    expect(f.services.audit.maxChangeId()).toBe(before);
  });
  it('captures COD and creates invoice on delivery', () => {
    f = fixture();
    const result = f.services.order.placeOrder({ ...input, paymentMethod: 'cod' });
    expect(result.payment.status).toBe('pending');
    const meta = { orderId: result.order.id, actor: 'system' as const, reason: 'Progress' };
    for (const toStatus of ['accepted', 'preparing', 'ready'] as const)
      f.services.order.advanceStatus({ ...meta, toStatus });
    f.services.delivery.executeReassign({ ...meta, partnerId: 'DP-2' });
    for (const toStatus of ['picked_up', 'out_for_delivery'] as const)
      f.services.order.advanceStatus({ ...meta, toStatus });
    expect(
      f.services.order.previewAdvanceStatus({ ...meta, toStatus: 'delivered' })
        .payment_status_after,
    ).toBe('paid');
    const delivered = f.services.order.advanceStatus({ ...meta, toStatus: 'delivered' });
    expect(delivered.payment?.status).toBe('paid');
    expect(delivered.invoice).not.toBeNull();
    expect(delivered.partner?.status).toBe('available');
  });
  it('sees second-connection changes, every entity, retention and immutable invoice behavior', () => {
    f = fixture();
    const before = f.services.audit.maxChangeId();
    const second = openWritable(f.path);
    try {
      second.prepare("UPDATE delivery_partners SET status='offline' WHERE id='DP-2'").run();
      expect(f.services.audit.listChangesAfter(before)[0]).toMatchObject({
        entity: 'partner',
        order_id: null,
      });
      const result = f.services.order.placeOrder(input);
      const meta = { orderId: result.order.id, actor: 'system' as const, reason: 'Cancel' };
      f.services.order.executeCancel(meta);
      const entities = new Set(f.services.audit.listChangesAfter(before).map((x) => x.entity));
      expect([...entities].sort()).toEqual(['delivery', 'order', 'partner', 'payment', 'refund']);
      const delivered = f.addOrder({ status: 'delivered', delivery: 'delivered' });
      second
        .prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          'INV-test',
          delivered,
          'INV-20261101-0001',
          1000,
          0,
          0,
          0,
          1000,
          '2026-11-01T12:00:00.000Z',
        );
      expect(f.services.audit.listChangesAfter(before).some((x) => x.entity === 'invoice')).toBe(
        true,
      );
      const max = f.services.audit.maxChangeId();
      expect(() => second.prepare('UPDATE invoices SET total_paise=0').run()).toThrow(/immutable/);
      expect(f.services.audit.maxChangeId()).toBe(max);
      expect(f.services.audit.pruneChangesBefore('2099-01-01T00:00:00.000Z')).toBeGreaterThan(0);
      expect(f.services.audit.listChangesAfter(0)).toEqual([]);
      expect(f.services.audit.maxChangeId()).toBe(max);
    } finally {
      second.close();
    }
  });
});

it('captures insert and update operations for every mutable watched table', () => {
  f = fixture();
  const before = f.services.audit.maxChangeId();
  const result = f.services.order.placeOrder(input);
  f.services.order.executeCancel({ orderId: result.order.id, actor: 'ops', reason: 'Test' });
  const second = openWritable(f.path);
  try {
    for (const table of ['orders', 'deliveries', 'payments', 'refunds', 'delivery_partners'])
      second.prepare(`UPDATE ${table} SET id=id`).run();
    const changes = f.services.audit.listChangesAfter(before);
    for (const entity of ['order', 'delivery', 'payment', 'refund'])
      for (const op of ['insert', 'update'])
        expect(changes.some((x) => x.entity === entity && x.op === op)).toBe(true);
    expect(changes.some((x) => x.entity === 'partner' && x.op === 'update')).toBe(true);
    expect(
      f.services.audit
        .listChangesAfter(0)
        .filter((x) => x.entity === 'partner' && x.op === 'insert'),
    ).toHaveLength(2);
    expect(() => f.services.audit.listChangesAfter(-1)).toThrow();
    expect(() => f.services.audit.listChangesAfter(0, 10001)).toThrow();
  } finally {
    second.close();
  }
});

it('preserves timeline insertion order for same-millisecond events', () => {
  f = fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
  try {
    const placed = f.services.order.placeOrder(input);
    const meta = { orderId: placed.order.id, actor: 'system' as const, reason: 'Same clock' };
    f.services.order.advanceStatus({ ...meta, toStatus: 'accepted' });
    f.services.order.advanceStatus({ ...meta, toStatus: 'preparing' });
    expect(f.services.order.getOrder(placed.order.id).timeline.map((x) => x.to_status)).toEqual([
      'placed',
      'accepted',
      'preparing',
    ]);
  } finally {
    vi.useRealTimers();
  }
});
