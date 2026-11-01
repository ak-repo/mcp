import fp from 'fastify-plugin';
import { ErrorCode } from '@foodops/shared';
import { HttpError, mapHttpError } from '../lib/http-errors.js';
export default fp(
  async (app) => {
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapHttpError(error);
      if (mapped.status >= 500) request.log.error({ err: error }, 'Request failed');
      reply.code(mapped.status).send(mapped.body);
    });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0] ?? '/';
      const methods = (['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).filter(
        (method) => app.hasRoute({ method, url }),
      );
      if (methods.length > 0) {
        reply.header('Allow', methods.join(', '));
        throw new HttpError(
          405,
          ErrorCode.VALIDATION,
          'Method is not allowed',
          'Use a method listed in Allow',
        );
      }
      throw new HttpError(404, ErrorCode.NOT_FOUND, 'Route was not found', 'Check the API path');
    });
  },
  { name: 'error-handler', fastify: '5.x' },
);
