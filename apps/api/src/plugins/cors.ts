import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { ErrorCode } from '@foodops/shared';
import { HttpError } from '../lib/http-errors.js';
export default fp<{ origins: readonly string[] }>(
  async (app, options) => {
    const allowed = new Set(options.origins);
    app.addHook('onRequest', async (request) => {
      if (request.method !== 'OPTIONS' || request.headers.origin === undefined) return;
      const method = request.headers['access-control-request-method'];
      if (typeof method !== 'string' || !method)
        throw new HttpError(
          400,
          ErrorCode.VALIDATION,
          'Invalid CORS preflight',
          'Include Origin and Access-Control-Request-Method',
        );
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method))
        throw new HttpError(
          403,
          'FORBIDDEN',
          'CORS method is not allowed',
          'Use an allowed API method',
        );
      const headers = request.headers['access-control-request-headers'];
      if (
        typeof headers === 'string' &&
        headers
          .split(',')
          .some(
            (header) =>
              ![
                'authorization',
                'content-type',
                'x-request-id',
                'x-run-id',
                'idempotency-key',
                'last-event-id',
              ].includes(header.trim().toLowerCase()),
          )
      )
        throw new HttpError(
          403,
          'FORBIDDEN',
          'CORS header is not allowed',
          'Use documented API headers',
        );
    });
    await app.register(cors, {
      origin(origin, done) {
        if (origin === undefined) {
          done(null, false);
          return;
        }
        if (allowed.has(origin)) {
          done(null, true);
          return;
        }
        done(
          new HttpError(403, 'FORBIDDEN', 'Origin is not allowed', 'Use a configured WEB_ORIGIN'),
          false,
        );
      },
      credentials: false,
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'X-Request-Id',
        'X-Run-Id',
        'Idempotency-Key',
        'Last-Event-ID',
      ],
      exposedHeaders: [
        'Retry-After',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'X-RateLimit-Reset',
        'Idempotency-Replayed',
        'X-Request-Id',
      ],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      strictPreflight: true,
    });
  },
  { name: 'cors', fastify: '5.x' },
);
