import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../../config.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import { createAnthropicProvider, ANTHROPIC_VERSION } from './anthropic.js';
import { fakeServer } from '../tests/fake-server.js';
import type { LLMProvider, StreamEvent } from '../types.js';
const servers: Awaited<ReturnType<typeof fakeServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function server(handler: Parameters<typeof fakeServer>[0]) {
  const s = await fakeServer(handler);
  servers.push(s);
  return s;
}
function config(
  url: string,
  provider: Config['LLM_PROVIDER'],
  overrides: Partial<Config> = {},
): Config {
  return {
    ...ConfigSchema.parse({
      ADMIN_TOKEN: 'a'.repeat(32),
      LLM_BASE_URL: url,
      LLM_PROVIDER: provider,
      LLM_MODEL: 'test',
      LLM_MAX_RETRIES: 0,
    }),
    ...overrides,
  };
}
async function collect(provider: LLMProvider, options: Parameters<LLMProvider['chat']>[2] = {}) {
  const events: StreamEvent[] = [];
  for await (const event of provider.chat([{ role: 'user', content: 'test' }], [], options))
    events.push(event);
  return events;
}
function sse(...values: unknown[]) {
  return values
    .map((value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)
    .join('');
}
const choice = (delta: unknown, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});
const openaiFinal = sse(choice({}, 'stop'), '[DONE]');
const anthropicFinal = sse(
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
);
const variants = [
  ['openai-compatible', createOpenAICompatibleProvider, openaiFinal],
  ['anthropic', createAnthropicProvider, anthropicFinal],
] as const;
describe('OpenAI-compatible streaming', () => {
  it('assembles interleaved fragmented calls once, then usage and done', async () => {
    const s = await server((_r, res) =>
      res.end(
        sse(
          choice({
            tool_calls: [
              { index: 0, id: 'one', function: { name: 'rec', arguments: '{"n":' } },
              { index: 1, id: 'two', function: { name: 'record', arguments: '{' } },
            ],
          }),
          choice({
            tool_calls: [
              { index: 1, function: { arguments: '"n":8}' } },
              { index: 0, function: { name: 'ord', arguments: '7}' } },
            ],
          }),
          choice({}, 'tool_calls'),
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
          '[DONE]',
        ),
      ),
    );
    expect(
      await collect(createOpenAICompatibleProvider(config(s.url, 'openai-compatible'))),
    ).toEqual([
      { type: 'tool_call', id: 'one', name: 'record', arguments: { n: 7 } },
      { type: 'tool_call', id: 'two', name: 'record', arguments: { n: 8 } },
      { type: 'usage', promptTokens: 12, completionTokens: 4 },
      { type: 'done', reason: 'tool_calls' },
    ]);
  });
  it('maps history and preserves base prefix with optional bearer auth', async () => {
    const s = await server((r, res) =>
      res.end(r.method === 'GET' ? '{"data":[{"id":"test"}]}' : openaiFinal),
    );
    const p = createOpenAICompatibleProvider(
      config(`${s.url}/v1`, 'openai-compatible', { LLM_API_KEY: 'secret' }),
    );
    for await (const event of p.chat(
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c', name: 'record', arguments: { n: 7 } }],
        },
        { role: 'tool', toolCallId: 'c', toolName: 'record', content: 'ok' },
      ],
      [],
    ))
      expect(event.type).toBe('done');
    expect(s.requests[0]).toMatchObject({
      path: '/v1/chat/completions',
      authorization: 'Bearer secret',
      body: {
        messages: [
          { role: 'assistant', tool_calls: [{ function: { arguments: '{"n":7}' } }] },
          { role: 'tool', tool_call_id: 'c' },
        ],
      },
    });
    expect(await p.listModels()).toEqual([{ name: 'test' }]);
    expect(s.requests[1]?.path).toBe('/v1/models');
  });
  it.each([
    sse(choice({ content: 'partial' })),
    sse(
      choice({ tool_calls: [{ index: 0, function: { name: 'r', arguments: '{' } }] }, 'tool_calls'),
      '[DONE]',
    ),
    'data: broken\n\n',
    sse('[DONE]'),
  ])('rejects incomplete or malformed streams', async (wire) => {
    const s = await server((_r, res) => res.end(wire));
    await expect(
      collect(createOpenAICompatibleProvider(config(s.url, 'openai-compatible'))),
    ).rejects.toMatchObject({ kind: 'provider_error' });
  });
});
describe('Anthropic streaming', () => {
  it('assembles tools at block stop, emits thinking separately and accumulates usage', async () => {
    const s = await server((_r, res) =>
      res.end(
        sse(
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'consider' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'c', name: 'record', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"n":' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '7}' },
          },
          { type: 'content_block_stop', index: 1 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 9 },
          },
          { type: 'message_stop' },
        ),
      ),
    );
    expect(await collect(createAnthropicProvider(config(s.url, 'anthropic')))).toEqual([
      { type: 'thinking_delta', delta: 'consider' },
      { type: 'tool_call', id: 'c', name: 'record', arguments: { n: 7 } },
      { type: 'usage', promptTokens: 5, completionTokens: 9 },
      { type: 'done', reason: 'tool_use' },
    ]);
  });
  it('separates system and merges tool results, sends required headers, lists pages', async () => {
    let headers: Record<string, unknown> = {};
    const s = await server((r, res, raw) => {
      headers = raw.headers;
      if (r.method === 'GET')
        res.end(
          JSON.stringify({
            data: [{ id: r.path.includes('after_id') ? 'two' : 'one' }],
            has_more: !r.path.includes('after_id'),
            last_id: 'one',
          }),
        );
      else res.end(anthropicFinal);
    });
    const p = createAnthropicProvider(config(s.url, 'anthropic', { LLM_API_KEY: 'secret' }));
    const history = [
      { role: 'system' as const, content: 'policy' },
      {
        role: 'assistant' as const,
        content: '',
        thinking: 'never sent',
        toolCalls: [
          { id: 'a', name: 'record', arguments: {} },
          { id: 'b', name: 'record', arguments: {} },
        ],
      },
      { role: 'tool' as const, toolCallId: 'a', toolName: 'record', content: 'A' },
      { role: 'tool' as const, toolCallId: 'b', toolName: 'record', content: 'B' },
    ];
    for await (const event of p.chat(history, [])) expect(event.type).not.toBe('thinking_delta');
    expect(headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': ANTHROPIC_VERSION,
    });
    expect(s.requests[0]?.body).toMatchObject({
      system: 'policy',
      max_tokens: 1024,
      messages: [
        { role: 'assistant' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a' },
            { type: 'tool_result', tool_use_id: 'b' },
          ],
        },
      ],
    });
    expect(JSON.stringify(s.requests[0]?.body)).not.toContain('never sent');
    expect(await p.listModels()).toEqual([{ name: 'one' }, { name: 'two' }]);
    await expect(collect(p, { think: true })).rejects.toMatchObject({ kind: 'bad_request' });
  });
});
for (const [name, create, final] of variants)
  describe(`${name} transport contract`, () => {
    it.each([401, 429, 500])('maps %s without leaking credentials', async (status) => {
      const s = await server((_r, res) => {
        res.writeHead(status, { 'Retry-After': '2' });
        res.end('secret');
      });
      const result = collect(create(config(s.url, name, { LLM_API_KEY: 'secret' })));
      await expect(result).rejects.toMatchObject({
        kind: status === 401 ? 'auth' : status === 429 ? 'rate_limit' : 'provider_error',
      });
      await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining('secret'));
    });
    it.each([429, 500])('retries %s once before output', async (status) => {
      let count = 0;
      const s = await server((_r, res) => {
        if (++count === 1) {
          res.writeHead(status, { 'Retry-After': '0' });
          res.end('{}');
        } else res.end(final);
      });
      expect(
        (await collect(create(config(s.url, name, { LLM_MAX_RETRIES: 1 })))).at(-1)?.type,
      ).toBe('done');
      expect(count).toBe(2);
    });
    it('does not retry partial output, enforces idle timeout, handles abort', async () => {
      const wire =
        name === 'anthropic'
          ? sse(
              { type: 'message_start', message: { usage: {} } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'hello' },
              },
            )
          : sse(choice({ content: 'hello' }));
      const s = await server((_r, res) => {
        res.write(wire);
      });
      await expect(
        collect(create(config(s.url, name, { LLM_IDLE_TIMEOUT_MS: 40, LLM_MAX_RETRIES: 1 }))),
      ).rejects.toMatchObject({ kind: 'timeout' });
      expect(s.requests).toHaveLength(1);
      const controller = new AbortController();
      await expect(
        (async () => {
          for await (const event of create(config(s.url, name)).chat(
            [{ role: 'user', content: 'hi' }],
            [],
            { signal: controller.signal },
          )) {
            expect(event.type).toBe('text_delta');
            controller.abort();
          }
        })(),
      ).rejects.toMatchObject({ kind: 'aborted' });
    });
  });
