import { createSeedData } from '../seed/factories.js';
import { insertSeedData } from '../seed/storage.js';
import { checkSeedInvariants } from '../seed/invariants.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorSchema,
  AppError,
  DeliveryStatusSchema,
  ErrorCode,
  ErrorCodeSchema,
  OrderStatusSchema,
  PartnerStatusSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  ToolCallStatusSchema,
} from '@foodops/shared';
import { openReadOnly, openWritable, type DatabaseConnection } from './connection.js';
import { DEFAULT_MIGRATIONS_DIRECTORY, migrate } from './migrate.js';

type Row = Record<string, string | number | null>;
const at = '2026-11-01T12:00:00.000Z';
const rows: Record<string, Row> = {
  customers: {
    id: 'C-1',
    name: 'Customer',
    phone: '123',
    email: 'ops@example.com',
    created_at: at,
  },
  addresses: {
    id: 'A-1',
    customer_id: 'C-1',
    label: 'Home',
    line1: '1 Street',
    area: 'Central',
    city: 'Pune',
    pincode: '411001',
  },
  restaurants: {
    id: 'R-1',
    name: 'Cafe',
    cuisine: 'Indian',
    city: 'Pune',
    area: 'Central',
    rating: 4.2,
    prep_time_min: 20,
    is_open: 1,
  },
  menu_items: {
    id: 'M-1',
    restaurant_id: 'R-1',
    name: 'Meal',
    price_paise: 100,
    is_veg: 1,
    is_available: 1,
  },
  orders: {
    id: 'O-1',
    customer_id: 'C-1',
    restaurant_id: 'R-1',
    address_id: 'A-1',
    status: 'placed',
    subtotal_paise: 100,
    tax_paise: 5,
    delivery_fee_paise: 0,
    platform_fee_paise: 0,
    discount_paise: 0,
    total_paise: 105,
    notes: null,
    cancel_reason: null,
    placed_at: at,
    updated_at: at,
  },
  order_items: {
    id: 'OI-1',
    order_id: 'O-1',
    menu_item_id: 'M-1',
    name_snapshot: 'Meal',
    unit_price_paise: 100,
    qty: 1,
  },
  order_events: {
    id: 'E-1',
    order_id: 'O-1',
    from_status: null,
    to_status: 'placed',
    actor: 'system',
    reason: 'Placed',
    at,
  },
  delivery_partners: {
    id: 'DP-1',
    name: 'Partner',
    phone: '123',
    vehicle: 'bike',
    status: 'available',
  },
  deliveries: {
    id: 'D-1',
    order_id: 'O-1',
    partner_id: null,
    status: 'pending',
    eta_min: null,
    assigned_at: null,
    picked_up_at: null,
    delivered_at: null,
  },
  payments: {
    id: 'P-1',
    order_id: 'O-1',
    method: 'upi',
    status: 'paid',
    amount_paise: 105,
    txn_ref: null,
  },
  refunds: {
    id: 'RF-1',
    order_id: 'O-1',
    payment_id: 'P-1',
    amount_paise: 1,
    reason: 'Refund',
    actor: 'ops',
    idempotency_key: 'K-1',
    created_at: at,
  },
  invoices: {
    id: 'I-1',
    order_id: 'O-1',
    invoice_no: 'INV-20261101-0001',
    subtotal_paise: 100,
    tax_paise: 5,
    fees_paise: 0,
    discount_paise: 0,
    total_paise: 105,
    issued_at: at,
  },
  tool_call_log: {
    id: 'T-1',
    session_id: null,
    tool: 'get_order',
    args_json: '{}',
    status: 'success',
    error_code: null,
    latency_ms: 1,
    actor: 'ai',
    at,
  },
  idempotency_keys: {
    key: 'K-1',
    operation: 'issue_refund',
    request_hash: 'a'.repeat(64),
    response_json: '{}',
    created_at: at,
  },
};

function insert(db: DatabaseConnection, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...Object.values(row));
}

let directory: string;
let databasePath: string;
let db: DatabaseConnection;
const extraConnections: DatabaseConnection[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'foodops-db-'));
  databasePath = join(directory, 'foodops.sqlite');
  db = openWritable(databasePath);
});
afterEach(() => {
  for (const connection of extraConnections.splice(0)) if (connection.open) connection.close();
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(): void {
  migrate(db);
  db.transaction(() => {
    for (const [table, row] of Object.entries(rows)) insert(db, table, row);
  })();
}

function migrationDirectory(): string {
  const path = join(directory, 'migrations');
  mkdirSync(path);
  copyFileSync(join(DEFAULT_MIGRATIONS_DIRECTORY, '0001_init.sql'), join(path, '0001_init.sql'));
  return path;
}

describe('connections', () => {
  it('sets WAL, foreign keys, busy timeout and NORMAL synchronization on both handles', () => {
    const ro = openReadOnly(databasePath);
    extraConnections.push(ro);
    for (const handle of [db, ro]) {
      expect(handle.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(handle.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(handle.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(handle.pragma('synchronous', { simple: true })).toBe(1);
    }
    expect(ro.readonly).toBe(true);
    expect(ro.pragma('query_only', { simple: true })).toBe(1);
  });

  it('allows read-only queries, rejects writes, and never creates missing read-only files', () => {
    fixture();
    const ro = openReadOnly(databasePath);
    extraConnections.push(ro);
    expect(ro.prepare('SELECT name FROM customers').get()).toEqual({ name: 'Customer' });
    expect(() => ro.exec("UPDATE customers SET name = 'Changed'")).toThrow(/readonly/i);
    expect(() => ro.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow(/readonly/i);
    expect(() => openReadOnly(join(directory, 'missing.sqlite'))).toThrow();
    expect(() => openWritable(' ')).toThrow(AppError);
    expect(() => openReadOnly('')).toThrow(AppError);
  });
});

describe('numbered migrations', () => {
  it('creates every table and required index once, preserving data and checksums on repeat runs', () => {
    fixture();
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    expect(migrate(db)).toEqual([]);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(history);
    expect(db.prepare('SELECT name FROM customers').get()).toEqual({ name: 'Customer' });
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      [...Object.keys(rows), 'schema_migrations', 'change_log', 'sqlite_sequence'].sort(),
    );
    const indexes = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_orders_status_placed_at',
        'idx_orders_customer_id',
        'idx_deliveries_partner_status',
        'idx_order_events_order_id',
        'idx_tool_call_log_at',
      ]),
    );
    const secondWriter = openWritable(databasePath);
    extraConnections.push(secondWriter);
    expect(migrate(secondWriter)).toEqual([]);
  });

  it('refuses changed applied SQL before running any pending migration', () => {
    const path = migrationDirectory();
    migrate(db, path);
    const file = join(path, '0001_init.sql');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n-- changed\n');
    writeFileSync(join(path, '0002_next.sql'), 'CREATE TABLE should_not_exist (id INTEGER);');
    expect(() => migrate(db, path)).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'should_not_exist'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
  });

  it('refuses a missing applied file', () => {
    const path = migrationDirectory();
    migrate(db, path);
    rmSync(join(path, '0001_init.sql'));
    expect(() => migrate(db, path)).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
  });

  it('rolls back failed migration DDL and data, then permits a corrected unapplied file', () => {
    const path = migrationDirectory();
    migrate(db, path);
    const file = join(path, '0002_next.sql');
    writeFileSync(
      file,
      'CREATE TABLE rolled_back (id INTEGER); INSERT INTO rolled_back VALUES (1); INSERT INTO missing_table VALUES (1);',
    );
    expect(() => migrate(db, path)).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
    expect(db.inTransaction).toBe(false);
    writeFileSync(file, 'CREATE TABLE committed (id INTEGER);');
    expect(migrate(db, path)).toEqual(['0002_next.sql']);
    expect(migrate(db, path)).toEqual([]);
  });

  it('rejects duplicate numeric prefixes and out-of-order pending files', () => {
    const path = migrationDirectory();
    writeFileSync(join(path, '0001_duplicate.sql'), 'SELECT 1;');
    expect(() => migrate(db, path)).toThrow(AppError);
    rmSync(join(path, '0001_duplicate.sql'));
    writeFileSync(join(path, '0003_later.sql'), 'SELECT 1;');
    migrate(db, path);
    writeFileSync(join(path, '0002_earlier.sql'), 'SELECT 1;');
    expect(() => migrate(db, path)).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
  });

  it('rejects read-only connections and caller-owned transactions', () => {
    migrate(db);
    const ro = openReadOnly(databasePath);
    extraConnections.push(ro);
    expect(() => migrate(ro)).toThrow(AppError);
    expect(() => db.transaction(() => migrate(db))()).toThrow(AppError);
    expect(db.inTransaction).toBe(false);
  });
});

describe('database constraints', () => {
  beforeEach(fixture);

  it('enforces every foreign key on inserts/updates and prevents deleting referenced parents', () => {
    for (const table of Object.keys(rows)) {
      const foreignKeys = db
        .prepare<[], { from: string }>(`PRAGMA foreign_key_list(${table})`)
        .all();
      for (const fk of foreignKeys) {
        expect(() =>
          db.prepare(`UPDATE ${table} SET ${fk.from} = ?`).run('missing-parent'),
        ).toThrow(table === 'invoices' ? /immutable/ : /FOREIGN KEY/);
      }
    }
    expect(() => db.exec("DELETE FROM customers WHERE id = 'C-1'")).toThrow(/FOREIGN KEY/);
  });

  it('rejects negative, fractional and unsafe money in every money column', () => {
    for (const [table, row] of Object.entries(rows)) {
      for (const column of Object.keys(row).filter((name) => name.endsWith('_paise'))) {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() => db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value)).toThrow();
        }
      }
    }
    expect(() => db.exec('UPDATE refunds SET amount_paise = 0')).toThrow(/CHECK/);
    expect(() => db.exec('UPDATE order_items SET qty = 0')).toThrow(/CHECK/);
  });

  it('keeps SQL enum constraints aligned with every shared enum', () => {
    const cases = [
      ['orders', 'status', OrderStatusSchema.options],
      ['order_events', 'from_status', OrderStatusSchema.options],
      ['order_events', 'to_status', OrderStatusSchema.options],
      ['order_events', 'actor', ActorSchema.options],
      ['deliveries', 'status', DeliveryStatusSchema.options],
      ['delivery_partners', 'status', PartnerStatusSchema.options],
      ['payments', 'method', PaymentMethodSchema.options],
      ['payments', 'status', PaymentStatusSchema.options],
      ['refunds', 'actor', ActorSchema.options],
      ['tool_call_log', 'actor', ActorSchema.options],
      ['tool_call_log', 'status', ToolCallStatusSchema.options],
      ['tool_call_log', 'error_code', ErrorCodeSchema.options],
    ] as const;
    for (const [table, column, values] of cases) {
      for (const value of values) db.prepare(`UPDATE ${table} SET ${column} = ?`).run(value);
      expect(() => db.prepare(`UPDATE ${table} SET ${column} = ?`).run('invalid')).toThrow(/CHECK/);
    }
  });

  it('enforces invoice/order uniqueness, refund idempotency and idempotency key uniqueness', () => {
    const invoice = rows['invoices'];
    const refund = rows['refunds'];
    const key = rows['idempotency_keys'];
    if (!invoice || !refund || !key) throw new Error('Missing test fixture');
    expect(() =>
      insert(db, 'invoices', { ...invoice, id: 'I-2', invoice_no: 'INV-20261101-0002' }),
    ).toThrow(/UNIQUE/);
    expect(() => insert(db, 'refunds', { ...refund, id: 'RF-2' })).toThrow(/UNIQUE/);
    expect(() => insert(db, 'idempotency_keys', key)).toThrow(/UNIQUE/);
    insert(db, 'refunds', { ...refund, id: 'RF-3', idempotency_key: null });
    insert(db, 'refunds', { ...refund, id: 'RF-4', idempotency_key: null });
  });

  it('rejects invalid booleans, counts, JSON, hashes and invoice numbering', () => {
    for (const sql of [
      'UPDATE restaurants SET is_open = 2',
      'UPDATE restaurants SET rating = 6',
      'UPDATE menu_items SET is_veg = -1',
      'UPDATE menu_items SET is_available = 2',
      'UPDATE deliveries SET eta_min = -1',
      'UPDATE tool_call_log SET latency_ms = -1',
      "UPDATE tool_call_log SET args_json = 'broken'",
      "UPDATE idempotency_keys SET response_json = 'broken'",
      "UPDATE idempotency_keys SET request_hash = 'bad'",
    ])
      expect(() => db.exec(sql)).toThrow(/CHECK/);
  });
});

describe('integrity migration', () => {
  it('rejects duplicate deliveries and payments and all invoice changes', () => {
    fixture();
    for (const table of ['deliveries', 'payments'])
      expect(() => insert(db, table, { ...rows[table], id: 'duplicate' })).toThrow(/UNIQUE/);
    for (const sql of ['UPDATE invoices SET total_paise = total_paise', 'DELETE FROM invoices'])
      expect(() => db.exec(sql)).toThrow(/immutable/);
    for (const invoice_no of ['INV-invalid', 'INV-20261101-0001x']) {
      db.prepare(
        'INSERT INTO orders SELECT ?, customer_id, restaurant_id, address_id, status, subtotal_paise, tax_paise, delivery_fee_paise, platform_fee_paise, discount_paise, total_paise, notes, cancel_reason, placed_at, updated_at FROM orders LIMIT 1',
      ).run(invoice_no);
      expect(() =>
        insert(db, 'invoices', {
          ...rows['invoices'],
          id: invoice_no,
          order_id: invoice_no,
          invoice_no,
        }),
      ).toThrow(/CHECK/);
    }
    const indexes = db.prepare('PRAGMA index_list(payments)').all() as {
      name: string;
      unique: number;
    }[];
    expect(indexes.filter((row) => row.name === 'idx_payments_order_id')).toEqual([
      expect.objectContaining({ unique: 1 }),
    ]);
  });
  it('upgrades a populated v1 database without changing content and protects the new checksum', () => {
    const path = migrationDirectory();
    migrate(db, path);
    db.transaction(() => insertSeedData(db, createSeedData()))();
    const before = checkSeedInvariants(db);
    copyFileSync(
      join(DEFAULT_MIGRATIONS_DIRECTORY, '0002_integrity.sql'),
      join(path, '0002_integrity.sql'),
    );
    expect(migrate(db, path)).toEqual(['0002_integrity.sql']);
    expect(checkSeedInvariants(db)).toEqual(before);
    expect(migrate(db, path)).toEqual([]);
    writeFileSync(
      join(path, '0002_integrity.sql'),
      readFileSync(join(path, '0002_integrity.sql'), 'utf8') + '\n-- changed',
    );
    expect(() => migrate(db, path)).toThrow(expect.objectContaining({ code: ErrorCode.CONFLICT }));
  });
  it.each(['deliveries', 'payments'])(
    'rolls back the integrity migration when legacy %s contain duplicates',
    (table) => {
      const path = migrationDirectory();
      migrate(db, path);
      db.transaction(() => {
        for (const [table, row] of Object.entries(rows)) insert(db, table, row);
      })();
      insert(db, table, { ...rows[table], id: 'duplicate' });
      copyFileSync(
        join(DEFAULT_MIGRATIONS_DIRECTORY, '0002_integrity.sql'),
        join(path, '0002_integrity.sql'),
      );
      expect(() => migrate(db, path)).toThrow(/UNIQUE/);
      expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='idx_deliveries_order_id'").get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()).toEqual([]);
    },
  );
});

describe('change-log upgrade', () => {
  it('adds triggers to an existing seeded v2 database without backfilling, protects checksums', () => {
    const path = migrationDirectory();
    copyFileSync(
      join(DEFAULT_MIGRATIONS_DIRECTORY, '0002_integrity.sql'),
      join(path, '0002_integrity.sql'),
    );
    migrate(db, path);
    db.transaction(() => insertSeedData(db, createSeedData()))();
    const hash = checkSeedInvariants(db).contentHash;
    copyFileSync(
      join(DEFAULT_MIGRATIONS_DIRECTORY, '0003_change_log.sql'),
      join(path, '0003_change_log.sql'),
    );
    expect(migrate(db, path)).toEqual(['0003_change_log.sql']);
    expect(checkSeedInvariants(db).contentHash).toBe(hash);
    expect(db.prepare('SELECT count(*) AS n FROM change_log').get()).toEqual({ n: 0 });
    db.prepare(
      'UPDATE payments SET status=status WHERE id=(SELECT id FROM payments LIMIT 1)',
    ).run();
    expect(db.prepare('SELECT entity,op FROM change_log').all()).toEqual([
      { entity: 'payment', op: 'update' },
    ]);
    writeFileSync(
      join(path, '0003_change_log.sql'),
      readFileSync(join(path, '0003_change_log.sql'), 'utf8') + '\n-- tampered',
    );
    expect(() => migrate(db, path)).toThrow(/changed/);
  });
});

it('preserves operational invariants after placing and cancelling a live order on a seed', async () => {
  const { seedDatabase } = await import('../seed/seed.js');
  const { createServices } = await import('../services/index.js');
  seedDatabase(db);
  const read = openReadOnly(databasePath);
  extraConnections.push(read);
  const services = createServices({ write: db, read });
  const restaurant = services.catalog.searchRestaurants({ openNow: true }).items[0]!;
  const address = services.catalog.placementCustomers()[0]!;
  const item = services.catalog.getMenu({ restaurantId: restaurant.id, availableOnly: true })
    .items[0]!;
  const result = services.order.placeOrder({
    customerId: address.customer_id,
    addressId: address.id,
    restaurantId: restaurant.id,
    items: [{ menuItemId: item.id, qty: 2 }],
    paymentMethod: 'upi',
    actor: 'system',
    reason: 'Live invariant test',
  });
  services.order.executeCancel({
    orderId: result.order.id,
    actor: 'system',
    reason: 'Live cancellation',
  });
  expect(() =>
    checkSeedInvariants(db, { operational: true, now: '2026-11-03T00:00:00.000Z' }),
  ).not.toThrow();
});
