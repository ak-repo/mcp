import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, type Config } from '../config.js';
import { LLMError } from './errors.js';
import { invalidateProbe, probeProvider } from './probe.js';
import type { LLMProvider, StreamEvent } from './types.js';
let serial = 0;
function fixture(
  settings: {
    listError?: LLMError;
    models?: string[];
    native?: boolean;
    prompted?: boolean;
    chatError?: LLMError;
  } = {},
) {
  const config = ConfigSchema.parse({ ADMIN_TOKEN: 'a'.repeat(32), LLM_MODEL: `test-${++serial}` });
  const list = vi.fn(async () => {
    if (settings.listError) throw settings.listError;
    return (settings.models ?? [config.LLM_MODEL!]).map((name) => ({ name }));
  });
  const calls: {
    native: boolean;
    retries: number | undefined;
    tokens: number | undefined;
    think: boolean | undefined;
  }[] = [];
  const provider: LLMProvider = {
    id: 'test',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    listModels: list,
    async *chat(_messages, tools, options) {
      calls.push({
        native: tools.length > 0,
        retries: options?.maxRetries,
        tokens: options?.maxTokens,
        think: options?.think,
      });
      if (settings.chatError) throw settings.chatError;
      if (tools.length ? settings.native !== false : settings.prompted !== false) {
        if (tools.length)
          yield { type: 'tool_call', id: 'c', name: 'record_number', arguments: { n: 7 } };
        else
          yield {
            type: 'text_delta',
            delta: '{"tool_call":{"name":"record_number","arguments":{"n":7}}}',
          };
      } else yield { type: 'text_delta', delta: 'I cannot call tools' };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return { provider, config, calls, list };
}
afterEach(() => vi.useRealTimers());
describe('provider probe', () => {
  it('checks models and a harmless native call with strict request budget', async () => {
    const f = fixture();
    const result = await probeProvider(f.provider, f.config);
    expect(result).toMatchObject({
      ok: true,
      model_found: true,
      tool_calling: 'native',
      recommended_tool_mode: 'native',
    });
    expect(result.steps.map((s) => s.name)).toEqual(['list_models', 'model_present', 'tool_smoke']);
    expect(f.calls).toEqual([{ native: true, retries: 0, tokens: 256, think: false }]);
  });
  it('falls back once without prompted repair, never exceeds two calls', async () => {
    const f = fixture({ native: false });
    expect(await probeProvider(f.provider, f.config)).toMatchObject({
      ok: true,
      tool_calling: 'prompted',
      recommended_tool_mode: 'prompted',
    });
    expect(f.calls).toHaveLength(2);
    const bad = fixture({ native: false, prompted: false });
    expect(await probeProvider(bad.provider, bad.config)).toMatchObject({
      ok: false,
      tool_calling: 'none',
    });
    expect(bad.calls).toHaveLength(2);
  });
  it.each([
    ['auth', 'API key is missing or invalid'],
    ['rate_limit', 'rate limited'],
    ['network', 'reach the provider'],
  ] as const)('reports %s at listing without chat', async (kind, detail) => {
    const f = fixture({ listError: new LLMError(kind, 'untrusted detail secret', false) });
    const result = await probeProvider(f.provider, f.config);
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain(detail);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.calls).toHaveLength(0);
  });
  it('stops on missing model or rate-limited smoke', async () => {
    const f = fixture({ models: ['other'] });
    expect(await probeProvider(f.provider, f.config)).toMatchObject({
      ok: false,
      model_found: false,
    });
    expect(f.calls).toHaveLength(0);
    const rate = fixture({ chatError: new LLMError('rate_limit', 'busy', true) });
    expect((await probeProvider(rate.provider, rate.config)).steps.at(-1)?.detail).toContain(
      'rate limited',
    );
    expect(rate.calls).toHaveLength(1);
  });
  it('caches defensively for ten minutes per config including key, supports invalidation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = await probeProvider(f.provider, f.config);
    first.models.length = 0;
    expect((await probeProvider(f.provider, f.config)).models).toHaveLength(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600001);
    await probeProvider(f.provider, f.config);
    expect(f.list).toHaveBeenCalledTimes(2);
    invalidateProbe(f.config);
    await probeProvider(f.provider, f.config);
    await probeProvider(f.provider, { ...f.config, LLM_API_KEY: 'other-key' });
    expect(f.list).toHaveBeenCalledTimes(4);
  });
  it('never caches an aborted probe', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(probeProvider(f.provider, f.config, controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
    await probeProvider(f.provider, f.config);
    expect(f.list).toHaveBeenCalledTimes(1);
  });
  it('checks the complete tool call, not merely the name', async () => {
    const f = fixture();
    f.provider.chat = async function* (_m, tools): AsyncIterable<StreamEvent> {
      if (tools.length)
        yield {
          type: 'tool_call',
          id: 'c',
          name: 'record_number',
          arguments: { n: 7, extra: true },
        };
      else yield { type: 'text_delta', delta: '{"final":"none"}' };
      yield { type: 'done', reason: 'stop' };
    };
    expect(await probeProvider(f.provider, f.config as Config)).toMatchObject({ ok: false });
  });
});

it('probes native first even if passed a prompted wrapper', async () => {
  const f = fixture();
  const { withPromptedTools } = await import('./prompted-tools.js');
  expect(await probeProvider(withPromptedTools(f.provider), f.config)).toMatchObject({
    tool_calling: 'native',
  });
  expect(f.calls[0]?.native).toBe(true);
});
