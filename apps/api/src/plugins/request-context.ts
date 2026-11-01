import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { ErrorCode } from '@foodops/shared';
import { HttpError } from '../lib/http-errors.js';
export function safeCorrelation(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}
export function requestId(request: {
  rawHeaders: string[];
  headers: { [key: string]: unknown };
}): string {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === 'x-request-id') count++;
  return count === 1 ? safeCorrelation(request.headers['x-request-id']) : randomUUID();
}
export default fp(
  async (app) => {
    let stopping = false;
    app.addHook('preClose', async () => {
      stopping = true;
    });
    app.addHook('onRequest', async (request, reply) => {
      request.log = request.log.child({ run_id: safeCorrelation(request.headers['x-run-id']) });
      reply.header('X-Request-Id', request.id);
      request.log.info(
        { method: request.method, path: request.url.split('?')[0] },
        'Request started',
      );
      if (stopping)
        throw new HttpError(
          503,
          ErrorCode.INTERNAL,
          'Service is stopping',
          'Retry after the service restarts',
        );
    });
    app.addHook('onResponse', async (request: FastifyRequest, reply) => {
      request.log.info(
        { status: reply.statusCode, latency_ms: reply.elapsedTime },
        'Request completed',
      );
    });
  },
  { name: 'request-context', fastify: '5.x' },
);
