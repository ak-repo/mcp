import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../lib/http-errors.js';
import { ErrorCode } from '@foodops/shared';
export function createTickets(now: () => number = Date.now) {
  const entries = new Map<string, { hash: Buffer; expires: number }>();
  const hash = (value: string) => createHash('sha256').update(value).digest();
  function sweep() {
    for (const [key, value] of entries) if (value.expires <= now()) entries.delete(key);
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (!timer) {
        timer = setInterval(sweep, 1000);
        timer.unref();
      }
    },
    issue() {
      sweep();
      if (entries.size >= 10000)
        throw new HttpError(
          429,
          ErrorCode.LIMIT_EXCEEDED,
          'Too many outstanding stream tickets',
          'Wait for tickets to expire',
        );
      const ticket = randomBytes(32).toString('base64url');
      const digest = hash(ticket);
      const expires = now() + 30000;
      entries.set(digest.toString('hex'), { hash: digest, expires });
      return { ticket, expires_at: new Date(expires).toISOString() };
    },
    consume(ticket: string) {
      sweep();
      const digest = hash(ticket);
      const key = digest.toString('hex');
      const entry = entries.get(key);
      const valid =
        timingSafeEqual(digest, entry?.hash ?? Buffer.alloc(32)) &&
        entry !== undefined &&
        entry.expires > now();
      if (!valid)
        throw new HttpError(
          401,
          'UNAUTHORIZED',
          'A valid single-use stream ticket is required',
          'Obtain a new ticket through POST /api/stream/ticket',
        );
      entries.delete(key);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      entries.clear();
    },
  };
}
