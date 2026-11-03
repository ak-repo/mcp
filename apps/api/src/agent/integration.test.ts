import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { AgentEventSchema } from '@foodops/shared';
import { fixture } from '../tests/helpers.js';
import { createMcpClient } from '../mcp/client.js';
import { createApprovals } from './approvals.js';
import { createSessions } from './store.js';
import { runAgent } from './run.js';
import type { LLMProvider, StreamEvent } from '../llm/types.js';
function scripted(orderId: string): LLMProvider {
  let turn = 0;
  return {
    id: 'fake',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    listModels: async () => [],
    async *chat(messages): AsyncIterable<StreamEvent> {
      expect(JSON.stringify(messages)).not.toContain('server-secret-token');
      if (++turn === 1)
        yield {
          type: 'tool_call',
          id: 'c',
          name: 'cancel_order',
          arguments: { order_id: orderId, reason: 'Approved agent test' },
        };
      else yield { type: 'text_delta', delta: 'Completed' };
      yield { type: 'done', reason: 'stop' };
    },
  };
}
it('uses SDK preview/token semantics and retries a lost execution response with the same key', async () => {
  const calls: Record<string, unknown>[] = [];
  let committed = 0;
  const responses = new Map<string, object>();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const message = JSON.parse(text) as {
        method: string;
        params?: { arguments?: Record<string, unknown> };
      };
      const mcp = new McpServer({ name: 'fake', version: '1' });
      mcp.registerTool(
        'cancel_order',
        {
          inputSchema: z.object({
            order_id: z.string(),
            reason: z.string(),
            action: z.enum(['preview', 'execute']).optional(),
            confirmation_token: z.string().optional(),
            idempotency_key: z.string().optional(),
          }),
          annotations: { readOnlyHint: false },
        },
        async (args) => {
          calls.push(args);
          if (args.action === 'preview')
            return {
              content: [{ type: 'text', text: 'Preview' }],
              structuredContent: {
                data: {
                  requires_user_approval: true,
                  preview: { order_id: args.order_id },
                  confirmation_token: 'server-secret-token',
                  expires_at: new Date(Date.now() + 300000).toISOString(),
                },
                truncated: false,
              },
            };
          expect(args.confirmation_token).toBe('server-secret-token');
          expect(args.idempotency_key).toBeTruthy();
          const key = args.idempotency_key!;
          if (!responses.has(key)) {
            committed++;
            responses.set(key, {
              content: [{ type: 'text', text: 'done' }],
              structuredContent: {
                data: { requires_user_approval: false, result: { order_id: args.order_id } },
                truncated: false,
              },
            });
          }
          return responses.get(key) as { content: { type: 'text'; text: string }[] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      res.on('close', () => {
        void mcp.close();
      });
      await transport.handleRequest(req, res, message);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const f = fixture();
  const config = {
    ...f.config,
    MCP_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    MCP_AUTH_TOKEN: 't'.repeat(32),
  };
  // Simulate loss after commit at the fetch boundary without bypassing SDK dispatch.
  let dropped = false;
  const client = createMcpClient(config, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { params?: { arguments?: { action?: string } } })
          : undefined;
      if (!dropped && body?.params?.arguments?.action === 'execute') {
        dropped = true;
        await response.text();
        throw new TypeError('Lost connection');
      }
      return response;
    },
  });
  const approvals = createApprovals();
  let runId = '';
  try {
    for await (const event of runAgent(
      {
        config,
        provider: scripted('O'),
        model: 'test',
        mcp: client,
        approvals,
        sessions: createSessions(),
        logger: f.runtime.logger,
      },
      { message: 'Cancel' },
    )) {
      AgentEventSchema.parse(event);
      expect(JSON.stringify(event)).not.toContain('server-secret-token');
      if (event.type === 'run.started') runId = event.run_id;
      if (event.type === 'approval.required') approvals.resolve(runId, event.call_id, 'approved');
      expect(event.type).not.toBe('run.error');
    }
    expect(committed).toBe(1);
    expect(calls.filter((c) => c.action === 'execute')).toHaveLength(2);
    expect(calls[1]?.idempotency_key).toBe(calls[2]?.idempotency_key);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
const entry = fileURLToPath(
  new URL('../../../mcp-server/dist/transports/http.js', import.meta.url),
);
it('real built MCP server: seeded poison stays data and approved cancel commits', async (context) => {
  if (!existsSync(entry)) {
    context.skip('MCP dist missing; run pnpm build');
    return;
  }
  const f = fixture();
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const token = 't'.repeat(32);
  const child = spawn(process.execPath, [entry], {
    cwd: f.directory,
    env: {
      ...process.env,
      DB_PATH: f.dbPath,
      MCP_AUTH_TOKEN: token,
      MCP_HOST: '127.0.0.1',
      PORT: String(port),
      ALLOWED_HOSTS: `127.0.0.1:${port}`,
      LOG_LEVEL: 'silent',
    },
    stdio: 'ignore',
  });
  const config = { ...f.config, MCP_AUTH_TOKEN: token, MCP_URL: `http://127.0.0.1:${port}/mcp` };
  const client = createMcpClient(config, { random: () => 0 });
  const approvals = createApprovals();
  let runId = '';
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
          ready = true;
          break;
        }
      } catch {
        // The spawned process may not have bound its port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(ready).toBe(true);
    const poison = await client.callTool(
      'get_order',
      { order_id: 'O-EDGE-INJECTION' },
      { retry: true },
    );
    expect(JSON.stringify(poison)).toContain('Ignore previous instructions');
    const candidates = f.runtime.services.order.listOrders({ status: 'placed', limit: 50 });
    const order = candidates.items[0];
    expect(order).toBeTruthy();
    const canceller = scripted(order!.id);
    let first = true;
    let poisonSeen = false;
    const provider: LLMProvider = {
      ...canceller,
      async *chat(messages, tools, options) {
        if (first) {
          first = false;
          yield {
            type: 'tool_call',
            id: 'poison-read',
            name: 'get_order',
            arguments: { order_id: 'O-EDGE-INJECTION' },
          };
          yield { type: 'done', reason: 'stop' };
        } else {
          poisonSeen = messages.some(
            (message) =>
              message.role === 'tool' && message.content.includes('Ignore previous instructions'),
          );
          expect(poisonSeen).toBe(true);
          yield* canceller.chat(messages, tools, options);
        }
      },
    };
    for await (const event of runAgent(
      {
        config,
        provider,
        model: 'test',
        mcp: client,
        approvals,
        sessions: createSessions(),
        logger: f.runtime.logger,
      },
      { message: 'Cancel after showing preview' },
    )) {
      if (event.type === 'run.started') runId = event.run_id;
      if (event.type === 'approval.required') {
        expect(f.runtime.services.order.getOrder(order!.id).order.status).toBe('placed');
        approvals.resolve(runId, event.call_id, 'approved');
      }
      expect(event.type).not.toBe('run.error');
    }
    expect(poisonSeen).toBe(true);
    expect(f.runtime.services.order.getOrder(order!.id).order.status).toBe('cancelled');
  } finally {
    await client.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
    await f.close();
  }
}, 15000);
