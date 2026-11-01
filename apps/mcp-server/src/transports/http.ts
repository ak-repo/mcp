import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { once } from 'node:events';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppError, ErrorCode } from '@foodops/shared';
import { createServer } from '../lib/create-server.js';
import { withLogContext } from '../lib/logger.js';
import { normalizeAuthority, defaultAllowedHosts, type Config } from '../lib/config.js';
import {
  correlation,
  drain,
  DRAIN_TIMEOUT_MS,
  installSignals,
  isMain,
  openRuntime,
  runCli,
  type Runtime,
} from './runtime.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const BODY_TIMEOUT_MS = 5000;
class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(status >= 400 ? { Connection: 'close' } : {}),
  });
  response.end(JSON.stringify(value));
}
function protocolError(response: ServerResponse, status: number, message: string): void {
  json(response, status, {
    jsonrpc: '2.0',
    id: null,
    error: { code: status === 400 ? -32700 : -32000, message },
  });
}
export function bearerValidator(token: string): (request: IncomingMessage) => boolean {
  const expected = createHash('sha256').update(token).digest();
  return (request) => {
    const headers = request.rawHeaders;
    let count = 0;
    for (let i = 0; i < headers.length; i += 2)
      if (headers[i]?.toLowerCase() === 'authorization') count++;
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    const supplied = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest();
    const equal = timingSafeEqual(expected, supplied);
    return equal && count === 1 && match !== null;
  };
}
function safeOrigin(request: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const host = normalizeAuthority(request.headers.host ?? '');
  if (host === null || !allowed.has(host)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    const authority = normalizeAuthority(
      `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`,
    );
    return authority !== null && allowed.has(authority);
  } catch {
    return false;
  }
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const fail = (error: BodyError) => {
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BodyError(413, 'Request body exceeds 1 MiB'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
        );
      } catch {
        reject(new BodyError(400, 'Invalid JSON request body'));
      }
    };
    const onAborted = () => fail(new BodyError(400, 'Request was aborted'));
    const onError = () => fail(new BodyError(400, 'Request body could not be read'));
    const timer = setTimeout(
      () => fail(new BodyError(408, 'Request body timed out')),
      BODY_TIMEOUT_MS,
    );
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
      fail(new BodyError(413, 'Request body exceeds 1 MiB'));
      return;
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}
function responseFinished(response: ServerResponse): Promise<void> {
  if (response.writableFinished || response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off('finish', done);
      response.off('close', done);
      resolve();
    };
    response.once('finish', done);
    response.once('close', done);
  });
}
export interface HttpOptions {
  config: Config;
  runtime?: Runtime;
  port?: number;
  signals?: boolean;
  drainMs?: number;
}
export interface HttpApplication {
  server: Server;
  runtime: Runtime;
  url: string;
  shutdown(): Promise<void>;
}
export async function startHttp(options: HttpOptions): Promise<HttpApplication> {
  const token = options.config.MCP_AUTH_TOKEN;
  if (!token || token.length < 32 || /\s/.test(token))
    throw new AppError(
      ErrorCode.VALIDATION,
      'MCP_AUTH_TOKEN must contain at least 32 characters for HTTP',
      'Set a bearer token of at least 32 characters without whitespace before starting HTTP',
    );
  const authorize = bearerValidator(token);
  const runtime = options.runtime ?? openRuntime(options.config);
  const pending = new Set<Promise<void>>();
  const active = new Set<McpServer>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  let uninstall = () => {};
  const server = createHttpServer((request, response) => {
    request.once('error', () => {});
    const context = { request_id: randomUUID(), run_id: correlation(request.headers['x-run-id']) };
    const at = performance.now();
    response.setHeader('X-Request-Id', context.request_id);
    response.setHeader('X-Run-Id', context.run_id);
    const task = withLogContext(context, async () => {
      const finished = responseFinished(response);
      let mcp: McpServer | undefined;
      try {
        if (stopping) {
          json(response, 503, { status: 'shutting_down' });
          return;
        }
        const address = server.address();
        if (
          !address ||
          typeof address === 'string' ||
          !safeOrigin(
            request,
            new Set(options.config.ALLOWED_HOSTS ?? defaultAllowedHosts(address.port)),
          )
        ) {
          protocolError(response, 403, 'Host or Origin is not allowed');
          return;
        }
        const path = request.url?.split('?')[0];
        if (path === '/healthz' && request.method === 'GET') {
          try {
            runtime.checkHealth();
            json(response, 200, { status: 'ok' });
          } catch {
            json(response, 503, { status: 'error' });
          }
          return;
        }
        if (path !== '/mcp') {
          json(response, 404, { error: 'Not found' });
          return;
        }
        if (!authorize(request)) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="foodops-mcp"');
          protocolError(response, 401, 'Unauthorized');
          request.resume();
          return;
        }
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          protocolError(response, 405, 'Method not allowed');
          return;
        }
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
          protocolError(response, 415, 'Content-Type must be application/json');
          request.resume();
          return;
        }
        const body = await readBody(request);
        if (response.destroyed) return;
        mcp = createServer(runtime);
        active.add(mcp);
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        await mcp.connect(transport);
        await Promise.race([transport.handleRequest(request, response, body), finished]);
      } catch (error) {
        if (error instanceof BodyError) protocolError(response, error.status, error.message);
        else {
          runtime.logger.error('HTTP request failed');
          if (!response.headersSent) protocolError(response, 500, 'Internal server error');
          else response.destroy();
        }
      } finally {
        await finished;
        if (mcp) {
          try {
            await mcp.close();
          } catch {
            runtime.logger.error('Request transport cleanup failed');
          }
          active.delete(mcp);
        }
        runtime.logger.info(
          {
            method: request.method,
            path: request.url?.split('?')[0],
            status: response.statusCode,
            latency_ms: Math.round(performance.now() - at),
          },
          'HTTP request completed',
        );
      }
    });
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => {
        pending.delete(task);
        runtime.logger.error('HTTP request cleanup failed');
      },
    );
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      runtime.logger.info('HTTP shutdown started');
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      const completed = await drain(async () => {
        await Promise.allSettled([...pending]);
        await stopped;
      }, options.drainMs ?? DRAIN_TIMEOUT_MS);
      if (!completed) {
        for (const mcp of active) await mcp.close();
        server.closeAllConnections();
        await Promise.allSettled([...pending]);
        await stopped;
      }
      runtime.close();
      uninstall();
      runtime.logger.info({ drained: completed }, 'HTTP shutdown completed');
      if (!completed) throw new Error('HTTP shutdown drain timed out');
    })();
    return closing;
  };
  try {
    server.listen(options.port ?? options.config.PORT, options.config.MCP_HOST);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP listener has no address');
    if (options.signals !== false) uninstall = installSignals(shutdown, runtime.logger);
    const host =
      options.config.MCP_HOST === '0.0.0.0'
        ? '127.0.0.1'
        : options.config.MCP_HOST === '::'
          ? '::1'
          : options.config.MCP_HOST;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
    runtime.logger.info({ url }, 'HTTP MCP server ready');
    return { server, runtime, url, shutdown };
  } catch (error) {
    server.close();
    runtime.close();
    uninstall();
    throw error;
  }
}
if (isMain(import.meta.url)) await runCli((config) => startHttp({ config }));
