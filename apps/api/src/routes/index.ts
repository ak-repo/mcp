import type { FastifyPluginAsync } from 'fastify';
import type { Runtime } from '../runtime.js';
import health from './health.js';
import restaurants from './restaurants.js';
import orders from './orders.js';
import deliveries from './deliveries.js';
import metrics from './metrics.js';
import mcp from './mcp.js';
const routes: FastifyPluginAsync<{ runtime: Runtime }> = async (app, options) => {
  for (const plugin of [health, restaurants, orders, deliveries, metrics, mcp]) {
    await app.register(plugin, { runtime: options.runtime });
  }
};
export default routes;
