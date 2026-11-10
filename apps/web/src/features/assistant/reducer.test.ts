import { expect, it } from 'vitest';
import { archiveTurn, initialRun, runAnnouncement, runReducer } from './reducer.js';

const started = {
  type: 'run.started' as const,
  run_id: 'r',
  session_id: 's',
  provider: 'ollama',
  model: 'm',
};
const call = {
  type: 'tool.call' as const,
  call_id: 'c',
  name: 'cancel_order',
  arguments: { order_id: 'O-1' },
  kind: 'write' as const,
};
const approval = {
  type: 'approval.required' as const,
  call_id: 'c',
  name: 'cancel_order',
  preview: { order_id: 'O-1' },
  expires_at: '2026-11-05T12:00:00Z',
};

it('moves through streaming, approval and completion states', () => {
  let state = runReducer(initialRun, { type: 'send' });
  state = runReducer(state, { type: 'event', event: started });
  state = runReducer(state, { type: 'event', event: call });
  state = runReducer(state, { type: 'event', event: approval });
  expect(state.state).toBe('awaiting_approval');
  state = runReducer(state, { type: 'approval_sent', decision: 'approved' });
  expect(state.state).toBe('streaming');
  state = runReducer(state, {
    type: 'event',
    event: {
      type: 'run.completed',
      usage: { promptTokens: 1, completionTokens: 1 },
      iterations: 1,
    },
  });
  expect(state.state).toBe('completed');
});

it('cancels and reports a lost connection without approving', () => {
  const state = runReducer(runReducer(initialRun, { type: 'send' }), { type: 'cancel' });
  expect(state.state).toBe('cancelled');
  expect(runReducer(initialRun, { type: 'connection_lost' }).state).toBe('error');
});

it('archives only turns that had a message and announces only coarse run states', () => {
  const run = runReducer(runReducer(initialRun, { type: 'send' }), {
    type: 'event',
    event: started,
  });
  expect(archiveTurn([], '', run)).toEqual([]);
  expect(archiveTurn([], 'hello', run)).toEqual([{ userMessage: 'hello', run }]);
  expect(runAnnouncement('streaming')).toBe('Assistant is responding');
  expect(runAnnouncement('awaiting_approval')).toBe('Approval required');
  expect(runAnnouncement('completed')).toBe('Run completed');
  expect(runAnnouncement('error')).toBe('Run failed');
  expect(runAnnouncement('idle')).toBe('');
});
