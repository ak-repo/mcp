import type { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  OrderSearchFiltersSchema,
  OrderPageSchema,
  OrderDetailsSchema,
  InvoiceDetailsSchema,
  AdvancePreviewSchema,
  CancelPreviewSchema,
  RefundPreviewSchema,
  OrderMutationSchema,
  RefundResultSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters, pageResponse, defined } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { executeRequest } from '../lib/execute-request.js';
import {
  IdParamsSchema,
  EmptyQuerySchema,
  responseSchema,
  AdvanceBodySchema,
  CancelBodySchema,
  RefundBodySchema,
  AdvanceExecuteSchema,
  CancelExecuteSchema,
  RefundExecuteSchema,
} from './schemas.js';
const orders: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime: { services } }) => {
  app.get<{ Reply: z.output<typeof OrderPageSchema> }>(
    '/orders',
    { schema: responseSchema(OrderPageSchema) },
    async (request) => {
      const query = queryFilters(OrderSearchFiltersSchema, request.query);
      return pageResponse(
        services.order.listOrders(
          defined({
            query: query.q,
            status: query.status,
            customerId: query.customer_id,
            restaurantId: query.restaurant_id,
            from: query.from,
            to: query.to,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
    },
  );
  app.get<{ Reply: z.output<typeof OrderDetailsSchema> }>(
    '/orders/:id',
    { schema: responseSchema(OrderDetailsSchema) },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      return services.order.getOrder(id);
    },
  );
  app.get<{ Reply: z.output<typeof InvoiceDetailsSchema> }>(
    '/orders/:id/invoice',
    { schema: responseSchema(InvoiceDetailsSchema) },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      return services.invoice.getInvoice(id);
    },
  );
  app.post<{ Reply: z.output<typeof AdvancePreviewSchema> }>(
    '/orders/:id/advance/preview',
    { preHandler: app.writeRateLimit, schema: responseSchema(AdvancePreviewSchema) },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(AdvanceBodySchema, request.body);
      return services.order.previewAdvanceStatus({
        orderId: id,
        actor: 'ops',
        reason: body.reason,
        toStatus: body.to_status,
      });
    },
  );
  app.post<{ Reply: z.output<typeof CancelPreviewSchema> }>(
    '/orders/:id/cancel/preview',
    { preHandler: app.writeRateLimit, schema: responseSchema(CancelPreviewSchema) },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(CancelBodySchema, request.body);
      return services.order.previewCancel({ orderId: id, actor: 'ops', reason: body.reason });
    },
  );
  app.post<{ Reply: z.output<typeof RefundPreviewSchema> }>(
    '/orders/:id/refund/preview',
    { preHandler: app.writeRateLimit, schema: responseSchema(RefundPreviewSchema) },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(RefundBodySchema, request.body);
      return services.refund.previewRefund({
        orderId: id,
        actor: 'ops',
        reason: body.reason,
        amountPaise: body.amount_paise,
      });
    },
  );
  app.post<{ Reply: z.output<typeof OrderMutationSchema> }>(
    '/orders/:id/advance',
    { preHandler: app.writeRateLimit, schema: responseSchema(OrderMutationSchema) },
    async (request, reply) => {
      const { id } = validate(IdParamsSchema, request.params);
      return executeRequest(
        request,
        reply,
        AdvanceExecuteSchema,
        (body, key) => ({
          orderId: id,
          actor: 'ops' as const,
          reason: body.reason,
          toStatus: body.to_status,
          idempotencyKey: key,
        }),
        services.order.replayAdvanceStatus,
        services.order.advanceStatus,
      );
    },
  );
  app.post<{ Reply: z.output<typeof OrderMutationSchema> }>(
    '/orders/:id/cancel',
    { preHandler: app.writeRateLimit, schema: responseSchema(OrderMutationSchema) },
    async (request, reply) => {
      const { id } = validate(IdParamsSchema, request.params);
      return executeRequest(
        request,
        reply,
        CancelExecuteSchema,
        (body, key) => ({
          orderId: id,
          actor: 'ops' as const,
          reason: body.reason,
          idempotencyKey: key,
        }),
        services.order.replayCancel,
        services.order.executeCancel,
      );
    },
  );
  app.post<{ Reply: z.output<typeof RefundResultSchema> }>(
    '/orders/:id/refund',
    { preHandler: app.writeRateLimit, schema: responseSchema(RefundResultSchema) },
    async (request, reply) => {
      const { id } = validate(IdParamsSchema, request.params);
      return executeRequest(
        request,
        reply,
        RefundExecuteSchema,
        (body, key) => ({
          orderId: id,
          actor: 'ops' as const,
          reason: body.reason,
          amountPaise: body.amount_paise,
          idempotencyKey: key,
        }),
        services.refund.replayRefund,
        services.refund.executeRefund,
      );
    },
  );
};
export default orders;
