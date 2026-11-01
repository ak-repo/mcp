import { createHash } from 'node:crypto';
import {
  AddressSchema,
  AppError,
  CustomerSchema,
  DeliveryPartnerSchema,
  DeliverySchema,
  ErrorCode,
  IdempotencyKeySchema,
  InvoiceSchema,
  MenuItemSchema,
  OrderEventSchema,
  OrderItemSchema,
  OrderSchema,
  PaymentSchema,
  RefundSchema,
  RestaurantSchema,
  ToolCallLogSchema,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import type { SeedData } from './factories.js';

const schemas = {
  customers: CustomerSchema,
  addresses: AddressSchema,
  restaurants: RestaurantSchema,
  menu_items: MenuItemSchema,
  orders: OrderSchema,
  order_items: OrderItemSchema,
  order_events: OrderEventSchema,
  delivery_partners: DeliveryPartnerSchema,
  deliveries: DeliverySchema,
  payments: PaymentSchema,
  refunds: RefundSchema,
  invoices: InvoiceSchema,
  tool_call_log: ToolCallLogSchema,
  idempotency_keys: IdempotencyKeySchema,
} as const;
export type SeedTable = keyof SeedData;
// This order also satisfies all foreign-key dependencies during insertion.
export const SEED_TABLES = Object.keys(schemas) as SeedTable[];
export type SeedCounts = Record<SeedTable, number>;
const booleanFields: Partial<Record<SeedTable, readonly string[]>> = {
  restaurants: ['is_open'],
  menu_items: ['is_veg', 'is_available'],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a seed row');
  return Object.fromEntries(Object.entries(value));
}
export function readSeedData(db: DatabaseConnection): SeedData {
  const entries = SEED_TABLES.map((table) => {
    const schema = schemas[table];
    const columns = Object.keys(schema.shape);
    const rows = db
      .prepare<[], unknown>(
        `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${table === 'idempotency_keys' ? 'key' : 'id'}`,
      )
      .all();
    const parsed = rows.map((raw) => {
      const row = record(raw);
      for (const column of booleanFields[table] ?? []) {
        if (row[column] !== 0 && row[column] !== 1)
          throw new Error(`Invalid stored boolean: ${table}.${column}`);
        row[column] = row[column] === 1;
      }
      return schema.parse(row);
    });
    return [table, parsed];
  });
  return Object.fromEntries(entries) as unknown as SeedData;
}
export function insertSeedData(db: DatabaseConnection, data: SeedData): void {
  if (!db.inTransaction)
    throw new AppError(
      ErrorCode.INTERNAL,
      'Seed insertion requires a transaction',
      'Use seedDatabase to insert the complete dataset atomically',
    );
  for (const table of SEED_TABLES) {
    const schema = schemas[table];
    const columns = Object.keys(schema.shape);
    const statement = db.prepare<unknown[]>(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    );
    for (const raw of data[table]) {
      const row = record(schema.parse(raw));
      statement.run(
        ...columns.map((column) =>
          typeof row[column] === 'boolean' ? Number(row[column]) : row[column],
        ),
      );
    }
  }
}
export function seedCounts(data: SeedData): SeedCounts {
  return Object.fromEntries(SEED_TABLES.map((table) => [table, data[table].length])) as SeedCounts;
}
/** Hash logical application content, not SQLite file bytes or installation-time migration metadata. */
export function seedContentHash(data: SeedData): string {
  const content = SEED_TABLES.map((table) => {
    const columns = Object.keys(schemas[table].shape);
    const primary = table === 'idempotency_keys' ? 'key' : 'id';
    const rows = data[table]
      .map(record)
      .sort((a, b) =>
        String(a[primary]) < String(b[primary])
          ? -1
          : String(a[primary]) > String(b[primary])
            ? 1
            : 0,
      );
    return {
      table,
      columns,
      rows: rows.map((row) =>
        columns.map((column) =>
          typeof row[column] === 'boolean' ? Number(row[column]) : row[column],
        ),
      ),
    };
  });
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
