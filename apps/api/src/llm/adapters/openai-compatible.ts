import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { httpError, LLMError, protocolError } from '../errors.js';
import type { SseFrame } from '../http.js';
import { sanitizeToolSchema } from '../schema-sanitizer.js';
import type { LLMProvider, NormalizedMessage, StreamEvent } from '../types.js';
import {
  encode,
  generation,
  json,
  objectArguments,
  parse,
  transport,
  type ProviderDependencies,
} from './common.js';

const chunkSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().nullable().optional(),
      type: z.string().optional(),
    })
    .optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        finish_reason: z.string().nullable().optional(),
        delta: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().nonnegative(),
                id: z.string().optional(),
                function: z
                  .object({ name: z.string().optional(), arguments: z.string().optional() })
                  .optional(),
              }),
            )
            .optional(),
        }),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
function messagesFor(messages: readonly NormalizedMessage[]) {
  return messages.map((message) => {
    if (message.role === 'tool')
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: encode(call.arguments) },
              })),
            }
          : {}),
      };
    return { role: message.role, content: message.content };
  });
}
export function createOpenAICompatibleProvider(
  config: Config,
  dependencies: ProviderDependencies = {},
): LLMProvider {
  const http = transport(config, dependencies);
  const headers = {
    'Content-Type': 'application/json',
    ...(config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : {}),
  };
  return {
    id: 'openai-compatible',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    async *chat(messages, tools, options = {}) {
      const settings = generation(config, options);
      if (options.think ?? config.LLM_THINK === 'on')
        throw new LLMError(
          'bad_request',
          'Thinking is not supported by this OpenAI-compatible adapter',
          false,
        );
      const body = encode({
        model: config.LLM_MODEL,
        messages: messagesFor(messages),
        stream: true,
        stream_options: { include_usage: true },
        temperature: settings.temperature,
        ...(settings.maxTokens === undefined ? {} : { max_tokens: settings.maxTokens }),
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: sanitizeToolSchema(tool.parameters, 'openai'),
                },
              })),
            }
          : {}),
      });
      const prefix = createHash('sha256').update(body).digest('hex').slice(0, 16);
      async function* decode(frames: AsyncIterable<SseFrame>): AsyncIterable<StreamEvent> {
        const calls = new Map<number, { id: string; name: string; args: string }>();
        let finished = false;
        let reason = 'stop';
        for await (const frame of frames) {
          if (frame.data === '[DONE]') {
            if (!finished) throw protocolError();
            yield { type: 'done', reason };
            return;
          }
          const chunk = parse(chunkSchema, json(frame.data));
          if (chunk.error)
            throw httpError(chunk.error.code === 'rate_limit_exceeded' ? 429 : 500, '');
          if (!chunk.choices) throw protocolError();
          for (const choice of chunk.choices) {
            if (choice.index !== 0 || finished) throw protocolError();
            if (choice.delta.content) yield { type: 'text_delta', delta: choice.delta.content };
            for (const fragment of choice.delta.tool_calls ?? []) {
              const call = calls.get(fragment.index) ?? { id: '', name: '', args: '' };
              if (fragment.id) {
                if (call.id && call.id !== fragment.id) throw protocolError();
                call.id = fragment.id;
              }
              call.name += fragment.function?.name ?? '';
              call.args += fragment.function?.arguments ?? '';
              if (
                Buffer.byteLength(call.args) > 1024 * 1024 ||
                call.name.length > 1024 ||
                calls.size > 128
              )
                throw protocolError();
              calls.set(fragment.index, call);
            }
            if (choice.finish_reason) {
              reason = choice.finish_reason;
              if (calls.size && reason !== 'tool_calls') throw protocolError();
              for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
                if (!call.name) throw protocolError();
                yield {
                  type: 'tool_call',
                  id: call.id || `openai-${prefix}-${index}`,
                  name: call.name,
                  arguments: parse(objectArguments, json(call.args)),
                };
              }
              finished = true;
            }
          }
          if (chunk.usage)
            yield {
              type: 'usage',
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
            };
        }
        throw protocolError();
      }
      yield* http.chat('/chat/completions', headers, body, decode, options);
    },
    listModels(signal) {
      return http.models(
        '/models',
        headers,
        (value) => ({
          models: parse(
            z.object({ data: z.array(z.object({ id: z.string().min(1) })) }),
            value,
          ).data.map((model) => ({ name: model.id })),
        }),
        signal,
      );
    },
  };
}
