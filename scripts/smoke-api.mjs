import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';
const { fetch, AbortController } = globalThis;
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createInterface } from 'node:readline';
import { openWritable, openReadOnly } from '../packages/core/dist/db/connection.js';
import { seedDatabase } from '../packages/core/dist/seed/seed.js';
import { createServices } from '../packages/core/dist/services/index.js';
const directory = await mkdtemp(join(tmpdir(), 'foodops-smoke-api-'));
const path = join(directory, 'smoke.sqlite');
const token = randomBytes(32).toString('hex');
let child;
let abort;
let stderr = '';
try {
  const write = openWritable(path);
  let order;
  try {
    seedDatabase(write);
    const read = openReadOnly(path);
    try {
      const services = createServices({ write, read });
      order = services.order
        .listOrders({ status: 'ready', limit: 50 })
        .items.find((row) => services.order.getOrder(row.id).delivery?.partner_id);
      assert.ok(order, 'Seed must contain an assigned cancellable order');
    } finally {
      read.close();
    }
  } finally {
    write.close();
  }
  child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { startApi, loadConfig } from './apps/api/dist/index.js';
    const api = await startApi({ config: loadConfig(), port: 0 });
    process.stdout.write(JSON.stringify({ready: api.url})+'\\n');
  `,
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: {
        ...process.env,
        DB_PATH: path,
        ADMIN_TOKEN: token,
        API_HOST: '127.0.0.1',
        WEB_ORIGIN: 'http://localhost:5173',
        LOG_LEVEL: 'silent',
        SIMULATOR: 'on',
        SIMULATOR_INTERVAL_MS: '1000',
        SIMULATOR_SEED: '42',
        CHANGE_FEED_POLL_MS: '100',
        RATE_LIMIT_PER_MIN: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API startup timed out')), 10000);
    const failed = (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited ${code}: ${stderr}`));
    };
    child.once('exit', failed);
    lines.on('line', (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready) {
          clearTimeout(timer);
          child.off('exit', failed);
          resolve(parsed.ready);
        }
      } catch {
        /* Startup log lines are not protocol data. */
      }
    });
  });
  const headers = { Authorization: `Bearer ${token}` };
  async function api(route, options = {}) {
    const response = await fetch(base + route, {
      ...options,
      headers: {
        ...headers,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
    return body;
  }
  assert.equal((await api('/api/simulator')).enabled, true);
  console.log('PASS simulator enabled on temporary seeded DB');
  const { ticket } = await api('/api/stream/ticket', { method: 'POST' });
  abort = new AbortController();
  const stream = await fetch(`${base}/api/stream?ticket=${encodeURIComponent(ticket)}`, {
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const events = [];
  let buffer = '';
  const readEvents = (async () => {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      buffer += new TextDecoder().decode(part.value);
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = /^data: (.*)$/m.exec(frame);
        if (data) events.push(JSON.parse(data[1]));
      }
    }
  })();
  // Attach rejection handling immediately; abort is expected during cleanup.
  void readEvents.catch(() => {});
  const reason = 'API smoke approved cancellation';
  const preview = await api(`/api/orders/${order.id}/cancel/preview`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  assert.equal(preview.to_status, 'cancelled');
  assert.equal(preview.partner_status_after, 'available');
  console.log(`PASS preview ${order.id}: partner ${preview.partner_id} -> available`);
  const result = await api(`/api/orders/${order.id}/cancel`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'smoke-api-cancel' },
    body: JSON.stringify({ reason, confirmation_token: preview.confirmation_token }),
  });
  assert.equal(result.order.status, 'cancelled');
  assert.equal(result.partner.status, 'available');
  console.log('PASS confirmed cancellation committed and partner released');
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    !['order.updated', 'delivery.updated', 'payment.updated'].every((type) =>
      events.some((event) => event.type === type && event.order_id === order.id),
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const type of ['order.updated', 'delivery.updated', 'payment.updated']) {
    assert.ok(
      events.some((event) => event.type === type && event.order_id === order.id),
      `Missing SSE ${type}`,
    );
  }
  for (const event of events.filter(
    (event) => event.order_id === order.id || event.entity === 'partner',
  ))
    console.log(`SSE ${JSON.stringify(event)}`);
  const replayResponse = await fetch(`${base}/api/orders/${order.id}/cancel`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'smoke-api-cancel',
    },
    body: JSON.stringify({ reason, confirmation_token: preview.confirmation_token }),
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(replayResponse.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await replayResponse.json(), result);
  console.log('PASS stored replay returned the same result with Idempotency-Replayed: true');
  const tickDeadline = Date.now() + 5000;
  let stats = await api('/api/simulator');
  while (stats.ticks === 0 && Date.now() < tickDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stats = await api('/api/simulator');
  }
  assert.ok(stats.ticks > 0, 'Simulator must tick');
  console.log(`PASS simulator ticked: ticks=${stats.ticks}, errors=${stats.errors}`);
  assert.equal(stats.errors, 0);
  abort.abort();
  await readEvents.catch(() => {});
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await Promise.race([
    exit,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Shutdown timed out')), 12000);
      timer.unref();
    }),
  ]);
  assert.equal(code, 0, `API shutdown: ${signal}: ${stderr}`);
  console.log('PASS SSE events verified; graceful shutdown completed');
} finally {
  abort?.abort();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }
  await rm(directory, { recursive: true, force: true });
}
