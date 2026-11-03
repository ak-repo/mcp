import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import { ConfigSchema } from '../config.js';
import { createMcpClient } from './client.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export async function fakeMcp() {
  let calls = 0;
  let fail = false;
  const headers: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      headers.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${'t'.repeat(32)}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (fail) {
        res.writeHead(503);
        res.end();
        return;
      }
      let text = '';
      for await (const chunk of req) text += String(chunk);
      const mcp = new McpServer({ name: 'fake', version: '1' });
      mcp.registerTool(
        'lookup',
        { inputSchema: z.object({ id: z.string() }), annotations: { readOnlyHint: true } },
        async ({ id }) => {
          calls++;
          return { content: [{ type: 'text', text: id }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      res.on('close', () => {
        void mcp.close();
      });
      await transport.handleRequest(req, res, JSON.parse(text) as unknown);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers,
    get calls() {
      return calls;
    },
    set fail(value: boolean) {
      fail = value;
    },
  };
}
function config(url: string) {
  return ConfigSchema.parse({
    ADMIN_TOKEN: 'a'.repeat(32),
    MCP_AUTH_TOKEN: 't'.repeat(32),
    MCP_URL: url,
  });
}
it('connects lazily, authenticates, caches defensively and calls tools', async () => {
  const s = await fakeMcp();
  const client = createMcpClient(config(s.url));
  cleanups.push(() => client.close());
  expect(client.status().connected).toBe(false);
  expect(s.headers).toHaveLength(0);
  const first = await client.listTools();
  const count = s.headers.length;
  first.length = 0;
  expect(await client.listTools()).toHaveLength(1);
  expect(s.headers).toHaveLength(count);
  expect(await client.callTool('lookup', { id: 'O-1' }, { retry: true })).toMatchObject({
    content: [{ text: 'O-1' }],
  });
  await client.refreshTools();
  expect(s.headers.length).toBeGreaterThan(count);
  expect(client.status()).toMatchObject({ connected: true, tool_count: 1, last_error: null });
});
it('reports auth safely and rejects aborted calls', async () => {
  const s = await fakeMcp();
  const cfg = config(s.url);
  cfg.MCP_AUTH_TOKEN = 'x'.repeat(32);
  const client = createMcpClient(cfg);
  cleanups.push(() => client.close());
  await expect(client.listTools()).rejects.toMatchObject({ kind: 'auth' });
  expect(client.status().last_error).not.toContain(cfg.MCP_AUTH_TOKEN);
  const controller = new AbortController();
  controller.abort();
  await expect(client.callTool('lookup', {}, { signal: controller.signal })).rejects.toMatchObject({
    kind: 'aborted',
  });
});
it('recovers after server availability changes and closes permanently', async () => {
  const s = await fakeMcp();
  const client = createMcpClient(config(s.url), { random: () => 0 });
  cleanups.push(() => client.close());
  await client.listTools();
  s.fail = true;
  await expect(client.callTool('lookup', { id: 'O' })).rejects.toMatchObject({ retryable: true });
  s.fail = false;
  expect(await client.callTool('lookup', { id: 'O' }, { retry: true })).toMatchObject({
    content: [{ text: 'O' }],
  });
  await client.close();
  await expect(client.listTools()).rejects.toMatchObject({ kind: 'aborted' });
});
