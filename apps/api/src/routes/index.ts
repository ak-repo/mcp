import me from './me.js';
import type { FastifyPluginAsync } from 'fastify';
import type { Runtime } from '../runtime.js';
import simulator from './simulator.js';
import stream from './stream.js';
import health from './health.js';
import restaurants from './restaurants.js';
import orders from './orders.js';
import deliveries from './deliveries.js';
import metrics from './metrics.js';
import mcp from './mcp.js';
const routes: FastifyPluginAsync<{ runtime: Runtime; replayLimit: number }> = async (
  app,
  options,
) => {
  await app.register(stream, { runtime: options.runtime, replayLimit: options.replayLimit });
  for (const plugin of [health, restaurants, orders, deliveries, metrics, mcp, simulator, me]) {
    await app.register(plugin, { runtime: options.runtime });
  }
};
export default routes;
