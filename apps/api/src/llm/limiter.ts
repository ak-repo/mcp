import { aborted, LLMError } from './errors.js';
interface Waiter {
  grant: () => void;
  reject: (error: LLMError) => void;
  signal: AbortSignal | undefined;
  abort: () => void;
}
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Waiter[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue = 100,
  ) {
    if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(maxQueue) || maxQueue < 0)
      throw new LLMError('bad_request', 'Invalid LLM concurrency limits', false);
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.active >= this.max && this.queue.length >= this.maxQueue)
      return Promise.reject(
        new LLMError('rate_limit', 'LLM request queue is full; try again later', false),
      );
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.queue.shift();
          if (next) {
            next.signal?.removeEventListener('abort', next.abort);
            next.grant();
          }
        });
      };
      if (this.active < this.max) {
        grant();
        return;
      }
      const waiter: Waiter = {
        grant,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.abort);
          reject(aborted());
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
  }
}
