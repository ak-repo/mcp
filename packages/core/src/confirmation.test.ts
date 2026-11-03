import { expect, it } from 'vitest';
import { createConfirmationSigner, CONFIRMATION_TTL_MS } from './confirmation.js';
const secret = 'shared-confirmation-test-secret-32-characters';
it('separates channels with the same key and otherwise identical context', () => {
  const signer = createConfirmationSigner({ secret, now: () => 1000 });
  const context = {
    channel: 'rest' as const,
    operation: 'cancel',
    args: { b: 2, a: 1 },
    preview: { b: [1, 2], a: 1 },
  };
  const token = signer.sign(context).confirmation_token;
  expect(signer.verify(token, { ...context, args: { a: 1, b: 2 } })).toBeDefined();
  expect(() => signer.verify(token, { ...context, channel: 'mcp' })).toThrow();
  const mcp = signer.sign({ ...context, channel: 'mcp' }).confirmation_token;
  expect(() => signer.verify(mcp, context)).toThrow();
  expect(() => signer.verify(token, { ...context, preview: {} })).toThrow(/preview changed/);
});
it('expires at the boundary, while allowing authentication for existing MCP replay', () => {
  let now = 1000;
  const signer = createConfirmationSigner({ secret, now: () => now });
  const context = { channel: 'rest' as const, operation: 'cancel', args: {}, preview: {} };
  const token = signer.sign(context).confirmation_token;
  now += CONFIRMATION_TTL_MS;
  expect(() => signer.verify(token, context)).toThrow();
  expect(signer.authenticate(token, 'rest')).toBeDefined();
  expect(() => createConfirmationSigner().authenticate(token, 'rest')).toThrow();
});
