import { z } from 'zod';
import type { Config } from '../../config.js';
import { LLMError, protocolError } from '../errors.js';
import { openHttp, readSse, withRetry } from '../http.js';
import { ConcurrencyLimiter } from '../limiter.js';
import type { ChatOptions, ModelInfo, StreamEvent } from '../types.js';

export interface ProviderDependencies {
  fetch?: typeof fetch;
  limiter?: ConcurrencyLimiter;
}
export const objectArguments = z.record(z.string(), z.unknown());
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw protocolError();
  return result.data;
}
export function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocolError();
  }
}
export function encode(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new LLMError(
      'bad_request',
      'Messages and tool arguments must be JSON serializable',
      false,
    );
  }
}
export function generation(config: Config, options: ChatOptions) {
  const temperature = options.temperature ?? config.LLM_TEMPERATURE;
  const maxTokens = options.maxTokens;
  if (!config.LLM_MODEL)
    throw new LLMError('bad_request', 'Set LLM_MODEL before starting a chat', false);
  if (
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2 ||
    (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) ||
    (options.numCtx !== undefined &&
      (!Number.isSafeInteger(options.numCtx) || options.numCtx < 1)) ||
    (options.maxRetries !== undefined &&
      (!Number.isSafeInteger(options.maxRetries) ||
        options.maxRetries < 0 ||
        options.maxRetries > config.LLM_MAX_RETRIES))
  )
    throw new LLMError('bad_request', 'Invalid generation options', false);
  return { temperature, maxTokens };
}
export function transport(config: Config, dependencies: ProviderDependencies) {
  const limiter = dependencies.limiter ?? new ConcurrencyLimiter(config.LLM_MAX_CONCURRENCY);
  const fetcher = dependencies.fetch ?? fetch;
  const base = config.LLM_BASE_URL.replace(/\/+$/, '');
  const httpOptions = (signal?: AbortSignal) => ({
    firstByteTimeoutMs: config.LLM_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs: config.LLM_IDLE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  return {
    base,
    async *chat(
      path: string,
      headers: Record<string, string>,
      body: string,
      decode: (frames: ReturnType<typeof readSse>) => AsyncIterable<StreamEvent>,
      options: ChatOptions,
    ) {
      const release = await limiter.acquire(options.signal);
      async function* attempt() {
        const stream = await openHttp(
          `${base}${path}`,
          { method: 'POST', headers, body },
          httpOptions(options.signal),
          fetcher,
        );
        try {
          yield* decode(readSse(stream.chunks));
        } finally {
          stream.close();
        }
      }
      try {
        yield* withRetry(attempt, {
          maxRetries: options.maxRetries ?? config.LLM_MAX_RETRIES,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } finally {
        release();
      }
    },
    async models(
      path: string,
      headers: Record<string, string>,
      decode: (value: unknown) => { models: ModelInfo[]; next?: string },
      signal?: AbortSignal,
    ): Promise<ModelInfo[]> {
      const release = await limiter.acquire(signal);
      async function* attempt() {
        const result: ModelInfo[] = [];
        const visited = new Set<string>();
        let current: string | undefined = path;
        while (current) {
          if (visited.has(current) || visited.size >= 100) throw protocolError();
          visited.add(current);
          const stream = await openHttp(
            `${base}${current}`,
            { method: 'GET', headers },
            httpOptions(signal),
            fetcher,
          );
          try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let text = '';
            for await (const chunk of stream.chunks) {
              text += decoder.decode(chunk, { stream: true });
              if (Buffer.byteLength(text) > 1024 * 1024) throw protocolError();
            }
            text += decoder.decode();
            const page = decode(json(text));
            result.push(...page.models);
            current = page.next;
          } catch (error) {
            if (error instanceof LLMError) throw error;
            throw protocolError();
          } finally {
            stream.close();
          }
        }
        yield result;
      }
      try {
        for await (const result of withRetry(attempt, {
          maxRetries: config.LLM_MAX_RETRIES,
          ...(signal ? { signal } : {}),
        }))
          return result;
        throw protocolError();
      } finally {
        release();
      }
    },
  };
}
