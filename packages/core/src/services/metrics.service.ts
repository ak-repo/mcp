import {
  AppError,
  ErrorCode,
  formatINR,
  SalesSummaryFiltersSchema,
  SalesSummarySchema,
  type Delivery,
  type Order,
  type SummaryMetrics,
} from '@foodops/shared';
import { keys, parse, singleton, type ServiceContext } from './context.js';
import type { MetricsInput } from './types.js';

function summarize(orders: Order[], deliveries: Map<string, Delivery>): SummaryMetrics {
  const delivered = orders.filter((order) => order.status === 'delivered');
  const gmv = delivered.reduce((sum, order) => sum + BigInt(order.total_paise), 0n);
  if (gmv > BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError(
      ErrorCode.LIMIT_EXCEEDED,
      'Summary money exceeds safe integer paise',
      'Narrow the summary date range',
    );
  const count = BigInt(delivered.length);
  const aov = count === 0n ? 0 : Number((gmv * 2n + count) / (count * 2n));
  const durations: number[] = [];
  for (const order of delivered) {
    const delivery = deliveries.get(order.id);
    if (delivery?.delivered_at) {
      const duration = Date.parse(delivery.delivered_at) - Date.parse(order.placed_at);
      if (duration < 0)
        throw new AppError(
          ErrorCode.CONFLICT,
          'Delivery predates order placement',
          'Repair the delivery timestamp before calculating metrics',
        );
      durations.push(duration / 60000);
    }
  }
  return {
    orders: orders.length,
    gmv_paise: Number(gmv),
    gmv_display: formatINR(Number(gmv)),
    avg_order_value_paise: aov,
    avg_order_value_display: formatINR(aov),
    cancel_rate:
      orders.length === 0
        ? 0
        : orders.filter((order) => order.status === 'cancelled').length / orders.length,
    avg_delivery_time_min:
      durations.length === 0
        ? null
        : durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
  };
}
export function createMetricsService(context: ServiceContext) {
  return {
    getSalesSummary(input: MetricsInput) {
      keys(input, ['from', 'to', 'groupBy']);
      const filters = parse(
        SalesSummaryFiltersSchema,
        { from: input.from, to: input.to, group_by: input.groupBy },
        'summary filters',
      );
      return context.read((repos) => {
        const rows = repos.metrics.rows(filters.from, filters.to);
        const byOrder = new Map<string, Delivery[]>();
        for (const delivery of rows.deliveries) {
          const list = byOrder.get(delivery.order_id) ?? [];
          list.push(delivery);
          byOrder.set(delivery.order_id, list);
        }
        const deliveries = new Map<string, Delivery>();
        for (const [orderId, list] of byOrder) {
          const delivery = singleton(list, 'delivery');
          if (delivery) deliveries.set(orderId, delivery);
        }
        const groups = new Map<string, Order[]>();
        for (const order of rows.orders) {
          const key =
            filters.group_by === 'day'
              ? new Date(order.placed_at).toISOString().slice(0, 10)
              : filters.group_by === 'restaurant'
                ? order.restaurant_id
                : order.status;
          const group = groups.get(key) ?? [];
          group.push(order);
          groups.set(key, group);
        }
        return SalesSummarySchema.parse({
          ...filters,
          totals: summarize(rows.orders, deliveries),
          groups: [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, orders]) => ({ key, ...summarize(orders, deliveries) })),
        });
      });
    },
  };
}
