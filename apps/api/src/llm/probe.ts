import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { aborted, LLMError, redact } from './errors.js';
import { unwrapPromptedTools, withPromptedTools } from './prompted-tools.js';
import type { LLMProvider, ModelInfo, ToolDefinition } from './types.js';
export type ToolMode = 'native' | 'prompted' | 'none';
export interface ProbeStep {
  name: 'list_models' | 'model_present' | 'tool_smoke';
  ok: boolean;
  detail: string;
  latency_ms: number;
}
export interface ProbeResult {
  ok: boolean;
  steps: ProbeStep[];
  models: ModelInfo[];
  model_found: boolean;
  tool_calling: ToolMode;
  recommended_tool_mode: 'native' | 'prompted';
  warnings: string[];
}
const TTL = 10 * 60 * 1000;
const cache = new Map<string, { expires: number; result: ProbeResult }>();
export function providerConfigHash(config: Config): string {
  const settings = Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => key.startsWith('LLM_'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}
export function cachedProbe(config: Config): ProbeResult | undefined {
  const entry = cache.get(providerConfigHash(config));
  if (!entry || entry.expires <= Date.now()) return undefined;
  return structuredClone(entry.result);
}
export function invalidateProbe(config: Config): void {
  cache.delete(providerConfigHash(config));
}
function failure(error: unknown): string {
  if (!(error instanceof LLMError)) return 'Provider probe failed';
  if (error.kind === 'auth') return 'API key is missing or invalid';
  if (error.kind === 'rate_limit') return 'Provider is rate limited; retry later';
  if (error.kind === 'network') return 'Could not reach the provider';
  if (error.kind === 'timeout') return 'Provider response timed out';
  return 'Provider rejected or could not complete the probe';
}
const tool: ToolDefinition = {
  name: 'record_number',
  description: 'Record an integer for this harmless capability test. It will not be executed.',
  parameters: {
    type: 'object',
    properties: { n: { type: 'integer' } },
    required: ['n'],
    additionalProperties: false,
  },
};
export async function probeProvider(
  provider: LLMProvider,
  config: Config,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  provider = unwrapPromptedTools(provider);
  if (signal?.aborted) throw aborted();
  const key = providerConfigHash(config);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return structuredClone(hit.result);
  const result: ProbeResult = {
    ok: false,
    steps: [],
    models: [],
    model_found: false,
    tool_calling: 'none',
    recommended_tool_mode: 'native',
    warnings: [],
  };
  const secret = config.LLM_API_KEY ? [config.LLM_API_KEY] : [];
  const save = () => {
    if (signal?.aborted) throw aborted();
    for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + TTL, result: structuredClone(result) });
    return result;
  };
  let start = performance.now();
  try {
    const models = await provider.listModels(signal);
    result.models = models.map((model) => ({
      name: redact(model.name, secret),
      ...(model.sizeBytes === undefined ? {} : { sizeBytes: model.sizeBytes }),
    }));
    result.model_found = Boolean(
      config.LLM_MODEL && models.some((model) => model.name === config.LLM_MODEL),
    );
    result.steps.push({
      name: 'list_models',
      ok: true,
      detail: 'Available models retrieved',
      latency_ms: Math.round(performance.now() - start),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof LLMError && error.kind === 'aborted')) throw aborted();
    result.steps.push({
      name: 'list_models',
      ok: false,
      detail: failure(error),
      latency_ms: Math.round(performance.now() - start),
    });
    return save();
  }
  result.steps.push({
    name: 'model_present',
    ok: result.model_found,
    detail: result.model_found
      ? 'Configured model is available'
      : 'Set LLM_MODEL to an available model identifier',
    latency_ms: 0,
  });
  if (!result.model_found) return save();
  start = performance.now();
  const smoke = async (candidate: LLMProvider): Promise<boolean> => {
    let calls = 0;
    let correct = false;
    let done = false;
    for await (const event of candidate.chat(
      [
        {
          role: 'user',
          content: 'Call record_number exactly once with n=7. Do not answer in prose.',
        },
      ],
      [tool],
      {
        temperature: 0,
        maxTokens: 256,
        think: false,
        maxRetries: 0,
        ...(signal ? { signal } : {}),
      },
    )) {
      if (event.type === 'tool_call') {
        calls++;
        correct =
          event.name === tool.name &&
          Object.keys(event.arguments).length === 1 &&
          event.arguments.n === 7;
      }
      if (event.type === 'done') done = true;
    }
    return done && calls === 1 && correct;
  };
  let detail = 'Model did not return a valid tool call';
  let fallback = true;
  try {
    if (await smoke(provider)) result.tool_calling = 'native';
  } catch (error) {
    if (signal?.aborted || (error instanceof LLMError && error.kind === 'aborted')) throw aborted();
    detail = failure(error);
    // An auth, rate-limit, network, or timeout failure is not evidence of missing native tools.
    fallback =
      error instanceof LLMError &&
      (error.kind === 'bad_request' || (error.kind === 'provider_error' && !error.retryable));
  }
  if (result.tool_calling === 'none' && fallback) {
    try {
      if (await smoke(withPromptedTools(provider, { repair: false, secrets: secret }))) {
        result.tool_calling = 'prompted';
        result.recommended_tool_mode = 'prompted';
        result.warnings.push('Native tools failed; use prompted tools (one call per turn)');
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof LLMError && error.kind === 'aborted'))
        throw aborted();
      detail = failure(error);
    }
  }
  result.ok = result.tool_calling !== 'none';
  result.steps.push({
    name: 'tool_smoke',
    ok: result.ok,
    detail: result.ok ? `Validated ${result.tool_calling} tool call without execution` : detail,
    latency_ms: Math.round(performance.now() - start),
  });
  if (!result.ok)
    result.warnings.push('No working tool mode detected; do not start a tool-using agent');
  return save();
}
