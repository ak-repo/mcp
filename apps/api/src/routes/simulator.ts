import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Runtime } from '../runtime.js';
import { validate } from '../lib/validate.js';
const settings = z.strictObject({
  enabled: z.boolean(),
  interval_ms: z.number().int().min(1000).max(60000),
});
const empty = z.strictObject({});
const simulator: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime }) => {
  app.get('/simulator', async (request) => {
    validate(empty, request.query);
    return runtime.simulator.status();
  });
  app.post('/simulator', { preHandler: app.writeRateLimit }, async (request) => {
    validate(empty, request.query);
    return runtime.simulator.configure(validate(settings, request.body));
  });
};
export default simulator;
