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
  confirmedPreview,
  AdvanceBodySchema,
  CancelBodySchema,
  RefundBodySchema,
  AdvanceExecuteSchema,
  CancelExecuteSchema,
  RefundExecuteSchema,
} from './schemas.js';
const orders: FastifyPluginAsync<{ runtime: Runtime }> = async (
  app,
  { runtime: { services, confirmation } },
) => {
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
  app.post<{ Reply: z.output<ReturnType<typeof confirmedPreview<typeof AdvancePreviewSchema>>> }>(
    '/orders/:id/advance/preview',
    {
      preHandler: app.writeRateLimit,
      schema: responseSchema(confirmedPreview(AdvancePreviewSchema)),
    },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(AdvanceBodySchema, request.body);
      const input = {
        orderId: id,
        actor: 'ops' as const,
        reason: body.reason,
        toStatus: body.to_status,
      };
      const preview = services.order.previewAdvanceStatus(input);
      return {
        ...preview,
        ...confirmation.sign({ channel: 'rest', operation: 'advance', args: input, preview }),
      };
    },
  );
  app.post<{ Reply: z.output<ReturnType<typeof confirmedPreview<typeof CancelPreviewSchema>>> }>(
    '/orders/:id/cancel/preview',
    {
      preHandler: app.writeRateLimit,
      schema: responseSchema(confirmedPreview(CancelPreviewSchema)),
    },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(CancelBodySchema, request.body);
      const input = { orderId: id, actor: 'ops' as const, reason: body.reason };
      const preview = services.order.previewCancel(input);
      return {
        ...preview,
        ...confirmation.sign({ channel: 'rest', operation: 'cancel', args: input, preview }),
      };
    },
  );
  app.post<{ Reply: z.output<ReturnType<typeof confirmedPreview<typeof RefundPreviewSchema>>> }>(
    '/orders/:id/refund/preview',
    {
      preHandler: app.writeRateLimit,
      schema: responseSchema(confirmedPreview(RefundPreviewSchema)),
    },
    async (request) => {
      const { id } = validate(IdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(RefundBodySchema, request.body);
      const input = {
        orderId: id,
        actor: 'ops' as const,
        reason: body.reason,
        amountPaise: body.amount_paise,
      };
      const preview = services.refund.previewRefund(input);
      return {
        ...preview,
        ...confirmation.sign({ channel: 'rest', operation: 'refund', args: input, preview }),
      };
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
        services.order.advanceStatusWithMetadata,
        confirmation,
        'advance',
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
        services.order.executeCancelWithMetadata,
        confirmation,
        'cancel',
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
        services.refund.executeRefundWithMetadata,
        confirmation,
        'refund',
      );
    },
  );
};
export default orders;
