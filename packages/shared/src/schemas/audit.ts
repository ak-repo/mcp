import { z } from 'zod';
import { ErrorCode } from '../errors.js';
import { ActorSchema, IdSchema, JsonTextSchema, TextSchema, TimestampSchema } from './common.js';

export const ErrorCodeSchema = z.enum(ErrorCode);
export const ToolCallStatusSchema = z.enum(['success', 'error']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;
export const ToolCallLogSchema = z.strictObject({
  id: IdSchema,
  session_id: TextSchema.nullable(),
  tool: TextSchema,
  args_json: JsonTextSchema,
  status: ToolCallStatusSchema,
  error_code: ErrorCodeSchema.nullable(),
  latency_ms: z.number().int().nonnegative(),
  actor: ActorSchema,
  at: TimestampSchema,
});
export type ToolCallLog = z.infer<typeof ToolCallLogSchema>;

export const IdempotencyKeySchema = z.strictObject({
  key: TextSchema,
  operation: TextSchema,
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  response_json: JsonTextSchema,
  created_at: TimestampSchema,
});
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
