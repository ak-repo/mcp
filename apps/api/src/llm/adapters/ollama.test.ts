import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../../config.js';
import { createOllamaProvider } from './ollama.js';
import { redact } from '../errors.js';
import type { NormalizedMessage, StreamEvent, ToolDefinition } from '../types.js';
import { fakeServer } from '../tests/fake-server.js';
import { final, fixtures, ndjson } from '../tests/fixtures.js';
const servers: Awaited<ReturnType<typeof fakeServer>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function server(handler: Parameters<typeof fakeServer>[0]) {
  const result = await fakeServer(handler);
  servers.push(result);
  return result;
}
function config(url: string, overrides: Partial<Config> = {}): Config {
  return {
    ...ConfigSchema.parse({
      ADMIN_TOKEN: 'a'.repeat(32),
      LLM_BASE_URL: url,
      LLM_MODEL: 'test-model',
      LLM_MAX_RETRIES: 0,
    }),
    ...overrides,
  };
}
const messages: NormalizedMessage[] = [{ role: 'user', content: 'Look up the order' }];
const tools: ToolDefinition[] = [
  {
    name: 'lookup',
    description: 'Looks up an order',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const result: StreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}
describe('Ollama native adapter', () => {
  it('streams text and counters, mapping configured options', async () => {
    const s = await server((_request, response) => response.end(ndjson(fixtures.text)));
    const provider = createOllamaProvider(config(s.url));
    expect(provider.id).toBe('ollama');
    expect(
      await collect(
        provider.chat(messages, [], { temperature: 0.4, maxTokens: 100, numCtx: 4096 }),
      ),
    ).toEqual([
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: '₹' },
      { type: 'usage', promptTokens: 12, completionTokens: 7 },
      { type: 'done', reason: 'stop' },
    ]);
    expect(s.requests[0]).toMatchObject({
      path: '/api/chat',
      method: 'POST',
      authorization: undefined,
      body: {
        model: 'test-model',
        messages,
        stream: true,
        think: false,
        options: { temperature: 0.4, num_ctx: 4096, num_predict: 100 },
      },
    });
  });
  it('streams thinking separately and whitelists history fields', async () => {
    const s = await server((_request, response) => response.end(ndjson(fixtures.thinking)));
    const history = [
      ...messages,
      { role: 'assistant', content: 'Prior', thinking: 'private trace' },
    ] as NormalizedMessage[];
    const result = await collect(
      createOllamaProvider(config(s.url, { LLM_THINK: 'on' })).chat(history, []),
    );
    expect(result.filter((event) => event.type === 'thinking_delta')).toEqual([
      { type: 'thinking_delta', delta: 'Consider ' },
      { type: 'thinking_delta', delta: 'carefully' },
    ]);
    expect(JSON.stringify(s.requests[0]?.body)).not.toContain('private trace');
    expect(s.requests[0]?.body).toMatchObject({ think: true });
  });
  it.each(['single', 'multiple', 'acrossRecords', 'fragments'] as const)(
    'handles %s calls with stable ids',
    async (name) => {
      const s = await server((_request, response) => response.end(ndjson(fixtures[name])));
      const provider = createOllamaProvider(config(s.url));
      const first = (await collect(provider.chat(messages, tools))).filter(
        (event) => event.type === 'tool_call',
      );
      const second = (await collect(provider.chat(messages, tools))).filter(
        (event) => event.type === 'tool_call',
      );
      expect(first).toEqual(second);
      expect(first).toHaveLength(['multiple', 'acrossRecords'].includes(name) ? 2 : 1);
      expect(first[0]).toMatchObject({
        type: 'tool_call',
        name: 'lookup',
        arguments: { id: 'O-1' },
      });
      expect(new Set(first.map((call) => call.id)).size).toBe(first.length);
    },
  );
  it('maps assistant tool calls and tool result names to native history', async () => {
    const s = await server((_request, response) => response.end(ndjson([final])));
    await collect(
      createOllamaProvider(config(s.url)).chat(
        [
          ...messages,
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 'O-1' } }],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            toolName: 'lookup',
            content: '{"status":"placed"}',
          },
        ],
        tools,
      ),
    );
    expect(s.requests[0]?.body).toMatchObject({
      messages: [
        messages[0],
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { type: 'function', function: { index: 0, name: 'lookup', arguments: { id: 'O-1' } } },
          ],
        },
        { role: 'tool', tool_name: 'lookup', content: '{"status":"placed"}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      ],
    });
    expect(JSON.stringify(s.requests[0]?.body)).not.toContain('additionalProperties');
  });
  it('preserves provider ids and deduplicates repeated identified calls only', async () => {
    const identified = { id: 'native-id', function: { name: 'lookup', arguments: { id: 'O-1' } } };
    const anonymous = { function: { name: 'lookup', arguments: { id: 'O-1' } } };
    const s = await server((_request, response) =>
      response.end(
        ndjson([
          { message: { tool_calls: [identified, identified, anonymous, anonymous] } },
          final,
        ]),
      ),
    );
    const result = (
      await collect(createOllamaProvider(config(s.url)).chat(messages, tools))
    ).filter((event) => event.type === 'tool_call');
    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe('native-id');
  });
  it('parses NDJSON split at arbitrary network byte boundaries', async () => {
    const s = await server(async (_request, response) => {
      for (const byte of Buffer.from(ndjson(fixtures.single))) {
        response.write(Buffer.from([byte]));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      response.end();
    });
    expect(
      (await collect(createOllamaProvider(config(s.url)).chat(messages, tools)))[0],
    ).toMatchObject({ type: 'tool_call', arguments: { id: 'O-1' } });
  });
  it.each([
    ['malformed', 'no json\n'],
    ['premature EOF', ndjson([{ message: { content: 'partial' } }])],
    ['invalid shape', '{}\n'],
    [
      'invalid arguments',
      ndjson([
        { message: { tool_calls: [{ function: { name: 'lookup', arguments: 1 } }] } },
        final,
      ]),
    ],
    [
      'ambiguous fragments',
      ndjson([
        { message: { tool_calls: [{ function: { name: 'lookup', arguments: '{"id":' } }] } },
        final,
      ]),
    ],
    [
      'incomplete fragment',
      ndjson([
        {
          message: {
            tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{"id":' } }],
          },
        },
        final,
      ]),
    ],
  ])('rejects %s', async (_name, text) => {
    const s = await server((_request, response) => response.end(text));
    await expect(
      collect(createOllamaProvider(config(s.url)).chat(messages, tools)),
    ).rejects.toMatchObject({ kind: 'provider_error', retryable: false });
  });
  it('does not retry mid-stream errors after partial text', async () => {
    const s = await server((_request, response) => response.end(ndjson(fixtures.midstreamError)));
    const seen: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of createOllamaProvider(config(s.url, { LLM_MAX_RETRIES: 2 })).chat(
          messages,
          [],
        ))
          seen.push(event);
      })(),
    ).rejects.toMatchObject({ kind: 'provider_error' });
    expect(seen).toEqual([{ type: 'text_delta', delta: 'Partial' }]);
    expect(s.requests).toHaveLength(1);
  });
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model_not_found'],
    [400, 'bad_request'],
    [400, 'context_overflow'],
  ] as const)('maps HTTP %s to %s without leaking keys', async (status, kind) => {
    const key = 'secret-llm-key';
    const s = await server((_request, response) => {
      response.writeHead(status);
      response.end(
        JSON.stringify({
          error: `${kind === 'context_overflow' ? 'context length exceeded ' : ''}Authorization: Bearer ${key}`,
        }),
      );
    });
    const result = collect(
      createOllamaProvider(config(s.url, { LLM_API_KEY: key })).chat(messages, []),
    );
    await expect(result).rejects.toMatchObject({ kind, status, retryable: false });
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining(key));
    expect(s.requests[0]?.authorization).toBe(`Bearer ${key}`);
  });
  it.each([429, 500])('retries HTTP %s before the first event', async (status) => {
    let attempts = 0;
    const s = await server((_request, response) => {
      if (++attempts === 1) {
        response.writeHead(status, { 'Retry-After': '0' });
        response.end('{"error":"busy"}');
      } else response.end(ndjson(fixtures.single));
    });
    expect(
      (
        await collect(
          createOllamaProvider(config(s.url, { LLM_MAX_RETRIES: 1 })).chat(messages, tools),
        )
      )[0]?.type,
    ).toBe('tool_call');
    expect(attempts).toBe(2);
  });
  it('times out on an idle stream and keeps partial output unretried', async () => {
    const s = await server((_request, response) => {
      response.write(ndjson([{ message: { content: 'started' } }]));
    });
    await expect(
      collect(
        createOllamaProvider(config(s.url, { LLM_IDLE_TIMEOUT_MS: 40, LLM_MAX_RETRIES: 2 })).chat(
          messages,
          [],
        ),
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(s.requests).toHaveLength(1);
  });
  it('times out before headers and classifies caller abort mid-stream', async () => {
    const stalled = await server(() => undefined);
    await expect(
      collect(
        createOllamaProvider(config(stalled.url, { LLM_FIRST_BYTE_TIMEOUT_MS: 40 })).chat(
          messages,
          [],
        ),
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
    const s = await server((_request, response) => {
      response.write(ndjson([{ message: { content: 'started' } }]));
    });
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const event of createOllamaProvider(config(s.url)).chat(messages, [], {
          signal: controller.signal,
        })) {
          expect(event.type).toBe('text_delta');
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });
  it.each([undefined, 'secret-llm-key'])('lists tags with optional auth %s', async (key) => {
    const s = await server((_request, response) =>
      response.end(JSON.stringify({ models: [{ name: 'one', size: 123 }, { name: 'two' }] })),
    );
    const cfg = config(s.url);
    cfg.LLM_MODEL = undefined;
    cfg.LLM_API_KEY = key;
    expect(await createOllamaProvider(cfg).listModels()).toEqual([
      { name: 'one', sizeBytes: 123 },
      { name: 'two' },
    ]);
    expect(s.requests[0]).toMatchObject({
      path: '/api/tags',
      method: 'GET',
      authorization: key ? `Bearer ${key}` : undefined,
    });
  });
  it('rejects malformed tags and prevents redirects with auth', async () => {
    const malformed = await server((_request, response) => response.end('{"models":[{"name":1}]}'));
    await expect(createOllamaProvider(config(malformed.url)).listModels()).rejects.toMatchObject({
      kind: 'provider_error',
    });
    const target = await server((_request, response) => response.end(ndjson([final])));
    const redirect = await server((_request, response) => {
      response.writeHead(302, { Location: target.url });
      response.end();
    });
    await expect(
      createOllamaProvider(config(redirect.url, { LLM_API_KEY: 'secret' })).listModels(),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(target.requests).toHaveLength(0);
  });
  it('defers missing model failures, rejects unsupported modes/options and makes no request', async () => {
    const s = await server((_request, response) => response.end(ndjson([final])));
    const cfg = config(s.url);
    cfg.LLM_MODEL = undefined;
    const provider = createOllamaProvider(cfg);
    await expect(collect(provider.chat(messages, []))).rejects.toMatchObject({
      kind: 'bad_request',
    });
    await expect(
      collect(
        createOllamaProvider(config(s.url, { LLM_TOOL_MODE: 'prompted' })).chat(messages, tools),
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(
      collect(createOllamaProvider(config(s.url)).chat(messages, [], { maxTokens: -1 })),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(s.requests).toHaveLength(0);
  });
  it('maps connection failures to safe retryable network errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Authorization: Bearer secret'));
    await expect(
      collect(
        createOllamaProvider(config('http://localhost'), { fetch: fetcher }).chat(messages, []),
      ),
    ).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
      message: 'Could not communicate with the LLM provider',
    });
  });
  it('releases the shared limiter when a consumer exits early', async () => {
    let ended = false;
    const s = await server((request, response) => {
      if (request.path === '/api/tags') response.end('{"models":[]}');
      else {
        response.on('close', () => {
          ended = true;
        });
        response.write(ndjson([{ message: { content: 'started' } }]));
      }
    });
    const provider = createOllamaProvider(config(s.url));
    for await (const event of provider.chat(messages, [])) {
      expect(event.type).toBe('text_delta');
      break;
    }
    expect(await provider.listModels()).toEqual([]);
    await vi.waitFor(() => expect(ended).toBe(true));
  });
  it('runs the opt-in CLI against a local fake provider without printing its key', async () => {
    const key = 'live-cli-secret-never-print';
    const s = await server((request, response) => {
      if (request.path === '/api/tags')
        response.end(
          JSON.stringify({ models: [{ name: 'test-model' }, { name: `model-${key}` }] }),
        );
      else {
        const body = request.body as {
          messages: { role: string; content?: string }[];
          tools?: { function: { name: string } }[];
        };
        const probe = body.tools?.some((tool) => tool.function.name === 'record_number');
        const afterRead = body.messages.some((message) =>
          message.content?.includes('Untrusted tool result data'),
        );
        const result = probe
          ? [
              {
                message: {
                  tool_calls: [{ function: { name: 'record_number', arguments: { n: 7 } } }],
                },
              },
              final,
            ]
          : [
              {
                message: {
                  content: afterRead
                    ? JSON.stringify({ final: key })
                    : JSON.stringify({
                        tool_call: {
                          name: 'track_delivery',
                          arguments: { order_id: 'O-EDGE-LATE' },
                        },
                      }),
                },
              },
              final,
            ];
        response.end(ndjson(result));
      }
    });
    const path = fileURLToPath(new URL('../../../../../scripts/llm-live.mjs', import.meta.url));
    const env = {
      ...process.env,
      ADMIN_TOKEN: 'a'.repeat(32),
      LLM_LIVE: '1',
      LLM_PROVIDER: 'ollama',
      LLM_BASE_URL: s.url,
      LLM_API_KEY: key,
      LLM_MODEL: 'test-model',
      LLM_TOOL_MODE: 'auto',
      LLM_MAX_RETRIES: '0',
    };
    const result = await promisify(execFile)(process.execPath, [path], {
      env,
      timeout: 15000,
    }).catch((error: unknown) => {
      const output =
        error !== null && typeof error === 'object' && 'stdout' in error
          ? String(error.stdout)
          : 'No transcript';
      throw new Error(`CLI failed: ${redact(output, [key])}`);
    });
    expect(result.stdout).toContain('"ok":true');
    expect(result.stdout).toContain('"writes_executed":0');
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(s.requests).toHaveLength(4);
    await expect(
      promisify(execFile)(process.execPath, [path], { env: { ...env, LLM_LIVE: '0' } }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('disabled') });
    expect(s.requests).toHaveLength(4);
  }, 20000);
});
