import { afterEach, expect, it, vi } from 'vitest';
import { createInvalidationBatcher, invalidationKeys } from './invalidation-batcher.js';
import type { LiveEvent } from './events.js';
import { queryKeys } from '../api/query-keys.js';
const event: LiveEvent = {
  type: 'order.updated',
  data: {
    id: 1,
    type: 'order.updated',
    entity: 'order',
    order_id: 'O-1',
    at: '2026-11-04T10:00:00.000Z',
  },
};
afterEach(() => vi.useRealTimers());
it('deduplicates structurally across a fixed one-second window', async () => {
  vi.useFakeTimers();
  const invalidate = vi.fn();
  const batch = createInvalidationBatcher(invalidate);
  batch.add(event);
  await vi.advanceTimersByTimeAsync(500);
  batch.add({ ...event });
  await vi.advanceTimersByTimeAsync(499);
  expect(invalidate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(invalidate).toHaveBeenCalledTimes(4);
  expect(invalidate).toHaveBeenCalledWith(queryKeys.order('O-1'));
  batch.add(event);
  batch.clear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(invalidate).toHaveBeenCalledTimes(4);
});
it('maps refund, invoice, partner and MCP events to existing cache prefixes', () => {
  expect(
    invalidationKeys({
      type: 'payment.updated',
      data: { ...event.data, type: 'payment.updated', entity: 'refund' },
    }),
  ).toContainEqual(queryKeys.invoice('O-1'));
  expect(
    invalidationKeys({
      type: 'partner.updated',
      data: { ...event.data, type: 'partner.updated', entity: 'partner', order_id: null },
    }),
  ).toEqual([queryKeys.partners(), queryKeys.deliveries()]);
  expect(
    invalidationKeys({
      type: 'invoice.updated',
      data: { ...event.data, type: 'invoice.updated', entity: 'invoice' },
    }),
  ).toEqual([queryKeys.order('O-1'), queryKeys.invoice('O-1')]);
  expect(
    invalidationKeys({
      type: 'mcp.call',
      data: {
        tool: 'get_order',
        status: 'success',
        error_code: null,
        latency_ms: 0,
        at: event.data.at,
      },
    }),
  ).toEqual([queryKeys.mcpCalls()]);
  expect(queryKeys.orderList({ status: 'placed', q: undefined })).toEqual(
    queryKeys.orderList({ status: 'placed' }),
  );
});
