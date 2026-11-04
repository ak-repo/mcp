import { z } from 'zod';
import { ErrorCodeSchema } from './audit.js';
import { ChangeSchema, ToolCallFeedSchema } from './changes.js';
import { TimestampSchema } from './common.js';

export const MeResponseSchema = z.strictObject({
  actor: z.literal('ops'),
  auth: z.literal('bearer'),
});

export const ReadyResponseSchema = z.strictObject({ status: z.literal('ready') });

export const StreamTicketResponseSchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expires_at: TimestampSchema,
});

// HTTP authentication codes do not belong to the core/MCP ErrorCode enum.
export const ApiErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.union([ErrorCodeSchema, z.enum(['UNAUTHORIZED', 'FORBIDDEN'])]),
    message: z.string(),
    hint: z.string(),
  }),
});

const liveChange = ChangeSchema.pick({ id: true, order_id: true, at: true });

// Match changeEvent(): refunds invalidate payments; entity IDs and ops stay private.
export const LiveChangeEventSchema = z.discriminatedUnion('type', [
  liveChange.extend({ type: z.literal('order.updated'), entity: z.literal('order') }),
  liveChange.extend({ type: z.literal('delivery.updated'), entity: z.literal('delivery') }),
  liveChange.extend({ type: z.literal('partner.updated'), entity: z.literal('partner') }),
  liveChange.extend({
    type: z.literal('payment.updated'),
    entity: z.enum(['payment', 'refund']),
  }),
  liveChange.extend({ type: z.literal('invoice.updated'), entity: z.literal('invoice') }),
]);

// mcp.call is live-only: no durable SSE ID, internal rowid or type in the JSON payload.
export const McpCallEventSchema = ToolCallFeedSchema.omit({ rowid: true });

export type MeResponse = z.infer<typeof MeResponseSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
export type StreamTicketResponse = z.infer<typeof StreamTicketResponseSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export type LiveChangeEvent = z.infer<typeof LiveChangeEventSchema>;
export type McpCallEvent = z.infer<typeof McpCallEventSchema>;
