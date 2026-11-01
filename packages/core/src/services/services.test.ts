import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode, OrderStatusSchema } from '@foodops/shared';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createServices } from './index.js';
import { AT, fixture, type Fixture } from './test-helpers.js';

let f: Fixture;
const meta = { actor: 'ops', reason: 'Operations request' } as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
  f = fixture();
});
afterEach(() => {
  f.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const call = (orderId: string) => ({ ...meta, orderId });
function snapshot(): unknown[] {
  return [
    'orders',
    'payments',
    'refunds',
    'order_events',
    'deliveries',
    'delivery_partners',
    'invoices',
    'idempotency_keys',
    'tool_call_log',
  ].map((table) => f.write.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}
function priorRefund(orderId: string, amount = 200): void {
  f.write
    .prepare('INSERT INTO refunds VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`RF-${orderId}`, orderId, `P-${orderId}`, amount, 'Earlier refund', 'ops', null, AT);
  f.write
    .prepare("UPDATE payments SET status = 'partially_refunded' WHERE order_id = ?")
    .run(orderId);
}
const valid = new Set([
  'placed:accepted',
  'placed:cancelled',
  'accepted:preparing',
  'accepted:cancelled',
  'preparing:ready',
  'preparing:cancelled',
  'ready:picked_up',
  'ready:cancelled',
  'picked_up:out_for_delivery',
  'out_for_delivery:delivered',
]);

describe('transactional order transition matrix', () => {
  it.each(
    OrderStatusSchema.options.flatMap((from) =>
      OrderStatusSchema.options.map((to) => ({ from, to })),
    ),
  )('$from → $to', ({ from, to }) => {
    const delivery =
      from === 'picked_up'
        ? 'picked_up'
        : from === 'out_for_delivery'
          ? 'out_for_delivery'
          : from === 'delivered'
            ? 'delivered'
            : 'assigned';
    const orderId = f.addOrder({ status: from, delivery });
    const input = { ...call(orderId), toStatus: to };
    if (valid.has(`${from}:${to}`)) {
      const result = f.services.order.advanceStatus(input);
      expect(result.order.status).toBe(to);
      expect(result.event).toMatchObject({
        from_status: from,
        to_status: to,
        actor: 'ops',
        reason: meta.reason,
      });
      expect(f.services.order.getOrder(orderId).timeline).toHaveLength(1);
      if (to === 'cancelled') expect(result.refund?.amount_paise).toBe(1000);
    } else {
      const before = snapshot();
      expect(() => f.services.order.advanceStatus(input)).toThrow(
        expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION, hint: expect.any(String) }),
      );
      expect(snapshot()).toEqual(before);
    }
  });
});

describe('previews and cancellation', () => {
  it('previews all three actions with no persistent side effects and exposes the approval threshold', () => {
    const orderId = f.addOrder({ total: 300000 });
    const delivered = f.addOrder({ status: 'delivered', delivery: 'delivered', total: 300000 });
    const before = snapshot();
    expect(f.services.order.previewCancel(call(orderId))).toMatchObject({
      refund_amount_paise: 300000,
      refund_amount_display: '₹3,000.00',
      requiresConfirmation: true,
    });
    expect(
      f.services.refund.previewRefund({ ...call(delivered), amountPaise: 200000 })
        .requiresConfirmation,
    ).toBe(false);
    expect(
      f.services.refund.previewRefund({ ...call(delivered), amountPaise: 200001 })
        .requiresConfirmation,
    ).toBe(true);
    expect(
      f.services.delivery.previewReassign({ ...call(orderId), partnerId: 'DP-2' }),
    ).toMatchObject({ partner_id: 'DP-2', partner_status_after: 'busy' });
    expect(snapshot()).toEqual(before);
  });

  it('cancels with refund and leaves deliveries, partners and item snapshots unchanged', () => {
    const orderId = f.addOrder();
    const beforeDelivery = f.services.delivery.trackDelivery(orderId);
    const beforeItems = f.services.order.getOrder(orderId).items;
    const result = f.services.order.executeCancel({ ...call(orderId), idempotencyKey: 'cancel-1' });
    expect(result.order).toMatchObject({ status: 'cancelled', cancel_reason: meta.reason });
    expect(result.payment?.status).toBe('refunded');
    expect(result.refund?.amount_paise).toBe(1000);
    const tracking = f.services.delivery.trackDelivery(orderId);
    expect(tracking.delivery).toEqual(beforeDelivery.delivery);
    expect(tracking.partner).toEqual(beforeDelivery.partner);
    expect(f.services.order.getOrder(orderId).items).toEqual(beforeItems);
    expect(f.count('order_events')).toBe(1);
    expect(f.count('idempotency_keys')).toBe(1);
  });

  it('refunds only the outstanding balance of a partially refunded payment', () => {
    const orderId = f.addOrder();
    priorRefund(orderId);
    expect(f.services.order.previewCancel(call(orderId)).refund_amount_paise).toBe(800);
    expect(f.services.order.executeCancel(call(orderId)).refund?.amount_paise).toBe(800);
    expect(f.services.order.getOrder(orderId).payment?.status).toBe('refunded');
    expect(f.count('refunds')).toBe(2);
  });

  it.each(['pending', 'failed', null] as const)(
    'does not refund payment status %s',
    (paymentStatus) => {
      const orderId = f.addOrder({ paymentStatus });
      expect(f.services.order.previewCancel(call(orderId)).refund_amount_paise).toBe(0);
      expect(f.services.order.executeCancel(call(orderId)).refund).toBeNull();
    },
  );

  it('does not refund an already fully refunded payment', () => {
    const orderId = f.addOrder();
    priorRefund(orderId, 1000);
    f.write.prepare("UPDATE payments SET status = 'refunded' WHERE order_id = ?").run(orderId);
    expect(f.services.order.executeCancel(call(orderId)).refund).toBeNull();
    expect(f.count('refunds')).toBe(1);
  });

  it('rechecks eligibility at execution rather than trusting the preview', () => {
    const orderId = f.addOrder({ status: 'ready' });
    f.services.order.previewCancel(call(orderId));
    f.services.order.advanceStatus({ ...call(orderId), toStatus: 'picked_up' });
    expect(() => f.services.order.executeCancel(call(orderId))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION }),
    );
    expect(f.count('refunds')).toBe(0);
  });

  it('rolls back order, event, payment, refund and idempotency when refund insertion fails', () => {
    const orderId = f.addOrder();
    f.write.exec(
      "CREATE TEMP TRIGGER fail_refund BEFORE INSERT ON refunds BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const before = snapshot();
    expect(() =>
      f.services.order.executeCancel({ ...call(orderId), idempotencyKey: 'atomic' }),
    ).toThrow(AppError);
    expect(snapshot()).toEqual(before);
    expect(f.write.inTransaction).toBe(false);
    f.write.exec('DROP TRIGGER fail_refund');
    expect(
      f.services.order.executeCancel({ ...call(orderId), idempotencyKey: 'atomic' }).payment
        ?.status,
    ).toBe('refunded');
  });
});

describe('refunds and idempotency', () => {
  it('executes approved large refunds without a confirm flag and completes partial refunds', () => {
    const orderId = f.addOrder({ status: 'delivered', delivery: 'delivered', total: 300000 });
    const first = f.services.refund.executeRefund({ ...call(orderId), amountPaise: 200001 });
    expect(first.payment.status).toBe('partially_refunded');
    expect(first.refund.amount_display).toBe('₹2,000.01');
    expect(
      f.services.refund.previewRefund({ ...call(orderId), amountPaise: 99999 })
        .remaining_after_paise,
    ).toBe(0);
    expect(
      f.services.refund.executeRefund({ ...call(orderId), amountPaise: 99999 }).payment.status,
    ).toBe('refunded');
    expect(() => f.services.refund.executeRefund({ ...call(orderId), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }),
    );
  });

  it('rejects zero, negative, fractional, excessive, unpaid and ineligible refunds', () => {
    const orderId = f.addOrder({ status: 'delivered' });
    for (const amountPaise of [0, -1, 0.5, 1001])
      expect(() => f.services.refund.executeRefund({ ...call(orderId), amountPaise })).toThrow(
        AppError,
      );
    const active = f.addOrder();
    expect(() => f.services.refund.previewRefund({ ...call(active), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION }),
    );
    const failed = f.addOrder({ status: 'delivered', paymentStatus: 'failed' });
    expect(() => f.services.refund.executeRefund({ ...call(failed), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }),
    );
  });

  it('replays exactly after subsequent changes and hashes normalized request field order', () => {
    const orderId = f.addOrder({ status: 'delivered' });
    const request = { ...call(orderId), amountPaise: 100, idempotencyKey: 'refund-1' };
    const original = f.services.refund.executeRefund(request);
    f.services.refund.executeRefund({ ...call(orderId), amountPaise: 200 });
    const reordered = {
      idempotencyKey: 'refund-1',
      amountPaise: 100,
      orderId,
      reason: meta.reason,
      actor: meta.actor,
    };
    expect(f.services.refund.executeRefund(reordered)).toEqual(original);
    expect(f.count('refunds')).toBe(2);
    expect(f.services.order.getOrder(orderId).payment?.status).toBe('partially_refunded');
    const stored = f.write
      .prepare<[string], { response_json: string }>(
        'SELECT response_json FROM idempotency_keys WHERE key = ?',
      )
      .get('refund-1');
    expect(JSON.parse(stored?.response_json ?? 'null')).toEqual(original);
  });

  it('rejects reuse with changed amount, reason, actor, order or operation before state validation', () => {
    const orderId = f.addOrder({ status: 'delivered' });
    const request = { ...call(orderId), amountPaise: 100, idempotencyKey: 'same' };
    f.services.refund.executeRefund(request);
    for (const patch of [
      { amountPaise: 101 },
      { reason: 'Different' },
      { actor: 'ai' as const },
      { orderId: 'missing' },
    ]) {
      expect(() => f.services.refund.executeRefund({ ...request, ...patch })).toThrow(
        expect.objectContaining({ code: ErrorCode.CONFLICT }),
      );
    }
    expect(() =>
      f.services.order.executeCancel({ ...call(orderId), idempotencyKey: 'same' }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
    expect(f.count('refunds')).toBe(1);
  });

  it('rejects inconsistent payment/refund records and malformed cached responses', () => {
    const orderId = f.addOrder({ status: 'delivered' });
    priorRefund(orderId, 1001);
    expect(() => f.services.refund.previewRefund({ ...call(orderId), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
    f.write.prepare("UPDATE payments SET status = 'failed'").run();
    expect(() => f.services.refund.previewRefund({ ...call(orderId), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
    const other = f.addOrder({ status: 'delivered' });
    const request = { ...call(other), amountPaise: 1, idempotencyKey: 'corrupt' };
    f.services.refund.executeRefund(request);
    f.write.prepare("UPDATE idempotency_keys SET response_json = '{}' WHERE key = 'corrupt'").run();
    expect(() => f.services.refund.executeRefund(request)).toThrow(
      expect.objectContaining({ code: ErrorCode.INTERNAL }),
    );
  });
});

describe('delivery lifecycle', () => {
  it('reassigns, frees the previous partner, and replays without a second assignment', () => {
    const orderId = f.addOrder({ status: 'ready' });
    const request = { ...call(orderId), partnerId: 'DP-2', idempotencyKey: 'assign' };
    const first = f.services.delivery.executeReassign(request);
    expect(first.previous_partner?.status).toBe('available');
    expect(first.partner.status).toBe('busy');
    expect(first.delivery).toMatchObject({
      partner_id: 'DP-2',
      assigned_at: AT,
      status: 'assigned',
    });
    expect(f.services.delivery.executeReassign(request)).toEqual(first);
    expect(f.count('order_events')).toBe(0);
    f.services.order.advanceStatus({ ...call(orderId), toStatus: 'picked_up' });
    expect(f.services.delivery.trackDelivery(orderId).delivery?.picked_up_at).toBe(AT);
    f.services.order.advanceStatus({ ...call(orderId), toStatus: 'out_for_delivery' });
    const result = f.services.order.advanceStatus({ ...call(orderId), toStatus: 'delivered' });
    expect(result.delivery).toMatchObject({ delivered_at: AT, status: 'delivered' });
    expect(f.services.delivery.trackDelivery(orderId).partner?.status).toBe('available');
  });

  it('assigns an unassigned delivery and rejects busy/offline/already assigned targets', () => {
    const orderId = f.addOrder({ delivery: 'pending', partnerId: null });
    expect(
      f.services.delivery.executeReassign({ ...call(orderId), partnerId: 'DP-2' }).previous_partner,
    ).toBeNull();
    expect(() =>
      f.services.delivery.executeReassign({ ...call(orderId), partnerId: 'DP-1' }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
    f.write.prepare("UPDATE delivery_partners SET status = 'offline' WHERE id = 'DP-1'").run();
    expect(() =>
      f.services.delivery.previewReassign({ ...call(orderId), partnerId: 'DP-1' }),
    ).toThrow(AppError);
    f.write.prepare("UPDATE delivery_partners SET status = 'available' WHERE id = 'DP-2'").run();
    expect(() =>
      f.services.delivery.previewReassign({ ...call(orderId), partnerId: 'DP-2' }),
    ).toThrow(AppError);
  });

  it('rejects late reassignment, missing deliveries and incoherent pickup states', () => {
    const picked = f.addOrder({ status: 'picked_up', delivery: 'picked_up' });
    expect(() =>
      f.services.delivery.executeReassign({ ...call(picked), partnerId: 'DP-2' }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION }));
    const missing = f.addOrder({ status: 'ready', delivery: null });
    expect(() =>
      f.services.delivery.previewReassign({ ...call(missing), partnerId: 'DP-2' }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND }));
    expect(() =>
      f.services.order.advanceStatus({ ...call(missing), toStatus: 'picked_up' }),
    ).toThrow(AppError);
    const unassigned = f.addOrder({ status: 'ready', delivery: 'pending', partnerId: null });
    expect(() =>
      f.services.order.advanceStatus({ ...call(unassigned), toStatus: 'picked_up' }),
    ).toThrow(AppError);
    const mismatched = f.addOrder({ status: 'ready', delivery: 'delivered' });
    expect(() =>
      f.services.order.advanceStatus({ ...call(mismatched), toStatus: 'picked_up' }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
    expect(() =>
      f.services.delivery.previewReassign({ ...call(mismatched), partnerId: 'DP-2' }),
    ).toThrow(AppError);
  });

  it('tracks late, unknown and completed deliveries without treating notes as instructions', () => {
    const orderId = f.addOrder();
    expect(f.services.delivery.trackDelivery(orderId).is_late).toBe(true);
    f.write.prepare('UPDATE deliveries SET eta_min = NULL').run();
    expect(f.services.delivery.trackDelivery(orderId).is_late).toBe(false);
    const absent = f.addOrder({ delivery: null });
    expect(f.services.delivery.trackDelivery(absent)).toMatchObject({
      delivery: null,
      partner: null,
      is_late: false,
    });
  });
});

describe('invoices', () => {
  it('numbers by UTC date, preserves snapshots after menu changes/refunds, and replays delivery', () => {
    const orderId = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    const request = { ...call(orderId), toStatus: 'delivered' as const, idempotencyKey: 'deliver' };
    const delivered = f.services.order.advanceStatus(request);
    expect(delivered.invoice?.invoice_no).toBe('INV-20261101-0001');
    expect(f.services.order.advanceStatus(request)).toEqual(delivered);
    const invoice = f.services.invoice.getInvoice(orderId);
    f.write.prepare("UPDATE menu_items SET name = 'Changed', price_paise = 999").run();
    f.services.refund.executeRefund({ ...call(orderId), amountPaise: 100 });
    expect(f.services.invoice.getInvoice(orderId)).toEqual(invoice);
    expect(invoice.items[0]?.name_snapshot).toBe('Original meal');
    expect(invoice.invoice.total_paise).toBe(1000);
    expect(Object.keys(f.services.invoice)).toEqual(['getInvoice']);
    f.write.prepare("UPDATE delivery_partners SET status = 'busy' WHERE id = 'DP-1'").run();
    const second = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    expect(
      f.services.order.advanceStatus({ ...call(second), toStatus: 'delivered' }).invoice
        ?.invoice_no,
    ).toBe('INV-20261101-0002');
    vi.setSystemTime(new Date('2026-11-02T00:00:00.000Z'));
    f.write.prepare("UPDATE delivery_partners SET status = 'busy' WHERE id = 'DP-1'").run();
    const third = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    expect(
      f.services.order.advanceStatus({ ...call(third), toStatus: 'delivered' }).invoice?.invoice_no,
    ).toBe('INV-20261102-0001');
  });

  it('grows the numeric suffix beyond four digits and refuses invoice reads before issue', () => {
    const first = f.addOrder({ status: 'delivered', delivery: 'delivered' });
    f.write
      .prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('I-old', first, 'INV-20261101-9999', 1000, 0, 0, 0, 1000, AT);
    const second = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    expect(() => f.services.invoice.getInvoice(second)).toThrow(
      expect.objectContaining({ code: ErrorCode.NOT_FOUND }),
    );
    expect(
      f.services.order.advanceStatus({ ...call(second), toStatus: 'delivered' }).invoice
        ?.invoice_no,
    ).toBe('INV-20261101-10000');
  });

  it('preserves an existing invoice and rolls back delivery if numbering is exhausted', () => {
    const existing = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    f.write
      .prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('I-existing', existing, 'INV-20261101-0001', 1000, 0, 0, 0, 1000, AT);
    expect(
      f.services.order.advanceStatus({ ...call(existing), toStatus: 'delivered' }).invoice?.id,
    ).toBe('I-existing');
    f.write.prepare("UPDATE delivery_partners SET status = 'busy' WHERE id = 'DP-1'").run();
    const next = f.addOrder({ status: 'out_for_delivery', delivery: 'out_for_delivery' });
    f.write.prepare("UPDATE invoices SET invoice_no = 'INV-20261101-9007199254740991'").run();
    const before = snapshot();
    expect(() =>
      f.services.order.advanceStatus({
        ...call(next),
        toStatus: 'delivered',
        idempotencyKey: 'exhausted',
      }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }));
    expect(snapshot()).toEqual(before);
  });

  it('allocates unique invoice numbers under competing writable connections', async () => {
    vi.useRealTimers();
    const one = f.addOrder({
      status: 'out_for_delivery',
      delivery: 'out_for_delivery',
      partnerId: 'DP-1',
    });
    f.write.prepare("UPDATE delivery_partners SET status = 'busy' WHERE id = 'DP-2'").run();
    const two = f.addOrder({
      status: 'out_for_delivery',
      delivery: 'out_for_delivery',
      partnerId: 'DP-2',
    });
    const sourceEntry = fileURLToPath(new URL('./index.ts', import.meta.url));
    const sourceConnection = fileURLToPath(new URL('../db/connection.ts', import.meta.url));
    const barrier = new SharedArrayBuffer(4);
    const run = (orderId: string) =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(
          `
        const { parentPort, workerData } = require('node:worker_threads');
        (async () => {
          const { register } = await import(workerData.loader);
          const { pathToFileURL } = await import('node:url');
          register();
          const { createServices } = await import(pathToFileURL(workerData.entry).href);
          const { openWritable, openReadOnly } = await import(pathToFileURL(workerData.connection).href);
          const write = openWritable(workerData.path); const read = openReadOnly(workerData.path);
          const barrier = new Int32Array(workerData.barrier);
          Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
          while (Atomics.load(barrier, 0) < 2) {
            if (Atomics.wait(barrier, 0, 1, 4000) === 'timed-out' && Atomics.load(barrier, 0) < 2) throw new Error('Peer writer did not start');
          }
          let number;
          try { number = createServices({write, read}).order.advanceStatus({ orderId: workerData.orderId, toStatus: 'delivered', actor: 'ops', reason: 'Concurrent completion' }).invoice.invoice_no; }
          finally { read.close(); write.close(); }
          parentPort.postMessage(number);
        })().catch(error => { throw error; });`,
          {
            eval: true,
            workerData: {
              path: f.path,
              orderId,
              entry: sourceEntry,
              connection: sourceConnection,
              loader: import.meta.resolve('tsx/esm/api'),
              barrier,
            },
          },
        );
        worker.on('message', (message: string) => resolve(message));
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker exited ${code}`));
        });
      });
    const numbers = await Promise.all([run(one), run(two)]);
    expect(new Set(numbers).size).toBe(2);
    expect(f.count('invoices')).toBe(2);
  });
});

describe('read services, validation and audit', () => {
  it('uses read-only handles for public reads and previews', () => {
    const orderId = f.addOrder();
    const prepare = vi.spyOn(f.write, 'prepare');
    f.services.catalog.searchRestaurants();
    f.services.catalog.getMenu({ restaurantId: 'R-1' });
    f.services.order.getOrder(orderId);
    f.services.order.listOrders();
    f.services.delivery.trackDelivery(orderId);
    f.services.delivery.listDeliveryPartners();
    f.services.order.previewCancel(call(orderId));
    f.services.delivery.previewReassign({ ...call(orderId), partnerId: 'DP-2' });
    f.services.metrics.getSalesSummary({ from: '2026-11-01', to: '2026-11-01', groupBy: 'day' });
    f.services.audit.listCalls();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('filters and pages catalogs and orders without duplicates on tied timestamps', () => {
    for (const id of ['O-1', 'O-2', 'O-3']) f.addOrder({ id });
    const first = f.services.order.listOrders({
      limit: 2,
      status: 'placed',
      customerId: 'C-1',
      restaurantId: 'R-1',
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(first.items.map((order) => order.id)).toEqual(['O-3', 'O-2']);
    const cursor = first.next_cursor;
    if (!cursor) throw new Error('Expected cursor');
    const last = f.services.order.listOrders({ limit: 2, cursor });
    expect(last.items.map((order) => order.id)).toEqual(['O-1']);
    expect(last.next_cursor).toBeNull();
    expect(
      f.services.catalog
        .searchRestaurants({ query: 'Indian', cuisine: 'Indian', area: 'Central', openNow: true })
        .items.map((row) => row.id),
    ).toEqual(['R-1']);
    const restaurants = f.services.catalog.searchRestaurants({ limit: 1 });
    expect(restaurants.items[0]?.id).toBe('R-2');
    expect(
      f.services.catalog.searchRestaurants({
        ...(restaurants.next_cursor ? { cursor: restaurants.next_cursor } : {}),
        limit: 1,
      }).items[0]?.id,
    ).toBe('R-1');
    expect(
      f.services.catalog.getMenu({ restaurantId: 'R-1', vegOnly: true, availableOnly: true })
        .items[0],
    ).toMatchObject({ id: 'M-1', price_display: '₹1.00', is_veg: true });
    expect(f.services.delivery.listDeliveryPartners({ status: 'available' }).items[0]?.id).toBe(
      'DP-2',
    );
  });

  it('returns helpful AppErrors for invalid inputs, missing entities, corrupt rows and duplicate relationships', () => {
    expect(() => f.services.order.getOrder('missing')).toThrow(
      expect.objectContaining({ code: ErrorCode.NOT_FOUND, hint: expect.any(String) }),
    );
    expect(() => f.services.catalog.getMenu({ restaurantId: 'missing' })).toThrow(AppError);
    expect(() => f.services.order.listOrders({ limit: 51 })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(() => f.services.order.listOrders({ cursor: 'bad' })).toThrow(AppError);
    expect(() =>
      f.services.order.executeCancel({ ...call('missing'), confirm: true } as Parameters<
        typeof f.services.order.executeCancel
      >[0]),
    ).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
    const orderId = f.addOrder();
    f.write
      .prepare(
        'INSERT INTO payments SELECT ?, order_id, method, status, amount_paise, txn_ref FROM payments WHERE order_id = ?',
      )
      .run('P-duplicate', orderId);
    expect(() => f.services.order.getOrder(orderId)).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
    f.write.prepare("DELETE FROM payments WHERE id = 'P-duplicate'").run();
    f.write.prepare("UPDATE customers SET email = 'invalid'").run();
    expect(() => f.services.order.getOrder(orderId)).toThrow(
      expect.objectContaining({ code: ErrorCode.INTERNAL }),
    );
    f.write
      .prepare(
        'INSERT INTO deliveries SELECT ?, order_id, partner_id, status, eta_min, assigned_at, picked_up_at, delivered_at FROM deliveries WHERE order_id = ?',
      )
      .run('D-duplicate', orderId);
    expect(() => f.services.delivery.trackDelivery(orderId)).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
  });

  it('refuses corrupt cached display amounts and cross-order refund associations', () => {
    const orderId = f.addOrder({ status: 'delivered' });
    const request = { ...call(orderId), amountPaise: 100, idempotencyKey: 'display' };
    const result = f.services.refund.executeRefund(request);
    f.write
      .prepare('UPDATE idempotency_keys SET response_json = ? WHERE key = ?')
      .run(
        JSON.stringify({ ...result, refund: { ...result.refund, amount_display: 'incorrect' } }),
        'display',
      );
    expect(() => f.services.refund.executeRefund(request)).toThrow(
      expect.objectContaining({ code: ErrorCode.INTERNAL }),
    );
    const other = f.addOrder({ status: 'delivered' });
    f.write.prepare('UPDATE refunds SET order_id = ?').run(other);
    expect(() => f.services.refund.previewRefund({ ...call(orderId), amountPaise: 1 })).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
  });

  it('validates handles and rejects nested writes', () => {
    expect(() => createServices({ write: f.read, read: f.write })).toThrow(AppError);
    const other = fixture();
    try {
      expect(() => createServices({ write: f.write, read: other.read })).toThrow(AppError);
    } finally {
      other.close();
    }
    const orderId = f.addOrder();
    expect(() =>
      f.write.transaction(() => f.services.order.executeCancel(call(orderId)))(),
    ).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
  });

  it('records, paginates and idempotently replays tool-call audit writes', () => {
    const input = {
      tool: 'get_order',
      argsJson: '{"order_id":"O-1"}',
      actor: 'ai',
      status: 'success',
      latencyMs: 10,
      idempotencyKey: 'audit',
    } as const;
    const original = f.services.audit.recordCall(input);
    expect(f.services.audit.recordCall(input)).toEqual(original);
    expect(f.count('tool_call_log')).toBe(1);
    f.services.audit.recordCall({
      tool: 'get_order',
      argsJson: '{}',
      actor: 'ai',
      status: 'error',
      errorCode: ErrorCode.NOT_FOUND,
      latencyMs: 1,
    });
    const first = f.services.audit.listCalls({ limit: 1 });
    expect(first.items).toHaveLength(1);
    const cursor = first.next_cursor;
    if (!cursor) throw new Error('Expected audit cursor');
    expect(f.services.audit.listCalls({ cursor, limit: 1 }).items).toHaveLength(1);
    expect(() => f.services.audit.recordCall({ ...input, argsJson: 'invalid' })).toThrow(AppError);
  });
});
