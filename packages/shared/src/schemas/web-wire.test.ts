import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ApiErrorEnvelopeSchema,
  ChangeSchema,
  ErrorCode,
  ErrorCodeSchema,
  LiveChangeEventSchema,
  McpCallEventSchema,
  MeResponseSchema,
  ReadyResponseSchema,
  StreamTicketResponseSchema,
  ToolCallFeedSchema,
} from '../index.js';

const at = '2026-11-04T12:00:00.000Z';
const change = { id: 42, type: 'order.updated', order_id: 'O-1', entity: 'order', at };
const call = {
  tool: 'get_order',
  status: 'success',
  error_code: null,
  latency_ms: 12,
  at,
};

const examples: { name: string; schema: z.ZodType; value: Record<string, unknown> }[] = [
  { name: 'me', schema: MeResponseSchema, value: { actor: 'ops', auth: 'bearer' } },
  { name: 'ready', schema: ReadyResponseSchema, value: { status: 'ready' } },
  {
    name: 'stream ticket',
    schema: StreamTicketResponseSchema,
    value: { ticket: 'aB09_-'.repeat(7) + 'x', expires_at: at },
  },
  {
    name: 'API error',
    schema: ApiErrorEnvelopeSchema,
    value: {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Valid bearer authentication is required',
        hint: 'Send exactly one Authorization: Bearer <ADMIN_TOKEN> header',
      },
    },
  },
  { name: 'live change', schema: LiveChangeEventSchema, value: change },
  { name: 'MCP call', schema: McpCallEventSchema, value: call },
];

describe.each(examples)('$name wire contract', ({ schema, value }) => {
  it('parses an API-shaped example unchanged', () => {
    expect(schema.parse(value)).toEqual(value);
  });

  it('rejects unknown top-level fields', () => {
    expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
  });

  it('requires every documented field without coercion', () => {
    for (const key of Object.keys(value)) {
      const missing = { ...value };
      delete missing[key];
      expect(schema.safeParse(missing).success, `missing ${key}`).toBe(false);
      expect(schema.safeParse({ ...value, [key]: [] }).success, `array ${key}`).toBe(false);
    }
  });
});

describe('HTTP response constraints', () => {
  it('rejects alternate actors, authentication methods and readiness states', () => {
    expect(MeResponseSchema.safeParse({ actor: 'ai', auth: 'bearer' }).success).toBe(false);
    expect(MeResponseSchema.safeParse({ actor: 'ops', auth: 'cookie' }).success).toBe(false);
    expect(ReadyResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });

  it('requires a 43-character base64url ticket and ISO expiry', () => {
    for (const ticket of ['', 'a'.repeat(42), 'a'.repeat(44), '+'.repeat(43)]) {
      expect(StreamTicketResponseSchema.safeParse({ ticket, expires_at: at }).success).toBe(false);
    }
    expect(
      StreamTicketResponseSchema.safeParse({ ticket: 'a'.repeat(43), expires_at: 'tomorrow' })
        .success,
    ).toBe(false);
  });

  it.each([...Object.values(ErrorCode), 'UNAUTHORIZED', 'FORBIDDEN'])(
    'accepts HTTP error code %s without changing the domain error enum',
    (code) => {
      const error = { code, message: 'Request failed', hint: 'Check the request' };
      expect(ApiErrorEnvelopeSchema.parse({ error })).toEqual({ error });
      expect(ErrorCodeSchema.safeParse(code).success).toBe(
        Object.values<string>(ErrorCode).includes(code),
      );
    },
  );

  it('requires a strict error object with string message and hint', () => {
    const error = { code: 'INTERNAL', message: 'Request failed', hint: 'Retry later' };
    for (const field of ['code', 'message', 'hint']) {
      const missing: Record<string, unknown> = { ...error };
      delete missing[field];
      expect(ApiErrorEnvelopeSchema.safeParse({ error: missing }).success).toBe(false);
      expect(ApiErrorEnvelopeSchema.safeParse({ error: { ...error, [field]: 123 } }).success).toBe(
        false,
      );
    }
    expect(ApiErrorEnvelopeSchema.safeParse({ error: { ...error, secret: 'extra' } }).success).toBe(
      false,
    );
    expect(ApiErrorEnvelopeSchema.safeParse({ error: { ...error, code: 'UNKNOWN' } }).success).toBe(
      false,
    );
  });
});

describe('SSE payload contracts', () => {
  it.each([
    ['order.updated', 'order'],
    ['delivery.updated', 'delivery'],
    ['partner.updated', 'partner'],
    ['payment.updated', 'payment'],
    ['payment.updated', 'refund'],
    ['invoice.updated', 'invoice'],
  ])('parses %s for entity %s', (type, entity) => {
    const value = { ...change, type, entity };
    expect(LiveChangeEventSchema.parse(value)).toEqual(value);
    expect(LiveChangeEventSchema.safeParse({ ...value, entity_id: 'private' }).success).toBe(false);
    expect(LiveChangeEventSchema.safeParse({ ...value, id: '42' }).success).toBe(false);
  });

  it('allows a nullable order association and rejects inconsistent event/entity pairs', () => {
    const unassigned = { ...change, type: 'partner.updated', entity: 'partner', order_id: null };
    expect(LiveChangeEventSchema.parse(unassigned)).toEqual(unassigned);
    expect(LiveChangeEventSchema.safeParse({ ...change, entity: 'refund' }).success).toBe(false);
    expect(LiveChangeEventSchema.safeParse({ ...change, type: 'refund.updated' }).success).toBe(
      false,
    );
    expect(LiveChangeEventSchema.safeParse({ ...change, order_id: '' }).success).toBe(false);
  });

  it('rejects invalid cursors and timestamps', () => {
    for (const id of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(LiveChangeEventSchema.safeParse({ ...change, id }).success).toBe(false);
    }
    expect(LiveChangeEventSchema.safeParse({ ...change, at: 'yesterday' }).success).toBe(false);
  });

  it('parses MCP error calls and retains the original domain error-code restriction', () => {
    for (const error_code of Object.values(ErrorCode)) {
      const value = { ...call, status: 'error', error_code };
      expect(McpCallEventSchema.parse(value)).toEqual(value);
    }
    for (const error_code of ['UNAUTHORIZED', 'FORBIDDEN', 'UNKNOWN']) {
      expect(McpCallEventSchema.safeParse({ ...call, error_code }).success).toBe(false);
    }
  });

  it('rejects MCP internal fields, SSE metadata and invalid values', () => {
    for (const field of ['rowid', 'id', 'type', 'args_json']) {
      expect(McpCallEventSchema.safeParse({ ...call, [field]: 'extra' }).success).toBe(false);
    }
    for (const latency_ms of [-1, 0.5, '12', Number.MAX_SAFE_INTEGER + 1]) {
      expect(McpCallEventSchema.safeParse({ ...call, latency_ms }).success).toBe(false);
    }
    expect(McpCallEventSchema.safeParse({ ...call, status: 'ok' }).success).toBe(false);
    expect(McpCallEventSchema.safeParse({ ...call, tool: '' }).success).toBe(false);
    expect(McpCallEventSchema.safeParse({ ...call, at: 'today' }).success).toBe(false);
  });

  it('leaves existing internal schemas unchanged', () => {
    expect(ToolCallFeedSchema.safeParse(call).success).toBe(false);
    expect(ToolCallFeedSchema.parse({ ...call, rowid: 7 })).toEqual({ ...call, rowid: 7 });
    expect(ChangeSchema.safeParse(change).success).toBe(false);
    const internal = {
      id: 42,
      entity: 'order',
      entity_id: 'O-1',
      order_id: 'O-1',
      op: 'update',
      at,
    };
    expect(ChangeSchema.parse(internal)).toEqual(internal);
  });
});
