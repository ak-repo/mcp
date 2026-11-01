import { AppError, ErrorCode, type Delivery, type OrderStatus } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { assertTransition } from '../domain/order-state-machine.js';
import { calculatePricing } from '../domain/pricing.js';
import { EDGE_CASE_IDS, INJECTION_NOTE, SEED_NOW } from './factories.js';
import { readSeedData, seedContentHash, seedCounts, type SeedCounts } from './storage.js';

export interface InvariantReport {
  counts: SeedCounts;
  contentHash: string;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new AppError(
      ErrorCode.INTERNAL,
      `Seed invariant failed: ${message}`,
      'Regenerate the demo database with pnpm seed --reset; inspect the seed factory if this repeats',
    );
}
function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = groups.get(id) ?? [];
    list.push(row);
    groups.set(id, list);
  }
  return groups;
}
function timestamp(value: string): number {
  return Date.parse(value);
}

/** Validate persisted data, independently of the factory's construction path. */
export function checkSeedInvariants(
  db: DatabaseConnection,
  options: { operational?: boolean; now?: string } = {},
): InvariantReport {
  try {
    const foreignKeys: unknown = db.pragma('foreign_key_check');
    check(Array.isArray(foreignKeys) && foreignKeys.length === 0, 'all foreign keys must resolve');
    const data = readSeedData(db);
    const anchor = timestamp(
      options.now ?? (options.operational ? new Date().toISOString() : SEED_NOW),
    );
    const orders = new Map(data.orders.map((row) => [row.id, row]));
    const customers = new Map(data.customers.map((row) => [row.id, row]));
    const addresses = new Map(data.addresses.map((row) => [row.id, row]));
    const restaurants = new Map(data.restaurants.map((row) => [row.id, row]));
    const menu = new Map(data.menu_items.map((row) => [row.id, row]));
    const partners = new Map(data.delivery_partners.map((row) => [row.id, row]));
    const addressesByCustomer = group(data.addresses, (row) => row.customer_id);
    const items = group(data.order_items, (row) => row.order_id);
    const events = group(data.order_events, (row) => row.order_id);
    const payments = group(data.payments, (row) => row.order_id);
    const deliveries = group(data.deliveries, (row) => row.order_id);
    const invoices = group(data.invoices, (row) => row.order_id);
    const refunds = group(data.refunds, (row) => row.payment_id);
    const busy = new Set<string>();
    const assignments = new Map<string, { start: number; end: number }[]>();
    for (const customer of data.customers) {
      const count = addressesByCustomer.get(customer.id)?.length ?? 0;
      check(count >= 1 && count <= 2, `${customer.id} must have 1–2 addresses`);
    }
    for (const order of data.orders) {
      check(
        customers.has(order.customer_id) && restaurants.has(order.restaurant_id),
        `${order.id} customer and restaurant`,
      );
      const address = addresses.get(order.address_id);
      check(address && address.customer_id === order.customer_id, `${order.id} address ownership`);
      check(
        options.operational || address.city === restaurants.get(order.restaurant_id)?.city,
        `${order.id} delivery city`,
      );
      check(
        (options.operational || timestamp(order.placed_at) >= anchor - 30 * 86400000) &&
          timestamp(order.updated_at) <= anchor,
        `${order.id} lies in the fixed 30-day window`,
      );
      const lineItems = items.get(order.id) ?? [];
      check(lineItems.length > 0, `${order.id} has line items`);
      for (const item of lineItems)
        check(
          menu.get(item.menu_item_id)?.restaurant_id === order.restaurant_id,
          `${order.id} menu belongs to its restaurant`,
        );
      const expected = calculatePricing({
        items: lineItems,
        delivery_fee_paise: order.delivery_fee_paise,
        platform_fee_paise: order.platform_fee_paise,
        discount_paise: order.discount_paise,
      });
      for (const field of Object.keys(expected) as (keyof typeof expected)[])
        check(order[field] === expected[field], `${order.id} pricing.${field}`);
      const chain = [...(events.get(order.id) ?? [])].sort(
        (a, b) =>
          timestamp(a.at) - timestamp(b.at) ||
          [
            'placed',
            'accepted',
            'preparing',
            'ready',
            'picked_up',
            'out_for_delivery',
            'delivered',
            'cancelled',
          ].indexOf(a.to_status) -
            [
              'placed',
              'accepted',
              'preparing',
              'ready',
              'picked_up',
              'out_for_delivery',
              'delivered',
              'cancelled',
            ].indexOf(b.to_status),
      );
      check(chain.length > 0, `${order.id} event chain exists`);
      let previous: OrderStatus | null = null;
      let previousAt = timestamp(order.placed_at);
      for (const [index, event] of chain.entries()) {
        check(event.from_status === previous, `${order.id} event chain continuity`);
        if (index === 0)
          check(
            event.to_status === 'placed' && event.at === order.placed_at,
            `${order.id} initial placement event`,
          );
        else {
          check(previous !== null, `${order.id} event source`);
          try {
            assertTransition(previous, event.to_status);
          } catch {
            check(false, `${order.id} invalid transition ${previous} -> ${event.to_status}`);
          }
        }
        check(
          timestamp(event.at) >= previousAt && timestamp(event.at) <= anchor,
          `${order.id} event chronology`,
        );
        previous = event.to_status;
        previousAt = timestamp(event.at);
      }
      check(
        previous === order.status && chain.at(-1)?.at === order.updated_at,
        `${order.id} final event matches order`,
      );
      check(
        order.status === 'cancelled'
          ? order.cancel_reason === chain.at(-1)?.reason
          : order.cancel_reason === null,
        `${order.id} cancellation reason`,
      );
      const orderPayments = payments.get(order.id) ?? [];
      check(orderPayments.length === 1, `${order.id} has one payment`);
      const payment = orderPayments[0];
      check(payment, `${order.id} payment exists`);
      check(payment.amount_paise === order.total_paise, `${order.id} payment matches total`);
      const records = refunds.get(payment.id) ?? [];
      const totalRefunded = records.reduce((sum, refund) => sum + BigInt(refund.amount_paise), 0n);
      const captured = ['paid', 'partially_refunded', 'refunded'].includes(payment.status)
        ? BigInt(payment.amount_paise)
        : 0n;
      check(totalRefunded <= captured, `${order.id} refunded <= paid`);
      if (payment.status === 'paid')
        check(totalRefunded === 0n, `${order.id} paid payment has no refunds`);
      if (payment.status === 'partially_refunded')
        check(totalRefunded > 0n && totalRefunded < captured, `${order.id} partial refund balance`);
      if (payment.status === 'refunded')
        check(totalRefunded === captured, `${order.id} full refund balance`);
      if (order.status === 'cancelled' && captured > 0n)
        check(payment.status === 'refunded', `${order.id} cancellation refunds captured payment`);
      if (order.status === 'delivered')
        check(captured > 0n, `${order.id} delivered payment is captured`);
      for (const refund of records) {
        check(refund.order_id === order.id, `${order.id} refund payment ownership`);
        check(
          order.status === 'cancelled' || order.status === 'delivered',
          `${order.id} refund status eligibility`,
        );
        check(
          timestamp(refund.created_at) >= timestamp(order.updated_at) &&
            timestamp(refund.created_at) <= anchor,
          `${order.id} refund chronology`,
        );
      }
      const issued = invoices.get(order.id) ?? [];
      check(
        issued.length === (order.status === 'delivered' ? 1 : 0),
        `${order.id} delivered-only invoice cardinality`,
      );
      for (const invoice of issued) {
        check(
          invoice.subtotal_paise === order.subtotal_paise &&
            invoice.tax_paise === order.tax_paise &&
            invoice.discount_paise === order.discount_paise &&
            invoice.total_paise === order.total_paise &&
            invoice.fees_paise === order.delivery_fee_paise + order.platform_fee_paise,
          `${order.id} immutable invoice totals`,
        );
        check(
          invoice.issued_at === order.updated_at &&
            invoice.invoice_no.startsWith(
              `INV-${invoice.issued_at.slice(0, 10).replace(/-/g, '')}-`,
            ),
          `${order.id} invoice issue date`,
        );
      }
      const orderDeliveries = deliveries.get(order.id) ?? [];
      check(orderDeliveries.length === 1, `${order.id} has one delivery`);
      const delivery = orderDeliveries[0];
      check(delivery, `${order.id} delivery exists`);
      const pickup = chain.find((event) => event.to_status === 'picked_up');
      const delivered = chain.find((event) => event.to_status === 'delivered');
      check(
        delivery.picked_up_at === (pickup?.at ?? null) &&
          delivery.delivered_at === (delivered?.at ?? null),
        `${order.id} delivery timestamps match events`,
      );
      const expectedStatus =
        order.status === 'cancelled' && options.operational
          ? 'cancelled'
          : order.status === 'delivered'
            ? 'delivered'
            : order.status === 'out_for_delivery'
              ? 'out_for_delivery'
              : order.status === 'picked_up'
                ? 'picked_up'
                : delivery.partner_id === null
                  ? 'pending'
                  : 'assigned';
      check(
        (options.operational &&
          order.status === 'cancelled' &&
          ['pending', 'assigned', 'cancelled'].includes(delivery.status)) ||
          delivery.status === expectedStatus,
        `${order.id} delivery status matches order`,
      );
      if (delivery.partner_id === null)
        check(
          delivery.assigned_at === null && delivery.eta_min === null && !pickup,
          `${order.id} unassigned delivery has no pickup`,
        );
      else {
        check(
          partners.has(delivery.partner_id) &&
            delivery.assigned_at !== null &&
            delivery.eta_min !== null,
          `${order.id} assignment exists`,
        );
        const accepted = chain.find((event) => event.to_status === 'accepted');
        check(
          options.operational
            ? timestamp(delivery.assigned_at) >= timestamp(order.placed_at) &&
                timestamp(delivery.assigned_at) <= anchor
            : accepted && delivery.assigned_at === accepted.at,
          `${order.id} assignment chronology`,
        );
        const intervals = assignments.get(delivery.partner_id) ?? [];
        intervals.push({
          start: timestamp(delivery.assigned_at),
          end:
            delivery.delivered_at !== null
              ? timestamp(delivery.delivered_at)
              : order.status === 'cancelled'
                ? timestamp(order.updated_at)
                : Infinity,
        });
        assignments.set(delivery.partner_id, intervals);
        if (order.status !== 'delivered' && order.status !== 'cancelled') {
          check(
            !busy.has(delivery.partner_id),
            `${order.id} partner has only one active assignment`,
          );
          busy.add(delivery.partner_id);
        }
      }
    }
    for (const partner of data.delivery_partners)
      check(
        busy.has(partner.id) ? partner.status === 'busy' : partner.status !== 'busy',
        `${partner.id} availability matches active assignments`,
      );
    for (const [partnerId, intervals] of options.operational ? [] : assignments) {
      intervals.sort((a, b) => a.start - b.start);
      for (let n = 1; n < intervals.length; n++)
        check(
          (intervals[n - 1]?.end ?? Infinity) <= (intervals[n]?.start ?? -Infinity),
          `${partnerId} assignment intervals do not overlap`,
        );
    }
    for (const list of group(data.invoices, (invoice) => invoice.issued_at.slice(0, 10)).values()) {
      const numbers = list
        .map((invoice) => Number(invoice.invoice_no.slice(13)))
        .sort((a, b) => a - b);
      check(
        numbers.every((number, index) => number === index + 1),
        'daily invoice sequences are contiguous and unique',
      );
    }
    if (options.operational)
      return { counts: seedCounts(data), contentHash: seedContentHash(data) };
    const edge = (id: string) => {
      const order = orders.get(id);
      check(order, `known edge case ${id} exists`);
      return order;
    };
    const deliveryFor = (id: string): Delivery => {
      const delivery = deliveries.get(id)?.[0];
      check(delivery, `${id} edge delivery exists`);
      return delivery;
    };
    const late = deliveryFor(edge(EDGE_CASE_IDS.lateDelivery).id);
    check(
      late.status === 'out_for_delivery' &&
        late.assigned_at !== null &&
        late.eta_min !== null &&
        timestamp(late.assigned_at) + late.eta_min * 60000 < anchor,
      'known late delivery is late at the anchor',
    );
    check(
      payments.get(edge(EDGE_CASE_IDS.failedPayment).id)?.[0]?.status === 'failed',
      'known failed payment',
    );
    check(
      payments.get(edge(EDGE_CASE_IDS.partialRefund).id)?.[0]?.status === 'partially_refunded',
      'known partial refund',
    );
    check(
      deliveryFor(edge(EDGE_CASE_IDS.unassignedDelivery).id).partner_id === null,
      'known unassigned delivery',
    );
    check(
      edge(EDGE_CASE_IDS.cancelledAndRefunded).status === 'cancelled' &&
        payments.get(EDGE_CASE_IDS.cancelledAndRefunded)?.[0]?.status === 'refunded',
      'known cancelled and refunded order',
    );
    check(
      edge(EDGE_CASE_IDS.injectionNote).notes === INJECTION_NOTE,
      'known injection note is preserved verbatim as data',
    );
    return { counts: seedCounts(data), contentHash: seedContentHash(data) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = new AppError(
      ErrorCode.INTERNAL,
      'Seed invariant checker found invalid stored data',
      'Inspect the stored row schemas and regenerate the synthetic dataset',
    );
    failure.cause = error;
    throw failure;
  }
}
