import {
  AppError,
  ErrorCode,
  TimestampSchema,
  ToolCallListFiltersSchema,
  ToolCallLogSchema,
} from '@foodops/shared';
import { keys, newId, now, parse, type ServiceContext } from './context.js';
import type { AuditInput, AuditListInput } from './types.js';
export function createAuditService(context: ServiceContext) {
  function bounds(id: number, limit: number) {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10000
    )
      throw new AppError(
        ErrorCode.VALIDATION,
        'Invalid change cursor or limit',
        'Use a nonnegative safe integer cursor and a limit from 1 to 10000',
      );
  }
  return {
    listChangesAfter(id: number, limit = 1000) {
      bounds(id, limit);
      return context.read((repos) => repos.audit.changesAfter(id, limit));
    },
    changeSnapshotAfter(id: number, limit = 1000) {
      bounds(id, limit);
      return context.read((repos) => {
        const bounds = repos.audit.changeBounds();
        const items = repos.audit.changesAfter(id, limit);
        const last = items.at(-1);
        const hasMore =
          items.length === limit &&
          last !== undefined &&
          repos.audit.changesAfter(last.id, 1).length > 0;
        return { ...bounds, items, hasMore };
      });
    },
    maxChangeId() {
      return context.read((repos) => repos.audit.changeBounds().max);
    },
    changeBounds() {
      return context.read((repos) => repos.audit.changeBounds());
    },
    maxCallRowId() {
      return context.read((repos) => repos.audit.maxCallRowId());
    },
    listCallsAfterRowId(id: number, limit = 1000) {
      bounds(id, limit);
      return context.read((repos) => repos.audit.callsAfterRowId(id, limit));
    },
    pruneChangesBefore(iso: string) {
      const at = parse(TimestampSchema, iso, 'retention timestamp');
      return context.mutate(
        'audit.pruneChangesBefore',
        { at } as { at: string; idempotencyKey?: string },
        (repos) => repos.audit.pruneChanges(at),
        (value) => Number(value),
      );
    },
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
