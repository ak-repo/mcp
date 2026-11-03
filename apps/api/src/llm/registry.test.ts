import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../config.js';
import { createLogger } from '../runtime.js';
import { createLLM, ProviderManager } from './registry.js';
import { fakeServer } from './tests/fake-server.js';
import type { LLMProvider, StreamEvent } from './types.js';
const servers: Awaited<ReturnType<typeof fakeServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(handler: Parameters<typeof fakeServer>[0]) {
  const s = await fakeServer(handler);
  servers.push(s);
  return s;
}
function config(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    ADMIN_TOKEN: 'a'.repeat(32),
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'test',
    LLM_MAX_RETRIES: 0,
    ...overrides,
  });
}
async function collect(provider: LLMProvider) {
  const events: StreamEvent[] = [];
  for await (const event of provider.chat([{ role: 'user', content: 'hi' }], []))
    events.push(event);
  return events;
}
const done =
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
describe('provider registry and manager', () => {
  it.each([
    ['ollama', 'https://ollama.com'],
    ['openai-compatible', 'https://api.openai.com/v1'],
    ['anthropic', 'https://api.anthropic.com'],
  ])('selects %s defaults without network', (provider, base) => {
    const fetcher = vi.fn<typeof fetch>();
    const created = createLLM(config({ LLM_PROVIDER: provider }), { fetch: fetcher });
    expect(created.provider.id).toBe(provider);
    expect(created.describe().base_url).toBe(base);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('updates atomically, rejects unknown/unsafe fields without changing active settings', () => {
    const m = new ProviderManager(config({ LLM_API_KEY: 'private-key' }));
    const before = m.publicView();
    for (const patch of [
      { temperature: 3 },
      { base_url: 'http://169.254.169.254' },
      { base_url: 'https://user:pass@host' },
      { api_key: 'new', clear_api_key: true },
      { api_key: 'bad\nkey' },
      { extra: true },
    ]) {
      expect(() => m.update(patch)).toThrow();
      expect(m.publicView()).toEqual(before);
    }
    expect(m.update({ temperature: 0.5, num_ctx: 8000 })).toMatchObject({
      temperature: 0.5,
      num_ctx: 8000,
      api_key_set: true,
    });
    expect(m.update({ clear_api_key: true })).toMatchObject({ api_key_set: false });
    m.update({ api_key: 'replacement' });
    expect(m.update({ provider: 'anthropic' })).toMatchObject({
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key_set: false,
    });
  });
  it('never exposes a key in views or logged views', () => {
    const m = new ProviderManager(config({ LLM_API_KEY: 'never-print-key' }));
    let output = '';
    const logger = createLogger('info', {
      write: (line) => {
        output += line;
      },
    });
    logger.info(m.publicView(), 'Provider settings');
    logger.info({ manager: m }, 'Manager');
    expect(output + JSON.stringify(m.publicView()) + JSON.stringify(m)).not.toContain(
      'never-print-key',
    );
    expect(m.publicView()).not.toHaveProperty('api_key');
  });
  it('keeps old calls on captured settings and shares concurrency across updates', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = await server(async (req, res) => {
      if ((req.body as { model: string }).model === 'test') {
        entered();
        await blocked;
      }
      res.end(done);
    });
    const m = new ProviderManager(config({ LLM_BASE_URL: s.url }));
    const first = collect(m.provider);
    await started;
    m.update({ model: 'next' });
    const second = collect(m.provider);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.requests).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(s.requests.map((r) => (r.body as { model: string }).model)).toEqual(['test', 'next']);
  });
  it('resolves auto from explicit probe, invalidates on updates and never probes at boot', async () => {
    const s = await server((req, res) => {
      if (req.method === 'GET') res.end('{"data":[{"id":"test"}]}');
      else {
        const body = req.body as { tools?: unknown[] };
        if (body.tools?.length) res.end(done);
        else
          res.end(
            'data: {"choices":[{"index":0,"delta":{"content":"{\\"tool_call\\":{\\"name\\":\\"record_number\\",\\"arguments\\":{\\"n\\":7}}}"},"finish_reason":null}]}\n\n' +
              done,
          );
      }
    });
    const m = new ProviderManager(config({ LLM_BASE_URL: s.url }));
    expect(s.requests).toHaveLength(0);
    expect(m.publicView().effective_tool_mode).toBe('native');
    expect(await m.probe()).toMatchObject({ tool_calling: 'prompted' });
    expect(m.publicView().effective_tool_mode).toBe('prompted');
    await m.probe();
    expect(s.requests).toHaveLength(3);
    m.update({ temperature: 0.4 });
    expect(m.publicView().effective_tool_mode).toBe('native');
    await m.probe();
    expect(s.requests).toHaveLength(6);
  });
});

it('does not apply a stale probe to settings updated while listing is in flight', async () => {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = await server(async (req, res) => {
    if (req.method === 'GET') {
      enter();
      await blocked;
      res.end('{"data":[]}');
    } else res.end(done);
  });
  const m = new ProviderManager(config({ LLM_BASE_URL: s.url }));
  const probe = m.probe();
  await entered;
  m.update({ provider: 'anthropic', model: 'new-model' });
  release();
  await probe;
  expect(m.publicView()).toMatchObject({
    provider: 'anthropic',
    model: 'new-model',
    effective_tool_mode: 'native',
  });
});

it('a retained auto provider follows a later matching probe recommendation', async () => {
  const s = await server((req, res) => {
    if (req.method === 'GET') res.end('{"data":[{"id":"test"}]}');
    else {
      const body = req.body as { tools?: unknown[] };
      const text = body.tools?.length
        ? 'no tools'
        : '{"tool_call":{"name":"record_number","arguments":{"n":7}}}';
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n` +
          done,
      );
    }
  });
  const cfg = config({ LLM_BASE_URL: s.url });
  const created = createLLM(cfg);
  const retained = created.provider;
  const { probeProvider } = await import('./probe.js');
  expect(await probeProvider(retained, cfg)).toMatchObject({ tool_calling: 'prompted' });
  const events: StreamEvent[] = [];
  for await (const event of retained.chat(
    [{ role: 'user', content: 'Record 7' }],
    [
      {
        name: 'record_number',
        description: 'Number',
        parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      },
    ],
  ))
    events.push(event);
  expect(events[0]).toMatchObject({ type: 'tool_call', arguments: { n: 7 } });
  expect(s.requests.at(-1)?.body).not.toHaveProperty('tools');
  expect(created.describe().effective_tool_mode).toBe('prompted');
});

it('probe performs one generation request on rate limiting despite configured retries', async () => {
  const s = await server((req, res) => {
    if (req.method === 'GET') res.end('{"data":[{"id":"test"}]}');
    else {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end('{}');
    }
  });
  const manager = new ProviderManager(config({ LLM_BASE_URL: s.url, LLM_MAX_RETRIES: 2 }));
  expect(await manager.probe()).toMatchObject({ ok: false, tool_calling: 'none' });
  expect(s.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
});

it('auto Ollama uses strict prompted mode when native schemas cannot represent the real catalog', async () => {
  const seen: unknown[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)) as unknown);
    return new Response(
      JSON.stringify({
        message: {
          content: '{"tool_call":{"name":"date_tool","arguments":{"date":"2026-11-03"}}}',
        },
        done: true,
        done_reason: 'stop',
      }) + '\n',
    );
  };
  const llm = createLLM(config({ LLM_PROVIDER: 'ollama', LLM_TOOL_MODE: 'auto' }), {
    fetch: fetcher,
  });
  const tool = {
    name: 'date_tool',
    description: 'Date',
    parameters: {
      type: 'object',
      properties: {
        date: {
          anyOf: [
            { type: 'string', format: 'date' },
            { type: 'string', format: 'date-time' },
          ],
        },
      },
      required: ['date'],
    },
  };
  const events: StreamEvent[] = [];
  for await (const event of llm.provider.chat([{ role: 'user', content: 'date' }], [tool]))
    events.push(event);
  expect(events[0]).toMatchObject({ type: 'tool_call', arguments: { date: '2026-11-03' } });
  expect(seen[0]).not.toHaveProperty('tools');
});
