import { useQuery } from '@tanstack/react-query';
import type { McpToolCatalog } from '@foodops/shared';
import { EmptyState, ErrorState, LoadingState } from '../../components/common/async-state.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { queryKeys } from '../../lib/api/query-keys.js';
import { listTools } from './api.js';

export function ToolCatalogList({ tools }: { tools: McpToolCatalog['tools'] }) {
  return (
    <ul className="tool-catalog">
      {tools.map((tool) => (
        <li key={tool.name} className="tool-catalog-item">
          <div className="tool-catalog-head">
            <code>{tool.name}</code>
            <Badge className={tool.kind === 'write' ? 'badge-danger' : ''}>{tool.kind}</Badge>
          </div>
          <p className="muted">{tool.description}</p>
          <details>
            <summary>JSON Schema for {tool.name}</summary>
            <pre>{JSON.stringify(tool.input_schema, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

export function ToolCatalog() {
  const tools = useQuery({
    queryKey: queryKeys.mcpTools(),
    queryFn: ({ signal }) => listTools(signal),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool catalog</CardTitle>
        <p className="muted">
          Sanitized schemas, as the assistant sees them. Host controls are hidden.
        </p>
      </CardHeader>
      <CardContent>
        {tools.isPending ? (
          <LoadingState label="Loading tool catalog…" />
        ) : tools.isError ? (
          <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
        ) : tools.data.tools.length === 0 ? (
          <EmptyState title="No tools" description="The MCP server did not advertise any tools." />
        ) : (
          <ToolCatalogList tools={tools.data.tools} />
        )}
      </CardContent>
    </Card>
  );
}
