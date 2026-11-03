import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { onRequestAsyncHookHandler } from 'fastify';
import { ErrorCode } from '@foodops/shared';
import { HttpError } from '../lib/http-errors.js';
declare module 'fastify' {
  interface FastifyInstance {
    chatRateLimit: onRequestAsyncHookHandler;
    probeRateLimit: onRequestAsyncHookHandler;
    writeRateLimit: onRequestAsyncHookHandler;
    ticketRateLimit: onRequestAsyncHookHandler;
  }
}
export default fp<{
  max: number;
  writeMax: number;
  ticketMax: number;
  chatMax: number;
  probeMax: number;
}>(
  async (app, options) => {
    await app.register(rateLimit, {
      global: false,
      max: options.max,
      timeWindow: 60000,
    });
    // An application hook also covers auth failures and unknown routes.
    app.addHook('onRequest', app.rateLimit());
    const bucket = (name: string, max: number): onRequestAsyncHookHandler => {
      const check = app.createRateLimit({
        max,
        timeWindow: 60000,
        keyGenerator: (request) => `${name}:${request.ip}`,
      });
      return async (request, reply) => {
        const result = await check(request);
        if (result.isAllowed) return;
        reply.header('X-RateLimit-Limit', result.max);
        reply.header('X-RateLimit-Remaining', result.remaining);
        reply.header('X-RateLimit-Reset', result.ttlInSeconds);
        if (result.isExceeded) {
          reply.header('Retry-After', result.ttlInSeconds);
          throw new HttpError(
            429,
            ErrorCode.LIMIT_EXCEEDED,
            `${name} rate limit exceeded`,
            'Wait for the Retry-After interval before retrying',
          );
        }
      };
    };
    app.decorate('chatRateLimit', bucket('chat', options.chatMax));
    app.decorate('probeRateLimit', bucket('probe', options.probeMax));
    app.decorate('writeRateLimit', bucket('write', options.writeMax));
    app.decorate('ticketRateLimit', bucket('ticket', options.ticketMax));
  },
  { name: 'rate-limit', fastify: '5.x' },
);
