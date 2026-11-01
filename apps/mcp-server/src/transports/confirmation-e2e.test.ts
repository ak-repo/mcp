import { expect, it } from 'vitest';
import { verifyConfirmation } from './confirmation-e2e.js';
it('verifies assigned-partner cancellation and every token rejection over real stdio', async () => {
  const output: string[] = [];
  await verifyConfirmation((message) => output.push(message));
  expect(output).toHaveLength(6);
  expect(output[0]).toMatch(/busy -> available/);
  for (const label of ['missing token', 'tampered token', 'expired token', 'state changed'])
    expect(output).toContain(`${label}: CONFIRMATION_REQUIRED; no cancellation`);
});
