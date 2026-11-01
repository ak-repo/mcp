import {
  AddressSchema,
  CustomerSchema,
  MenuItemSchema,
  RestaurantSchema,
  type MenuListFilters,
  type RestaurantListFilters,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { idCursor, many, one, page } from './common.js';

const restaurantColumns = 'id, name, cuisine, city, area, rating, prep_time_min, is_open';
const menuColumns = 'id, restaurant_id, name, price_paise, is_veg, is_available';
export function createCatalogRepository(db: DatabaseConnection) {
  return {
    restaurant: (id: string) =>
      one(db, `SELECT ${restaurantColumns} FROM restaurants WHERE id = ?`, [id], RestaurantSchema, [
        'is_open',
      ]),
    customer: (id: string) =>
      one(
        db,
        'SELECT id, name, phone, email, created_at FROM customers WHERE id = ?',
        [id],
        CustomerSchema,
      ),
    address: (id: string) =>
      one(
        db,
        'SELECT id, customer_id, label, line1, area, city, pincode FROM addresses WHERE id = ?',
        [id],
        AddressSchema,
      ),
    restaurants(filters: RestaurantListFilters) {
      const cursor = idCursor(filters.cursor);
      const rows = many(
        db,
        `SELECT ${restaurantColumns} FROM restaurants
        WHERE (? IS NULL OR instr(lower(name), lower(?)) > 0 OR instr(lower(cuisine), lower(?)) > 0 OR instr(lower(area), lower(?)) > 0)
          AND (? IS NULL OR lower(cuisine) = lower(?)) AND (? IS NULL OR lower(area) = lower(?))
          AND (? IS NULL OR is_open = ?) AND (? IS NULL OR id < ?)
        ORDER BY id DESC LIMIT ?`,
        [
          filters.query ?? null,
          filters.query ?? null,
          filters.query ?? null,
          filters.query ?? null,
          filters.cuisine ?? null,
          filters.cuisine ?? null,
          filters.area ?? null,
          filters.area ?? null,
          filters.open_now === undefined ? null : Number(filters.open_now),
          filters.open_now === undefined ? null : Number(filters.open_now),
          cursor,
          cursor,
          filters.limit + 1,
        ],
        RestaurantSchema,
        ['is_open'],
      );
      return page(rows, filters.limit);
    },
    menu(filters: MenuListFilters) {
      const cursor = idCursor(filters.cursor);
      return page(
        many(
          db,
          `SELECT ${menuColumns} FROM menu_items WHERE restaurant_id = ?
        AND (? = 0 OR is_veg = 1) AND (? = 0 OR is_available = 1) AND (? IS NULL OR id < ?)
        ORDER BY id DESC LIMIT ?`,
          [
            filters.restaurant_id,
            Number(filters.veg_only ?? false),
            Number(filters.available_only ?? false),
            cursor,
            cursor,
            filters.limit + 1,
          ],
          MenuItemSchema,
          ['is_veg', 'is_available'],
        ),
        filters.limit,
      );
    },
  };
}
