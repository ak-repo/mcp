import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppError, ErrorCode } from '@foodops/shared';
import { allTools } from '../tools/index.js';
import { defineTool, type ToolDefinition, type ToolDependencies } from './define-tool.js';
import { z } from 'zod';
import { registerResources } from '../resources/index.js';
import { registerPrompts } from '../prompts/index.js';

/** Construct an unconnected server; the caller owns its transport and database handles. */
export function createServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer({ name: 'foodops-mcp', version: '0.0.0' });
  const registry = new Map<string, ToolDefinition>();
  for (const tool of allTools) {
    if (registry.has(tool.name)) throw new Error('Duplicate tool registration');
    registry.set(tool.name, tool);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      (args, extra) => tool.run(args, extra, dependencies),
    );
  }
  // SDK validation precedes callbacks. Dispatch through the public protocol API so
  // validation errors have the shared error format and are audited as well.
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const tool =
      (!request.params.task && registry.get(request.params.name)) ||
      defineTool({
        name: request.params.name,
        description: 'Unknown tool',
        inputSchema: z.unknown(),
        dataSchema: z.strictObject({}),
        hint: 'Use tools/list to discover available tools',
        execute: () => {
          throw new AppError(
            request.params.task ? ErrorCode.VALIDATION : ErrorCode.NOT_FOUND,
            request.params.task ? 'Task execution is not supported' : 'Tool was not found',
            'Use a normal tools/call request with a name from tools/list',
          );
        },
        summarize: () => 'Unknown tool',
      });
    return tool.run(request.params.arguments, extra, dependencies);
  });
  registerResources(server, dependencies.services);
  registerPrompts(server);
  return server;
}
