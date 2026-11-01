import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  ActorSchema,
  AppError,
  ErrorCode,
  formatINR,
  IdSchema,
  TextSchema,
  type Actor,
} from '@foodops/shared';
import type { DatabaseConnection } from '../db/connection.js';
import type { Schema } from '../repositories/common.js';
import { createCatalogRepository } from '../repositories/catalog.repo.js';
import { createOrderRepository } from '../repositories/order.repo.js';
import { createDeliveryRepository } from '../repositories/delivery.repo.js';
import { createPaymentRepository } from '../repositories/payment.repo.js';
import { createRefundRepository } from '../repositories/refund.repo.js';
import { createInvoiceRepository } from '../repositories/invoice.repo.js';
import { createMetricsRepository } from '../repositories/metrics.repo.js';
import { createAuditRepository } from '../repositories/audit.repo.js';

export interface ServiceHandles {
  write: DatabaseConnection;
  read: DatabaseConnection;
}
export interface WriteMeta {
  actor: Actor;
  reason: string;
  idempotencyKey?: string;
}
type DisplayFields<T> = {
  [K in keyof T as K extends `${infer Name}_paise` ? `${Name}_display` : never]: string;
};
export type Presented<T> = T extends readonly (infer Item)[]
  ? Presented<Item>[]
  : T extends object
    ? { [K in keyof T]: Presented<T[K]> } & DisplayFields<T>
    : T;

export function present<T>(value: T): Presented<T> {
  if (Array.isArray(value)) return value.map((item) => present(item)) as Presented<T>;
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = present(child);
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('_paise') && typeof child === 'number')
        result[key.slice(0, -6) + '_display'] = formatINR(child);
    }
    return result as Presented<T>;
  }
  return value as Presented<T>;
}
export function stripDisplays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDisplays);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('_display') && key.slice(0, -8) + '_paise' in value) continue;
      result[key] = stripDisplays(child);
    }
    return result;
  }
  return value;
}
export function canonical(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sorted(v)]),
      );
    return item;
  }
  const json = JSON.stringify(sorted(value));
  if (json === undefined)
    throw new AppError(
      ErrorCode.INTERNAL,
      'Response cannot be serialized',
      'Use JSON-compatible operation inputs and results',
    );
  return json;
}
export function assertExpectedPreview(expected: unknown, preview: () => unknown): void {
  if (expected === undefined) return;
  try {
    if (canonical(expected) === canonical(present(preview()))) return;
  } catch (error) {
    if (!(error instanceof AppError) || error.code === ErrorCode.INTERNAL) throw error;
  }
  throw new AppError(
    ErrorCode.CONFLICT,
    'Operation preview changed',
    'Refresh the preview before retrying',
    { precondition: 'preview_changed' },
  );
}
function requestHash(operation: string, input: { idempotencyKey?: string }): string {
  const semantic = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== 'idempotencyKey'),
  );
  return createHash('sha256')
    .update(canonical({ operation, input: semantic }))
    .digest('hex');
}
function cached<T>(
  repos: Repositories,
  operation: string,
  input: { idempotencyKey?: string },
  decode: (value: unknown) => T,
): Presented<T> | undefined {
  const record = input.idempotencyKey === undefined ? null : repos.audit.key(input.idempotencyKey);
  if (!record) return undefined;
  if (record.operation !== operation || record.request_hash !== requestHash(operation, input))
    throw new AppError(
      ErrorCode.CONFLICT,
      'Idempotency key was used for a different request',
      'Replay the original request or use a new idempotency key',
    );
  const stored: unknown = JSON.parse(record.response_json);
  const result = present(decode(stripDisplays(stored)));
  // Legacy order responses predate the additive partner field.
  const comparable =
    stored !== null &&
    typeof stored === 'object' &&
    !('partner' in stored) &&
    result !== null &&
    typeof result === 'object' &&
    'partner' in result
      ? { ...stored, partner: null }
      : stored;
  if (canonical(result) !== canonical(comparable))
    throw new AppError(
      ErrorCode.INTERNAL,
      'Stored idempotent response is invalid',
      'Repair the idempotency record before retrying',
    );
  return result;
}
export function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AppError) {
      if (error.hint) throw error;
      throw new AppError(
        error.code,
        error.message,
        'Check the operation inputs and current state before retrying',
        error.details,
      );
    }
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (/^SQLITE_(BUSY|LOCKED|CONSTRAINT)/.test(code))
      throw new AppError(
        ErrorCode.CONFLICT,
        'The operation conflicts with database state',
        'Refresh the record or retry after concurrent work completes',
      );
    const failure = new AppError(
      ErrorCode.INTERNAL,
      'The operation could not be completed',
      'Check database integrity and retry; no transaction changes were committed',
    );
    failure.cause = error;
    throw failure;
  }
}
export function parse<T>(schema: Schema<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      `Invalid ${label}`,
      'Use the documented fields, types, and limits',
    );
  }
}
export function keys(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid input fields',
      `Use only: ${allowed.join(', ')}`,
    );
  }
}
export function writeInput<T extends WriteMeta>(value: T, extra: readonly string[]): T {
  keys(value, ['actor', 'reason', 'idempotencyKey', ...extra]);
  parse(ActorSchema, value.actor, 'actor');
  parse(TextSchema, value.reason, 'reason');
  if (value.idempotencyKey !== undefined)
    parse(TextSchema, value.idempotencyKey, 'idempotency key');
  return value;
}
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new AppError(
      ErrorCode.NOT_FOUND,
      `${label} was not found`,
      `Check the ${label.toLowerCase()} identifier`,
    );
  return value;
}
export function singleton<T>(rows: T[], label: string): T | null {
  if (rows.length > 1)
    throw new AppError(
      ErrorCode.CONFLICT,
      `Multiple ${label} records are ambiguous`,
      'Reconcile duplicate records for this order before retrying',
    );
  return rows[0] ?? null;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid cached response');
  return value as Record<string, unknown>;
}
export function nullable<T>(schema: Schema<T>, value: unknown): T | null {
  return value === null ? null : schema.parse(value);
}
export function id(value: unknown): string {
  return parse(IdSchema, value, 'identifier');
}
export const newId = (): string => randomUUID();
export const now = (): string => new Date().toISOString();

function repositories(db: DatabaseConnection) {
  return {
    catalog: createCatalogRepository(db),
    order: createOrderRepository(db),
    delivery: createDeliveryRepository(db),
    payment: createPaymentRepository(db),
    refund: createRefundRepository(db),
    invoice: createInvoiceRepository(db),
    metrics: createMetricsRepository(db),
    audit: createAuditRepository(db),
  };
}
export type Repositories = ReturnType<typeof repositories>;
export function createContext(handles: ServiceHandles) {
  return guard(() => {
    const { write, read } = handles;
    if (
      !write.open ||
      !read.open ||
      write.readonly ||
      !read.readonly ||
      write === read ||
      realpathSync(write.name) !== realpathSync(read.name)
    ) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Services require writable and read-only handles for the same database',
        'Open separate handles using openWritable and openReadOnly',
      );
    }
    const readRepos = repositories(read);
    const writeRepos = repositories(write);
    return {
      read<T>(operation: (repos: Repositories) => T): Presented<T> {
        return guard(() => present(read.transaction(() => operation(readRepos)).deferred()));
      },
      replay<T>(
        operation: string,
        input: { idempotencyKey?: string },
        decode: (value: unknown) => T,
      ): Presented<T> | undefined {
        return guard(() =>
          read.transaction(() => cached(readRepos, operation, input, decode)).deferred(),
        );
      },
      mutate<T>(
        operation: string,
        input: { idempotencyKey?: string },
        execute: (repos: Repositories) => T,
        decode: (value: unknown) => T,
      ): Presented<T> {
        return guard(() => {
          if (write.inTransaction)
            throw new AppError(
              ErrorCode.CONFLICT,
              'Service writes cannot join a caller-owned transaction',
              'Call the service outside an existing transaction',
            );
          const { idempotencyKey } = input;
          const hash = requestHash(operation, input);
          return write
            .transaction(() => {
              const replay = cached(writeRepos, operation, input, decode);
              if (replay !== undefined) return replay;
              const result = present(execute(writeRepos));
              if (idempotencyKey !== undefined)
                writeRepos.audit.insertKey({
                  key: idempotencyKey,
                  operation,
                  request_hash: hash,
                  response_json: canonical(result),
                  created_at: now(),
                });
              return result;
            })
            .immediate();
        });
      },
    };
  });
}
export type ServiceContext = ReturnType<typeof createContext>;
