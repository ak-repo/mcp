import { DeliverySchema, OrderSchema } from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { dateBounds, many } from './common.js';
import { ORDER_COLUMNS } from './order.repo.js';
import { DELIVERY_COLUMNS } from './delivery.repo.js';
export function createMetricsRepository(db: DatabaseConnection) {
  return {
    rows(from: string, to: string) {
      const bounds = dateBounds(from, to);
      return {
        orders: many(
          db,
          `SELECT ${ORDER_COLUMNS} FROM orders WHERE julianday(placed_at) >= julianday(?) AND julianday(placed_at) ${bounds.exclusive ? '<' : '<='} julianday(?) ORDER BY placed_at, id`,
          [bounds.from, bounds.to],
          OrderSchema,
        ),
        deliveries: many(
          db,
          `SELECT ${DELIVERY_COLUMNS.split(', ')
            .map((c) => 'd.' + c)
            .join(', ')} FROM deliveries d
          JOIN orders o ON o.id = d.order_id WHERE julianday(o.placed_at) >= julianday(?) AND julianday(o.placed_at) ${bounds.exclusive ? '<' : '<='} julianday(?) ORDER BY d.id`,
          [bounds.from, bounds.to],
          DeliverySchema,
        ),
      };
    },
  };
}
