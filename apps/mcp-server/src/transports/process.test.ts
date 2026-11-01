import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { seedFixture, HEADERS, INITIALIZE, TOKEN } from './test-helpers.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
let fixture: ReturnType<typeof seedFixture>;
const children = new Set<ChildProcessWithoutNullStreams>();
beforeEach(() => {
  fixture = seedFixture();
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  children.clear();
  fixture.close();
});
function launch(entry: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    entry === 'pnpm:dev' ? 'pnpm' : process.execPath,
    entry === 'pnpm:dev' ? ['--silent', 'dev:mcp'] : [join(packageRoot, 'dist', entry)],
    {
      cwd:
        entry === 'pnpm:dev'
          ? fileURLToPath(new URL('../../../..', import.meta.url))
          : fixture.directory,
      env: {
        ...process.env,
        DB_PATH: fixture.config.DB_PATH,
        LOG_LEVEL: 'info',
        MCP_AUTH_TOKEN: TOKEN,
        ...extra,
      },
      stdio: 'pipe',
    },
  );
  children.add(child);
  let stdout = '';
  let stderr = '';
  const responses = new Map<number, unknown>();
  const waiters = new Map<number, (value: unknown) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    let position: number;
    while ((position = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, position);
      buffer = buffer.slice(position + 1);
      const value = JSONRPCMessageSchema.parse(JSON.parse(line));
      if ('id' in value && typeof value.id === 'number') {
        responses.set(value.id, value);
        waiters.get(value.id)?.(value);
        waiters.delete(value.id);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    async request(value: { id: number; [key: string]: unknown }): Promise<unknown> {
      const response = new Promise<unknown>((resolve) => {
        waiters.set(value.id, resolve);
      });
      child.stdin.write(`${JSON.stringify(value)}\n`);
      if (responses.has(value.id)) return responses.get(value.id);
      return response;
    },
  };
}
it.each(['transports/stdio.js', 'index.js', 'pnpm:dev'])(
  'initializes %s and emits only valid JSON-RPC stdout lines',
  async (entry) => {
    const process = launch(entry);
    expect(await process.request(INITIALIZE)).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'foodops-mcp' } },
    });
    process.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    expect(
      await process.request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: { run_id: 'stdio-test-run' } },
      }),
    ).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: 'cancel_order' })]),
      },
    });
    process.child.stdin.end();
    expect((await process.exited)[0]).toBe(0);
    const lines = process.stdout().split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines)
      expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success).toBe(true);
    const logs = process
      .stderr()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'Stdio MCP server ready' }));
    expect(logs).toContainEqual(
      expect.objectContaining({
        run_id: 'stdio-test-run',
        request_id: expect.any(String),
        method: 'tools/list',
      }),
    );
    expect(process.stderr()).not.toContain(TOKEN);
  },
);
it.each(['SIGINT', 'SIGTERM'] as const)(
  'exits cleanly on %s after a stdio response',
  async (signal) => {
    const process = launch('transports/stdio.js');
    await process.request(INITIALIZE);
    process.child.kill(signal);
    expect(await process.exited).toEqual([0, null]);
    expect(process.stderr()).toContain('Stdio shutdown completed');
  },
);
it('fails missing-database startup without creating a file or writing stdout', async () => {
  const path = join(fixture.directory, 'missing.sqlite');
  const process = launch('transports/stdio.js', { DB_PATH: path });
  expect((await process.exited)[0]).toBe(1);
  expect(process.stdout()).toBe('');
  expect(existsSync(path)).toBe(false);
  expect(process.stderr()).toContain('MCP startup failed');
});
it('imports the package without starting a transport', async () => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(join(packageRoot, 'dist/index.js'))})`,
    ],
    { stdio: 'pipe' },
  );
  children.add(child);
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  expect((await once(child, 'exit'))[0]).toBe(0);
  expect(stdout).toBe('');
});
it('starts authenticated HTTP, correlates tool logs, and shuts down on SIGTERM', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const process = launch('transports/http.js', { PORT: String(address.port) });
  const ready = new Promise<void>((resolve) => {
    const onData = () => {
      if (process.stderr().includes('HTTP MCP server ready')) {
        process.child.stderr.off('data', onData);
        resolve();
      }
    };
    process.child.stderr.on('data', onData);
  });
  await ready;
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, 'X-Run-Id': 'http-test-run' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_orders', arguments: { limit: 1 } },
    }),
  });
  expect(response.status).toBe(200);
  await response.json();
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toBeTruthy();
  process.child.kill('SIGTERM');
  expect(await process.exited).toEqual([0, null]);
  expect(process.stdout()).toBe('');
  const logs = process
    .stderr()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(logs).toContainEqual(
    expect.objectContaining({
      request_id: requestId,
      run_id: 'http-test-run',
      tool: 'list_orders',
      msg: 'Tool call completed',
    }),
  );
  expect(process.stderr()).not.toContain(TOKEN);
});
it('fails HTTP startup when no token is configured', async () => {
  const process = launch('transports/http.js', { MCP_AUTH_TOKEN: '' });
  expect((await process.exited)[0]).toBe(1);
  expect(process.stdout()).toBe('');
  expect(process.stderr()).toContain('MCP_AUTH_TOKEN');
});
