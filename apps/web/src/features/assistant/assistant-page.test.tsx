import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { ErrorCode } from '@foodops/shared';
import { ApiError } from '../../lib/api/errors.js';
import { AssistantPage } from './assistant-page.js';
import * as api from './api.js';

vi.mock('./api.js', () => ({
  getProviders: vi.fn(),
  startChat: vi.fn(),
  resolveApproval: vi.fn(),
  cancelRun: vi.fn(),
}));

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) =>
  encoder.encode(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
const started = (n: number) => ({
  type: 'run.started',
  run_id: `r${n}`,
  session_id: 's',
  provider: 'ollama',
  model: 'm',
});
const completed = {
  type: 'run.completed',
  usage: { promptTokens: 1, completionTokens: 1 },
  iterations: 1,
};
function streamOf(events: Record<string, unknown>[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(frame(event));
      controller.close();
    },
  });
}
function openStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (event: Record<string, unknown>) => controller.enqueue(frame(event)),
    end: () => controller.close(),
  };
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssistantPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.mocked(api.getProviders).mockResolvedValue({
    provider: 'ollama',
    model: 'm',
    api_key_set: false,
  } as never);
});
const readCall = (id: string, order: string) => ({
  type: 'tool.call',
  call_id: id,
  name: 'get_order',
  arguments: { order_id: order },
  kind: 'read',
});
const readResult = (id: string) => ({
  type: 'tool.result',
  call_id: id,
  name: 'get_order',
  status: 'ok',
  latency_ms: 3,
  summary: `summary ${id}`,
  truncated: false,
});

it('clears the composer on send, keeps the bubble stable and keeps every turn visible', async () => {
  const user = userEvent.setup();
  vi.mocked(api.startChat)
    .mockResolvedValueOnce(
      streamOf([
        started(1),
        readCall('c1', 'O-1'),
        readResult('c1'),
        { type: 'text.delta', text: 'First reply' },
        completed,
      ]),
    )
    .mockResolvedValueOnce(
      streamOf([
        started(2),
        readCall('c2', 'O-2'),
        readResult('c2'),
        { type: 'text.delta', text: 'Second reply' },
        completed,
      ]),
    );
  renderPage();
  const input = screen.getByRole('textbox', { name: 'Message assistant' });
  await user.type(input, 'first question');
  await user.keyboard('{Enter}');
  await screen.findByText('First reply');
  expect(input).toHaveValue('');
  await user.type(input, 'draft only');
  expect(screen.getByText('first question')).toBeInTheDocument();
  expect(screen.queryByText('draft only', { selector: 'p' })).not.toBeInTheDocument();
  await user.clear(input);
  await user.type(input, 'second question');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Second reply');
  for (const text of [
    'first question',
    'First reply',
    'second question',
    'Second reply',
    'summary c1',
    'summary c2',
  ])
    expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getAllByText('get_order', { exact: false })).toHaveLength(2);
  expect(api.startChat).toHaveBeenLastCalledWith('second question', 's', expect.any(AbortSignal));
  await user.click(screen.getByRole('button', { name: /New chat/ }));
  expect(screen.queryByText('first question')).not.toBeInTheDocument();
  expect(screen.queryByText('Second reply')).not.toBeInTheDocument();
});

it('announces only state changes, never streaming deltas, and does not use a live transcript', async () => {
  const user = userEvent.setup();
  const live = openStream();
  vi.mocked(api.startChat).mockResolvedValueOnce(live.body);
  const { container } = renderPage();
  expect(container.querySelector('.assistant-transcript')).not.toHaveAttribute('aria-live');
  await user.type(screen.getByRole('textbox', { name: 'Message assistant' }), 'hi{Enter}');
  const status = screen.getByRole('status');
  await waitFor(() => expect(status).toHaveTextContent('Assistant is responding'));
  act(() => live.push({ type: 'text.delta', text: 'streamed words' }));
  await screen.findByText('streamed words');
  expect(status).toHaveTextContent('Assistant is responding');
  expect(status).not.toHaveTextContent('streamed words');
  act(() => live.push(completed));
  await waitFor(() => expect(status).toHaveTextContent('Run completed'));
  act(() => live.end());
});

it('leaves Approve and Reject to the server clock and archives turns without approval controls', async () => {
  const user = userEvent.setup();
  vi.mocked(api.startChat)
    .mockResolvedValueOnce(
      streamOf([
        started(1),
        {
          type: 'tool.call',
          call_id: 'w1',
          name: 'cancel_order',
          arguments: { order_id: 'O-1' },
          kind: 'write',
        },
        {
          type: 'approval.required',
          call_id: 'w1',
          name: 'cancel_order',
          preview: { order_id: 'O-1' },
          expires_at: '2020-01-01T00:00:00.000Z',
        },
      ]),
    )
    .mockResolvedValueOnce(
      streamOf([started(2), { type: 'text.delta', text: 'Later reply' }, completed]),
    );
  vi.mocked(api.resolveApproval).mockRejectedValueOnce(
    new ApiError(409, ErrorCode.CONFLICT, 'Already resolved', 'Retry', null, null),
  );
  renderPage();
  await user.type(screen.getByRole('textbox', { name: 'Message assistant' }), 'cancel it{Enter}');
  await user.click(await screen.findByRole('button', { name: 'Review approval' }));
  const dialog = await screen.findByRole('dialog');
  const approve = within(dialog).getByRole('button', { name: 'Approve' });
  expect(approve).toBeEnabled();
  expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeEnabled();
  await user.click(approve);
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('already resolved or expired');
  expect(api.resolveApproval).toHaveBeenCalledWith('r1', 'w1', 'approved');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: /Stop/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message assistant' }), 'next{Enter}');
  await screen.findByText('Later reply');
  expect(screen.getByText('cancel it')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Review approval' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
});
