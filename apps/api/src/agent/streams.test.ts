import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createChatStreams } from './streams.js';
class Response extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  write = vi.fn<(text: string) => boolean>(() => true);
  end() {
    queueMicrotask(() => this.emit('finish'));
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
}
afterEach(() => vi.useRealTimers());
it('sends named JSON frames and heartbeats, cleans up on close', async () => {
  vi.useFakeTimers();
  const owner = createChatStreams();
  const response = new Response();
  const cleanup = vi.fn();
  const stream = owner.open(response as unknown as ServerResponse, cleanup);
  await stream.send({ type: 'text.delta', text: 'Hello' });
  expect(response.write).toHaveBeenCalledWith(
    'event: text.delta\ndata: {"type":"text.delta","text":"Hello"}\n\n',
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(response.write).toHaveBeenCalledWith(': heartbeat\n\n');
  owner.close();
  await vi.advanceTimersByTimeAsync(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds blocked buffers and resolves a pending drain on disconnect', async () => {
  const owner = createChatStreams();
  const response = new Response();
  response.write.mockReturnValue(false);
  const cleanup = vi.fn();
  const stream = owner.open(response as unknown as ServerResponse, cleanup);
  const sending = stream.send({ type: 'text.delta', text: 'Hello' });
  response.emit('close');
  expect(await sending).toBe(false);
  expect(cleanup).toHaveBeenCalledTimes(1);
  const full = new Response();
  full.writableLength = 262144;
  const next = owner.open(full as unknown as ServerResponse, cleanup);
  expect(await next.send({ type: 'text.delta', text: 'Hello' })).toBe(false);
  expect(full.write).not.toHaveBeenCalled();
  owner.close();
});
