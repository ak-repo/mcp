import type { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { SalesSummaryFiltersSchema, SalesSummarySchema } from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters } from '../lib/pagination.js';
import { responseSchema } from './schemas.js';
const metrics: FastifyPluginAsync<{ runtime: Runtime }> = async (
  app,
  { runtime: { services } },
) => {
  app.get<{ Reply: z.output<typeof SalesSummarySchema> }>(
    '/metrics/summary',
    { schema: responseSchema(SalesSummarySchema) },
    async (request) => {
      const query = queryFilters(SalesSummaryFiltersSchema, request.query);
      return services.metrics.getSalesSummary({
        from: query.from,
        to: query.to,
        groupBy: query.group_by,
      });
    },
  );
};
export default metrics;
