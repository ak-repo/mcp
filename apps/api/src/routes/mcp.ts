import { agentTools } from '../agent/tools.js';
import { validate } from '../lib/validate.js';
import { UpstreamHttpError } from '../lib/http-errors.js';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  ToolCallListFiltersSchema,
  ToolCallPageSchema,
  McpStatusSchema,
  McpToolCatalogSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters, pageResponse, defined } from '../lib/pagination.js';
import { responseSchema } from './schemas.js';
const mcp: FastifyPluginAsync<{ runtime: Runtime }> = async (app, { runtime }) => {
  const { services } = runtime;
  app.get('/mcp/status', async (request) => {
    validate(z.strictObject({}), request.query);
    return McpStatusSchema.parse(runtime.mcp.status());
  });
  app.get('/mcp/tools', async (request) => {
    validate(z.strictObject({}), request.query);
    try {
      return McpToolCatalogSchema.parse({
        tools: [
          ...agentTools(await runtime.mcp.listTools({ signal: runtime.signal })).values(),
        ].map(({ kind, definition }) => ({
          name: definition.name,
          description: definition.description,
          input_schema: definition.parameters,
          kind,
        })),
      });
    } catch {
      throw new UpstreamHttpError(
        'MCP tool catalog is unavailable',
        'Check MCP_URL, MCP_AUTH_TOKEN, and the MCP server',
      );
    }
  });
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
