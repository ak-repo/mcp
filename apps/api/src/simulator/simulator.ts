import { randomUUID } from 'node:crypto';
import { ORDER_TRANSITIONS, type Services } from '@foodops/core';
import type { Logger } from 'pino';
import type { OrderStatus } from '@foodops/shared';
import { createRng } from './rng.js';
export interface SimulatorSettings {
  enabled: boolean;
  interval_ms: number;
}
export function createSimulator(
  services: Services,
  logger: Logger,
  settings: SimulatorSettings,
  seed: number,
  options: { maxActive?: number } = {},
) {
  const random = createRng(seed);
  const stats = {
    ticks: 0,
    orders_placed: 0,
    advanced: 0,
    cancelled: 0,
    errors: 0,
    ticks_waiting_for_partner: 0,
  };
  let config = { ...settings };
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const choose = <T>(items: readonly T[]): T | undefined =>
    items[Math.floor(random() * items.length)];
  function failed(error: unknown) {
    stats.errors++;
    logger.warn({ err: error }, 'Simulator action failed');
  }
  async function tick() {
    await Promise.resolve();
    if (!active || !config.enabled) return;
    stats.ticks++;
    let waitingForPartner = false;
    try {
      if (random() < 0.3 && services.order.countActive() < (options.maxActive ?? 60)) {
        try {
          const restaurant = choose(
            services.catalog.searchRestaurants({ openNow: true, limit: 50 }).items,
          );
          const address = choose(services.catalog.placementCustomers());
          if (restaurant && address) {
            const item = choose(
              services.catalog.getMenu({
                restaurantId: restaurant.id,
                availableOnly: true,
                limit: 50,
              }).items,
            );
            if (item) {
              services.order.placeOrder({
                customerId: address.customer_id,
                addressId: address.id,
                restaurantId: restaurant.id,
                items: [{ menuItemId: item.id, qty: 1 + Math.floor(random() * 3) }],
                paymentMethod: choose(['upi', 'card', 'cod', 'wallet'] as const) ?? 'upi',
                actor: 'system',
                reason: 'Simulator placement',
                idempotencyKey: randomUUID(),
              });
              stats.orders_placed++;
            }
          }
        } catch (error) {
          failed(error);
        }
      }
      const eligible = services.order.listProgressable({
        statuses: ['placed', 'accepted', 'preparing', 'ready', 'picked_up', 'out_for_delivery'],
        limitPerStatus: 50,
      });
      // Placement time gives simulator-created orders a stable sampling order when a tick updates several at once.
      eligible.sort(
        (a, b) =>
          a.updated_at.localeCompare(b.updated_at) ||
          a.placed_at.localeCompare(b.placed_at) ||
          a.id.localeCompare(b.id),
      );
      for (let n = 0; n < 3 && eligible.length; n++) {
        const index = Math.floor(random() * eligible.length);
        const order = eligible.splice(index, 1)[0];
        if (!order) continue;
        try {
          const details = services.order.getOrder(order.id);
          if (details.payment?.status === 'failed') continue;
          const meta = {
            orderId: order.id,
            actor: 'system' as const,
            reason: 'Simulator progression',
            idempotencyKey: randomUUID(),
          };
          if (
            ['placed', 'accepted', 'preparing', 'ready'].includes(order.status) &&
            random() < 0.05
          ) {
            services.order.executeCancel({ ...meta, reason: 'Simulator cancellation' });
            stats.cancelled++;
            continue;
          }
          const next = ORDER_TRANSITIONS[order.status].find((status) => status !== 'cancelled') as
            OrderStatus | undefined;
          if (!next) continue;
          if (next === 'picked_up' && !details.delivery?.partner_id) {
            const partner = choose(
              services.delivery.listDeliveryPartners({ status: 'available', limit: 50 }).items,
            );
            if (!partner) {
              waitingForPartner = true;
              continue;
            }
            services.delivery.executeReassign({
              ...meta,
              idempotencyKey: randomUUID(),
              partnerId: partner.id,
              reason: 'Simulator assignment',
            });
          }
          services.order.advanceStatus({ ...meta, toStatus: next });
          stats.advanced++;
        } catch (error) {
          failed(error);
        }
      }
    } catch (error) {
      failed(error);
    } finally {
      if (waitingForPartner) stats.ticks_waiting_for_partner++;
    }
  }
  function schedule() {
    if (!active || !config.enabled || timer || inFlight) return;
    const delay = Math.max(
      1000,
      Math.min(60000, Math.round(config.interval_ms * (0.9 + random() * 0.2))),
    );
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, delay);
    timer.unref();
  }
  return {
    status() {
      return { ...config, ...stats };
    },
    start() {
      if (active) return;
      active = true;
      schedule();
    },
    async configure(next: SimulatorSettings) {
      config = { ...next };
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
      schedule();
      return this.status();
    },
    async stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
export type Simulator = ReturnType<typeof createSimulator>;
