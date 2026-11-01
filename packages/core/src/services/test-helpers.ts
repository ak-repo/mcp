import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadOnly, openWritable } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createServices, type Services } from './index.js';
import type { DatabaseConnection } from '../db/connection.js';
import type { DeliveryStatus, OrderStatus, PaymentStatus } from '@foodops/shared';

export const AT = '2026-11-01T12:00:00.000Z';
export const PLACED_AT = '2026-11-01T11:00:00.000Z';
export interface OrderOptions {
  id?: string;
  status?: OrderStatus;
  total?: number;
  placedAt?: string;
  restaurantId?: string;
  paymentStatus?: PaymentStatus | null;
  delivery?: DeliveryStatus | null;
  partnerId?: string | null;
  deliveredAt?: string | null;
}
export interface Fixture {
  path: string;
  directory: string;
  write: DatabaseConnection;
  read: DatabaseConnection;
  services: Services;
  addOrder(options?: OrderOptions): string;
  count(table: string): number;
  close(): void;
}
export function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'foodops-services-'));
  const path = join(directory, 'db.sqlite');
  const write = openWritable(path);
  migrate(write);
  write
    .prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?)')
    .run('C-1', 'Customer', '123', 'ops@example.com', AT);
  write
    .prepare('INSERT INTO addresses VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('A-1', 'C-1', 'Home', '1 Street', 'Central', 'Pune', '411001');
  for (const n of [1, 2]) {
    write
      .prepare('INSERT INTO restaurants VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        `R-${n}`,
        `Cafe ${n}`,
        n === 1 ? 'Indian' : 'Italian',
        'Pune',
        'Central',
        4,
        20,
        n === 1 ? 1 : 0,
      );
    write
      .prepare('INSERT INTO menu_items VALUES (?, ?, ?, ?, ?, ?)')
      .run(`M-${n}`, 'R-1', `Meal ${n}`, 100 * n, n === 1 ? 1 : 0, n === 1 ? 1 : 0);
    write
      .prepare('INSERT INTO delivery_partners VALUES (?, ?, ?, ?, ?)')
      .run(`DP-${n}`, `Partner ${n}`, '123', 'bike', n === 1 ? 'busy' : 'available');
  }
  const read = openReadOnly(path);
  const services = createServices({ write, read });
  let sequence = 0;
  function addOrder(options: OrderOptions = {}) {
    const id = options.id ?? `O-${++sequence}`;
    const total = options.total ?? 1000;
    const status = options.status ?? 'placed';
    const placedAt = options.placedAt ?? PLACED_AT;
    write
      .prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        'C-1',
        options.restaurantId ?? 'R-1',
        'A-1',
        status,
        total,
        0,
        0,
        0,
        0,
        total,
        'Untrusted notes',
        null,
        placedAt,
        placedAt,
      );
    write
      .prepare('INSERT INTO order_items VALUES (?, ?, ?, ?, ?, ?)')
      .run(`OI-${id}`, id, 'M-1', 'Original meal', total, 1);
    if (options.paymentStatus !== null)
      write
        .prepare('INSERT INTO payments VALUES (?, ?, ?, ?, ?, ?)')
        .run(`P-${id}`, id, 'upi', options.paymentStatus ?? 'paid', total, null);
    if (options.delivery !== null)
      write
        .prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          `D-${id}`,
          id,
          options.partnerId === undefined ? 'DP-1' : options.partnerId,
          options.delivery ?? 'assigned',
          30,
          options.partnerId === null ? null : placedAt,
          ['picked_up', 'out_for_delivery', 'delivered'].includes(options.delivery ?? '')
            ? placedAt
            : null,
          options.deliveredAt ?? (options.delivery === 'delivered' ? AT : null),
        );
    return id;
  }
  function count(table: string): number {
    const result = write.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get();
    if (!result) throw new Error('Missing count');
    return result.n;
  }
  return {
    path,
    directory,
    write,
    read,
    services,
    addOrder,
    count,
    close() {
      read.close();
      write.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
