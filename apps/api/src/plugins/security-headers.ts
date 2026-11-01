import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
export default fp(
  async (app) => {
    await app.register(helmet, {
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
  },
  { name: 'security-headers', fastify: '5.x' },
);
