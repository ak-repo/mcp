import type { FastifyPluginAsync } from 'fastify';
import type { Runtime } from '../runtime.js';
import health from './health.js';
const routes: FastifyPluginAsync<{ runtime: Runtime }> = async (app, options) => {
  await app.register(health, { runtime: options.runtime });
};
export default routes;
