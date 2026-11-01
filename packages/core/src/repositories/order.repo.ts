import {
  decodeCursor,
  OrderEventSchema,
  OrderItemSchema,
  OrderSchema,
  type Order,
  type OrderEvent,
  type OrderListFilters,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { dateBounds, many, one, page } from './common.js';

export const ORDER_COLUMNS =
  'id, customer_id, restaurant_id, address_id, status, subtotal_paise, tax_paise, delivery_fee_paise, platform_fee_paise, discount_paise, total_paise, notes, cancel_reason, placed_at, updated_at';
export function createOrderRepository(db: DatabaseConnection) {
  return {
    get: (id: string) =>
      one(db, `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`, [id], OrderSchema),
    items: (id: string) =>
      many(
        db,
        'SELECT id, order_id, menu_item_id, name_snapshot, unit_price_paise, qty FROM order_items WHERE order_id = ? ORDER BY id',
        [id],
        OrderItemSchema,
      ),
    events: (id: string) =>
      many(
        db,
        'SELECT id, order_id, from_status, to_status, actor, reason, at FROM order_events WHERE order_id = ? ORDER BY at, id',
        [id],
        OrderEventSchema,
      ),
    list(filters: OrderListFilters) {
      const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
      const bounds = dateBounds(filters.from, filters.to);
      return page(
        many(
          db,
          `SELECT ${ORDER_COLUMNS} FROM orders
        WHERE (? IS NULL OR status = ?) AND (? IS NULL OR customer_id = ?) AND (? IS NULL OR restaurant_id = ?)
          AND (? IS NULL OR julianday(placed_at) >= julianday(?)) AND (? IS NULL OR ${bounds.exclusive ? 'julianday(placed_at) < julianday(?)' : 'julianday(placed_at) <= julianday(?)'})
          AND (? IS NULL OR placed_at < ? OR (placed_at = ? AND id < ?))
        ORDER BY placed_at DESC, id DESC LIMIT ?`,
          [
            filters.status ?? null,
            filters.status ?? null,
            filters.customer_id ?? null,
            filters.customer_id ?? null,
            filters.restaurant_id ?? null,
            filters.restaurant_id ?? null,
            bounds.from,
            bounds.from,
            bounds.to,
            bounds.to,
            cursor?.placed_at ?? null,
            cursor?.placed_at ?? null,
            cursor?.placed_at ?? null,
            cursor?.id ?? null,
            filters.limit + 1,
          ],
          OrderSchema,
        ),
        filters.limit,
        (row) => row.placed_at,
      );
    },
    update(order: Order) {
      const row = OrderSchema.parse(order);
      db.prepare(
        'UPDATE orders SET status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?',
      ).run(row.status, row.cancel_reason, row.updated_at, row.id);
    },
    insertEvent(event: OrderEvent) {
      const row = OrderEventSchema.parse(event);
      db.prepare(
        'INSERT INTO order_events (id, order_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.order_id, row.from_status, row.to_status, row.actor, row.reason, row.at);
    },
  };
}
