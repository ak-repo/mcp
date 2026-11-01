import type { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { ToolCallListFiltersSchema, ToolCallPageSchema } from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters, pageResponse, defined } from '../lib/pagination.js';
import { responseSchema } from './schemas.js';
const mcp: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime: { services } }) => {
  app.get<{ Reply: z.output<typeof ToolCallPageSchema> }>(
    '/mcp/calls',
    { schema: responseSchema(ToolCallPageSchema) },
    async (request) => {
      const query = queryFilters(ToolCallListFiltersSchema, request.query);
      return pageResponse(services.audit.listCalls(defined(query)));
    },
  );
};
export default mcp;
