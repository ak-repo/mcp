import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { onRequestAsyncHookHandler } from 'fastify';
import { ErrorCode } from '@foodops/shared';
import { HttpError } from '../lib/http-errors.js';
declare module 'fastify' {
  interface FastifyInstance {
    writeRateLimit: onRequestAsyncHookHandler;
  }
}
export default fp<{ max: number }>(
  async (app, options) => {
    await app.register(rateLimit, {
      global: false,
      max: options.max,
      timeWindow: 60000,
    });
    // An application hook also covers auth failures and unknown routes.
    app.addHook('onRequest', app.rateLimit());
    // createRateLimit avoids the plugin's per-request "already ran" flag:
    // both the global bucket and this independent write bucket must be consumed.
    const checkWrite = app.createRateLimit({
      max: Math.max(1, Math.floor(options.max / 4)),
      timeWindow: 60000,
      keyGenerator: (request) => `write:${request.ip}`,
    });
    app.decorate('writeRateLimit', async (request, reply) => {
      const result = await checkWrite(request);
      if (result.isAllowed) return;
      reply.header('X-RateLimit-Limit', result.max);
      reply.header('X-RateLimit-Remaining', result.remaining);
      reply.header('X-RateLimit-Reset', result.ttlInSeconds);
      if (result.isExceeded) {
        reply.header('Retry-After', result.ttlInSeconds);
        throw new HttpError(
          429,
          ErrorCode.LIMIT_EXCEEDED,
          'Write rate limit exceeded',
          'Wait for the Retry-After interval before retrying',
        );
      }
    });
  },
  { name: 'rate-limit', fastify: '5.x' },
);
