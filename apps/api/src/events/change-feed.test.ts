import { afterEach, expect, it, vi } from 'vitest';
import type { Services } from '@foodops/core';
import { createChangeFeed } from './change-feed.js';
import { createTickets } from './tickets.js';
import { createLogger } from '../runtime.js';
import { fixture, type Fixture } from '../tests/helpers.js';
let f: Fixture | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await f?.close();
  f = undefined;
});
it('expires tickets and consumes them exactly once', () => {
  let at = 0;
  const tickets = createTickets(() => at);
  const first = tickets.issue();
  expect(first.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  tickets.consume(first.ticket);
  expect(() => tickets.consume(first.ticket)).toThrow(/ticket/);
  const expired = tickets.issue();
  at = 30000;
  expect(() => tickets.consume(expired.ticket)).toThrow(/ticket/);
  expect(() => tickets.consume('x'.repeat(43))).toThrow();
  tickets.stop();
});
it('does not overlap poll ticks, catches failures and prunes hourly', async () => {
  vi.useFakeTimers();
  const changes = vi.fn(() => []);
  const prune = vi.fn();
  const calls = vi.fn(() => []);
  const audit = {
    maxChangeId: () => 0,
    maxCallRowId: () => 0,
    listChangesAfter: changes,
    listCallsAfterRowId: calls,
    pruneChangesBefore: prune,
  };
  const feed = createChangeFeed({ audit } as unknown as Services, createLogger('silent'), 500);
  feed.start();
  feed.start();
  changes.mockImplementationOnce(() => {
    vi.advanceTimersByTime(5000);
    return [];
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(changes).toHaveBeenCalledTimes(1);
  changes.mockImplementationOnce(() => {
    throw new Error('temporary');
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(changes).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(changes).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(prune).toHaveBeenCalled();
  await feed.stop();
  const count = changes.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(changes).toHaveBeenCalledTimes(count);
});
it('publishes redacted live MCP audit events without a durable SSE id', async () => {
  f = fixture();
  await f.app.ready();
  const events: unknown[] = [];
  const unsub = f.runtime.feed.subscribe((event) => events.push(event));
  f.runtime.services.audit.recordCall({
    tool: 'get_order',
    argsJson: '{"secret":"do not emit"}',
    status: 'success',
    actor: 'ai',
    latencyMs: 3,
  });
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(events).toContainEqual({
    type: 'mcp.call',
    data: expect.objectContaining({ tool: 'get_order', status: 'success', latency_ms: 3 }),
  });
  expect(JSON.stringify(events)).not.toContain('secret');
  unsub();
});
