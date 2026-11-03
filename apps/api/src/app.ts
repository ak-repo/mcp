import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyReply,
} from 'fastify';
import type { Config } from './config.js';
import type { Runtime } from './runtime.js';
import requestContext, { requestId, safeCorrelation } from './plugins/request-context.js';
import errorHandler from './plugins/error-handler.js';
import securityHeaders from './plugins/security-headers.js';
import rateLimit from './plugins/rate-limit.js';
import cors from './plugins/cors.js';
import auth from './plugins/auth.js';
import routes from './routes/index.js';
import { mapHttpError } from './lib/http-errors.js';
export function buildApp(deps: { config: Config; runtime: Runtime }): FastifyInstance {
  const { config, runtime } = deps;
  const logger: FastifyBaseLogger = runtime.logger;
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'request_id',
    }),
    requestIdHeader: false,
    genReqId: requestId,
    trustProxy: false,
    // Use the mapped onRequest shutdown gate instead of Fastify's raw 503 shortcut.
    return503OnClosing: false,
    frameworkErrors(error, request, reply: FastifyReply) {
      // Router parse failures bypass application hooks, including request context.
      request.log = request.log.child({ run_id: safeCorrelation(request.headers['x-run-id']) });
      const mapped = mapHttpError(error);
      request.log[mapped.status >= 500 ? 'error' : 'warn'](
        mapped.status >= 500 ? { err: error } : { status: mapped.status },
        'Request rejected by router',
      );
      reply.header('X-Request-Id', request.id).header('Cache-Control', 'no-store');
      reply.code(mapped.status).send(mapped.body);
    },
    bodyLimit: 102400,
    requestTimeout: 10000,
    http: { headersTimeout: 10000 },
    exposeHeadRoutes: false,
    forceCloseConnections: 'idle',
  });
  app.register(requestContext);
  app.register(errorHandler);
  app.register(securityHeaders);
  app.register(cors, { origins: config.WEB_ORIGIN });
  app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MIN,
    writeMax: config.RATE_LIMIT_WRITE_PER_MIN,
    ticketMax: config.RATE_LIMIT_TICKET_PER_MIN,
  });
  app.register(auth, { token: config.ADMIN_TOKEN });
  app.addHook('onReady', async () => {
    runtime.start();
  });
  app.addHook('preClose', async () => {
    await runtime.stop();
  });
  app.register(routes, { replayLimit: config.SSE_REPLAY_LIMIT, prefix: '/api', runtime });
  return app;
}
