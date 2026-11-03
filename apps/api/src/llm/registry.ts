import { ProviderUpdateSchema, type ProviderUpdate } from '@foodops/shared';
export type { ProviderUpdate } from '@foodops/shared';
import { LLMSettingsSchema, PROVIDER_BASE_URLS, type Config } from '../config.js';
import { createAnthropicProvider } from './adapters/anthropic.js';
import { createOllamaProvider } from './adapters/ollama.js';
import { createOpenAICompatibleProvider } from './adapters/openai-compatible.js';
import type { ProviderDependencies } from './adapters/common.js';
import { LLMError, redact } from './errors.js';
import { ConcurrencyLimiter } from './limiter.js';
import { sanitizeToolSchema } from './schema-sanitizer.js';
import { registerNativeProvider, withPromptedTools } from './prompted-tools.js';
import { cachedProbe, invalidateProbe, probeProvider, type ProbeResult } from './probe.js';
import type { LLMProvider } from './types.js';

function validated(value: Config): Config {
  const parsed = LLMSettingsSchema.safeParse(value);
  if (!parsed.success)
    throw new LLMError(
      'bad_request',
      'Invalid provider settings; check configuration fields',
      false,
    );
  return { ...value, ...parsed.data };
}
function native(config: Config, dependencies: ProviderDependencies): LLMProvider {
  const settings = { ...config, LLM_TOOL_MODE: 'native' as const };
  switch (config.LLM_PROVIDER) {
    case 'ollama':
      return createOllamaProvider(settings, dependencies);
    case 'openai-compatible':
      return createOpenAICompatibleProvider(settings, dependencies);
    case 'anthropic':
      return createAnthropicProvider(settings, dependencies);
  }
}
function view(config: Config, effectiveMode: 'native' | 'prompted') {
  const secrets = config.LLM_API_KEY ? [config.LLM_API_KEY] : [];
  return {
    provider: config.LLM_PROVIDER,
    base_url: redact(config.LLM_BASE_URL, secrets),
    model: config.LLM_MODEL === undefined ? null : redact(config.LLM_MODEL, secrets),
    tool_mode: config.LLM_TOOL_MODE,
    effective_tool_mode: effectiveMode,
    temperature: config.LLM_TEMPERATURE,
    num_ctx: config.LLM_NUM_CTX,
    api_key_set: Boolean(config.LLM_API_KEY),
  };
}
export function createLLM(input: Config, dependencies: ProviderDependencies = {}) {
  const config = validated(input);
  const provider = native(config, dependencies);
  const prompted = withPromptedTools(provider, {
    secrets: config.LLM_API_KEY ? [config.LLM_API_KEY] : [],
  });
  const mode = (): 'native' | 'prompted' =>
    config.LLM_TOOL_MODE === 'prompted' ||
    (config.LLM_TOOL_MODE === 'auto' && cachedProbe(config)?.recommended_tool_mode === 'prompted')
      ? 'prompted'
      : 'native';
  const routed: LLMProvider = {
    id: provider.id,
    get capabilities() {
      return { ...(mode() === 'prompted' ? prompted : provider).capabilities };
    },
    listModels: (signal) => provider.listModels(signal),
    chat(messages, tools, options) {
      let selected = mode() === 'prompted' ? prompted : provider;
      if (
        config.LLM_TOOL_MODE === 'auto' &&
        config.LLM_PROVIDER === 'ollama' &&
        selected === provider
      ) {
        try {
          for (const tool of tools) sanitizeToolSchema(tool.parameters, 'ollama');
        } catch (error) {
          if (!(error instanceof LLMError) || error.kind !== 'bad_request') throw error;
          selected = prompted;
        }
      }
      return selected.chat(messages, tools, options);
    },
  };
  registerNativeProvider(routed, provider);
  return {
    provider: routed,
    describe: () => ({ ...view(config, mode()), capabilities: { ...routed.capabilities } }),
  };
}

export class ProviderManager {
  #config: Config;
  #active: ReturnType<typeof createLLM>;
  #limiter: ConcurrencyLimiter;
  #revision = 0;
  #dependencies: ProviderDependencies;
  constructor(config: Config, dependencies: ProviderDependencies = {}) {
    this.#config = validated(config);
    this.#limiter = dependencies.limiter ?? new ConcurrencyLimiter(config.LLM_MAX_CONCURRENCY);
    this.#dependencies = { ...dependencies, limiter: this.#limiter };
    this.#active = createLLM(this.#config, this.#dependencies);
  }
  get provider(): LLMProvider {
    return this.#active.provider;
  }
  publicView() {
    return this.#active.describe();
  }
  capture() {
    const provider = this.provider;
    const publicConfig = this.publicView();
    const secrets = this.#config.LLM_API_KEY ? [this.#config.LLM_API_KEY] : [];
    return { provider, publicConfig, redact: (text: string) => redact(text, secrets) };
  }
  lastProbe() {
    return cachedProbe(this.#config) ?? null;
  }
  redact(text: string) {
    return redact(text, this.#config.LLM_API_KEY ? [this.#config.LLM_API_KEY] : []);
  }
  update(input: ProviderUpdate) {
    const parsed = ProviderUpdateSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.api_key !== undefined && parsed.data.clear_api_key === true)
    )
      throw new LLMError(
        'bad_request',
        'Invalid provider update; set or clear the API key, not both',
        false,
      );
    const patch = parsed.data;
    const changedProvider =
      patch.provider !== undefined && patch.provider !== this.#config.LLM_PROVIDER;
    const next = validated({
      ...this.#config,
      LLM_PROVIDER: patch.provider ?? this.#config.LLM_PROVIDER,
      LLM_BASE_URL:
        patch.base_url ??
        (changedProvider ? PROVIDER_BASE_URLS[patch.provider!] : this.#config.LLM_BASE_URL),
      LLM_MODEL: patch.model ?? this.#config.LLM_MODEL,
      LLM_TOOL_MODE: patch.tool_mode ?? this.#config.LLM_TOOL_MODE,
      LLM_TEMPERATURE: patch.temperature ?? this.#config.LLM_TEMPERATURE,
      LLM_NUM_CTX: patch.num_ctx ?? this.#config.LLM_NUM_CTX,
      LLM_API_KEY:
        patch.clear_api_key || changedProvider
          ? patch.api_key
          : (patch.api_key ?? this.#config.LLM_API_KEY),
    });
    const replacement = createLLM(next, this.#dependencies);
    invalidateProbe(this.#config);
    invalidateProbe(next);
    this.#config = next;
    this.#active = replacement;
    this.#revision++;
    return this.publicView();
  }
  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const config = this.#config;
    const revision = this.#revision;
    const result = await probeProvider(native(config, this.#dependencies), config, signal);
    if (revision === this.#revision) this.#active = createLLM(config, this.#dependencies);
    else invalidateProbe(config);
    return result;
  }
}
