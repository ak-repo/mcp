import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReadyResponseSchema } from '@foodops/shared';
import { Activity, Radio, Database, RefreshCw, CircleCheck } from 'lucide-react';
import { apiFetch } from '../../lib/api/client.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { useLive, useLiveManager } from '../../lib/live/live-context.js';
import { formatDate, formatRelative } from '../../lib/dates.js';
import { PageHeader } from '../../components/common/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/common/async-state.js';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '../../components/ui/card.js';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from '../../components/ui/table.js';

export function SystemPage() {
  const live = useLive();
  const manager = useLiveManager();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const ready = useQuery({
    queryKey: queryKeys.ready(),
    queryFn: ({ signal }) => apiFetch('/api/ready', ReadyResponseSchema, { signal, auth: false }),
    refetchInterval: 30000,
  });
  return (
    <>
      <PageHeader
        title="System status"
        description="A live view of your FoodOps connection and recent activity."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void ready.refetch();
              manager.retry();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh status
          </Button>
        }
      />
      <div className="status-grid">
        <Card>
          <CardHeader>
            <div className="card-icon">
              <Database size={20} aria-hidden="true" />
            </div>
            <CardTitle>API readiness</CardTitle>
            <CardDescription>Database access through the API</CardDescription>
          </CardHeader>
          <CardContent>
            {ready.isPending ? (
              <LoadingState label="Checking API readiness" />
            ) : ready.isError ? (
              <ErrorState
                error={ready.error}
                onRetry={() => {
                  void ready.refetch();
                }}
              />
            ) : (
              <>
                <p className="metric">
                  <CircleCheck size={22} aria-hidden="true" />
                  Ready
                </p>
                <p className="muted text-sm">The API can read operational data.</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="card-icon">
              <Radio size={20} aria-hidden="true" />
            </div>
            <CardTitle>Live connection</CardTitle>
            <CardDescription>Changes from every connected host</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="metric capitalize">{live.status}</p>
            <p className="muted text-sm">{live.message}</p>
            {live.status === 'offline' && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => manager.retry()}>
                Reconnect
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="card-icon">
              <Activity size={20} aria-hidden="true" />
            </div>
            <CardTitle>Recent events</CardTitle>
            <CardDescription>Current browser session</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="metric">
              {live.events.length}
              <span className="metric-unit">/ 20</span>
            </p>
            <p className="muted text-sm">Latest validated events, newest first.</p>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-7">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Live activity</CardTitle>
              <CardDescription>Changes refresh operational data automatically.</CardDescription>
            </div>
            <Badge>
              <Radio size={14} aria-hidden="true" />
              {live.status === 'live' ? 'Listening' : 'Waiting for connection'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!live.events.length ? (
            <EmptyState
              title="Waiting for activity"
              description="Order changes and MCP tool calls will appear here as they happen."
            />
          ) : (
            <Table>
              <TableCaption className="sr-only">Last twenty live events</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {live.events.map((event, index) => (
                  <TableRow
                    key={event.type === 'mcp.call' ? `${event.data.at}-${index}` : event.data.id}
                  >
                    <TableCell>
                      <span className="font-medium">{event.type}</span>
                    </TableCell>
                    <TableCell>
                      {event.type === 'mcp.call'
                        ? event.data.tool
                        : (event.data.order_id ?? 'Unassigned partner')}
                    </TableCell>
                    <TableCell>
                      {event.type === 'mcp.call'
                        ? `${event.data.status} · ${event.data.latency_ms} ms`
                        : `${event.data.entity} changed`}
                    </TableCell>
                    <TableCell>
                      <time dateTime={event.data.at} title={formatDate(event.data.at)}>
                        {formatRelative(event.data.at, now)}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="mt-4 text-xs muted">
        Durable changes resume after reconnect. MCP call notifications are live-only.
      </p>
    </>
  );
}
