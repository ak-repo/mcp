import { createHash, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import { HttpError } from '../lib/http-errors.js';
export default fp<{ token: string }>(
  async (app, options) => {
    const expected = createHash('sha256').update(options.token).digest();
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (
        request.method === 'GET' &&
        (path === '/api/health' || path === '/api/ready' || path === '/api/stream')
      )
        return;
      let count = 0;
      for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
        if (request.raw.rawHeaders[i]?.toLowerCase() === 'authorization') count++;
      const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
      const supplied = createHash('sha256')
        .update(match?.[1] ?? '')
        .digest();
      const equal = timingSafeEqual(expected, supplied);
      if (!equal || count !== 1 || !match) {
        reply.header('WWW-Authenticate', 'Bearer realm="foodops-api"');
        throw new HttpError(
          401,
          'UNAUTHORIZED',
          'Valid bearer authentication is required',
          'Send exactly one Authorization: Bearer <ADMIN_TOKEN> header',
        );
      }
    });
  },
  { name: 'auth', fastify: '5.x' },
);
