import {
  DeliveryPartnerSchema,
  DeliverySchema,
  type Delivery,
  type DeliveryPartner,
  type PartnerListFilters,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import { idCursor, many, one, page } from './common.js';
export const DELIVERY_COLUMNS =
  'id, order_id, partner_id, status, eta_min, assigned_at, picked_up_at, delivered_at';
const partnerColumns = 'id, name, phone, vehicle, status';
export function createDeliveryRepository(db: DatabaseConnection) {
  return {
    forOrder: (id: string) =>
      many(
        db,
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE order_id = ? ORDER BY id`,
        [id],
        DeliverySchema,
      ),
    activeForPartner: (partnerId: string, excludingId: string) =>
      many(
        db,
        `SELECT ${DELIVERY_COLUMNS} FROM deliveries WHERE partner_id = ? AND id <> ? AND status NOT IN ('delivered', 'cancelled')`,
        [partnerId, excludingId],
        DeliverySchema,
      ),
    partner: (id: string) =>
      one(
        db,
        `SELECT ${partnerColumns} FROM delivery_partners WHERE id = ?`,
        [id],
        DeliveryPartnerSchema,
      ),
    partners(filters: PartnerListFilters) {
      const cursor = idCursor(filters.cursor);
      return page(
        many(
          db,
          `SELECT ${partnerColumns} FROM delivery_partners
        WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
          [filters.status ?? null, filters.status ?? null, cursor, cursor, filters.limit + 1],
          DeliveryPartnerSchema,
        ),
        filters.limit,
      );
    },
    update(delivery: Delivery) {
      const row = DeliverySchema.parse(delivery);
      db.prepare(
        'UPDATE deliveries SET partner_id = ?, status = ?, eta_min = ?, assigned_at = ?, picked_up_at = ?, delivered_at = ? WHERE id = ?',
      ).run(
        row.partner_id,
        row.status,
        row.eta_min,
        row.assigned_at,
        row.picked_up_at,
        row.delivered_at,
        row.id,
      );
    },
    updatePartner(partner: DeliveryPartner) {
      const row = DeliveryPartnerSchema.parse(partner);
      db.prepare('UPDATE delivery_partners SET status = ? WHERE id = ?').run(row.status, row.id);
    },
  };
}
