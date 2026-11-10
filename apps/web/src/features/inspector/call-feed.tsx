import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, ErrorState, LoadingState } from '../../components/common/async-state.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { formatDate } from '../../lib/dates.js';
import { useLiveEvents } from '../../lib/live/live-context.js';
import { listCalls } from './api.js';
import { FEED_CAP, mergeFeed, rowFromEvent, rowFromLog, type FeedRow } from './feed-utils.js';

export function CallFeedTable({ rows }: { rows: readonly FeedRow[] }) {
  return (
    <Table aria-label="Recent MCP tool calls">
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Latency</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>
              <span className="font-medium">{row.tool}</span>
            </TableCell>
            <TableCell>
              <Badge className={row.status === 'error' ? 'badge-danger' : ''}>{row.status}</Badge>
            </TableCell>
            <TableCell>{row.latencyMs} ms</TableCell>
            <TableCell>{row.actor ?? '—'}</TableCell>
            <TableCell>
              <time dateTime={row.at} title={row.at}>
                {formatDate(row.at)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LiveCallFeed() {
  const calls = useQuery({
    queryKey: queryKeys.mcpCalls(),
    queryFn: ({ signal }) => listCalls({ limit: 50 }, signal),
  });
  const [live, setLive] = useState<FeedRow[]>([]);
  const sequence = useRef(0);
  useLiveEvents('mcp.call', (event) => {
    const row = rowFromEvent(event.data, ++sequence.current);
    setLive((current) => [row, ...current].slice(0, FEED_CAP));
  });
  const rows = useMemo(
    () => mergeFeed(calls.data?.data.map(rowFromLog) ?? [], live),
    [calls.data, live],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live feed</CardTitle>
        <p className="muted">
          Tool calls from any MCP host, newest first. The latest {FEED_CAP} are kept.
        </p>
      </CardHeader>
      <CardContent>
        {calls.isPending && rows.length === 0 ? (
          <LoadingState label="Loading recent calls…" />
        ) : calls.isError && rows.length === 0 ? (
          <ErrorState error={calls.error} onRetry={() => void calls.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No tool calls yet"
            description="Calls made through any MCP host will appear here as they happen."
          />
        ) : (
          <CallFeedTable rows={rows} />
        )}
      </CardContent>
    </Card>
  );
}
