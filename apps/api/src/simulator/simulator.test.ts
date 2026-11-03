import { openWritable } from '@foodops/core/db/connection';
import { afterEach, expect, it, vi } from 'vitest';
import { ORDER_TRANSITIONS } from '@foodops/core';
import { createSimulator, type Simulator } from './simulator.js';
import { openRuntime } from '../runtime.js';
import { createRng } from './rng.js';
import { fixture, type Fixture } from '../tests/helpers.js';
let f: Fixture | undefined;
let simulator: Simulator | undefined;
afterEach(async () => {
  await simulator?.stop();
  simulator = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  await f?.close();
  f = undefined;
});
it('has a repeatable seedable RNG in [0,1)', () => {
  const a = createRng(42),
    b = createRng(42),
    c = createRng(43);
  const first = Array.from({ length: 100 }, a);
  expect(first).toEqual(Array.from({ length: 100 }, b));
  expect(first).not.toEqual(Array.from({ length: 100 }, c));
  expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
});
it('repeats action choices, follows transitions, and respects partner availability', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
  async function sequence() {
    f = fixture();
    const services = f.runtime.services;
    const actions: unknown[] = [];
    const aliases = new Map<string, string>();
    const place = services.order.placeOrder;
    vi.spyOn(services.order, 'placeOrder').mockImplementation((input) => {
      const result = place(input);
      aliases.set(result.order.id, `new-${aliases.size + 1}`);
      actions.push(['place', input.items, input.paymentMethod]);
      return result;
    });
    const advance = services.order.advanceStatus;
    vi.spyOn(services.order, 'advanceStatus').mockImplementation((input) => {
      const before = services.order.getOrder(input.orderId);
      expect(ORDER_TRANSITIONS[before.order.status] as readonly string[]).toContain(input.toStatus);
      if (input.toStatus === 'picked_up') expect(before.delivery?.partner_id).toBeTruthy();
      const result = advance(input);
      actions.push(['advance', aliases.get(input.orderId) ?? input.orderId, input.toStatus]);
      if (input.toStatus === 'delivered') {
        expect(result.invoice).not.toBeNull();
        expect(result.payment?.status).toBe('paid');
      }
      return result;
    });
    const assign = services.delivery.executeReassign;
    vi.spyOn(services.delivery, 'executeReassign').mockImplementation((input) => {
      expect(
        services.delivery
          .listDeliveryPartners({ status: 'available', limit: 50 })
          .items.some((x) => x.id === input.partnerId),
      ).toBe(true);
      const result = assign(input);
      actions.push(['assign', aliases.get(input.orderId) ?? input.orderId, input.partnerId]);
      return result;
    });
    const cancel = services.order.executeCancel;
    vi.spyOn(services.order, 'executeCancel').mockImplementation((input) => {
      const result = cancel(input);
      actions.push(['cancel', aliases.get(input.orderId) ?? input.orderId]);
      return result;
    });
    simulator = createSimulator(
      services,
      f.runtime.logger,
      { enabled: true, interval_ms: 1000 },
      42,
    );
    simulator.start();
    simulator.start();
    await vi.advanceTimersByTimeAsync(120000);
    await simulator.stop();
    const stats = simulator.status();
    expect(stats.ticks).toBeGreaterThan(90);
    expect(stats.orders_placed).toBeGreaterThan(10);
    expect(stats.advanced).toBeGreaterThan(10);
    expect(stats.errors).toBe(0);
    vi.restoreAllMocks();
    await f.close();
    f = undefined;
    simulator = undefined;
    return { actions, stats };
  }
  const first = await sequence();
  vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
  expect(await sequence()).toEqual(first);
});
it('does not overlap ticks, isolates action errors, and disabling stops scheduling', async () => {
  vi.useFakeTimers();
  f = fixture();
  const services = f.runtime.services;
  const list = services.order.listProgressable;
  let injected = false;
  vi.spyOn(services.order, 'listProgressable').mockImplementation((input) => {
    if (!injected) {
      injected = true;
      vi.advanceTimersByTime(10000);
      throw new Error('discovery failed');
    }
    return list(input);
  });
  simulator = createSimulator(services, f.runtime.logger, { enabled: true, interval_ms: 1000 }, 42);
  simulator.start();
  await vi.advanceTimersByTimeAsync(1100);
  expect(simulator.status().ticks).toBe(1);
  expect(simulator.status().errors).toBe(1);
  await vi.advanceTimersByTimeAsync(2200);
  expect(simulator.status().ticks).toBeGreaterThan(1);
  await simulator.configure({ enabled: false, interval_ms: 1000 });
  const stopped = simulator.status();
  await vi.advanceTimersByTimeAsync(10000);
  expect(simulator.status()).toEqual(stopped);
  await simulator.configure({ enabled: true, interval_ms: 1000 });
  await vi.advanceTimersByTimeAsync(1100);
  expect(simulator.status().ticks).toBeGreaterThan(stopped.ticks);
  await simulator.stop();
  const ticks = simulator.status().ticks;
  await vi.advanceTimersByTimeAsync(10000);
  expect(simulator.status().ticks).toBe(ticks);
});
it('logs and counts failed individual actions while continuing the tick', async () => {
  vi.useFakeTimers();
  f = fixture();
  vi.spyOn(f.runtime.services.order, 'advanceStatus').mockImplementation(() => {
    throw new Error('forced advancement failure');
  });
  simulator = createSimulator(
    f.runtime.services,
    f.runtime.logger,
    { enabled: true, interval_ms: 1000 },
    42,
  );
  simulator.start();
  await vi.advanceTimersByTimeAsync(20000);
  expect(simulator.status().ticks).toBeGreaterThan(10);
  expect(simulator.status().errors).toBeGreaterThan(0);
  expect(simulator.status().orders_placed).toBeGreaterThan(0);
});
it('exposes authenticated strict runtime controls and resets on reopen', async () => {
  f = fixture();
  const headers = { authorization: `Bearer ${f.config.ADMIN_TOKEN}` };
  expect((await f.app.inject({ url: '/api/simulator' })).statusCode).toBe(401);
  const before = await f.app.inject({ url: '/api/simulator', headers });
  expect(before.json()).toMatchObject({ enabled: false, interval_ms: 5000, ticks: 0 });
  for (const payload of [
    { enabled: true, interval_ms: 999 },
    { enabled: true, interval_ms: 60001 },
    { enabled: true, interval_ms: 1000, actor: 'ops' },
  ])
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/simulator', headers, payload })).statusCode,
    ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/simulator',
        headers,
        payload: { enabled: true, interval_ms: 1000 },
      })
    ).json(),
  ).toMatchObject({ enabled: true, interval_ms: 1000 });
  await f.app.inject({
    method: 'POST',
    url: '/api/simulator',
    headers,
    payload: { enabled: false, interval_ms: 1000 },
  });
  const reopened = openRuntime(f.config);
  try {
    expect(reopened.simulator.status()).toMatchObject({
      enabled: false,
      interval_ms: 5000,
      ticks: 0,
    });
  } finally {
    reopened.close();
  }
});
it('does not place orders once the active backlog reaches its cap', async () => {
  vi.useFakeTimers();
  f = fixture();
  simulator = createSimulator(
    f.runtime.services,
    f.runtime.logger,
    { enabled: true, interval_ms: 1000 },
    42,
    { maxActive: 1 },
  );
  const place = vi.spyOn(f.runtime.services.order, 'placeOrder');
  simulator.start();
  await vi.advanceTimersByTimeAsync(10000);
  await simulator.stop();
  expect(place).not.toHaveBeenCalled();
  expect(simulator.status().orders_placed).toBe(0);
});
it('progresses an old untouched order', async () => {
  vi.useFakeTimers();
  f = fixture();
  const services = f.runtime.services;
  const oldest = services.order.listProgressable({ statuses: ['placed'], limitPerStatus: 1 })[0]!;
  simulator = createSimulator(
    services,
    f.runtime.logger,
    { enabled: true, interval_ms: 1000 },
    42,
    { maxActive: 1 },
  );
  simulator.start();
  await vi.advanceTimersByTimeAsync(60000);
  await simulator.stop();
  expect(services.order.getOrder(oldest.id).order.status).not.toBe('placed');
});
it('waits when every partner is busy, then uses a partner released by a delivery', async () => {
  vi.useFakeTimers();
  f = fixture();
  const services = f.runtime.services;
  const orderId = 'O-EDGE-UNASSIGNED';
  for (const toStatus of ['preparing', 'ready'] as const)
    services.order.advanceStatus({
      orderId,
      toStatus,
      actor: 'system',
      reason: 'Prepare waiting test',
    });
  const db = openWritable(f.dbPath);
  try {
    db.prepare("UPDATE delivery_partners SET status='busy'").run();
  } finally {
    db.close();
  }
  const list = services.order.listProgressable;
  vi.spyOn(services.order, 'listProgressable').mockImplementation((input) =>
    list(input).filter((order) => order.id === orderId),
  );
  simulator = createSimulator(
    services,
    f.runtime.logger,
    { enabled: true, interval_ms: 1000 },
    42,
    { maxActive: 1 },
  );
  simulator.start();
  await vi.advanceTimersByTimeAsync(1100);
  expect(simulator.status().ticks_waiting_for_partner).toBe(1);
  expect(services.order.getOrder(orderId).delivery?.partner_id).toBeNull();
  const finished = services.order.advanceStatus({
    orderId: 'O-EDGE-LATE',
    toStatus: 'delivered',
    actor: 'system',
    reason: 'Free a partner',
  });
  expect(finished.partner?.status).toBe('available');
  await vi.advanceTimersByTimeAsync(1100);
  await simulator.stop();
  expect(services.order.getOrder(orderId).delivery?.partner_id).toBe(finished.partner?.id);
  expect(services.order.getOrder(orderId).order.status).toBe('picked_up');
  expect(simulator.status().errors).toBe(0);
});
