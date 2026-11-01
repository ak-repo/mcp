import { expect, it } from 'vitest';
import { createConfirmationGate, CONFIRMATION_TTL_MS } from './confirmation.js';
const secret = 'test-confirmation-secret-32-characters';
it('canonicalizes nested objects, preserves arrays and excludes controls', () => {
  const gate = createConfirmationGate({ secret, now: () => 1000 });
  const token = gate.issue(
    'cancel',
    { order: 'one', nested: { b: 2, a: 1 }, idempotency_key: 'x' },
    { b: [1, 2], a: 3 },
  );
  const claims = gate.authenticate(token.confirmation_token);
  gate.assertArguments(claims, 'cancel', {
    nested: { a: 1, b: 2 },
    order: 'one',
    action: 'execute',
    confirmation_token: token.confirmation_token,
    idempotency_key: 'y',
  });
  gate.assertCurrent(claims, { a: 3, b: [1, 2] });
  expect(() => gate.assertCurrent(claims, { a: 3, b: [2, 1] })).toThrow(/current preview/);
});
it('supports a shared secret across runtimes, rejects a random process secret and changed tool/args', () => {
  const first = createConfirmationGate({ secret, now: () => 1000 });
  const second = createConfirmationGate({ secret, now: () => 1000 });
  const token = first.issue('cancel', { order: 'one' }, {}).confirmation_token;
  const claims = second.authenticate(token);
  second.assertArguments(claims, 'cancel', { order: 'one' });
  expect(() => createConfirmationGate().authenticate(token)).toThrow(/CONFIRMATION|token/);
  expect(() => second.assertArguments(claims, 'refund', { order: 'one' })).toThrow();
  expect(() => second.assertArguments(claims, 'cancel', { order: 'two' })).toThrow();
});
it('expires exactly at five minutes, while authenticating expired tokens for replay', () => {
  let time = 1000;
  const gate = createConfirmationGate({ secret, now: () => time });
  const token = gate.issue('cancel', {}, {}).confirmation_token;
  time += CONFIRMATION_TTL_MS - 1;
  gate.assertCurrent(gate.authenticate(token), {});
  time++;
  expect(() => gate.assertCurrent(gate.authenticate(token), {})).toThrow();
  expect(gate.authenticate(token)).toBeDefined();
});
it.each(['', '.', 'a.b', 'x'.repeat(2049), 'eyJ2IjoxfQ.' + 'A'.repeat(43)])(
  'rejects malformed tokens safely',
  (token) => {
    expect(() => createConfirmationGate({ secret }).authenticate(token)).toThrow(/token/);
  },
);
it('rejects a weak secret override', () => {
  expect(() => createConfirmationGate({ secret: 'short' })).toThrow(/secret/);
});
