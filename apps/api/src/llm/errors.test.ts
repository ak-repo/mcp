import { describe, expect, it } from 'vitest';
import { httpError, LLMError, redact } from './errors.js';
describe('LLM errors', () => {
  it.each([
    [401, '', 'auth', false],
    [403, '', 'auth', false],
    [404, '', 'model_not_found', false],
    [429, '', 'rate_limit', true],
    [400, 'context length exceeded', 'context_overflow', false],
    [400, 'too many tokens', 'context_overflow', false],
    [400, 'invalid request', 'bad_request', false],
    [500, '', 'provider_error', true],
    [502, '', 'provider_error', true],
  ])('maps status %s', (status, body, kind, retryable) => {
    expect(httpError(status as number, body as string, 1000)).toMatchObject({
      kind,
      retryable,
      status,
    });
  });
  it('redacts exact secrets and Authorization values', () => {
    expect(redact('key abcXYZ Bearer something Authorization: Basic abc', ['abcXYZ'])).toBe(
      'key [REDACTED] Bearer [REDACTED] Authorization: [REDACTED]',
    );
    expect(redact('ab abcd', ['ab', 'abcd'])).toBe('[REDACTED] [REDACTED]');
    expect(new LLMError('auth', 'Authorization: Bearer private', false).message).not.toContain(
      'private',
    );
    expect(httpError(500, 'my-secret')).not.toHaveProperty('cause');
    expect(httpError(500, 'my-secret').message).not.toContain('my-secret');
  });
});

it('redacts Anthropic and manager credential fields', () => {
  expect(redact('x-api-key: private api_key=private')).not.toContain('private');
});
