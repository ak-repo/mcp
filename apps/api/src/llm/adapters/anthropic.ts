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

export const ANTHROPIC_VERSION = '2023-06-01';
function messagesFor(history: readonly NormalizedMessage[]) {
  const system = history
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const messages: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  for (const message of history) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] =
      message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
        : [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...(message.role === 'assistant'
              ? (message.toolCalls ?? []).map((call) => ({
                  type: 'tool_use',
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                }))
              : []),
          ];
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return { ...(system ? { system } : {}), messages };
}
const eventSchema = z.object({ type: z.string() });
const blockSchema = z.object({
  index: z.number().int().nonnegative(),
  content_block: z.object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: objectArguments.optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  }),
});
const deltaSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: z.object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    partial_json: z.string().optional(),
  }),
});
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
});
export function createAnthropicProvider(
  config: Config,
  dependencies: ProviderDependencies = {},
): LLMProvider {
  const http = transport(config, dependencies);
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(config.LLM_API_KEY ? { 'x-api-key': config.LLM_API_KEY } : {}),
  };
  return {
    id: 'anthropic',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    async *chat(messages, tools, options = {}) {
      const settings = generation(config, options);
      if (options.think ?? config.LLM_THINK === 'on')
        throw new LLMError(
          'bad_request',
          'Anthropic thinking requires signed history support and is disabled',
          false,
        );
      const body = encode({
        model: config.LLM_MODEL,
        ...messagesFor(messages),
        stream: true,
        thinking: { type: 'disabled' },
        max_tokens: settings.maxTokens ?? 1024,
        temperature: settings.temperature,
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: sanitizeToolSchema(tool.parameters, 'anthropic'),
              })),
            }
          : {}),
      });
      async function* decode(frames: AsyncIterable<SseFrame>): AsyncIterable<StreamEvent> {
        const blocks = new Map<
          number,
          {
            type: string;
            id: string;
            name: string;
            input: Record<string, unknown>;
            args: string;
            fragments: boolean;
          }
        >();
        let started = false;
        let reason: string | undefined;
        let promptTokens = 0;
        let completionTokens = 0;
        for await (const frame of frames) {
          const value = json(frame.data);
          const event = parse(eventSchema, value);
          if (event.type === 'ping') continue;
          if (event.type === 'error') {
            const error = parse(z.object({ error: z.object({ type: z.string() }) }), value).error;
            const status =
              error.type === 'authentication_error'
                ? 401
                : error.type === 'permission_error'
                  ? 403
                  : error.type === 'rate_limit_error'
                    ? 429
                    : error.type === 'invalid_request_error'
                      ? 400
                      : 500;
            throw httpError(status, '');
          }
          if (event.type === 'message_start') {
            if (started) throw protocolError();
            started = true;
            const start = parse(z.object({ message: z.object({ usage: usageSchema }) }), value);
            promptTokens = start.message.usage.input_tokens ?? 0;
            completionTokens = start.message.usage.output_tokens ?? 0;
          } else if (event.type === 'content_block_start') {
            if (!started || reason) throw protocolError();
            const { index, content_block: block } = parse(blockSchema, value);
            if (blocks.has(index)) throw protocolError();
            blocks.set(index, {
              type: block.type,
              id: block.id ?? '',
              name: block.name ?? '',
              input: block.input ?? {},
              args: '',
              fragments: false,
            });
            if (blocks.size > 128) throw protocolError();
            if (block.type === 'text' && block.text)
              yield { type: 'text_delta', delta: block.text };
            if (block.type === 'thinking' && block.thinking)
              yield { type: 'thinking_delta', delta: block.thinking };
          } else if (event.type === 'content_block_delta') {
            const { index, delta } = parse(deltaSchema, value);
            const block = blocks.get(index);
            if (!block) throw protocolError();
            if (delta.type === 'text_delta') {
              if (block.type !== 'text' || delta.text === undefined) throw protocolError();
              if (delta.text) yield { type: 'text_delta', delta: delta.text };
            } else if (delta.type === 'thinking_delta') {
              if (block.type !== 'thinking' || delta.thinking === undefined) throw protocolError();
              if (delta.thinking) yield { type: 'thinking_delta', delta: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              if (block.type !== 'tool_use' || delta.partial_json === undefined)
                throw protocolError();
              block.fragments = true;
              block.args += delta.partial_json;
              if (Buffer.byteLength(block.args) > 1024 * 1024) throw protocolError();
            }
          } else if (event.type === 'content_block_stop') {
            const { index } = parse(z.object({ index: z.number().int().nonnegative() }), value);
            const block = blocks.get(index);
            if (!block) throw protocolError();
            if (block.type === 'tool_use') {
              if (!block.id || !block.name) throw protocolError();
              yield {
                type: 'tool_call',
                id: block.id,
                name: block.name,
                arguments: block.fragments ? parse(objectArguments, json(block.args)) : block.input,
              };
            }
            blocks.delete(index);
          } else if (event.type === 'message_delta') {
            if (!started || blocks.size) throw protocolError();
            const update = parse(
              z.object({
                delta: z.object({ stop_reason: z.string().nullable().optional() }),
                usage: usageSchema.optional(),
              }),
              value,
            );
            reason = update.delta.stop_reason ?? reason;
            promptTokens = update.usage?.input_tokens ?? promptTokens;
            completionTokens = update.usage?.output_tokens ?? completionTokens;
          } else if (event.type === 'message_stop') {
            if (!started || blocks.size || !reason) throw protocolError();
            yield { type: 'usage', promptTokens, completionTokens };
            yield { type: 'done', reason };
            return;
          }
        }
        throw protocolError();
      }
      yield* http.chat('/v1/messages', headers, body, decode, options);
    },
    listModels(signal) {
      return http.models(
        '/v1/models?limit=100',
        headers,
        (value) => {
          const page = parse(
            z.object({
              data: z.array(z.object({ id: z.string().min(1) })),
              has_more: z.boolean(),
              last_id: z.string().nullable().optional(),
            }),
            value,
          );
          if (page.has_more && !page.last_id) throw protocolError();
          return {
            models: page.data.map((model) => ({ name: model.id })),
            ...(page.has_more
              ? { next: `/v1/models?limit=100&after_id=${encodeURIComponent(page.last_id!)}` }
              : {}),
          };
        },
        signal,
      );
    },
  };
}
