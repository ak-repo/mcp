import type { McpCallEvent, ToolCallLog } from '@foodops/shared';

export const FEED_CAP = 200;

export type FeedRow = {
  key: string;
  tool: string;
  status: 'success' | 'error';
  latencyMs: number;
  /** Live events carry no actor, so only audit-log rows have one. */
  actor: string | null;
  at: string;
};

const signature = (row: Pick<FeedRow, 'at' | 'tool' | 'status' | 'latencyMs'>) =>
  `${row.at}|${row.tool}|${row.status}|${row.latencyMs}`;

export function rowFromLog(log: ToolCallLog): FeedRow {
  return {
    key: `log-${log.id}`,
    tool: log.tool,
    status: log.status,
    latencyMs: log.latency_ms,
    actor: log.actor,
    at: log.at,
  };
}
export function rowFromEvent(event: McpCallEvent, sequence: number): FeedRow {
  return {
    key: `live-${sequence}`,
    tool: event.tool,
    status: event.status,
    latencyMs: event.latency_ms,
    actor: null,
    at: event.at,
  };
}
/**
 * Combine audit history with live rows: newest first, one row per call (a live row that the audit
 * log has since caught up with is dropped in favour of the logged row), capped at FEED_CAP.
 */
export function mergeFeed(logged: readonly FeedRow[], live: readonly FeedRow[]): FeedRow[] {
  const seen = new Set(logged.map(signature));
  const fresh = live.filter((row) => !seen.has(signature(row)));
  return [...fresh, ...logged]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, FEED_CAP);
}
