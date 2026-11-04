import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ChatRequestSchema,
  ApproveRequestSchema,
  ApprovalResponseSchema,
  CancelRunResponseSchema,
  AgentEventSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { validate } from '../lib/validate.js';
const empty = z.strictObject({});
const params = z.strictObject({ runId: z.string().min(1).max(128) });
const chat: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime }) => {
  app.post('/chat', { preHandler: app.chatRateLimit }, async (request, reply) => {
    validate(empty, request.query);
    const input = validate(ChatRequestSchema, request.body);
    let run: ReturnType<Runtime['agent']['start']>;
    try {
      run = runtime.agent.start({
        message: input.message,
        ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
      });
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'statusCode' in error &&
        error.statusCode === 429
      )
        reply.header('Retry-After', '1');
      throw error;
    }
    let terminal = false;
    let clientAborted = false;
    const context = { run_id: run.runId, session_id: run.sessionId };
    const warn = (error: unknown) =>
      request.log.warn(
        { run_id: run.runId, err: run.safeError(error) },
        'Chat stream cleanup failed',
      );
    let connection: ReturnType<Runtime['chatStreams']['open']> | undefined;
    try {
      reply.hijack();
      for (const [key, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined)
          reply.raw.setHeader(
            key,
            typeof value === 'number' || typeof value === 'string' ? value : [...value],
          );
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      connection = runtime.chatStreams.open(reply.raw, () => {
        if (!terminal) {
          clientAborted = true;
          run.abort();
        }
      });
      for await (const raw of run.events) {
        const event = AgentEventSchema.parse(raw);
        if (event.type === 'run.completed' || event.type === 'run.error') terminal = true;
        if (!(await connection.send(event))) break;
      }
    } catch (error) {
      if (!clientAborted && !request.raw.aborted && !reply.raw.destroyed && !runtime.signal.aborted)
        request.log.error({ ...context, err: run.safeError(error) }, 'Chat event loop failed');
      else
        request.log.warn(
          { run_id: run.runId, err: run.safeError(error) },
          'Chat stream interrupted',
        );
      if (connection && !reply.raw.destroyed && !terminal) {
        terminal = true;
        try {
          await connection.send({
            type: 'run.error',
            kind: 'internal',
            message: 'Chat stream could not complete',
            retryable: false,
          });
        } catch (failure) {
          warn(failure);
        }
      }
    } finally {
      try {
        await run.close();
      } catch (error) {
        warn(error);
      }
      try {
        connection?.close();
      } catch (error) {
        warn(error);
      }
    }
  });
  app.post('/chat/:runId/approve', { preHandler: app.writeRateLimit }, async (request) => {
    validate(empty, request.query);
    const { runId } = validate(params, request.params);
    const { call_id, decision } = validate(ApproveRequestSchema, request.body);
    return ApprovalResponseSchema.parse(runtime.agent.resolve(runId, call_id, decision));
  });
  app.post('/chat/:runId/cancel', { preHandler: app.writeRateLimit }, async (request) => {
    validate(empty, request.query);
    validate(empty.optional(), request.body);
    const { runId } = validate(params, request.params);
    return CancelRunResponseSchema.parse(runtime.agent.cancel(runId));
  });
};
export default chat;
