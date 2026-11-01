import { ToolCallListFiltersSchema, ToolCallLogSchema } from '@foodops/shared';
import { keys, newId, now, parse, type ServiceContext } from './context.js';
import type { AuditInput, AuditListInput } from './types.js';
export function createAuditService(context: ServiceContext) {
  return {
    recordCall(input: AuditInput) {
      keys(input, [
        'sessionId',
        'tool',
        'argsJson',
        'status',
        'errorCode',
        'latencyMs',
        'actor',
        'idempotencyKey',
      ]);
      const semantic = parse(
        ToolCallLogSchema.omit({ id: true, at: true }),
        {
          session_id: input.sessionId ?? null,
          tool: input.tool,
          args_json: input.argsJson,
          status: input.status,
          error_code: input.errorCode ?? null,
          latency_ms: input.latencyMs,
          actor: input.actor,
        },
        'tool call',
      );
      if (input.idempotencyKey !== undefined)
        parse(ToolCallLogSchema.shape.id, input.idempotencyKey, 'idempotency key');
      const request = {
        ...semantic,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      };
      return context.mutate(
        'audit.recordCall',
        request,
        (repos) => {
          const call = ToolCallLogSchema.parse({ ...semantic, id: newId(), at: now() });
          repos.audit.record(call);
          return call;
        },
        (value) => ToolCallLogSchema.parse(value),
      );
    },
    listCalls(input: AuditListInput = {}) {
      keys(input, ['cursor', 'limit', 'tool', 'status']);
      const filters = parse(ToolCallListFiltersSchema, input, 'audit filters');
      return context.read((repos) => repos.audit.list(filters));
    },
  };
}
