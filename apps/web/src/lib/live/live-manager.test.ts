import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ContractError } from '../api/errors.js';
import { createLiveManager } from './live-manager.js';
import { ErrorCode } from '@foodops/shared';
import { readSse } from './sse-reader.js';

const payload = (id: number) => ({
  id,
  type: 'order.updated',
  order_id: 'O-1',
  entity: 'order',
  at: '2026-11-04T10:00:00.000Z',
});
const frame = (id: number) =>
  `id: ${id}\nevent: order.updated\ndata: ${JSON.stringify(payload(id))}\n\n`;
const encoder = new TextEncoder();
function fixture() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const cancelled = vi.fn();
  let sequence = 0;
  const ticket = vi.fn(async () => ({
    ticket: `single-use-${++sequence}`,
    expires_at: '2026-11-04T10:00:30.000Z',
  }));
  const open = vi.fn<
    (
      ticket: string,
      cursor: number | undefined,
      signal: AbortSignal,
    ) => Promise<ReadableStream<Uint8Array>>
  >(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
        cancel: cancelled,
      }),
  );
  const invalidateAll = vi.fn();
  const onEvent = vi.fn();
  const clearBatch = vi.fn();
  const manager = createLiveManager({
    ticket,
    open,
    invalidateAll,
    onEvent,
    clearBatch,
    random: () => 0,
  });
  return { manager, ticket, open, streams, cancelled, invalidateAll, onEvent, clearBatch };
}
const activeManagers: ReturnType<typeof createLiveManager>[] = [];
function setup() {
  const result = fixture();
  activeManagers.push(result.manager);
  return result;
}
const flush = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  activeManagers.forEach((manager) => manager.stop());
  activeManagers.length = 0;
  await flush();
  vi.useRealTimers();
});

describe('live manager', () => {
  it('opens with a fresh ticket and resumes from the last validated durable ID', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode(frame(42)));
    await flush();
    f.streams[0]!.close();
    await flush();
    expect(f.manager.getSnapshot().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.open.mock.calls.map(([ticket, cursor]) => [ticket, cursor])).toEqual([
      ['single-use-1', undefined],
      ['single-use-2', 42],
    ]);
    expect(new Set(f.open.mock.calls.map(([ticket]) => ticket)).size).toBe(
      f.open.mock.calls.length,
    );
  });
  it('backs off exponentially and never reuses a failed ticket', async () => {
    const f = setup();
    f.open.mockRejectedValue(new Error('closed'));
    f.manager.start();
    await flush();
    expect(f.ticket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.ticket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ticket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.ticket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ticket).toHaveBeenCalledTimes(3);
    expect(f.open.mock.calls.map(([ticket]) => ticket)).toEqual([
      'single-use-1',
      'single-use-2',
      'single-use-3',
    ]);
  });
  it('honors Retry-After for stream admission failures', async () => {
    const f = setup();
    f.open.mockRejectedValue(new ApiError(429, ErrorCode.LIMIT_EXCEEDED, '', '', null, 10000));
    f.manager.start();
    await flush();
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.ticket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.ticket).toHaveBeenCalledTimes(2);
  });
  it('recovers a resume gap with invalidation, a new ticket and no cursor', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode(frame(50)));
    await flush();
    f.streams[0]!.close();
    await flush();
    f.open.mockRejectedValueOnce(new ApiError(409, ErrorCode.CONFLICT, '', '', null, null));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.invalidateAll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.open.mock.calls.map(([ticket, cursor]) => [ticket, cursor])).toEqual([
      ['single-use-1', undefined],
      ['single-use-2', 50],
      ['single-use-3', undefined],
    ]);
    expect(f.invalidateAll).toHaveBeenCalledTimes(3);
  });
  it('deduplicates replay and keeps only twenty events', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    for (let id = 1; id <= 25; id++) f.streams[0]!.enqueue(encoder.encode(frame(id)));
    f.streams[0]!.enqueue(encoder.encode(frame(25)));
    await flush();
    expect(f.onEvent).toHaveBeenCalledTimes(25);
    expect(f.manager.getSnapshot().events).toHaveLength(20);
    expect(f.manager.getSnapshot().events[0]?.data).toMatchObject({ id: 25 });
  });
  it('publishes MCP calls without moving the durable cursor', async () => {
    const f = setup();
    const listener = vi.fn();
    f.manager.bus.subscribe(listener);
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode(frame(5)));
    f.streams[0]!.enqueue(
      encoder.encode(
        `event: mcp.call\ndata: {"tool":"get_order","status":"success","error_code":null,"latency_ms":1,"at":"2026-11-04T10:00:00.000Z"}\n\n`,
      ),
    );
    await flush();
    f.streams[0]!.close();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.open.mock.calls[1]?.[1]).toBe(5);
  });
  it('pauses only after sixty seconds hidden and resyncs on return', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode(frame(7)));
    await flush();
    f.manager.setHidden(true);
    await vi.advanceTimersByTimeAsync(30000);
    f.streams[0]!.enqueue(encoder.encode(': heartbeat\n\n'));
    await flush();
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.cancelled).toHaveBeenCalledTimes(1);
    expect(f.manager.getSnapshot().status).toBe('offline');
    f.manager.setHidden(false);
    await flush();
    expect(f.open.mock.calls[1]?.[1]).toBe(7);
    expect(f.ticket).toHaveBeenCalledTimes(2);
    expect(f.invalidateAll).toHaveBeenCalledTimes(3);
  });
  it('cancels the hidden timer when the tab returns early', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.manager.setHidden(true);
    await vi.advanceTimersByTimeAsync(1000);
    f.manager.setHidden(false);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(14000);
      f.streams[0]!.enqueue(encoder.encode(': heartbeat\n\n'));
      await flush();
    }
    expect(f.ticket).toHaveBeenCalledTimes(1);
    expect(f.manager.getSnapshot().status).toBe('live');
  });
  it('logout aborts readers, retries and visibility timers and clears history', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode(frame(8)));
    await flush();
    f.manager.setHidden(true);
    f.manager.stop();
    await flush();
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.open.mock.calls[0]?.[2].aborted).toBe(true);
    expect(f.cancelled).toHaveBeenCalled();
    expect(f.clearBatch).toHaveBeenCalled();
    expect(f.manager.getSnapshot().events).toEqual([]);
    expect(f.ticket).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a stale ticket resolving after stop/start (StrictMode lifecycle)', async () => {
    const f = setup();
    let resolve!: (ticket: { ticket: string; expires_at: string }) => void;
    f.ticket.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.manager.start();
    f.manager.stop();
    f.manager.start();
    await flush();
    resolve({ ticket: 'stale', expires_at: '2026-11-04T10:00:30.000Z' });
    await flush();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0]?.[0]).not.toBe('stale');
  });
  it('handles browser offline/online without retrying offline', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.manager.setOnline(false);
    await flush();
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.ticket).toHaveBeenCalledTimes(1);
    f.manager.setOnline(true);
    await flush();
    expect(f.ticket).toHaveBeenCalledTimes(2);
  });
  it('stops malformed known events, invalidates data and supports explicit retry', async () => {
    const f = setup();
    f.manager.start();
    await flush();
    f.streams[0]!.enqueue(encoder.encode('id: 4\nevent: order.updated\ndata: {}\n\n'));
    await flush();
    expect(f.manager.getSnapshot().status).toBe('offline');
    expect(f.onEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.ticket).toHaveBeenCalledTimes(1);
    f.manager.retry();
    await flush();
    expect(f.ticket).toHaveBeenCalledTimes(2);
  });
});

describe('SSE reader', () => {
  it('handles byte-by-byte UTF-8, CRLF split boundaries, comments and multiline data', async () => {
    const event = {
      tool: 'café',
      status: 'success',
      error_code: null,
      latency_ms: 0,
      at: '2026-11-04T10:00:00.000Z',
    };
    const text = `: heartbeat\r\n\r\nevent: mcp.call\r\ndata: ${JSON.stringify(event).replace(',"status"', ',\r\ndata: "status"')}\r\n\r\n`;
    const bytes = encoder.encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const receive = vi.fn();
    await readSse(body, new AbortController().signal, receive);
    expect(receive).toHaveBeenCalledWith({ type: 'mcp.call', data: event });
    expect(receive).toHaveBeenCalledTimes(1);
  });
  it('rejects a frame ID that disagrees with the payload', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(frame(5).replace('id: 5', 'id: 4')));
        c.close();
      },
    });
    await expect(readSse(body, new AbortController().signal, vi.fn())).rejects.toBeInstanceOf(
      ContractError,
    );
  });
});
