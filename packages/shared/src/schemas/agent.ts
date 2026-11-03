import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AgentUsageSchema = z.strictObject({ promptTokens: count, completionTokens: count });
export const ApprovalDecisionSchema = z.enum(['approved', 'rejected', 'expired', 'cancelled']);
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('run.started'),
    run_id: IdSchema,
    session_id: IdSchema,
    provider: IdSchema,
    model: IdSchema,
  }),
  z.strictObject({ type: z.literal('text.delta'), text: z.string() }),
  z.strictObject({ type: z.literal('thinking.delta'), text: z.string() }),
  z.strictObject({
    type: z.literal('tool.call'),
    call_id: IdSchema,
    name: IdSchema,
    arguments: z.record(z.string(), z.json()),
    kind: z.enum(['read', 'write']),
  }),
  z.strictObject({
    type: z.literal('tool.result'),
    call_id: IdSchema,
    name: IdSchema,
    status: z.enum(['ok', 'error']),
    latency_ms: count,
    summary: z.string(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('approval.required'),
    call_id: IdSchema,
    name: IdSchema,
    preview: z.json(),
    expires_at: TimestampSchema,
  }),
  z.strictObject({
    type: z.literal('approval.resolved'),
    call_id: IdSchema,
    decision: ApprovalDecisionSchema,
  }),
  z.strictObject({ type: z.literal('run.completed'), usage: AgentUsageSchema, iterations: count }),
  z.strictObject({
    type: z.literal('run.error'),
    kind: IdSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
