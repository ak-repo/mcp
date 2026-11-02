import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMError } from './errors.js';
import { openHttp, readNdjson, readSse, retryAfter, withRetry } from './http.js';
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of stream) result.push(event);
  return result;
}
async function* bytes(text: string) {
  for (const byte of new TextEncoder().encode(text)) yield new Uint8Array([byte]);
}
afterEach(() => vi.useRealTimers());
describe('LLM stream readers', () => {
  it('parses split UTF-8, CRLF, blank lines and unterminated NDJSON', async () => {
    expect(await collect(readNdjson(bytes('\r\n{"x":"₹"}\r\n{"y":2}')))).toEqual([
      { x: '₹' },
      { y: 2 },
    ]);
  });
  it('rejects malformed and oversized records', async () => {
    await expect(collect(readNdjson(bytes('bad\n')))).rejects.toMatchObject({
      kind: 'provider_error',
    });
    async function* large() {
      yield Buffer.from('x'.repeat(1024 * 1024 + 1));
    }
    await expect(collect(readNdjson(large()))).rejects.toMatchObject({ kind: 'provider_error' });
  });
  it('reads SSE fields, comments and multiline data', async () => {
    expect(
      await collect(
        readSse(
          bytes(
            ': hi\r\nid: 1\r\nevent: delta\r\nretry: 123\r\ndata: a\r\ndata: b\r\n\r\ndata: c\n\n',
          ),
        ),
      ),
    ).toEqual([
      { data: 'a\nb', id: '1', event: 'delta', retry: 123 },
      { data: 'c', id: '1' },
    ]);
  });
});
describe('LLM retries and timeouts', () => {
  it('uses exponential jitter and Retry-After', async () => {
    vi.useFakeTimers();
    let calls = 0;
    async function* attempt() {
      calls++;
      if (calls < 3) throw new LLMError('rate_limit', 'busy', true, 750);
      yield 'ok';
    }
    const result = collect(withRetry(attempt, { maxRetries: 2, random: () => 1 }));
    await vi.advanceTimersByTimeAsync(749);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(['ok']);
    expect(retryAfter('2')).toBe(2000);
    expect(retryAfter(new Date(10000).toUTCString(), 5000)).toBe(5000);
    expect(retryAfter('bad')).toBeUndefined();
  });
  it('never retries after any event or for non-retryable failures', async () => {
    let calls = 0;
    async function* partial() {
      calls++;
      yield { type: 'thinking_delta' };
      throw new LLMError('network', 'lost', true);
    }
    await expect(collect(withRetry(partial, { maxRetries: 2 }))).rejects.toMatchObject({
      kind: 'network',
    });
    expect(calls).toBe(1);
    async function* invalid(): AsyncIterable<never> {
      yield* [];
      throw new LLMError('bad_request', 'bad', false);
    }
    await expect(collect(withRetry(invalid, { maxRetries: 2 }))).rejects.toMatchObject({
      kind: 'bad_request',
    });
  });
  it('aborts retry sleeps', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    async function* attempt(): AsyncIterable<never> {
      yield* [];
      throw new LLMError('network', 'lost', true);
    }
    const result = expect(
      collect(withRetry(attempt, { maxRetries: 2, signal: controller.signal, random: () => 1 })),
    ).rejects.toMatchObject({ kind: 'aborted' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out waiting for the first byte and between chunks', async () => {
    vi.useFakeTimers();
    let sink: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sink = controller;
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
    );
    const stream = await openHttp(
      'http://localhost',
      {},
      { firstByteTimeoutMs: 100, idleTimeoutMs: 50 },
      fetcher,
    );
    const first = expect(collect(stream.chunks)).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const next = await openHttp(
      'http://localhost',
      {},
      { firstByteTimeoutMs: 100, idleTimeoutMs: 50 },
      fetcher,
    );
    const idle = expect(collect(next.chunks)).rejects.toMatchObject({ kind: 'timeout' });
    sink!.enqueue(Buffer.from('x'));
    await vi.advanceTimersByTimeAsync(49);
    await vi.advanceTimersByTimeAsync(1);
    await idle;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('maps caller abort and network errors without raw details', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-key'));
    await expect(
      openHttp(
        'http://localhost',
        {},
        { firstByteTimeoutMs: 100, idleTimeoutMs: 50, signal: controller.signal },
        fetcher,
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });
    await expect(
      openHttp('http://localhost', {}, { firstByteTimeoutMs: 100, idleTimeoutMs: 50 }, fetcher),
    ).rejects.toMatchObject({ kind: 'network' });
  });
});
