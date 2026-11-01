import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createStreams } from './streams.js';
afterEach(() => vi.useRealTimers());
it('waits for drain, preserves frame order, and disconnects bounded slow consumers', () => {
  vi.useFakeTimers();
  const output: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    write: vi.fn((text: string) => {
      output.push(text);
      return false;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  const cleanup = vi.fn();
  const streams = createStreams(1);
  const client = streams.open(raw as unknown as ServerResponse, cleanup);
  expect(streams.full).toBe(true);
  client.send({ id: 1, type: 'order.updated', data: { order_id: 'one' } });
  client.send({ id: 2, type: 'order.updated', data: { order_id: 'two' } });
  expect(output).toHaveLength(1);
  raw.emit('drain');
  expect(output[1]).toContain('id: 1');
  raw.emit('drain');
  expect(output[2]).toContain('id: 2');
  client.send({ type: 'mcp.call', data: { tool: 'x'.repeat(262145) } });
  expect(cleanup).toHaveBeenCalledOnce();
  expect(raw.end).toHaveBeenCalledOnce();
  expect(streams.full).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(raw.destroy).toHaveBeenCalledOnce();
});
