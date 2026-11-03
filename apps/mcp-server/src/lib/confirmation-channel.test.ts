import { expect, it, vi } from 'vitest';
import { createConfirmationSigner } from '@foodops/core';
import { createConfirmationGate, writeFlow } from './confirmation.js';
it('rejects a REST token in the MCP write flow even with the same key and arguments', () => {
  const secret = 'shared-cross-channel-secret-32-characters';
  const args = { order_id: 'O-1', reason: 'test' };
  const preview = { order_id: 'O-1', to_status: 'cancelled' };
  const token = createConfirmationSigner({ secret }).sign({
    channel: 'rest',
    operation: 'cancel_order',
    args,
    preview,
  });
  const execute = vi.fn();
  expect(() =>
    writeFlow({
      tool: 'cancel_order',
      input: { ...args, confirmation_token: token.confirmation_token },
      confirmation: createConfirmationGate({ secret }),
      preview: () => preview,
      replay: () => undefined,
      execute,
    }),
  ).toThrow(/token/);
  expect(execute).not.toHaveBeenCalled();
});
