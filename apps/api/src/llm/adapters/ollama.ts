import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { httpError, LLMError, protocolError } from '../errors.js';
import { openHttp, readNdjson, withRetry } from '../http.js';
import { ConcurrencyLimiter } from '../limiter.js';
import { generation, type ProviderDependencies } from './common.js';
import { sanitizeToolSchema } from '../schema-sanitizer.js';
import type {
  ChatOptions,
  LLMProvider,
  ModelInfo,
  NormalizedMessage,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from '../types.js';
const argumentsSchema = z.record(z.string(), z.unknown());
const nativeCall = z.object({
  id: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  function: z.object({
    name: z.string().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
    arguments: z.union([argumentsSchema, z.string()]),
  }),
});
const chunkSchema = z.object({
  error: z.string().optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  message: z
    .object({
      content: z.string().optional(),
      thinking: z.string().optional(),
      tool_calls: z.array(nativeCall).optional(),
    })
    .optional(),
  prompt_eval_count: z.number().int().nonnegative().safe().optional(),
  eval_count: z.number().int().nonnegative().safe().optional(),
});
const modelsSchema = z.object({
  models: z.array(
    z.object({ name: z.string().min(1), size: z.number().int().nonnegative().safe().optional() }),
  ),
});
function valid<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}
function optionsFor(config: Config, signal?: AbortSignal) {
  return {
    firstByteTimeoutMs: config.LLM_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs: config.LLM_IDLE_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  };
}
function mapMessages(messages: readonly NormalizedMessage[]) {
  return messages.map((message) => {
    if (message.role === 'tool')
      return { role: 'tool', tool_name: message.toolName, content: message.content };
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call, index) => ({
                type: 'function',
                function: { index, name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    return { role: message.role, content: message.content };
  });
}
interface BufferedCall {
  id: string;
  name: string | undefined;
  fragment: string;
  emitted: ToolCall | undefined;
}
export function createOllamaProvider(
  config: Config,
  dependencies: ProviderDependencies = {},
): LLMProvider {
  const limiter = dependencies.limiter ?? new ConcurrencyLimiter(config.LLM_MAX_CONCURRENCY);
  const fetcher = dependencies.fetch ?? fetch;
  const base = config.LLM_BASE_URL.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : {}),
  };
  return {
    id: 'ollama',
    capabilities: { toolCalling: true, streaming: true, thinking: true },
    async *chat(
      messages: readonly NormalizedMessage[],
      tools: readonly ToolDefinition[],
      options: ChatOptions = {},
    ): AsyncIterable<StreamEvent> {
      generation(config, options);
      if (!config.LLM_MODEL)
        throw new LLMError('bad_request', 'Set LLM_MODEL before starting a chat', false);
      if (config.LLM_PROVIDER !== 'ollama')
        throw new LLMError('bad_request', 'This adapter requires LLM_PROVIDER=ollama', false);
      if (tools.length && config.LLM_TOOL_MODE === 'prompted')
        throw new LLMError(
          'bad_request',
          'Prompted tools are not available; use auto or native',
          false,
        );
      const temperature = options.temperature ?? config.LLM_TEMPERATURE;
      const numCtx = options.numCtx ?? config.LLM_NUM_CTX;
      if (
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2 ||
        !Number.isSafeInteger(numCtx) ||
        numCtx < 1 ||
        (options.maxTokens !== undefined &&
          (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))
      )
        throw new LLMError(
          'bad_request',
          'Invalid temperature, context window or token limit',
          false,
        );
      let body: string;
      try {
        body = JSON.stringify({
          model: config.LLM_MODEL,
          messages: mapMessages(messages),
          stream: true,
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: sanitizeToolSchema(tool.parameters, 'ollama'),
                  },
                })),
              }
            : {}),
          options: {
            temperature,
            num_ctx: numCtx,
            ...(options.maxTokens === undefined ? {} : { num_predict: options.maxTokens }),
          },
          think: options.think ?? config.LLM_THINK === 'on',
        });
      } catch (error) {
        if (error instanceof LLMError) throw error;
        throw new LLMError(
          'bad_request',
          'Messages and tool arguments must be JSON serializable',
          false,
        );
      }
      const prefix = `ollama-${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
      const release = await limiter.acquire(options.signal);
      async function* attempt(): AsyncIterable<StreamEvent> {
        const stream = await openHttp(
          `${base}/api/chat`,
          { method: 'POST', headers, body },
          optionsFor(config, options.signal),
          fetcher,
        );
        const calls = new Map<string, BufferedCall>();
        let ordinal = 0;
        let completed = false;
        try {
          for await (const value of readNdjson(stream.chunks)) {
            const chunk = valid(chunkSchema, value);
            if (chunk.error !== undefined) throw httpError(500, chunk.error);
            if (!chunk.message && chunk.done !== true) throw protocolError();
            if (chunk.message?.content) yield { type: 'text_delta', delta: chunk.message.content };
            if (chunk.message?.thinking)
              yield { type: 'thinking_delta', delta: chunk.message.thinking };
            for (const raw of chunk.message?.tool_calls ?? []) {
              const index = raw.index ?? raw.function.index;
              const key = raw.id
                ? `id:${raw.id}`
                : index === undefined
                  ? undefined
                  : `index:${index}`;
              let call = key === undefined ? undefined : calls.get(key);
              if (!call) {
                call = {
                  id: raw.id ?? `${prefix}-${ordinal++}`,
                  name: raw.function.name,
                  fragment: '',
                  emitted: undefined,
                };
                if (key !== undefined) calls.set(key, call);
              }
              if (raw.function.name) {
                if (call.name && call.name !== raw.function.name) throw protocolError();
                call.name = raw.function.name;
              }
              if (typeof raw.function.arguments === 'string') {
                if (key === undefined || call.emitted) throw protocolError();
                call.fragment += raw.function.arguments;
                if (Buffer.byteLength(call.fragment) > 1024 * 1024) throw protocolError();
              } else {
                if (!call.name || call.fragment) throw protocolError();
                const result: ToolCall = {
                  id: call.id,
                  name: call.name,
                  arguments: raw.function.arguments,
                };
                if (call.emitted) {
                  if (JSON.stringify(call.emitted) !== JSON.stringify(result))
                    throw protocolError();
                  continue;
                }
                call.emitted = result;
                yield { type: 'tool_call', ...result };
              }
            }
            if (chunk.done) {
              for (const call of calls.values()) {
                if (call.emitted) continue;
                if (!call.name) throw protocolError();
                let parsed: unknown;
                try {
                  parsed = JSON.parse(call.fragment) as unknown;
                } catch {
                  throw protocolError();
                }
                yield {
                  type: 'tool_call',
                  id: call.id,
                  name: call.name,
                  arguments: valid(argumentsSchema, parsed),
                };
              }
              if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined)
                yield {
                  type: 'usage',
                  promptTokens: chunk.prompt_eval_count ?? 0,
                  completionTokens: chunk.eval_count ?? 0,
                };
              yield { type: 'done', reason: chunk.done_reason ?? 'stop' };
              completed = true;
              return;
            }
          }
          if (!completed) throw protocolError();
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
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
      const release = await limiter.acquire(signal);
      async function* attempt(): AsyncIterable<ModelInfo[]> {
        const stream = await openHttp(
          `${base}/api/tags`,
          { method: 'GET', headers },
          optionsFor(config, signal),
          fetcher,
        );
        try {
          let text = '';
          const decoder = new TextDecoder('utf-8', { fatal: true });
          for await (const chunk of stream.chunks) {
            text += decoder.decode(chunk, { stream: true });
            if (Buffer.byteLength(text) > 1024 * 1024) throw protocolError();
          }
          text += decoder.decode();
          let value: unknown;
          try {
            value = JSON.parse(text) as unknown;
          } catch {
            throw protocolError();
          }
          yield valid(modelsSchema, value).models.map((model) => ({
            name: model.name,
            ...(model.size === undefined ? {} : { sizeBytes: model.size }),
          }));
        } catch (error) {
          if (error instanceof LLMError) throw error;
          throw protocolError();
        } finally {
          stream.close();
        }
      }
      try {
        for await (const models of withRetry(attempt, {
          maxRetries: config.LLM_MAX_RETRIES,
          ...(signal ? { signal } : {}),
        }))
          return models;
        throw protocolError();
      } finally {
        release();
      }
    },
  };
}
