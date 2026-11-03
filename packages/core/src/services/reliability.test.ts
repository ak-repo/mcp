import { afterEach, expect, it } from 'vitest';
import { createServices } from './index.js';
import { openReadOnly, openWritable } from '../db/connection.js';
import { confirmationDigest } from '../confirmation.js';
import { fixture, type Fixture } from './test-helpers.js';
let f: Fixture;
afterEach(() => f?.close());
it('reports transactional replays after two callers both observe an empty preliminary lookup', () => {
  f = fixture();
  const orderId = f.addOrder();
  const write = openWritable(f.path);
  const read = openReadOnly(f.path);
  try {
    const other = createServices({ write, read });
    const input = {
      orderId,
      actor: 'ops' as const,
      reason: 'cancel',
      idempotencyKey: 'interleaved-cancel',
    };
    const expectedPreviewHash = confirmationDigest(f.services.order.previewCancel(input));
    expect(f.services.order.replayCancel(input)).toBeUndefined();
    expect(other.order.replayCancel(input)).toBeUndefined();
    const first = f.services.order.executeCancelWithMetadata(input, { expectedPreviewHash });
    const second = other.order.executeCancelWithMetadata(input, { expectedPreviewHash });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(f.services.order.executeCancel(input)).toEqual(first.result);
    expect(f.count('order_events')).toBe(1);
    expect(() => other.order.executeCancelWithMetadata({ ...input, reason: 'different' })).toThrow(
      /Idempotency/,
    );
  } finally {
    read.close();
    write.close();
  }
});
it('keeps its feed high-water mark after full audit pruning and sees a new writer', () => {
  f = fixture();
  const call = {
    tool: 'get_order',
    argsJson: '{}',
    status: 'success' as const,
    actor: 'ai' as const,
    latencyMs: 1,
  };
  f.services.audit.recordCall(call);
  const cursor = f.services.audit.maxCallRowId();
  expect(f.services.audit.pruneCallsBefore('2099-01-01T00:00:00.000Z')).toBe(1);
  expect(f.services.audit.maxCallRowId()).toBe(cursor);
  const write = openWritable(f.path);
  const read = openReadOnly(f.path);
  try {
    createServices({ write, read }).audit.recordCall(call);
  } finally {
    read.close();
    write.close();
  }
  const rows = f.services.audit.listCallsAfterRowId(cursor);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.rowid).toBeGreaterThan(cursor);
  expect(f.services.audit.pruneCallsBefore('2000-01-01T00:00:00.000Z')).toBe(0);
  expect(() => f.services.audit.pruneCallsBefore('bad-date')).toThrow();
});
