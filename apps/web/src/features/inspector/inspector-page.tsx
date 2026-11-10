import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../../components/common/page-header.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { getMcpStatus } from './api.js';
import { LiveCallFeed } from './call-feed.js';
import { ToolCatalog } from './tool-catalog.js';

function McpStatusBadge() {
  const status = useQuery({
    queryKey: queryKeys.mcpStatus(),
    queryFn: ({ signal }) => getMcpStatus(signal),
  });
  if (status.isPending) return <Badge>Checking MCP connection…</Badge>;
  if (status.isError) return <Badge className="badge-danger">MCP status unavailable</Badge>;
  return (
    <Badge className={status.data.connected ? '' : 'badge-danger'}>
      {status.data.connected ? 'MCP connected' : 'MCP not connected'} · {status.data.tool_count}{' '}
      tools
    </Badge>
  );
}

/** Manual calls need a browser-facing endpoint; the API has none and this page adds no write path. */
function TryItCard() {
  return (
    <Card aria-labelledby="try-it-title" className="try-it-card" role="region">
      <CardHeader>
        <CardTitle id="try-it-title">Try it</CardTitle>
      </CardHeader>
      <CardContent>
        <p>
          <Badge>Unavailable</Badge> Manual tool calls are not available from the browser.
        </p>
        <p className="muted">
          The API exposes no endpoint for calling MCP tools directly, so this page stays read-only.
          Use the MCP Inspector or an MCP host to try a tool.
        </p>
      </CardContent>
    </Card>
  );
}

export function InspectorPage() {
  return (
    <div className="page-stack">
      <PageHeader
        title="MCP Inspector"
        description="Watch tool calls from any host and browse the tool catalog"
        actions={<McpStatusBadge />}
      />
      <LiveCallFeed />
      <ToolCatalog />
      <TryItCard />
    </div>
  );
}
