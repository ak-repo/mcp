import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { LiveContext } from '../../lib/live/live-context.js';
import { createLiveManager } from '../../lib/live/live-manager.js';
import { InspectorPage } from './inspector-page.js';
import { LiveCallFeed } from './call-feed.js';
import { ToolCatalog } from './tool-catalog.js';
import { FEED_CAP } from './feed-utils.js';

function manager() {
  return createLiveManager({
    ticket: vi.fn(),
    open: vi.fn(),
    invalidateAll: vi.fn(),
    onEvent: vi.fn(),
    clearBatch: vi.fn(),
  });
}
function renderWith(node: React.ReactNode, live = manager()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LiveContext.Provider value={live}>{node}</LiveContext.Provider>
    </QueryClientProvider>,
  );
  return { live, ...view };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const log = (n: number) => ({
  id: `T-${n}`,
  session_id: null,
  tool: 'get_order',
  args_json: '{"order_id":"O-1","confirmation_token":"secret-token"}',
  status: n % 2 ? 'success' : 'error',
  error_code: n % 2 ? null : 'NOT_FOUND',
  latency_ms: n,
  actor: 'ai',
  at: `2026-11-04T10:00:0${n}.000Z`,
});
const event = (n: number) => ({
  type: 'mcp.call' as const,
  data: {
    tool: `live_tool_${n}`,
    status: 'success' as const,
    error_code: null,
    latency_ms: 7,
    at: new Date(Date.UTC(2026, 10, 5, 0, 0, 0, n)).toISOString(),
  },
});

it('renders logged calls newest first, appends live rows and caps the feed at 200', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(json({ data: [log(1), log(2), log(3)], next_cursor: null })),
  );
  const { live } = renderWith(<LiveCallFeed />);
  const table = await screen.findByRole('table', { name: 'Recent MCP tool calls' });
  const rows = () => within(table).getAllByRole('row').slice(1);
  expect(rows()).toHaveLength(3);
  expect(within(rows()[0]!).getByText('3 ms')).toBeInTheDocument();
  expect(within(rows()[0]!).getByText('ai')).toBeInTheDocument();
  expect(within(rows()[1]!).getByText('error')).toBeInTheDocument();
  expect(screen.queryByText(/secret-token/)).not.toBeInTheDocument();
  act(() => live.bus.publish(event(1)));
  expect(within(rows()[0]!).getByText('live_tool_1')).toBeInTheDocument();
  act(() => {
    for (let n = 2; n <= 250; n++) live.bus.publish(event(n));
  });
  await waitFor(() => expect(rows()).toHaveLength(FEED_CAP));
  expect(within(rows()[0]!).getByText('live_tool_250')).toBeInTheDocument();
  expect(screen.queryByText('get_order')).not.toBeInTheDocument();
});

it('shows an empty state and a retryable error for the feed', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: [], next_cursor: null })));
  const first = renderWith(<LiveCallFeed />);
  expect(await screen.findByText('No tool calls yet')).toBeInTheDocument();
  first.unmount();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'INTERNAL', message: 'Audit unavailable', hint: 'Retry' } }, 500),
      ),
  );
  renderWith(<LiveCallFeed />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Audit unavailable');
});

it('renders the tool catalog with kind badges and collapsible JSON schemas', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      json({
        tools: [
          {
            name: 'get_order',
            description: 'Read an order',
            kind: 'read',
            input_schema: { type: 'object', properties: { order_id: { type: 'string' } } },
          },
          {
            name: 'cancel_order',
            description: 'Cancel an order',
            kind: 'write',
            input_schema: { type: 'object', properties: { reason: { type: 'string' } } },
          },
        ],
      }),
    ),
  );
  renderWith(<ToolCatalog />);
  expect(await screen.findByText('get_order')).toBeInTheDocument();
  expect(screen.getByText('cancel_order')).toBeInTheDocument();
  expect(screen.getByText('read')).toBeInTheDocument();
  expect(screen.getByText('write')).toBeInTheDocument();
  expect(screen.getByText('Read an order')).toBeInTheDocument();
  const schemas = document.querySelectorAll('details');
  expect(schemas).toHaveLength(2);
  expect(schemas[0]).not.toHaveAttribute('open');
  expect(schemas[0]!.querySelector('pre')).toHaveTextContent('"order_id"');
  expect(schemas[1]!.querySelector('pre')).toHaveTextContent('"reason"');
});

it('keeps manual calls disabled because the API has no endpoint for them', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: [], next_cursor: null })));
  renderWith(<InspectorPage />);
  const card = await screen.findByRole('region', { name: 'Try it' });
  expect(card).toHaveTextContent('Manual tool calls are not available from the browser');
  expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
});
