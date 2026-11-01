import { createHash } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { openReadOnly } from '@foodops/core/db/connection';
import { startHttp, MAX_BODY_BYTES, type HttpApplication } from './http.js';
import { openRuntime, type Runtime } from './runtime.js';
import { seedFixture, HEADERS, INITIALIZE, TOKEN } from './test-helpers.js';

let fixture: ReturnType<typeof seedFixture>;
let app: HttpApplication;
let runtime: Runtime;
const clients: Client[] = [];
beforeEach(async () => {
  fixture = seedFixture();
  runtime = openRuntime(fixture.config);
  app = await startHttp({ config: fixture.config, runtime, port: 0, signals: false });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  await app?.shutdown().catch(() => {});
  fixture?.close();
});
async function rpc(method: string, params?: unknown, id = 1) {
  return fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}
async function client(): Promise<Client> {
  const value = new Client({ name: 'foodops-http-test', version: '1.0.0' });
  clients.push(value);
  await value.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  return value;
}
it('requires a bearer token and accepts a valid initialized request without session headers', async () => {
  for (const authorization of [undefined, 'Bearer wrong', 'Basic abc', 'Bearer']) {
    const result = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: authorization ?? '' },
      body: JSON.stringify(INITIALIZE),
    });
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('Bearer');
  }
  const result = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(INITIALIZE),
  });
  expect(result.status).toBe(200);
  expect(result.headers.has('mcp-session-id')).toBe(false);
  expect(await result.json()).toMatchObject({
    id: 1,
    result: { serverInfo: { name: 'foodops-mcp' } },
  });
  expect((await rpc('tools/list')).status).toBe(200);
});
it('rejects duplicate Authorization headers', async () => {
  const response = await new Promise<number>((resolve, reject) => {
    const req = nodeRequest(
      `${app.url}/mcp`,
      {
        method: 'POST',
        headers: { ...HEADERS, Authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(INITIALIZE));
  });
  expect(response).toBe(401);
});
it('checks the database without authentication and sanitizes health failures', async () => {
  const result = await fetch(`${app.url}/healthz`);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ status: 'ok' });
  vi.spyOn(runtime, 'checkHealth').mockImplementation(() => {
    throw new Error('SECRET DB PATH');
  });
  const failed = await fetch(`${app.url}/healthz`);
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ status: 'error' });
});
it('supports SDK clients and concurrent requests with overlapping JSON-RPC IDs', async () => {
  const connections = await Promise.all([client(), client(), client()]);
  const responses = await Promise.all(connections.map((connection) => connection.listTools()));
  expect(responses.every((result) => result.tools.length === 12)).toBe(true);
  const calls = await Promise.all(
    Array.from({ length: 8 }, () =>
      rpc('tools/call', { name: 'list_orders', arguments: { limit: 1 } }, 7),
    ),
  );
  for (const response of calls) {
    expect(response.status).toBe(200);
    expect(response.headers.has('mcp-session-id')).toBe(false);
    expect(await response.json()).toMatchObject({
      id: 7,
      result: { structuredContent: { data: { items: expect.any(Array) } } },
    });
  }
});
it.each(['GET', 'DELETE', 'PUT'])('rejects unsupported /mcp method %s', async (method) => {
  const result = await fetch(`${app.url}/mcp`, { method, headers: HEADERS });
  expect(result.status).toBe(405);
  expect(result.headers.get('allow')).toBe('POST');
});
it('validates origin, media type, malformed JSON, SDK envelopes, and protocol versions', async () => {
  const origin = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, Origin: 'https://attacker.example' },
    body: '{}',
  });
  expect(origin.status).toBe(403);
  const host = await new Promise<number>((resolve, reject) => {
    const req = nodeRequest(
      `${app.url}/healthz`,
      { headers: { Host: 'attacker.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(host).toBe(403);
  const media = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  expect(media.status).toBe(415);
  const malformed = await fetch(`${app.url}/mcp`, { method: 'POST', headers: HEADERS, body: '{' });
  expect(malformed.status).toBe(400);
  const invalid = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ invalid: true }),
  });
  expect(invalid.status).toBe(400);
  const version = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, 'MCP-Protocol-Version': 'invalid' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(version.status).toBe(400);
});
it('limits declared and chunked bodies to one MiB', async () => {
  const result = await fetch(`${app.url}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: 'x'.repeat(MAX_BODY_BYTES + 1),
  });
  expect(result.status).toBe(413);
  const status = await new Promise<number>((resolve, reject) => {
    const req = nodeRequest(`${app.url}/mcp`, { method: 'POST', headers: HEADERS }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    for (let n = 0; n < 17; n++) req.write(Buffer.alloc(65536, 'x'));
    req.end();
  });
  expect(status).toBe(413);
});
function businessHash(): string {
  const db = openReadOnly(fixture.config.DB_PATH);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('tool_call_log', 'schema_migrations') ORDER BY name",
      )
      .all() as { name: string }[];
    return createHash('sha256')
      .update(
        JSON.stringify(
          tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all()]),
        ),
      )
      .digest('hex');
  } finally {
    db.close();
  }
}
it('completes preview, confirm, replay and persists events and audited calls', async () => {
  const connection = await client();
  const id = runtime.services.order.listOrders({ status: 'placed' }).items[0]!.id;
  const args = { order_id: id, to_status: 'accepted', idempotency_key: 'http-approved-transition' };
  const before = runtime.services.order.getOrder(id);
  const hash = businessHash();
  const preview = CallToolResultSchema.parse(
    await connection.callTool({ name: 'advance_order_status', arguments: args }),
  );
  expect(preview.structuredContent).toMatchObject({ data: { confirm_required: true } });
  expect(runtime.services.order.getOrder(id)).toEqual(before);
  expect(businessHash()).toBe(hash);
  const confirmed = CallToolResultSchema.parse(
    await connection.callTool({
      name: 'advance_order_status',
      arguments: { ...args, confirm: true },
    }),
  );
  const replay = CallToolResultSchema.parse(
    await connection.callTool({
      name: 'advance_order_status',
      arguments: { ...args, confirm: true },
    }),
  );
  expect(confirmed.isError).not.toBe(true);
  expect(replay.structuredContent).toEqual(confirmed.structuredContent);
  const db = openReadOnly(fixture.config.DB_PATH);
  try {
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM order_events WHERE order_id=? AND to_status='accepted' AND actor='ai'",
        )
        .get(id),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM tool_call_log WHERE tool='advance_order_status' AND status='success' AND actor='ai'",
        )
        .get(),
    ).toEqual({ n: 3 });
    expect(
      db
        .prepare('SELECT count(*) AS n FROM idempotency_keys WHERE key=?')
        .get(args.idempotency_key),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
it('drains a controlled in-flight call before closing the database and shuts down once', async () => {
  const result = runtime.services.order.getOrder('O-EDGE-PARTIAL-REFUND');
  let release!: (value: typeof result) => void;
  const gate = new Promise<typeof result>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(runtime.services.order, 'getOrder').mockImplementation(() => {
    entered();
    return gate as unknown as typeof result;
  });
  const close = vi.spyOn(runtime, 'close');
  const response = rpc('tools/call', {
    name: 'get_order',
    arguments: { order_id: 'O-EDGE-PARTIAL-REFUND' },
  });
  await started;
  const shutdown = app.shutdown();
  expect(app.shutdown()).toBe(shutdown);
  expect(close).not.toHaveBeenCalled();
  release(result);
  expect((await response).status).toBe(200);
  await shutdown;
  expect(close).toHaveBeenCalledOnce();
  expect(() => runtime.checkHealth()).toThrow();
});
it('rejects missing HTTP credentials before opening a runtime', async () => {
  const { MCP_AUTH_TOKEN: _token, ...config } = fixture.config;
  expect(_token).toBe(TOKEN);
  await expect(startHttp({ config, signals: false })).rejects.toThrow('MCP_AUTH_TOKEN');
});

it('forces overdue connections closed and closes the database on drain timeout', async () => {
  await app.shutdown();
  runtime = openRuntime(fixture.config);
  app = await startHttp({ config: fixture.config, runtime, port: 0, signals: false, drainMs: 20 });
  const result = runtime.services.order.getOrder('O-EDGE-PARTIAL-REFUND');
  let release!: (value: typeof result) => void;
  const gate = new Promise<typeof result>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(runtime.services.order, 'getOrder').mockImplementation(() => {
    entered();
    return gate as unknown as typeof result;
  });
  const response = rpc('tools/call', {
    name: 'get_order',
    arguments: { order_id: 'O-EDGE-PARTIAL-REFUND' },
  }).catch(() => null);
  await started;
  await expect(app.shutdown()).rejects.toThrow('drain timed out');
  await response;
  release(result);
  expect(() => runtime.checkHealth()).toThrow();
});
