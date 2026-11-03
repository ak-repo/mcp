import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { request, type ClientRequest } from 'node:http';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startApi, type ApiApplication } from '../index.js';
import { AUTH, fixture, type Fixture } from './helpers.js';
let f: Fixture | undefined;
let application: ApiApplication | undefined;
const children: ChildProcessWithoutNullStreams[] = [];
const requests: ClientRequest[] = [];
afterEach(async () => {
  for (const req of requests.splice(0)) req.destroy();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  await application?.shutdown().catch(() => {});
  application = undefined;
  await f?.close();
  f = undefined;
});
async function childServer(mode = 'normal') {
  f = fixture();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../dist/tests/test-server.js', import.meta.url)), mode],
    {
      env: {
        ...process.env,
        DB_PATH: f.dbPath,
        ADMIN_TOKEN: f.config.ADMIN_TOKEN,
        LOG_LEVEL: 'silent',
        SIMULATOR: 'off',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('API startup timeout: ' + output));
    }, 5000);
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`API exited before ready: ${code}: ${output}`));
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        try {
          const value: unknown = JSON.parse(line);
          if (
            value &&
            typeof value === 'object' &&
            'api_test_url' in value &&
            typeof value.api_test_url === 'string'
          ) {
            cleanup();
            resolve(value.api_test_url);
            return;
          }
        } catch {
          /* Wait for a complete JSON log line. */
        }
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.stdout.off('data', onData);
    }
    child.once('exit', onExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
  });
  return { child, url };
}
function partialRequest(
  url: string,
  id: string,
): { req: ClientRequest; response: Promise<number> } {
  let req: ClientRequest;
  const response = new Promise<number>((resolve, reject) => {
    req = request(
      new URL('/api/health', url),
      {
        method: 'POST',
        headers: {
          ...AUTH,
          'x-request-id': id,
          'content-type': 'application/json',
          'content-length': 2,
        },
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.once('error', reject);
    req.write('{');
    requests.push(req);
  });
  return { req: requests[requests.length - 1]!, response };
}
describe('HTTP lifecycle', () => {
  it('compiled CLI fails fast without exposing a rejected secret', async () => {
    f = fixture();
    const secret = 'short-secret';
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../../dist/index.js', import.meta.url))],
      {
        env: { ...process.env, DB_PATH: f.dbPath, ADMIN_TOKEN: secret, SIMULATOR: 'off' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect(await once(child, 'exit')).toEqual([1, null]);
    expect(output).toContain('Invalid API configuration: ADMIN_TOKEN');
    expect(output).not.toContain(secret);
  });
  it('compiled library imports without opening a listener or database', async () => {
    const url = new URL('../../dist/index.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
      {
        env: { ...process.env, ADMIN_TOKEN: '', DB_PATH: '/does/not/exist.sqlite' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    expect(await once(child, 'exit')).toEqual([0, null]);
    expect(output).toBe('');
  });

  it('starts on a non-loopback bind, rejects raw duplicate auth, and shuts down once', async () => {
    f = fixture({ API_HOST: '0.0.0.0' });
    const close = vi.spyOn(f.runtime, 'shutdown');
    application = await startApi({ config: f.config, runtime: f.runtime, port: 0, signals: false });
    expect(application.app.server.address()).toMatchObject({ address: '0.0.0.0' });
    const address = application.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    const result = new Promise<string>((resolve, reject) => {
      let response = '';
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString();
      });
      socket.once('end', () => resolve(response));
      socket.once('error', reject);
    });
    socket.end(
      `GET /absent HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${AUTH.authorization}\r\nAuthorization: ${AUTH.authorization}\r\nConnection: close\r\n\r\n`,
    );
    expect(await result).toContain('401 Unauthorized');
    const first = application.shutdown();
    expect(application.shutdown()).toBe(first);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => f?.runtime.checkReady()).toThrow();
  });
  it('closes runtime on listener failure', async () => {
    f = fixture();
    const occupied = await startApi({ config: f.config, port: 0, signals: false });
    application = occupied;
    const address = occupied.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const close = vi.spyOn(f.runtime, 'shutdown');
    await expect(
      startApi({ config: f.config, runtime: f.runtime, port: address.port, signals: false }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalled();
    expect(() => f?.runtime.checkReady()).toThrow();
  });
  it.each(['SIGINT', 'SIGTERM'] as const)('compiled server exits cleanly on %s', async (signal) => {
    const { child, url } = await childServer();
    expect((await fetch(`${url}/api/ready`)).status).toBe(200);
    const exited = once(child, 'exit');
    child.kill(signal);
    expect(await exited).toEqual([0, null]);
  });
  it('drains an in-flight body before closing the database', async () => {
    f = fixture();
    application = await startApi({ config: f.config, runtime: f.runtime, port: 0, signals: false });
    const pending = partialRequest(application.url, 'drain-request');
    await vi.waitFor(() => {
      expect(f?.logs.join('')).toContain('drain-request');
    });
    let completed = false;
    const closing = application.shutdown().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    expect(() => f?.runtime.checkReady()).not.toThrow();
    pending.req.end('}');
    expect(await pending.response).toBe(405);
    await closing;
    expect(() => f?.runtime.checkReady()).toThrow();
  });
  it('exits 1 when SIGTERM cannot drain a pending request', async () => {
    const { child, url } = await childServer('timeout');
    const pending = partialRequest(url, 'timeout-request');
    const rejected = pending.response.catch(() => 0);
    // Headers/body are flushed before signaling; readiness proves the child can accept requests.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    expect(await exited).toEqual([1, null]);
    await rejected;
  });
});
