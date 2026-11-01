import { ErrorCode } from '@foodops/shared';
import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '../lib/http-errors.js';
import type { Runtime } from '../runtime.js';
const health: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime }) => {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (request) => {
    try {
      runtime.checkReady();
    } catch (error) {
      request.log.error({ err: error }, 'Readiness check failed');
      throw new HttpError(503, ErrorCode.INTERNAL, 'Service is not ready', 'Retry later');
    }
    return { status: 'ready' };
  });
};
export default health;
