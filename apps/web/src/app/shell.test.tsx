import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from './shell.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { LiveContext } from '../lib/live/live-context.js';
import { createLiveManager } from '../lib/live/live-manager.js';
import { LiveProvider } from '../lib/live/live-provider.js';
import { SystemPage } from '../features/system/system-page.js';
import { authStore } from '../lib/api/auth-store.js';
import { useLiveEvents } from '../lib/live/live-context.js';

beforeEach(() => authStore.logout());
function manager() {
  return createLiveManager({
    ticket: vi.fn(),
    open: vi.fn(),
    invalidateAll: vi.fn(),
    onEvent: vi.fn(),
    clearBatch: vi.fn(),
  });
}
it('supports keyboard navigation, command palette, theme and logout menus', async () => {
  const user = userEvent.setup();
  authStore.login('in-memory');
  render(
    <MemoryRouter>
      <TooltipProvider>
        <LiveContext.Provider value={manager()}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<h1>System status</h1>} />
            </Route>
          </Routes>
        </LiveContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
  await user.tab();
  expect(screen.getByText('Skip to main content')).toHaveFocus();
  await user.keyboard('{Control>}k{/Control}');
  expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  await user.type(screen.getByRole('combobox', { name: 'Search navigation' }), 'system');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('Skip to main content')).toHaveFocus());
  act(() => screen.getByRole('button', { name: 'Open command palette' }).focus());
  await user.keyboard('{Control>}k{/Control}');
  expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Open command palette' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Choose theme' }));
  await user.click(await screen.findByRole('menuitem', { name: /Dark/ }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  await user.click(screen.getByRole('button', { name: 'Open user menu' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
  expect(authStore.getToken()).toBeNull();
});

it('renders readiness and validated live events on the functional status page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"ready"}')));
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const live = createLiveManager({
    ticket: async () => ({ ticket: 'a'.repeat(43), expires_at: '2026-11-04T10:00:30.000Z' }),
    open: async () =>
      new ReadableStream({
        start(controller) {
          stream = controller;
        },
      }),
    invalidateAll: vi.fn(),
    onEvent: vi.fn(),
    clearBatch: vi.fn(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LiveContext.Provider value={live}>
        <SystemPage />
      </LiveContext.Provider>
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Ready', { exact: true })).toBeInTheDocument();
  expect(screen.getByText('Waiting for activity')).toBeInTheDocument();
  act(() => live.start());
  await waitFor(() => expect(live.getSnapshot().status).toBe('live'));
  act(() =>
    stream.enqueue(
      new TextEncoder().encode(
        'event: mcp.call\ndata: {"tool":"<img src=x onerror=alert(1)>","status":"success","error_code":null,"latency_ms":2,"at":"2026-11-04T10:00:00.000Z"}\n\n',
      ),
    ),
  );
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  expect(screen.getByText('mcp.call')).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
  act(() => live.stop());
  view.unmount();
  client.clear();
});

it('shows readiness failures and permits an explicit retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'INTERNAL', message: 'Service is not ready', hint: 'Retry later' },
        }),
        { status: 503 },
      ),
    )
    .mockResolvedValueOnce(new Response('{"status":"ready"}'));
  vi.stubGlobal('fetch', fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LiveContext.Provider value={manager()}>
        <SystemPage />
      </LiveContext.Provider>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Service is not ready');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Ready', { exact: true })).toBeInTheDocument();
  view.unmount();
  client.clear();
});

it('does not leak a ticket or connection through actual StrictMode mount/cleanup/remount', async () => {
  const requests: string[] = [];
  const signals: AbortSignal[] = [];
  const cancellations = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/ticket'))
        return new Response(
          JSON.stringify({ ticket: 'a'.repeat(43), expires_at: '2026-11-04T10:00:30.000Z' }),
        );
      signals.push(init!.signal!);
      return new Response(new ReadableStream({ cancel: cancellations }), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
  authStore.login('strict-mode-test');
  const client = new QueryClient();
  const receive = vi.fn();
  function Consumer() {
    useLiveEvents('mcp.call', receive);
    return null;
  }
  const view = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <LiveProvider>
          <Consumer />
        </LiveProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(signals).toHaveLength(1));
  expect(requests.filter((url) => url.endsWith('/ticket'))).toHaveLength(2);
  act(() => authStore.logout());
  await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  await waitFor(() => expect(cancellations).toHaveBeenCalledTimes(1));
  view.unmount();
  client.clear();
});
