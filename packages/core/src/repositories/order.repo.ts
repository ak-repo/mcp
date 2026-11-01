import {
  decodeCursor,
  OrderEventSchema,
  OrderItemSchema,
  OrderSchema,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderSearchFilters,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { dateBounds, many, one, page } from './common.js';

export const ORDER_COLUMNS =
  'id, customer_id, restaurant_id, address_id, status, subtotal_paise, tax_paise, delivery_fee_paise, platform_fee_paise, discount_paise, total_paise, notes, cancel_reason, placed_at, updated_at';
export function createOrderRepository(db: DatabaseConnection) {
  return {
    insert(value: Order) {
      const row = OrderSchema.parse(value);
      const columns = Object.keys(OrderSchema.shape);
      db.prepare(
        `INSERT INTO orders (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...columns.map((key) => row[key as keyof Order]));
    },
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
        'SELECT id, order_id, from_status, to_status, actor, reason, at FROM order_events WHERE order_id = ? ORDER BY at, rowid',
        [id],
        OrderEventSchema,
      ),
    list(filters: OrderSearchFilters) {
      const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
      const bounds = dateBounds(filters.from, filters.to);
      return page(
        many(
          db,
          `SELECT ${ORDER_COLUMNS} FROM orders
        WHERE (? IS NULL OR status = ?) AND (? IS NULL OR customer_id = ?) AND (? IS NULL OR restaurant_id = ?)
          AND (? IS NULL OR julianday(placed_at) >= julianday(?)) AND (? IS NULL OR ${bounds.exclusive ? 'julianday(placed_at) < julianday(?)' : 'julianday(placed_at) <= julianday(?)'})
          AND (? IS NULL OR instr(lower(id), lower(?)) > 0 OR instr(lower(coalesce(notes, '')), lower(?)) > 0
            OR EXISTS (SELECT 1 FROM customers c WHERE c.id = orders.customer_id AND instr(lower(c.name), lower(?)) > 0)
            OR EXISTS (SELECT 1 FROM restaurants r WHERE r.id = orders.restaurant_id AND instr(lower(r.name), lower(?)) > 0))
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
            filters.q ?? null,
            filters.q ?? null,
            filters.q ?? null,
            filters.q ?? null,
            filters.q ?? null,
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
    insertItem(value: OrderItem) {
      const row = OrderItemSchema.parse(value);
      db.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?, ?, ?)').run(
        row.id,
        row.order_id,
        row.menu_item_id,
        row.name_snapshot,
        row.unit_price_paise,
        row.qty,
      );
    },
    insertEvent(event: OrderEvent) {
      const row = OrderEventSchema.parse(event);
      db.prepare(
        'INSERT INTO order_events (id, order_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.order_id, row.from_status, row.to_status, row.actor, row.reason, row.at);
    },
  };
}
