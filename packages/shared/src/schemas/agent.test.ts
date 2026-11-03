import { expect, it } from 'vitest';
import { AgentEventSchema } from './agent.js';
const events = [
  { type: 'run.started', run_id: 'r', session_id: 's', provider: 'ollama', model: 'm' },
  { type: 'text.delta', text: 'hi' },
  { type: 'thinking.delta', text: 'think' },
  { type: 'tool.call', call_id: 'c', name: 'read', arguments: { id: 'o' }, kind: 'read' },
  {
    type: 'tool.result',
    call_id: 'c',
    name: 'read',
    status: 'ok',
    latency_ms: 2,
    summary: 'ok',
    truncated: false,
  },
  {
    type: 'approval.required',
    call_id: 'c',
    name: 'write',
    preview: { amount: 1 },
    expires_at: '2026-11-03T12:00:00Z',
  },
  { type: 'approval.resolved', call_id: 'c', decision: 'approved' },
  { type: 'run.completed', usage: { promptTokens: 1, completionTokens: 2 }, iterations: 1 },
  { type: 'run.error', kind: 'network', message: 'Unavailable', retryable: true },
];
it.each(events)('validates $type and rejects extra fields', (event) => {
  expect(AgentEventSchema.parse(event)).toEqual(event);
  expect(AgentEventSchema.safeParse({ ...event, confirmation_token: 'secret' }).success).toBe(
    false,
  );
});
it('rejects invalid counts, dates and non-JSON data', () => {
  expect(AgentEventSchema.safeParse({ ...events[5], expires_at: 'bad' }).success).toBe(false);
  expect(AgentEventSchema.safeParse({ ...events[4], latency_ms: -1 }).success).toBe(false);
  expect(AgentEventSchema.safeParse({ ...events[3], arguments: { f: () => 1 } }).success).toBe(
    false,
  );
});
