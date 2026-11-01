import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, ErrorCode, OrderStatusSchema } from '@foodops/shared';
import { openReadOnly, openWritable, type DatabaseConnection } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createServices } from '../services/index.js';
import { createSeedData, EDGE_CASE_IDS, INJECTION_NOTE, SEED_NOW } from './factories.js';
import { checkSeedInvariants } from './invariants.js';
import { resolveSeedPath, resetDatabaseFile, runSeedCli, seedDatabase, seedFile } from './seed.js';
import { readSeedData, seedContentHash, SEED_TABLES } from './storage.js';

let directory: string;
const connections: DatabaseConnection[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'foodops-seed-test-'));
});
afterEach(() => {
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
function database(name = 'seed.sqlite'): DatabaseConnection {
  const db = openWritable(join(directory, name));
  connections.push(db);
  return db;
}
function seeded(): DatabaseConnection {
  const db = database();
  seedDatabase(db);
  return db;
}

// Hash storage values independently of the production hashing implementation.
function persistedContent(db: DatabaseConnection): string {
  return JSON.stringify(
    SEED_TABLES.map((table) => ({
      table,
      rows: db
        .prepare(`SELECT * FROM ${table} ORDER BY ${table === 'idempotency_keys' ? 'key' : 'id'}`)
        .all(),
    })),
  );
}

describe('deterministic dataset', () => {
  it('creates two independent seeds with identical rows, counts and content hashes despite different wall clocks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T00:00:00.000Z'));
    const first = database('one.sqlite');
    const report = seedDatabase(first);
    vi.setSystemTime(new Date('2030-07-12T20:00:00.000Z'));
    const second = database('two.sqlite');
    const repeated = seedDatabase(second);
    expect(repeated.counts).toEqual(report.counts);
    expect(repeated.contentHash).toBe(report.contentHash);
    expect(persistedContent(second)).toBe(persistedContent(first));
    expect(report.anchor).toBe(SEED_NOW);
    expect(report.counts).toMatchObject({
      customers: 25,
      restaurants: 12,
      menu_items: 80,
      delivery_partners: 10,
      orders: 200,
      deliveries: 200,
      payments: 200,
      invoices: 165,
    });
    expect(report.counts.addresses).toBeGreaterThanOrEqual(25);
    expect(report.counts.addresses).toBeLessThanOrEqual(50);
    expect(seedContentHash(createSeedData())).toBe(report.contentHash);
  });

  it('replays an unchanged seed without duplicating or altering rows', () => {
    const db = database();
    const original = seedDatabase(db);
    const before = persistedContent(db);
    const replay = seedDatabase(db);
    expect(replay).toEqual({ ...original, alreadySeeded: true });
    expect(persistedContent(db)).toBe(before);
    expect(checkSeedInvariants(db).contentHash).toBe(original.contentHash);
    expect(db.inTransaction).toBe(false);
  });

  it('covers every status, validates all invariants and provides the six stable edge cases', () => {
    const db = seeded();
    const data = readSeedData(db);
    expect(new Set(data.orders.map((row) => row.status))).toEqual(
      new Set(OrderStatusSchema.options),
    );
    expect(
      Object.values(EDGE_CASE_IDS).every((id) => data.orders.some((order) => order.id === id)),
    ).toBe(true);
    expect(checkSeedInvariants(db).counts.orders).toBe(200);
    const recent = data.orders.filter(
      (order) => Date.parse(order.placed_at) >= Date.parse(SEED_NOW) - 7 * 86400000,
    );
    expect(recent.some((order) => order.status === 'delivered')).toBe(true);
    expect(recent.some((order) => order.status === 'cancelled')).toBe(true);
    expect(data.orders.find((order) => order.id === EDGE_CASE_IDS.injectionNote)?.notes).toBe(
      INJECTION_NOTE,
    );
    expect(
      data.invoices.every(
        (invoice) =>
          data.orders.find((order) => order.id === invoice.order_id)?.status === 'delivered',
      ),
    ).toBe(true);
    expect(data.delivery_partners.filter((partner) => partner.status === 'available')).toHaveLength(
      2,
    );
    expect(data.delivery_partners.filter((partner) => partner.status === 'busy')).toHaveLength(7);
  });

  it('is consumable by the existing read and mutation services', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(SEED_NOW));
    const write = seeded();
    const read = openReadOnly(write.name);
    connections.push(read);
    const services = createServices({ write, read });
    expect(services.delivery.trackDelivery(EDGE_CASE_IDS.lateDelivery).is_late).toBe(true);
    expect(services.order.getOrder(EDGE_CASE_IDS.failedPayment).payment?.status).toBe('failed');
    expect(services.order.getOrder(EDGE_CASE_IDS.partialRefund).payment?.status).toBe(
      'partially_refunded',
    );
    expect(services.order.getOrder(EDGE_CASE_IDS.cancelledAndRefunded).payment?.status).toBe(
      'refunded',
    );
    const before = persistedContent(write);
    const available = services.delivery.listDeliveryPartners({ status: 'available' }).items[0];
    if (!available) throw new Error('Expected an available partner');
    expect(
      services.delivery.previewReassign({
        orderId: EDGE_CASE_IDS.unassignedDelivery,
        partnerId: available.id,
        actor: 'ops',
        reason: 'Seed walkthrough',
      }).previous_partner_id,
    ).toBeNull();
    expect(services.order.getOrder(EDGE_CASE_IDS.injectionNote).order.notes).toBe(INJECTION_NOTE);
    expect(persistedContent(write)).toBe(before);
    const ready = services.order.listOrders({ status: 'ready' }).items[0];
    if (!ready) throw new Error('Expected a ready order');
    const request = { orderId: ready.id, actor: 'ops', reason: 'Seed lifecycle check' } as const;
    services.order.advanceStatus({ ...request, toStatus: 'picked_up' });
    services.order.advanceStatus({ ...request, toStatus: 'out_for_delivery' });
    const completed = services.order.advanceStatus({ ...request, toStatus: 'delivered' });
    expect(completed.invoice?.invoice_no).toMatch(/^INV-20261101-/);
    expect(services.invoice.getInvoice(ready.id).invoice.total_paise).toBe(ready.total_paise);
  });

  it('requires explicit reset to replace a different application dataset', () => {
    const db = seeded();
    db.prepare("UPDATE orders SET notes = 'Operator edit' WHERE id = ?").run(
      EDGE_CASE_IDS.injectionNote,
    );
    const before = persistedContent(db);
    expect(() => seedDatabase(db)).toThrow(
      expect.objectContaining({
        code: ErrorCode.CONFLICT,
        hint: expect.stringContaining('--reset'),
      }),
    );
    expect(persistedContent(db)).toBe(before);
  });

  it('rolls back the entire seed if a write or invariant check fails', () => {
    const db = database();
    migrate(db);
    db.exec(
      "CREATE TEMP TRIGGER fail_seed BEFORE INSERT ON refunds BEGIN SELECT RAISE(ABORT, 'injected seed failure'); END",
    );
    expect(() => seedDatabase(db)).toThrow(AppError);
    for (const table of SEED_TABLES)
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER fail_seed');
    db.exec(
      'CREATE TEMP TRIGGER break_total AFTER INSERT ON orders BEGIN UPDATE orders SET tax_paise = tax_paise + 1 WHERE id = new.id; END',
    );
    expect(() => seedDatabase(db)).toThrow(
      expect.objectContaining({ message: expect.stringContaining('pricing') }),
    );
    for (const table of SEED_TABLES)
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER break_total');
    expect(seedDatabase(db).counts.orders).toBe(200);
  });
});

describe('invariant failures', () => {
  it.each([
    [
      'line item subtotal',
      'UPDATE order_items SET qty = qty + 1 WHERE id = (SELECT id FROM order_items LIMIT 1)',
    ],
    [
      'pricing totals',
      "UPDATE orders SET total_paise = total_paise + 1 WHERE id = 'O-EDGE-INJECTION'",
    ],
    [
      'refund balance',
      "UPDATE refunds SET amount_paise = 900000000 WHERE id = 'RF-O-EDGE-PARTIAL-REFUND'",
    ],
    [
      'invalid event transition',
      "UPDATE order_events SET to_status = 'delivered' WHERE order_id = 'O-EDGE-INJECTION'",
    ],
    [
      'event source continuity',
      "UPDATE order_events SET from_status = 'ready' WHERE order_id = 'O-EDGE-LATE' AND to_status = 'preparing'",
    ],
    [
      'partner availability',
      "UPDATE delivery_partners SET status = 'available' WHERE id = 'DP-0001'",
    ],
    [
      'delivery timestamp',
      "UPDATE deliveries SET picked_up_at = NULL WHERE order_id = 'O-EDGE-LATE'",
    ],
  ])('rejects corrupted %s', (_name, sql) => {
    const db = seeded();
    db.exec(sql);
    expect(() => checkSeedInvariants(db)).toThrow(
      expect.objectContaining({ code: ErrorCode.INTERNAL, hint: expect.any(String) }),
    );
  });

  it('checks snapshots rather than comparing past orders to current menu prices', () => {
    const db = seeded();
    const before = checkSeedInvariants(db);
    db.prepare(
      "UPDATE menu_items SET name = 'New menu name', price_paise = price_paise + 1000",
    ).run();
    expect(checkSeedInvariants(db).counts).toEqual(before.counts);
  });
});

describe('seed configuration and reset', () => {
  it('loads DB_PATH from the root .env, including quoted relative paths, regardless of package cwd', () => {
    writeFileSync(
      join(directory, '.env'),
      '# Demo configuration\nDB_PATH="./demo data/foodops.sqlite"\n',
    );
    expect(resolveSeedPath({ root: directory, env: {} })).toBe(
      join(directory, 'demo data', 'foodops.sqlite'),
    );
    expect(resolveSeedPath({ root: directory, env: { DB_PATH: './override.sqlite' } })).toBe(
      join(directory, 'override.sqlite'),
    );
    expect(resolveSeedPath({ root: directory, env: { DATABASE_PATH: './legacy.sqlite' } })).toBe(
      join(directory, 'legacy.sqlite'),
    );
    expect(() => resolveSeedPath({ root: directory, env: { DB_PATH: '' } })).toThrow(AppError);
    expect(() => resolveSeedPath({ root: directory, env: { DB_PATH: ':memory:' } })).toThrow(
      AppError,
    );
  });

  it('supports the legacy variable, prefers DB_PATH, and supplies a workspace-relative default', () => {
    expect(resolveSeedPath({ root: directory, env: {} })).toBe(
      join(directory, 'data', 'foodops.sqlite'),
    );
    writeFileSync(join(directory, '.env'), 'DATABASE_PATH=./legacy.sqlite\n');
    expect(resolveSeedPath({ root: directory, env: {} })).toBe(join(directory, 'legacy.sqlite'));
    writeFileSync(join(directory, '.env'), 'DB_PATH=./new.sqlite\nDATABASE_PATH=./legacy.sqlite\n');
    expect(resolveSeedPath({ root: directory, env: {} })).toBe(join(directory, 'new.sqlite'));
  });

  it('drops and recreates the SQLite file with the original deterministic content', () => {
    const path = join(directory, 'reset.sqlite');
    const original = seedFile(path);
    const edit = openWritable(path);
    edit.prepare("UPDATE orders SET notes = 'Changed data'").run();
    edit.close();
    const reset = seedFile(path, true);
    expect(reset).toEqual(original);
    expect(existsSync(path)).toBe(true);
    const db = openWritable(path);
    connections.push(db);
    expect(checkSeedInvariants(db).contentHash).toBe(original.contentHash);
  });

  it('refuses to reset an unrelated file and does not remove it', () => {
    const path = join(directory, 'unrelated.txt');
    writeFileSync(path, 'Preserve this file');
    expect(() => resetDatabaseFile(path)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(readFileSync(path, 'utf8')).toBe('Preserve this file');
    expect(() => resetDatabaseFile(directory)).toThrow(AppError);
  });

  it('rejects unsupported command arguments with stderr-only diagnostics', () => {
    const previous = process.exitCode;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      runSeedCli(['--unknown']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('VALIDATION:'));
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previous;
    }
  });
});

it('invoice deletion is rejected before it can corrupt the seeded dataset', () => {
  const db = seeded();
  const before = checkSeedInvariants(db);
  expect(() => db.exec("DELETE FROM invoices WHERE order_id = 'O-EDGE-PARTIAL-REFUND'")).toThrow(
    /immutable/,
  );
  expect(checkSeedInvariants(db)).toEqual(before);
});
