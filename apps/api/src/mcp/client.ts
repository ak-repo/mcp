import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { sleep } from '../llm/http.js';
export class McpClientError extends Error {
  constructor(
    public readonly kind: 'auth' | 'network' | 'timeout' | 'aborted' | 'protocol',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}
export interface McpConnection {
  listTools(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<Tool[]>;
  refreshTools(signal?: AbortSignal): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; retry?: boolean },
  ): Promise<CallToolResult>;
  status(): { connected: boolean; last_error: string | null; tool_count: number };
  close(): Promise<void>;
}
function safeError(error: unknown, signal?: AbortSignal): McpClientError {
  if (signal?.aborted) return new McpClientError('aborted', 'MCP request cancelled', false);
  if (error instanceof McpClientError) return error;
  if (error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403))
    return new McpClientError('auth', 'MCP authentication failed; check MCP_AUTH_TOKEN', false);
  if (error instanceof Error && error.name === 'UnauthorizedError')
    return new McpClientError('auth', 'MCP authentication failed; check MCP_AUTH_TOKEN', false);
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === -32001)
    return new McpClientError('timeout', 'MCP request timed out', true);
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'number' &&
    error.code < 0
  )
    return new McpClientError('protocol', 'MCP server rejected the protocol request', false);
  return new McpClientError(
    'network',
    'MCP server is unavailable or returned an invalid response',
    true,
  );
}
export function createMcpClient(
  config: Config,
  dependencies: { fetch?: typeof fetch; random?: () => number } = {},
): McpConnection {
  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let catalog: Tool[] = [];
  let expires = 0;
  let refreshing: Promise<Tool[]> | undefined;
  let lastError: string | null = null;
  let closed = false;
  const lifetime = new AbortController();
  const combined = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const options = (signal?: AbortSignal) => ({
    signal: combined(signal),
    timeout: config.MCP_CALL_TIMEOUT_MS,
    maxTotalTimeout: config.MCP_CALL_TIMEOUT_MS,
  });
  async function disconnect(expected?: Client) {
    const previous = expected ?? client;
    if (client === previous) {
      client = undefined;
      expires = 0;
    }
    await previous?.close().catch(() => undefined);
  }
  async function connect(): Promise<Client> {
    if (closed) throw new McpClientError('aborted', 'MCP client is closed', false);
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      if (!config.MCP_AUTH_TOKEN)
        throw new McpClientError('auth', 'Set MCP_AUTH_TOKEN before connecting', false);
      for (let attempt = 0; ; attempt++) {
        const candidate = new Client(
          { name: 'foodops-api', version: '0.0.0' },
          { capabilities: {} },
        );
        const transport = new StreamableHTTPClientTransport(new URL(config.MCP_URL), {
          requestInit: {
            headers: { Authorization: `Bearer ${config.MCP_AUTH_TOKEN}` },
            redirect: 'error',
          },
          fetch: async (input, init) =>
            (dependencies.fetch ?? fetch)(input, {
              ...init,
              redirect: 'error',
              signal: init?.signal
                ? AbortSignal.any([init.signal, lifetime.signal])
                : lifetime.signal,
            }),
          reconnectionOptions: {
            initialReconnectionDelay: 250,
            maxReconnectionDelay: 2000,
            reconnectionDelayGrowFactor: 2,
            maxRetries: 0,
          },
        });
        candidate.onerror = () => {
          lastError = 'MCP transport reported an error';
        };
        candidate.onclose = () => {
          if (client === candidate) {
            client = undefined;
            expires = 0;
          }
        };
        try {
          await candidate.connect(transport, options());
          if (closed) {
            await candidate.close();
            throw new McpClientError('aborted', 'MCP client is closed', false);
          }
          client = candidate;
          lastError = null;
          expires = 0;
          return candidate;
        } catch (error) {
          await candidate.close().catch(() => undefined);
          const failure = safeError(error, lifetime.signal);
          lastError = failure.message;
          if (!failure.retryable || attempt >= 2) throw failure;
          await sleep(
            Math.floor((dependencies.random ?? Math.random)() * Math.min(2000, 250 * 2 ** attempt)),
            lifetime.signal,
          );
        }
      }
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function connected(signal?: AbortSignal): Promise<Client> {
    const requestSignal = combined(signal);
    if (requestSignal.aborted) throw safeError(undefined, requestSignal);
    // Cancellation of one waiter must not cancel another caller's shared handshake.
    return new Promise<Client>((resolve, reject) => {
      const cancel = () => reject(safeError(undefined, requestSignal));
      requestSignal.addEventListener('abort', cancel, { once: true });
      void connect()
        .then(resolve, reject)
        .finally(() => requestSignal.removeEventListener('abort', cancel));
    });
  }
  async function perform<T>(
    work: (connection: Client) => Promise<T>,
    retry: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = await connected(signal);
      try {
        const result = await work(current);
        lastError = null;
        return result;
      } catch (error) {
        const failure = safeError(error, combined(signal));
        lastError = failure.message;
        if (failure.kind !== 'aborted') await disconnect(current);
        if (!retry || !failure.retryable || attempt >= 1) throw failure;
      }
    }
  }
  const api: McpConnection = {
    async listTools(settings = {}) {
      if (settings.signal?.aborted || closed) throw safeError(undefined, combined(settings.signal));
      if (!settings.refresh && expires > Date.now() && client) return structuredClone(catalog);
      if (!refreshing)
        refreshing = perform(
          async (current) => {
            const tools: Tool[] = [];
            const seen = new Set<string>();
            let cursor: string | undefined;
            for (let page = 0; ; page++) {
              if (page >= 100 || (cursor !== undefined && seen.has(cursor)))
                throw new McpClientError(
                  'protocol',
                  'MCP tool catalog pagination is invalid',
                  false,
                );
              if (cursor !== undefined) seen.add(cursor);
              const result = await current.listTools(
                cursor ? { cursor } : {},
                options(settings.signal),
              );
              tools.push(...result.tools);
              cursor = result.nextCursor;
              if (!cursor) break;
            }
            if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
              throw new McpClientError('protocol', 'MCP tool names are not unique', false);
            catalog = tools;
            expires = Date.now() + config.MCP_TOOLS_TTL_MS;
            return tools;
          },
          true,
          settings.signal,
        ).finally(() => {
          refreshing = undefined;
        });
      return structuredClone(await refreshing);
    },
    refreshTools(signal) {
      return api.listTools({ refresh: true, ...(signal ? { signal } : {}) });
    },
    callTool(name, args, settings = {}) {
      return perform(
        async (current) =>
          CallToolResultSchema.parse(
            await current.callTool({ name, arguments: args }, undefined, options(settings.signal)),
          ),
        settings.retry === true,
        settings.signal,
      );
    },
    status: () => ({
      connected: client !== undefined,
      last_error: lastError,
      tool_count: catalog.length,
    }),
    async close() {
      closed = true;
      lifetime.abort();
      await disconnect();
      await connecting?.catch(() => undefined);
      await refreshing?.catch(() => undefined);
    },
  };
  return api;
}
