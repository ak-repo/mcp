import { z } from 'zod';
import { IdSchema } from './common.js';
export const ChatRequestSchema = z.strictObject({
  session_id: IdSchema.max(128).optional(),
  message: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => value.trim().length > 0, 'Message must not be blank'),
});
export const ApproveRequestSchema = z.strictObject({
  call_id: IdSchema.max(128),
  decision: z.enum(['approved', 'rejected']),
});
export const ApprovalResponseSchema = z.strictObject({
  run_id: IdSchema,
  ...ApproveRequestSchema.shape,
});
export const CancelRunResponseSchema = z.strictObject({
  run_id: IdSchema,
  status: z.literal('cancelled'),
});
export const ProviderPublicConfigSchema = z.strictObject({
  provider: z.enum(['ollama', 'openai-compatible', 'anthropic']),
  base_url: z.string(),
  model: z.string().nullable(),
  tool_mode: z.enum(['auto', 'native', 'prompted']),
  effective_tool_mode: z.enum(['native', 'prompted']),
  temperature: z.number().finite().min(0).max(2),
  num_ctx: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  api_key_set: z.boolean(),
  capabilities: z.strictObject({
    toolCalling: z.boolean(),
    streaming: z.boolean(),
    thinking: z.boolean(),
  }),
});
export const ProviderUpdateSchema = z
  .strictObject({
    provider: z.enum(['ollama', 'openai-compatible', 'anthropic']).optional(),
    base_url: z.string().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    tool_mode: z.enum(['auto', 'native', 'prompted']).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    num_ctx: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    api_key: z.string().min(1).regex(/^\S+$/).optional(),
    clear_api_key: z.boolean().optional(),
  })
  .refine(
    (value) => !(value.api_key !== undefined && value.clear_api_key === true),
    'Set or clear the API key, not both',
  );
export const ProbeStepSchema = z.strictObject({
  name: z.enum(['list_models', 'model_present', 'tool_smoke']),
  ok: z.boolean(),
  detail: z.string(),
  latency_ms: z.number().int().nonnegative(),
});
export const ModelInfoSchema = z.strictObject({
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const ModelListSchema = z.strictObject({ models: z.array(ModelInfoSchema) });
export const ProbeResultSchema = z.strictObject({
  ok: z.boolean(),
  steps: z.array(ProbeStepSchema),
  models: z.array(ModelInfoSchema),
  model_found: z.boolean(),
  tool_calling: z.enum(['native', 'prompted', 'none']),
  recommended_tool_mode: z.enum(['native', 'prompted']),
  warnings: z.array(z.string()),
});
export const ProvidersResponseSchema = ProviderPublicConfigSchema.extend({
  last_probe: ProbeResultSchema.nullable(),
});
export const McpToolCatalogSchema = z.strictObject({
  tools: z.array(
    z.strictObject({
      name: z.string().min(1),
      description: z.string(),
      input_schema: z.record(z.string(), z.json()),
      kind: z.enum(['read', 'write']),
    }),
  ),
});
export const McpStatusSchema = z.strictObject({
  connected: z.boolean(),
  last_error: z.string().nullable(),
  tool_count: z.number().int().nonnegative(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
export type ProviderPublicConfig = z.infer<typeof ProviderPublicConfigSchema>;
export type ProviderUpdate = z.infer<typeof ProviderUpdateSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export type ProbeStep = z.infer<typeof ProbeStepSchema>;
export type ModelList = z.infer<typeof ModelListSchema>;
export type McpToolCatalog = z.infer<typeof McpToolCatalogSchema>;
export type McpStatus = z.infer<typeof McpStatusSchema>;
