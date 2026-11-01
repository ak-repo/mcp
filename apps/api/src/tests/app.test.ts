import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ErrorCode } from '@foodops/shared';
import { validate } from '../lib/validate.js';
import { OrderStatusSchema } from '@foodops/shared';
import { AUTH, TOKEN, fixture, type Fixture } from './helpers.js';
let f: Fixture;
beforeEach(() => {
  f = fixture();
  f.app.register(async (app) => {
    app.get('/private', async (request) => {
      request.log.info({ authorization: TOKEN }, 'Private');
      return { ok: true };
    });
    app.post('/body', async (request) => ({ body: request.body }));
    app.post(
      '/validation',
      {
        schema: {
          body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        },
      },
      async () => ({ ok: true }),
    );
    app.get('/zod', async () => validate(OrderStatusSchema, 'wrong'));
    app.get<{ Params: { code: string } }>('/error/:code', async (request) => {
      if (request.params.code === 'unknown') throw new Error('SELECT secret FROM credentials');
      throw new AppError(request.params.code as ErrorCode, 'Safe domain message', 'Domain hint');
    });
    app.post('/write', { preHandler: app.writeRateLimit }, async () => ({ ok: true }));
  });
});
afterEach(async () => {
  await f.close();
});
function expectError(
  response: Awaited<ReturnType<Fixture['app']['inject']>>,
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({
    error: { code, message: expect.any(String), hint: expect.any(String) },
  });
  expect(response.headers['x-request-id']).toBeTruthy();
}
describe('authentication and probes', () => {
  it.each([undefined, 'Bearer wrong', 'Basic token', `Bearer ${TOKEN} extra`])(
    'rejects invalid authorization %s',
    async (authorization) => {
      expectError(
        await f.app.inject({
          url: '/private',
          headers: authorization === undefined ? {} : { authorization },
        }),
        401,
        'UNAUTHORIZED',
      );
    },
  );
  it('rejects duplicate Authorization fields and accepts a single valid bearer', async () => {
    const headers: Record<string, string | string[]> = {
      authorization: [AUTH.authorization, AUTH.authorization],
    };
    expectError(await f.app.inject({ url: '/private', headers }), 401, 'UNAUTHORIZED');
    expect((await f.app.inject({ url: '/private', headers: AUTH })).json()).toEqual({ ok: true });
  });
  it('checks liveness without touching readiness or any service', async () => {
    const check = vi.spyOn(f.runtime, 'checkReady').mockImplementation(() => {
      throw new Error('database offline');
    });
    expect((await f.app.inject('/api/health')).json()).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();
    expectError(await f.app.inject('/api/ready'), 503, 'INTERNAL');
  });
  it('allows both public GET probes even with invalid credentials', async () => {
    for (const url of ['/api/health', '/api/ready']) {
      expect((await f.app.inject({ url, headers: { authorization: 'wrong' } })).statusCode).toBe(
        200,
      );
    }
  });
  it.each(['HEAD', 'POST'] as const)('protects %s on a probe', async (method) => {
    const response = await f.app.inject({ method, url: '/api/health' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeTruthy();
  });
  it('protects unknown paths and maps authenticated 404 and 405', async () => {
    expectError(await f.app.inject('/absent'), 401, 'UNAUTHORIZED');
    expectError(await f.app.inject({ url: '/absent', headers: AUTH }), 404, 'NOT_FOUND');
    const response = await f.app.inject({ method: 'POST', url: '/api/health', headers: AUTH });
    expectError(response, 405, 'VALIDATION');
    expect(response.headers.allow).toBe('GET');
  });
});
describe('error envelope', () => {
  it.each([
    [ErrorCode.VALIDATION, 400],
    [ErrorCode.NOT_FOUND, 404],
    [ErrorCode.INVALID_TRANSITION, 409],
    [ErrorCode.CONFLICT, 409],
    [ErrorCode.LIMIT_EXCEEDED, 422],
    [ErrorCode.CONFIRMATION_REQUIRED, 428],
    [ErrorCode.INTERNAL, 500],
    ['unknown', 500],
  ] as const)('maps %s', async (code, status) => {
    const response = await f.app.inject({ url: `/error/${code}`, headers: AUTH });
    expectError(response, status, code === 'unknown' ? 'INTERNAL' : code);
    if (status === 500) {
      expect(response.body).not.toMatch(/Safe domain|SELECT|stack|credentials/);
      expect(f.logs.some((line) => line.includes('Request failed'))).toBe(true);
    } else expect(response.json().error.hint).toBe('Domain hint');
  });
  it('sanitizes INTERNAL AppError messages and hints', async () => {
    f.app.get('/internal', async () => {
      throw new AppError(ErrorCode.INTERNAL, 'SQL secret', 'password secret');
    });
    const response = await f.app.inject({ url: '/internal', headers: AUTH });
    expectError(response, 500, 'INTERNAL');
    expect(response.body).not.toContain('secret');
    expect(f.logs.join('')).toContain('SQL secret');
  });
  it('maps malformed URL parse failures without reflecting the URL', async () => {
    const response = await f.app.inject({
      url: '/error/%ZZ',
      headers: { ...AUTH, 'x-request-id': 'bad-url' },
    });
    expectError(response, 400, 'VALIDATION');
    expect(response.headers['x-request-id']).toBe('bad-url');
    expect(response.body).not.toContain('%ZZ');
  });
  it('maps shared Zod and Fastify schema validation errors', async () => {
    expectError(await f.app.inject({ url: '/zod', headers: AUTH }), 400, 'VALIDATION');
    expectError(
      await f.app.inject({ method: 'POST', url: '/validation', headers: AUTH, payload: {} }),
      400,
      'VALIDATION',
    );
  });
  it('maps JSON parse, unsupported media type and body limits', async () => {
    expectError(
      await f.app.inject({
        method: 'POST',
        url: '/body',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{invalid',
      }),
      400,
      'VALIDATION',
    );
    expectError(
      await f.app.inject({
        method: 'POST',
        url: '/body',
        headers: { ...AUTH, 'content-type': 'application/xml' },
        payload: '<xml/>',
      }),
      415,
      'VALIDATION',
    );
    expectError(
      await f.app.inject({
        method: 'POST',
        url: '/body',
        headers: { ...AUTH, 'content-type': 'text/plain' },
        payload: 'x'.repeat(102401),
      }),
      413,
      'LIMIT_EXCEEDED',
    );
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/body',
          headers: { ...AUTH, 'content-type': 'text/plain' },
          payload: 'x'.repeat(102400),
        })
      ).statusCode,
    ).toBe(200);
  });
});
describe('request context and security', () => {
  it('propagates safe IDs, generates unsafe/missing/duplicate IDs, and isolates concurrent logs', async () => {
    const responses = await Promise.all(
      ['request-one', 'request-two'].map((id) =>
        f.app.inject({
          url: '/private',
          headers: { ...AUTH, 'x-request-id': id, 'x-run-id': `run-${id}` },
        }),
      ),
    );
    expect(responses.map((r) => r.headers['x-request-id'])).toEqual(['request-one', 'request-two']);
    for (const id of ['request-one', 'request-two']) {
      const records = f.logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record['request_id'] === id);
      expect(records.length).toBeGreaterThanOrEqual(3);
      expect(records.every((record) => record['run_id'] === `run-${id}`)).toBe(true);
    }
    for (const value of [undefined, 'bad id', 'a'.repeat(129), ['one', 'two']]) {
      const response = await f.app.inject({
        url: '/api/health',
        headers: value === undefined ? {} : { 'x-request-id': value },
      });
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(f.logs.join('')).not.toContain(TOKEN);
    expect(f.logs.join('')).toContain('[REDACTED]');
  });
  it('sets security headers on successes and errors', async () => {
    for (const url of ['/private', '/api/health']) {
      const response = await f.app.inject(url);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).not.toContain(
        'upgrade-insecure-requests',
      );
    }
  });
  it('allows configured origins, disallows credentials, and denies other origins', async () => {
    const response = await f.app.inject({
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expectError(
      await f.app.inject({ url: '/api/health', headers: { origin: 'https://evil.example' } }),
      403,
      'FORBIDDEN',
    );
  });
  it('allows valid unauthenticated preflight and maps invalid ones', async () => {
    const response = await f.app.inject({
      method: 'OPTIONS',
      url: '/private',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(response.statusCode).toBe(204);
    expectError(
      await f.app.inject({
        method: 'OPTIONS',
        url: '/private',
        headers: { origin: 'http://localhost:5173' },
      }),
      400,
      'VALIDATION',
    );
    expectError(
      await f.app.inject({
        method: 'OPTIONS',
        url: '/private',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      }),
      403,
      'FORBIDDEN',
    );
    expectError(
      await f.app.inject({
        method: 'OPTIONS',
        url: '/private',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'TRACE' },
      }),
      403,
      'FORBIDDEN',
    );
  });
});
describe('rate limits', () => {
  it('limits failed authentication and ignores spoofed forwarded IP', async () => {
    await f.close();
    f = fixture({ RATE_LIMIT_PER_MIN: 2 });
    for (const ip of ['1.1.1.1', '2.2.2.2'])
      expectError(
        await f.app.inject({ url: '/absent', headers: { 'x-forwarded-for': ip } }),
        401,
        'UNAUTHORIZED',
      );
    const response = await f.app.inject({
      url: '/absent',
      headers: { 'x-forwarded-for': '3.3.3.3' },
    });
    expectError(response, 429, 'LIMIT_EXCEEDED');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
  it('enforces a separate stricter write bucket alongside the global one', async () => {
    await f.close();
    f = fixture({ RATE_LIMIT_PER_MIN: 8 });
    f.app.register(async (app) => {
      app.post('/write', { preHandler: app.writeRateLimit }, async () => ({ ok: true }));
    });
    expect((await f.app.inject({ method: 'POST', url: '/write', headers: AUTH })).statusCode).toBe(
      200,
    );
    expect((await f.app.inject({ method: 'POST', url: '/write', headers: AUTH })).statusCode).toBe(
      200,
    );
    expectError(
      await f.app.inject({ method: 'POST', url: '/write', headers: AUTH }),
      429,
      'LIMIT_EXCEEDED',
    );
    expect((await f.app.inject('/api/health')).statusCode).toBe(200);
  });
});
