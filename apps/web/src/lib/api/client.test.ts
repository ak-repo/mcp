import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, ReadyResponseSchema } from '@foodops/shared';
import { createApiClient } from './client.js';
import { createAuthStore } from './auth-store.js';
import {
  ApiError,
  ContractError,
  NetworkError,
  TimeoutError,
  queryRetry,
  retryAfter,
} from './errors.js';

const origin = 'http://api.test';
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, ...(headers ? { headers } : {}) });
const envelope = {
  error: { code: 'UNAUTHORIZED', message: 'Invalid credentials', hint: 'Sign in again' },
};
function fixture() {
  const auth = createAuthStore();
  auth.login('private-test-credential');
  const fetcher = vi.fn<typeof fetch>();
  const client = createApiClient({ origin, auth, fetch: fetcher });
  return { auth, fetcher, ...client };
}
afterEach(() => vi.useRealTimers());

describe('apiFetch', () => {
  it('validates success, sends bearer only to the API origin and omits cookies/redirects', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(json({ status: 'ready' }));
    expect(await apiFetch('/api/ready', ReadyResponseSchema)).toEqual({ status: 'ready' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/ready');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-test-credential');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    await expect(apiFetch('http://other.test/api/me', ReadyResponseSchema)).rejects.toThrow(
      'Invalid API path',
    );
    await expect(apiFetch('//other.test/api/me', ReadyResponseSchema)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('permits public requests without bearer injection', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(json({ status: 'ready' }));
    await apiFetch('/api/ready', ReadyResponseSchema, { auth: false });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false);
  });
  it('exposes a validated API error and request ID', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(
      json({ error: { code: 'CONFLICT', message: 'State changed', hint: 'Refresh' } }, 409, {
        'X-Request-Id': 'request-1',
      }),
    );
    await expect(apiFetch('/api/orders', ReadyResponseSchema)).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'State changed',
      hint: 'Refresh',
      requestId: 'request-1',
    });
  });
  it('clears auth on 401, even with a malformed error envelope', async () => {
    const { fetcher, apiFetch, auth } = fixture();
    fetcher.mockResolvedValue(json(envelope, 401));
    await expect(apiFetch('/api/me', ReadyResponseSchema)).rejects.toBeInstanceOf(ApiError);
    expect(auth.getToken()).toBeNull();
    auth.login('new-session');
    fetcher.mockResolvedValue(new Response('invalid', { status: 401 }));
    await expect(apiFetch('/api/me', ReadyResponseSchema)).rejects.toBeInstanceOf(ContractError);
    expect(auth.getToken()).toBeNull();
  });
  it('does not expire a newer session for a stale 401', async () => {
    const { fetcher, apiFetch, auth } = fixture();
    let resolve!: (response: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = apiFetch('/api/me', ReadyResponseSchema);
    auth.login('replacement');
    resolve(json(envelope, 401));
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(auth.getToken()).toBe('replacement');
  });
  it('handles 429 and numeric Retry-After without retrying', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(
      json({ error: { code: 'LIMIT_EXCEEDED', message: 'Wait', hint: 'Retry later' } }, 429, {
        'Retry-After': '12',
      }),
    );
    await expect(apiFetch('/api/me', ReadyResponseSchema)).rejects.toMatchObject({
      retryAfterMs: 12000,
      status: 429,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{ status: 'wrong' }, { status: 'ready', extra: true }])(
    'rejects schema mismatch %j',
    async (body) => {
      const { fetcher, apiFetch } = fixture();
      fetcher.mockResolvedValue(json(body));
      await expect(apiFetch('/api/ready', ReadyResponseSchema)).rejects.toBeInstanceOf(
        ContractError,
      );
    },
  );
  it('rejects invalid JSON and malformed error bodies safely', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(new Response('not-json'));
    await expect(apiFetch('/api/ready', ReadyResponseSchema)).rejects.toThrow(
      'unexpected response',
    );
    fetcher.mockResolvedValue(json({ secret: 'private-data' }, 500));
    await expect(apiFetch('/api/ready', ReadyResponseSchema)).rejects.toThrow(
      'unexpected response',
    );
  });
  it('sends JSON and the caller idempotency key exactly once for writes', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(json({ status: 'ready' }));
    await apiFetch('/api/example', ReadyResponseSchema, {
      method: 'POST',
      body: { reason: 'operator' },
      idempotencyKey: 'same-key-123',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"reason":"operator"}');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('same-key-123');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });
  it('never retries a failed write or exposes a raw network message', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockRejectedValue(new Error('private-test-credential'));
    await expect(apiFetch('/api/example', ReadyResponseSchema, { method: 'POST' })).rejects.toThrow(
      'could not be reached',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('redacts credentials reflected in an API error or request ID', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockResolvedValue(
      json(
        {
          error: {
            code: 'INTERNAL',
            message: 'private-test-credential',
            hint: 'private-test-credential',
          },
        },
        500,
        { 'X-Request-Id': 'private-test-credential' },
      ),
    );
    await expect(apiFetch('/api/me', ReadyResponseSchema)).rejects.toMatchObject({
      message: '[REDACTED]',
      hint: '[REDACTED]',
      requestId: '[REDACTED]',
    });
  });
  it('times out and releases its timer', async () => {
    vi.useFakeTimers();
    const { fetcher, apiFetch } = fixture();
    fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        }),
    );
    const pending = apiFetch('/api/ready', ReadyResponseSchema, { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('distinguishes caller abort and never starts an already-aborted request', async () => {
    const { fetcher, apiFetch } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiFetch('/api/ready', ReadyResponseSchema, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels an in-flight request through its caller signal', async () => {
    const { fetcher, apiFetch } = fixture();
    fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        }),
    );
    const controller = new AbortController();
    const pending = apiFetch('/api/ready', ReadyResponseSchema, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });
  it('rejects invalid configured origins', () => {
    for (const origin of [
      'ftp://api.test',
      'https://user:pass@api.test',
      'https://api.test/prefix',
      'https://api.test/?x=1',
    ])
      expect(() => createApiClient({ origin })).toThrow('Invalid API origin');
  });
});

describe('stream transport', () => {
  it('sends the resume header and ticket without bearer auth', async () => {
    const { fetcher, openStream } = fixture();
    fetcher.mockResolvedValue(
      new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    await openStream('ticket-only', 42, new AbortController().signal);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/api/stream?ticket=ticket-only');
    expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('42');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });
  it('does not log out for an expired single-use stream ticket', async () => {
    const { fetcher, openStream, auth } = fixture();
    fetcher.mockResolvedValue(json(envelope, 401));
    await expect(
      openStream('expired', undefined, new AbortController().signal),
    ).rejects.toMatchObject({ status: 401 });
    expect(auth.getSnapshot().authenticated).toBe(true);
  });
  it('requires an event-stream response', async () => {
    const { fetcher, openStream } = fixture();
    fetcher.mockResolvedValue(json({ status: 'ready' }));
    await expect(
      openStream('ticket', undefined, new AbortController().signal),
    ).rejects.toBeInstanceOf(ContractError);
  });
});

it('parses Retry-After dates and restricts query retries to two network/5xx retries', () => {
  expect(retryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 5000)).toBe(5000);
  expect(retryAfter('invalid')).toBeNull();
  expect(retryAfter(null)).toBeNull();
  expect(queryRetry(0, new NetworkError())).toBe(true);
  expect(queryRetry(1, new NetworkError())).toBe(true);
  expect(queryRetry(2, new NetworkError())).toBe(false);
  expect(queryRetry(0, new ApiError(503, ErrorCode.INTERNAL, '', '', null, null))).toBe(true);
  expect(queryRetry(0, new ApiError(429, ErrorCode.LIMIT_EXCEEDED, '', '', null, 1000))).toBe(
    false,
  );
  expect(queryRetry(0, new ContractError())).toBe(false);
  expect(queryRetry(0, new TimeoutError())).toBe(false);
});
