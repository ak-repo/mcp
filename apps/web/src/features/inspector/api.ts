import {
  McpStatusSchema,
  McpToolCatalogSchema,
  ToolCallPageSchema,
  type ToolCallStatus,
} from '@foodops/shared';
import { apiFetch } from '../../lib/api/client.js';
import { query } from '../orders/api.js';

export function listCalls(
  filters: { tool?: string; status?: ToolCallStatus; limit?: number },
  signal?: AbortSignal,
) {
  return apiFetch(`/api/mcp/calls${query(filters)}`, ToolCallPageSchema, signal ? { signal } : {});
}
export function listTools(signal?: AbortSignal) {
  return apiFetch('/api/mcp/tools', McpToolCatalogSchema, signal ? { signal } : {});
}
export function getMcpStatus(signal?: AbortSignal) {
  return apiFetch('/api/mcp/status', McpStatusSchema, signal ? { signal } : {});
}
