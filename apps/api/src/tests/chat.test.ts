import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventSchema, type AgentEvent } from '@foodops/shared';
import { fixture, AUTH } from './helpers.js';
import type { LLMProvider } from '../llm/types.js';
import type { AgentHostDependencies } from '../agent/host.js';
import { readSse } from '../llm/http.js';
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) await f.close();
});
let serial = 0;
const orderTool = {
  name: 'get_order',
  description: 'Read',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
  },
};
const writeTool = {
  name: 'cancel_order',
  description: 'Cancel. Call without a confirmation_token',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object' as const,
    properties: {
      order_id: { type: 'string' },
      reason: { type: 'string' },
      confirmation_token: { type: 'string' },
      idempotency_key: { type: 'string' },
      action: { type: 'string' },
    },
    required: ['order_id', 'reason'],
  },
};
function provider(): LLMProvider {
  return {
    id: 'scripted',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    listModels: async () => [{ name: 'test' }],
    async *chat(messages, _tools, options) {
      const latest = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const last = messages.at(-1);
      if (latest === 'wait') {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      if (last?.role === 'tool') {
        yield { type: 'text_delta', delta: 'Done' };
        yield { type: 'done', reason: 'stop' };
        return;
      }
      yield {
        type: 'tool_call',
        id: 'call-1',
        name: latest.includes('cancel') ? 'cancel_order' : 'get_order',
        arguments: latest.includes('cancel')
          ? { order_id: 'O', reason: 'User request' }
          : { order_id: 'O' },
      };
      yield { type: 'done', reason: 'tool_calls' };
    },
  };
}
function setup(
  overrides: Parameters<typeof fixture>[0] = {},
  agent: AgentHostDependencies = { provider: provider() },
) {
  const f = fixture(
    { LLM_MODEL: 'test', LLM_BASE_URL: `http://127.0.0.1:${24000 + ++serial}`, ...overrides },
    { agent },
  );
  fixtures.push(f);
  const calls: Record<string, unknown>[] = [];
  f.runtime.mcp.listTools = async () => [orderTool, writeTool];
  f.runtime.mcp.callTool = async (name, args) => {
    calls.push(args);
    if (name === 'cancel_order' && args.action === 'preview')
      return {
        content: [{ type: 'text', text: 'Preview' }],
        structuredContent: {
          data: {
            requires_user_approval: true,
            preview: { order_id: 'O' },
            confirmation_token: 'private-token',
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
          truncated: false,
        },
      };
    return {
      content: [{ type: 'text', text: 'Done' }],
      structuredContent: {
        data:
          name === 'cancel_order'
            ? { requires_user_approval: false, result: { order_id: 'O' } }
            : { order_id: 'O' },
        truncated: false,
      },
    };
  };
  return { ...f, calls };
}
async function listen(f: ReturnType<typeof setup>) {
  return f.app.listen({ host: '127.0.0.1', port: 0 });
}
async function* events(response: Response): AsyncGenerator<AgentEvent> {
  if (!response.body) throw new Error('Missing stream');
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        yield part.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  for await (const frame of readSse(chunks())) {
    const event = AgentEventSchema.parse(JSON.parse(frame.data) as unknown);
    expect(frame.event).toBe(event.type);
    yield event;
  }
}
async function chat(url: string, message: string, signal?: AbortSignal) {
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({ message }),
    ...(signal ? { signal } : {}),
  });
}
const paths = [
  ['POST', '/api/chat'],
  ['POST', '/api/chat/run/approve'],
  ['POST', '/api/chat/run/cancel'],
  ['GET', '/api/providers'],
  ['PUT', '/api/providers'],
  ['GET', '/api/providers/models'],
  ['POST', '/api/providers/test'],
  ['GET', '/api/mcp/tools'],
  ['GET', '/api/mcp/status'],
] as const;
it.each(paths)('requires bearer auth for %s %s', async (method, url) => {
  const f = setup();
  expect((await f.app.inject({ method, url })).statusCode).toBe(401);
});
it('streams deterministic read events with CORS after hijack', async () => {
  const f = setup();
  const url = await listen(f);
  const response = await chat(url, 'read');
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  expect(response.headers.get('access-control-expose-headers')).toContain('X-Request-Id');
  const transcript: AgentEvent[] = [];
  for await (const event of events(response)) transcript.push(event);
  expect(transcript.map((e) => e.type)).toEqual([
    'run.started',
    'tool.call',
    'tool.result',
    'text.delta',
    'run.completed',
  ]);
  expect(f.runtime.agent.activeCount).toBe(0);
});
it.each(['approved', 'rejected'] as const)(
  'resolves %s through HTTP and replays the decision safely',
  async (decision) => {
    const f = setup();
    const url = await listen(f);
    const response = await chat(url, 'cancel');
    let runId = '';
    for await (const event of events(response)) {
      if (event.type === 'run.started') runId = event.run_id;
      expect(JSON.stringify(event)).not.toContain('private-token');
      if (event.type === 'approval.required') {
        const req = {
          method: 'POST' as const,
          url: `/api/chat/${runId}/approve`,
          headers: AUTH,
          payload: { call_id: event.call_id, decision },
        };
        const first = await f.app.inject(req);
        expect(first.statusCode).toBe(200);
        expect((await f.app.inject(req)).json()).toEqual(first.json());
        expect(
          (
            await f.app.inject({
              ...req,
              payload: {
                call_id: event.call_id,
                decision: decision === 'approved' ? 'rejected' : 'approved',
              },
            })
          ).statusCode,
        ).toBe(409);
      }
    }
    expect(f.calls.filter((c) => c.action === 'execute')).toHaveLength(
      decision === 'approved' ? 1 : 0,
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/chat/${runId}/approve`,
          headers: AUTH,
          payload: { call_id: 'wrong', decision },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/chat/unknown/cancel', headers: AUTH }))
        .statusCode,
    ).toBe(404);
  },
);
it('disconnect aborts a run, and cancellation is idempotent', async () => {
  const f = setup();
  const url = await listen(f);
  const controller = new AbortController();
  const response = await chat(url, 'wait', controller.signal);
  const iterator = events(response);
  const first = await iterator.next();
  expect(first.value?.type).toBe('run.started');
  controller.abort();
  await iterator.return(undefined).catch(() => undefined);
  await vi.waitFor(() => expect(f.runtime.agent.activeCount).toBe(0));
  const second = await chat(url, 'wait');
  const stream = events(second);
  const start = (await stream.next()).value;
  if (start?.type !== 'run.started') throw new Error('No run');
  const req = { method: 'POST' as const, url: `/api/chat/${start.run_id}/cancel`, headers: AUTH };
  expect((await f.app.inject(req)).statusCode).toBe(200);
  expect((await f.app.inject(req)).statusCode).toBe(200);
  for await (const event of stream) AgentEventSchema.parse(event);
});
it('reserves concurrent slots before hijack and uses independent chat quota', async () => {
  const f = setup({ AGENT_MAX_CONCURRENT_RUNS: 1, RATE_LIMIT_CHAT_PER_MIN: 2 });
  const url = await listen(f);
  const first = await chat(url, 'wait');
  const stream = events(first);
  const started = (await stream.next()).value;
  const full = await chat(url, 'read');
  expect(full.status).toBe(429);
  expect(full.headers.get('retry-after')).toBeTruthy();
  if (started?.type === 'run.started')
    await f.app.inject({
      method: 'POST',
      url: `/api/chat/${started.run_id}/cancel`,
      headers: AUTH,
    });
  for await (const event of stream) AgentEventSchema.parse(event);
  const limited = await chat(url, 'read');
  expect(limited.status).toBe(429);
  expect(limited.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  expect(
    (await f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH })).statusCode,
  ).toBe(200);
});
it('shutdown during an active chat drains and closes the listener', async () => {
  const f = setup();
  const url = await listen(f);
  const response = await chat(url, 'wait');
  const stream = events(response);
  await stream.next();
  await f.app.close();
  for await (const event of stream) AgentEventSchema.parse(event);
  expect(f.runtime.agent.activeCount).toBe(0);
  expect(f.logs.join('')).not.toContain('Request failed');
});
describe('provider/catalog endpoints', () => {
  function providerFetch(status = 200) {
    return async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      if (status !== 200) return new Response(JSON.stringify({ error: 'secret-key' }), { status });
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'test' }] });
      return new Response(
        JSON.stringify({
          message: { tool_calls: [{ function: { name: 'record_number', arguments: { n: 7 } } }] },
          done: true,
          done_reason: 'stop',
        }) + '\n',
      );
    };
  }
  it('never returns/logs keys and validates atomic settings updates', async () => {
    const f = setup({ LLM_API_KEY: 'secret-key' });
    const get = () => f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH });
    expect((await get()).json()).toMatchObject({ api_key_set: true, last_probe: null });
    const invalid = await f.app.inject({
      method: 'PUT',
      url: '/api/providers',
      headers: AUTH,
      payload: { base_url: 'http://169.254.169.254' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/providers',
          headers: AUTH,
          payload: { api_key: 'replacement-key', temperature: 0.4 },
        })
      ).json(),
    ).toMatchObject({ api_key_set: true, temperature: 0.4 });
    expect((await get()).body + f.logs.join('')).not.toMatch(/secret-key|replacement-key/);
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/mcp/tools', headers: AUTH })).json().tools[1],
    ).toMatchObject({ kind: 'write' });
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/mcp/tools', headers: AUTH })).body,
    ).not.toContain('confirmation_token');
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/mcp/status', headers: AUTH })).json(),
    ).toHaveProperty('connected');
  });
  it('lists models, probes successfully and exposes the matching result', async () => {
    const f = setup({}, { provider: provider(), providerDependencies: { fetch: providerFetch() } });
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/providers/models', headers: AUTH })).json(),
    ).toEqual({ models: [{ name: 'test' }] });
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/providers/test', headers: AUTH })).json(),
    ).toMatchObject({ ok: true, tool_calling: 'native' });
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH })).json()
        .last_probe,
    ).toMatchObject({ ok: true });
  });
  it.each([401, 429, 404])('maps provider failure %s to safe 502', async (status) => {
    const f = setup(
      { LLM_MAX_RETRIES: 0, LLM_API_KEY: 'secret-key' },
      { provider: provider(), providerDependencies: { fetch: providerFetch(status) } },
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/providers/test',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toHaveProperty('error.hint');
    expect(response.body + f.logs.join('')).not.toContain('secret-key');
  });
  it('validates chat/approval bodies and separates probe rate limits', async () => {
    const f = setup(
      { RATE_LIMIT_PROBE_PER_MIN: 1 },
      { provider: provider(), providerDependencies: { fetch: providerFetch() } },
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/chat',
          headers: AUTH,
          payload: { message: ' ' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/chat/run/approve',
          headers: AUTH,
          payload: { call_id: 'c', decision: 'expired' },
        })
      ).statusCode,
    ).toBe(400);
    await f.app.inject({ method: 'POST', url: '/api/providers/test', headers: AUTH });
    expect(
      (await f.app.inject({ method: 'POST', url: '/api/providers/test', headers: AUTH }))
        .statusCode,
    ).toBe(429);
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH })).statusCode,
    ).toBe(200);
  });
});

it('disconnect during approval clears the registry without executing', async () => {
  const f = setup();
  const url = await listen(f);
  const controller = new AbortController();
  const response = await chat(url, 'cancel', controller.signal);
  const stream = events(response);
  let item = await stream.next();
  while (item.value?.type !== 'approval.required') item = await stream.next();
  expect(f.runtime.agent.approvals.size).toBe(1);
  controller.abort();
  await stream.return(undefined).catch(() => undefined);
  await vi.waitFor(() => {
    expect(f.runtime.agent.approvals.size).toBe(0);
    expect(f.runtime.agent.activeCount).toBe(0);
  });
  expect(f.calls.filter((call) => call.action === 'execute')).toHaveLength(0);
});
it('same-session admission fails before SSE begins', async () => {
  const f = setup();
  const url = await listen(f);
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'same', message: 'wait' }),
  });
  const stream = events(response);
  const started = (await stream.next()).value;
  const conflict = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: AUTH,
    payload: { session_id: 'same', message: 'read' },
  });
  expect(conflict.statusCode).toBe(409);
  if (started?.type === 'run.started')
    await f.app.inject({
      method: 'POST',
      url: `/api/chat/${started.run_id}/cancel`,
      headers: AUTH,
    });
  for await (const event of stream) AgentEventSchema.parse(event);
});

it('redacts the active write-only key from chat after a settings update', async () => {
  const p = provider();
  p.chat = async function* () {
    yield { type: 'text_delta', delta: 'replacement-key' };
    yield { type: 'done', reason: 'stop' };
  };
  const f = setup({}, { provider: p });
  await f.app.inject({
    method: 'PUT',
    url: '/api/providers',
    headers: AUTH,
    payload: { api_key: 'replacement-key' },
  });
  const url = await listen(f);
  const response = await chat(url, 'read');
  const transcript: AgentEvent[] = [];
  for await (const event of events(response)) transcript.push(event);
  expect(JSON.stringify(transcript) + f.logs.join('')).not.toContain('replacement-key');
  expect(transcript).toContainEqual({ type: 'text.delta', text: '[REDACTED]' });
});
it('a missing configured model is a helpful failed probe, not a boot failure', async () => {
  const fetcher: typeof fetch = async () => Response.json({ models: [{ name: 'other' }] });
  const f = setup({}, { provider: provider(), providerDependencies: { fetch: fetcher } });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/providers/test',
    headers: AUTH,
  });
  expect(response.statusCode).toBe(502);
  expect(response.body).toContain('LLM_MODEL');
});

it.each([
  ['host', 'https://old.example/v1', { base_url: 'https://new.example/v1' }, false],
  ['port', 'https://old.example:8443/v1', { base_url: 'https://old.example:9443/v1' }, false],
  ['scheme', 'http://old.example/v1', { base_url: 'https://old.example/v1' }, false],
  ['path', 'https://old.example/v1', { base_url: 'https://old.example/new-path' }, true],
  [
    'replacement',
    'https://old.example/v1',
    { base_url: 'https://new.example/v1', api_key: 'replacement-private-key' },
    true,
  ],
  ['clear', 'https://old.example/v1', { clear_api_key: true }, false],
] as const)(
  'PUT exposes credential state for %s changes without leaking credentials',
  async (_label, base, patch, retained) => {
    const f = setup({ LLM_BASE_URL: base, LLM_API_KEY: 'old-private-key' });
    const response = await f.app.inject({
      method: 'PUT',
      url: '/api/providers',
      headers: AUTH,
      payload: patch,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().api_key_set).toBe(retained);
    const current = await f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH });
    expect(current.json().api_key_set).toBe(retained);
    const invalid = await f.app.inject({
      method: 'PUT',
      url: '/api/providers',
      headers: AUTH,
      payload: { api_key: 'replacement-private-key', clear_api_key: true },
    });
    expect(invalid.statusCode).toBe(400);
    expect(response.body + current.body + invalid.body + f.logs.join('')).not.toMatch(
      /old-private-key|replacement-private-key/,
    );
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/providers', headers: AUTH })).json()
        .api_key_set,
    ).toBe(retained);
  },
);

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each(['disconnect', 'cancel'] as const)(
  '%s after approval preserves the committed write in session history',
  async (action) => {
    const scripted = provider();
    const chat = scripted.chat.bind(scripted);
    const histories: unknown[] = [];
    scripted.chat = (messages, tools, options) => {
      histories.push(structuredClone(messages));
      return chat(messages, tools, options);
    };
    const f = setup({}, { provider: scripted });
    const url = await listen(f);
    const gate = pending<void>();
    const entered = pending<void>();
    const original = f.runtime.mcp.callTool;
    let executionSignal: AbortSignal | undefined;
    f.runtime.mcp.callTool = async (name, args, options) => {
      if (args.action === 'execute') {
        executionSignal = options?.signal;
        entered.resolve();
        await gate.promise;
      }
      const result = await original(name, args, options);
      if (args.action === 'execute')
        result.structuredContent = {
          data: { requires_user_approval: false, result: { status: 'committed-for-review' } },
          truncated: false,
        };
      return result;
    };
    const controller = new AbortController();
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'cancel', session_id: 'shielded' }),
      signal: controller.signal,
    });
    const stream = events(response);
    let runId = '';
    for (;;) {
      const event = (await stream.next()).value;
      if (event?.type === 'run.started') runId = event.run_id;
      if (event?.type === 'approval.required') break;
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/chat/${runId}/approve`,
          headers: AUTH,
          payload: { call_id: 'call-1', decision: 'approved' },
        })
      ).statusCode,
    ).toBe(200);
    await entered.promise;
    if (action === 'disconnect') {
      controller.abort();
      await stream.return(undefined).catch(() => undefined);
    } else
      expect(
        (await f.app.inject({ method: 'POST', url: `/api/chat/${runId}/cancel`, headers: AUTH }))
          .statusCode,
      ).toBe(200);
    expect(executionSignal?.aborted).toBe(false);
    expect(f.runtime.agent.activeCount).toBe(1);
    gate.resolve();
    const remaining: AgentEvent[] = [];
    if (action === 'cancel') for await (const event of stream) remaining.push(event);
    if (action === 'cancel')
      expect(remaining.some((event) => event.type === 'tool.result' && event.status === 'ok')).toBe(
        true,
      );
    await vi.waitFor(() => expect(f.runtime.agent.activeCount).toBe(0));
    expect(f.runtime.agent.approvals.size).toBe(0);
    const next = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'read', session_id: 'shielded' }),
    });
    for await (const event of events(next)) AgentEventSchema.parse(event);
    expect(JSON.stringify(histories)).toContain('committed-for-review');
    expect(f.calls.filter((args) => args.action === 'execute')).toHaveLength(1);
    expect(
      f.logs
        .map((line) => JSON.parse(line) as { level: number })
        .filter((entry) => entry.level === 50),
    ).toEqual([]);
  },
);
it('logs one safe contextual error for a failed event loop and a generic client event', async () => {
  const f = setup({ LLM_API_KEY: 'secret-key' });
  const start = f.runtime.agent.start;
  f.runtime.agent.start = (...args) => {
    const run = start(...args);
    return {
      ...run,
      events: (async function* () {
        yield {
          type: 'run.started' as const,
          run_id: run.runId,
          session_id: run.sessionId,
          provider: 'scripted',
          model: 'test',
        };
        throw new Error(
          'secret-key Authorization: Bearer header-secret confirmation_token=token-secret prompt and tool payload',
        );
      })(),
    };
  };
  const url = await listen(f);
  const response = await chat(url, 'read');
  const transcript: AgentEvent[] = [];
  for await (const event of events(response)) transcript.push(event);
  const errors = f.logs
    .map(
      (line) =>
        JSON.parse(line) as { level: number; run_id?: string; session_id?: string; err?: unknown },
    )
    .filter((entry) => entry.level === 50);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    run_id: expect.any(String),
    session_id: expect.any(String),
    err: expect.any(Object),
  });
  expect(f.logs.join('') + JSON.stringify(transcript)).not.toMatch(
    /secret-key|header-secret|token-secret|prompt and tool payload/,
  );
  expect(transcript.at(-1)).toEqual({
    type: 'run.error',
    kind: 'internal',
    message: 'Chat stream could not complete',
    retryable: false,
  });
});
it('warns with run context if closing a chat consumer fails', async () => {
  const f = setup();
  const start = f.runtime.agent.start;
  f.runtime.agent.start = (...args) => {
    const run = start(...args);
    return {
      ...run,
      async close() {
        await run.close();
        throw new Error('Authorization: Bearer private-close-data');
      },
    };
  };
  const url = await listen(f);
  for await (const event of events(await chat(url, 'read'))) AgentEventSchema.parse(event);
  expect(
    f.logs
      .map((line) => JSON.parse(line) as { level: number; run_id?: string })
      .some((entry) => entry.level === 40 && entry.run_id),
  ).toBe(true);
  expect(f.logs.join('')).not.toContain('private-close-data');
});

it('shutdown aborts an in-flight approved execution and drains without error logs', async () => {
  const f = setup();
  const url = await listen(f);
  const entered = pending<void>();
  const original = f.runtime.mcp.callTool;
  let signal: AbortSignal | undefined;
  f.runtime.mcp.callTool = async (name, args, options) => {
    if (args.action === 'execute') {
      signal = options?.signal;
      entered.resolve();
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('Shutdown'));
        else signal?.addEventListener('abort', () => reject(new Error('Shutdown')), { once: true });
      });
    }
    return original(name, args, options);
  };
  const response = await chat(url, 'cancel');
  const stream = events(response);
  let runId = '';
  for (;;) {
    const event = (await stream.next()).value;
    if (event?.type === 'run.started') runId = event.run_id;
    if (event?.type === 'approval.required') break;
  }
  await f.app.inject({
    method: 'POST',
    url: `/api/chat/${runId}/approve`,
    headers: AUTH,
    payload: { call_id: 'call-1', decision: 'approved' },
  });
  await entered.promise;
  await f.app.close();
  for await (const event of stream) AgentEventSchema.parse(event);
  expect(signal?.aborted).toBe(true);
  expect(f.runtime.agent.activeCount).toBe(0);
  expect(f.runtime.agent.approvals.size).toBe(0);
  expect(
    f.logs
      .map((line) => JSON.parse(line) as { level: number })
      .filter((entry) => entry.level === 50),
  ).toEqual([]);
});
