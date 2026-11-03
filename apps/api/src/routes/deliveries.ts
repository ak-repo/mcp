import type { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  DeliveryListFiltersSchema,
  PartnerListFiltersSchema,
  DeliveryPageSchema,
  PartnerPageSchema,
  ReassignPreviewSchema,
  ReassignResultSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters, pageResponse, defined } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { executeRequest } from '../lib/execute-request.js';
import {
  OrderIdParamsSchema,
  EmptyQuerySchema,
  ReassignBodySchema,
  ReassignExecuteSchema,
  responseSchema,
  confirmedPreview,
} from './schemas.js';
const deliveries: FastifyPluginAsync<{ runtime: Runtime }> = async (
  app,
  { runtime: { services, confirmation } },
) => {
  app.get<{ Reply: z.output<typeof DeliveryPageSchema> }>(
    '/deliveries',
    { schema: responseSchema(DeliveryPageSchema) },
    async (request) => {
      const query = queryFilters(DeliveryListFiltersSchema, request.query);
      return pageResponse(
        services.delivery.listDeliveries(
          defined({
            status: query.status,
            partnerId: query.partner_id,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
    },
  );
  app.get<{ Reply: z.output<typeof PartnerPageSchema> }>(
    '/delivery-partners',
    { schema: responseSchema(PartnerPageSchema) },
    async (request) => {
      const query = queryFilters(PartnerListFiltersSchema, request.query);
      return pageResponse(services.delivery.listDeliveryPartners(defined(query)));
    },
  );
  app.post<{ Reply: z.output<ReturnType<typeof confirmedPreview<typeof ReassignPreviewSchema>>> }>(
    '/deliveries/:orderId/reassign/preview',
    {
      preHandler: app.writeRateLimit,
      schema: responseSchema(confirmedPreview(ReassignPreviewSchema)),
    },
    async (request) => {
      const { orderId } = validate(OrderIdParamsSchema, request.params);
      validate(EmptyQuerySchema, request.query);
      const body = validate(ReassignBodySchema, request.body);
      const input = {
        orderId,
        actor: 'ops' as const,
        reason: body.reason,
        partnerId: body.partner_id,
      };
      const preview = services.delivery.previewReassign(input);
      return {
        ...preview,
        ...confirmation.sign({ channel: 'rest', operation: 'reassign', args: input, preview }),
      };
    },
  );
  app.post<{ Reply: z.output<typeof ReassignResultSchema> }>(
    '/deliveries/:orderId/reassign',
    { preHandler: app.writeRateLimit, schema: responseSchema(ReassignResultSchema) },
    async (request, reply) => {
      const { orderId } = validate(OrderIdParamsSchema, request.params);
      return executeRequest(
        request,
        reply,
        ReassignExecuteSchema,
        (body, key) => ({
          orderId,
          actor: 'ops' as const,
          reason: body.reason,
          partnerId: body.partner_id,
          idempotencyKey: key,
        }),
        services.delivery.replayReassign,
        services.delivery.executeReassignWithMetadata,
        confirmation,
        'reassign',
      );
    },
  );
};
export default deliveries;
