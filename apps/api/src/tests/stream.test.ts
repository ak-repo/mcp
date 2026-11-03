import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWritable } from '@foodops/core/db/connection';
import { fixture, AUTH, type Fixture } from './helpers.js';
let f: Fixture;
const controllers: AbortController[] = [];
beforeEach(() => {
  f = fixture({ CHANGE_FEED_POLL_MS: 100 });
});
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.abort());
  await f.close();
  vi.useRealTimers();
});
async function ticket() {
  const response = await f.app.inject({ method: 'POST', url: '/api/stream/ticket', headers: AUTH });
  expect(response.statusCode).toBe(200);
  return response.json<{ ticket: string }>().ticket;
}
async function connect(id?: number) {
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  return open(address, await ticket(), id);
}
async function open(address: string, key: string, id?: number) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${address}/api/stream?ticket=${key}`, {
    headers: id === undefined ? {} : { 'Last-Event-ID': String(id) },
    signal: controller.signal,
  });
  return { response, controller };
}
async function until(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeout = 2000,
) {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (!predicate(text)) {
          const part = await reader.read();
          if (part.done) throw new Error('stream closed early');
          text += new TextDecoder().decode(part.value);
        }
        return text;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE timeout: ${text}`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
it('requires a single-use ticket and never authorizes with an admin URL token', async () => {
  for (const url of [
    '/api/stream',
    '/api/stream?ADMIN_TOKEN=secret',
    '/api/stream?ticket=' + 'x'.repeat(43),
  ]) {
    const response = await f.app.inject({ url, headers: AUTH });
    expect([400, 401]).toContain(response.statusCode);
  }
  expect((await f.app.inject({ method: 'POST', url: '/api/stream/ticket' })).statusCode).toBe(401);
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const key = await ticket();
  const first = await open(address, key);
  expect(first.response.status).toBe(200);
  const again = await open(address, key);
  expect(again.response.status).toBe(401);
});
it('sees second-connection writes within two seconds and resumes without gaps or duplicates', async () => {
  const initial = f.runtime.services.audit.maxChangeId();
  const { response, controller } = await connect(initial);
  const reader = response.body!.getReader();
  await until(reader, (text) => text.includes(': connected'));
  const second = openWritable(f.dbPath);
  try {
    second
      .prepare("UPDATE orders SET notes='external MCP process' WHERE id='O-EDGE-UNASSIGNED'")
      .run();
    const text = await until(reader, (text) => text.includes('event: order.updated'));
    const id = Number(/id: (\d+)/.exec(text)?.[1]);
    expect(id).toBe(initial + 1);
    controller.abort();
    second.prepare("UPDATE orders SET notes='resume one' WHERE id='O-EDGE-UNASSIGNED'").run();
    second.prepare("UPDATE orders SET notes='resume two' WHERE id='O-EDGE-UNASSIGNED'").run();
    const addr = f.app.listeningOrigin;
    const resumed = await open(addr, await ticket(), id);
    const next = await until(resumed.response.body!.getReader(), (text) =>
      text.includes(`id: ${id + 2}\n`),
    );
    const ids = [...next.matchAll(/^id: (\d+)$/gm)].map((x) => Number(x[1]));
    expect(ids).toEqual([id + 1, id + 2]);
  } finally {
    second.close();
  }
});
it('enforces stream limits and closes active streams on shutdown', async () => {
  await f.close();
  f = fixture({ SSE_MAX_STREAMS: 1 });
  const first = await connect();
  const reader = first.response.body!.getReader();
  await until(reader, (text) => text.includes('connected'));
  const second = await open(f.app.listeningOrigin, await ticket());
  expect(second.response.status).toBe(429);
  await f.app.close();
  expect((await reader.read()).done).toBe(true);
});
it('rejects replay outside retention or beyond the cap', async () => {
  await f.close();
  f = fixture({ SSE_REPLAY_LIMIT: 1 });
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  expect((await open(address, await ticket(), 0)).response.status).toBe(409);
  expect(
    (await open(address, await ticket(), f.runtime.services.audit.maxChangeId() + 1)).response
      .status,
  ).toBe(409);
  f.runtime.services.audit.pruneChangesBefore('2099-01-01T00:00:00.000Z');
  expect((await open(address, await ticket(), 1)).response.status).toBe(409);
});
it('sends a heartbeat comment after 15 seconds', async () => {
  const { response } = await connect();
  const reader = response.body!.getReader();
  await until(reader, (text) => text.includes('connected'));
  // Only intervals are virtualized; HTTP and the poller's timeout remain real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  // Reopen after replacing interval scheduling.
  controllers.splice(0).forEach((c) => c.abort());
  const stream = await open(f.app.listeningOrigin, await ticket());
  const heartbeatReader = stream.response.body!.getReader();
  await until(heartbeatReader, (text) => text.includes('connected'));
  await vi.advanceTimersByTimeAsync(15000);
  expect(await until(heartbeatReader, (text) => text.includes(': heartbeat'))).toContain(
    ': heartbeat\n\n',
  );
});

it('preserves CORS and exposed headers after SSE hijack', async () => {
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const key = await ticket();
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${address}/api/stream?ticket=${key}`, {
    signal: controller.signal,
    headers: { Origin: 'http://localhost:5173' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  for (const header of [
    'Retry-After',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'Idempotency-Replayed',
    'X-Request-Id',
  ])
    expect(response.headers.get('access-control-expose-headers')).toContain(header);
  controller.abort();
});
