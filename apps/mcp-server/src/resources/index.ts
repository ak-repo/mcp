import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '@foodops/core';
import { registerSchemaResource } from './schema.js';
import { registerPolicyResource } from './policies.js';
import { registerInvoiceResource } from './invoice-template.js';

export function registerResources(server: McpServer, services: Services): void {
  registerSchemaResource(server);
  registerPolicyResource(server);
  registerInvoiceResource(server, services);
}
