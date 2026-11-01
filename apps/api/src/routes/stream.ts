import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ErrorCode } from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { validate } from '../lib/validate.js';
import { HttpError } from '../lib/http-errors.js';
import { changeEvent, type FeedEvent } from '../events/change-feed.js';
const querySchema = z.strictObject({
  ticket: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
const resumeSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const stream: FastifyPluginAsync<{ runtime: Runtime; replayLimit: number }> = async (
  app,
  { runtime, replayLimit },
) => {
  app.post('/stream/ticket', { preHandler: app.writeRateLimit }, async (request) => {
    validate(z.strictObject({}), request.query);
    validate(z.strictObject({}).optional(), request.body);
    return runtime.tickets.issue();
  });
  app.get('/stream', async (request, reply) => {
    const { ticket } = validate(querySchema, request.query);
    runtime.tickets.consume(ticket ?? '');
    if (runtime.streams.full)
      throw new HttpError(
        429,
        ErrorCode.LIMIT_EXCEEDED,
        'Concurrent stream limit reached',
        'Close another stream before reconnecting',
      );
    const raw = request.headers['last-event-id'];
    const count = request.raw.rawHeaders.filter(
      (_, i) => i % 2 === 0 && request.raw.rawHeaders[i]?.toLowerCase() === 'last-event-id',
    ).length;
    if (count > 1)
      throw new HttpError(
        400,
        ErrorCode.VALIDATION,
        'Duplicate Last-Event-ID',
        'Send a single cursor header',
      );
    const resume = raw === undefined ? undefined : validate(resumeSchema, raw);
    const pending: FeedEvent[] = [];
    let ready = false;
    let last = resume ?? runtime.services.audit.maxChangeId();
    let connection: ReturnType<typeof runtime.streams.open> | undefined;
    const unsubscribe = runtime.feed.subscribe((event) => {
      if (!ready) {
        pending.push(event);
        return;
      }
      if (event.id !== undefined && event.id <= last) return;
      if (event.id !== undefined) last = event.id;
      connection?.send(event);
    });
    try {
      const bounds = runtime.services.audit.changeSnapshotAfter(resume ?? last, replayLimit);
      if (
        resume !== undefined &&
        (resume > bounds.max ||
          (resume < bounds.max && (bounds.min === 0 || resume < bounds.min - 1)))
      )
        throw new HttpError(
          409,
          ErrorCode.CONFLICT,
          'Stream history is unavailable',
          'Refresh REST state and reconnect with a new ticket without Last-Event-ID',
        );
      const replay = resume === undefined ? [] : bounds.items;
      if (resume !== undefined && bounds.hasMore)
        throw new HttpError(
          409,
          ErrorCode.CONFLICT,
          'Stream replay limit exceeded',
          'Refresh REST state and reconnect without Last-Event-ID',
        );
      reply.hijack();
      for (const [key, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined)
          reply.raw.setHeader(
            key,
            typeof value === 'number' || typeof value === 'string' ? value : [...value],
          );
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      connection = runtime.streams.open(reply.raw, unsubscribe);
      for (const row of replay) {
        connection.send(changeEvent(row));
        last = row.id;
      }
      ready = true;
      for (const event of pending) {
        if (event.id !== undefined && event.id <= last) continue;
        if (event.id !== undefined) last = event.id;
        connection.send(event);
      }
    } catch (error) {
      unsubscribe();
      throw error;
    }
  });
};
export default stream;
