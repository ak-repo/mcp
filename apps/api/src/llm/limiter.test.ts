import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from './limiter.js';
describe('LLM concurrency limiter', () => {
  it('grants FIFO and release is idempotent', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const first = await limiter.acquire();
    const order: number[] = [];
    const second = limiter.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const third = limiter.acquire().then((release) => {
      order.push(3);
      return release;
    });
    first();
    first();
    const releaseSecond = await second;
    expect(order).toEqual([2]);
    releaseSecond();
    (await third)();
    expect(order).toEqual([2, 3]);
  });
  it('removes aborted waiters and bounds the queue', async () => {
    const limiter = new ConcurrencyLimiter(1, 1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const waiting = expect(limiter.acquire(controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
    await expect(limiter.acquire()).rejects.toMatchObject({ kind: 'rate_limit', retryable: false });
    controller.abort();
    await waiting;
    const next = limiter.acquire();
    release();
    (await next)();
    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });
  it('supports multiple active operations and validates limits', async () => {
    const limiter = new ConcurrencyLimiter(2, 0);
    const a = await limiter.acquire();
    const b = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ kind: 'rate_limit' });
    a();
    b();
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });
});
