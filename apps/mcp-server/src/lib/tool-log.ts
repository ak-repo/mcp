import type { Services } from '@foodops/core';
import type { ErrorCode } from '@foodops/shared';

export interface ToolLogEntry {
  tool: string;
  args: unknown;
  errorCode: ErrorCode | null;
  latencyMs: number;
  sessionId?: string;
}
export function logToolCall(audit: Services['audit'], entry: ToolLogEntry): void {
  audit.recordCall({
    tool: entry.tool,
    argsJson: JSON.stringify(entry.args ?? {}),
    status: entry.errorCode === null ? 'success' : 'error',
    errorCode: entry.errorCode,
    latencyMs: Math.max(0, Math.round(entry.latencyMs)),
    actor: 'ai',
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
  });
}
