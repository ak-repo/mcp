import { expect, it } from 'vitest';
import {
  ChatRequestSchema,
  ApproveRequestSchema,
  ProviderUpdateSchema,
  ProviderPublicConfigSchema,
  McpStatusSchema,
} from './chat.js';
it.each(['', '   ', 'x'.repeat(4001)])('rejects invalid message %j', (message) => {
  expect(ChatRequestSchema.safeParse({ message }).success).toBe(false);
});
it('uses strict browser-safe input contracts', () => {
  expect(ChatRequestSchema.parse({ message: 'Hi' })).toEqual({ message: 'Hi' });
  expect(ChatRequestSchema.safeParse({ message: 'Hi', actor: 'ai' }).success).toBe(false);
  expect(ApproveRequestSchema.safeParse({ call_id: 'c', decision: 'expired' }).success).toBe(false);
  expect(ProviderUpdateSchema.safeParse({ api_key: 'private', clear_api_key: true }).success).toBe(
    false,
  );
  expect(ProviderUpdateSchema.safeParse({ api_key: 'bad\nkey' }).success).toBe(false);
  expect(ProviderUpdateSchema.safeParse({ temperature: 3 }).success).toBe(false);
  expect(ProviderUpdateSchema.safeParse({ unknown: true }).success).toBe(false);
});
it('public schemas reject credentials and validate status', () => {
  const view = {
    provider: 'ollama',
    base_url: 'https://ollama.com',
    model: null,
    tool_mode: 'auto',
    effective_tool_mode: 'native',
    temperature: 0.2,
    num_ctx: 16384,
    api_key_set: true,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  };
  expect(ProviderPublicConfigSchema.parse(view)).toEqual(view);
  expect(ProviderPublicConfigSchema.safeParse({ ...view, api_key: 'private' }).success).toBe(false);
  expect(McpStatusSchema.parse({ connected: false, last_error: null, tool_count: 0 })).toBeTruthy();
});
