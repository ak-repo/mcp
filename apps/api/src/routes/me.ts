import type { FastifyPluginAsync } from 'fastify';
import { EmptyQuerySchema } from './schemas.js';
import { validate } from '../lib/validate.js';
const me: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    validate(EmptyQuerySchema, request.query);
    return { actor: 'ops', auth: 'bearer' };
  });
};
export default me;
