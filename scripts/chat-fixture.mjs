import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
const { fetch, URL } = globalThis;
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openWritable } from '../packages/core/dist/db/connection.js';
import { seedDatabase } from '../packages/core/dist/seed/seed.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { openRuntime } from '../apps/api/dist/runtime.js';
import { buildApp } from '../apps/api/dist/app.js';
export function scriptedProvider() {
  return {
    id: 'scripted',
    capabilities: { toolCalling: true, streaming: true, thinking: false },
    listModels: async () => [{ name: 'scripted' }],
    async *chat(messages) {
      if (messages.at(-1)?.role === 'tool') {
        yield { type: 'text_delta', delta: 'Operation result received.' };
        yield { type: 'done', reason: 'stop' };
        return;
      }
      const user =
        [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const match = /cancel order ([A-Za-z0-9-]+)/i.exec(user);
      yield {
        type: 'tool_call',
        id: match ? 'cancel-1' : 'late-1',
        name: match ? 'cancel_order' : 'track_delivery',
        arguments: match
          ? { order_id: match[1], reason: 'Explicitly approved smoke cancellation' }
          : { order_id: 'O-EDGE-LATE' },
      };
      yield { type: 'usage', promptTokens: 10, completionTokens: 5 };
      yield { type: 'done', reason: 'tool_calls' };
    },
  };
}
export async function startChatFixture({ live = false } = {}) {
  const entry = fileURLToPath(
    new URL('../apps/mcp-server/dist/transports/http.js', import.meta.url),
  );
  if (!existsSync(entry)) throw new Error('Run pnpm build before chat diagnostics');
  const directory = mkdtempSync(join(tmpdir(), 'foodops-chat-'));
  const dbPath = join(directory, 'db.sqlite');
  const db = openWritable(dbPath);
  try {
    seedDatabase(db);
  } finally {
    db.close();
  }
  const auth = randomBytes(32).toString('hex');
  const mcpAuth = randomBytes(32).toString('hex');
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [entry], {
    cwd: directory,
    env: {
      ...process.env,
      DB_PATH: dbPath,
      MCP_AUTH_TOKEN: mcpAuth,
      MCP_HOST: '127.0.0.1',
      PORT: String(port),
      ALLOWED_HOSTS: `127.0.0.1:${port}`,
      LOG_LEVEL: 'silent',
    },
    stdio: 'ignore',
  });
  let runtime;
  let app;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (app) await app.close();
      if (runtime) await runtime.shutdown();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        timer.unref();
        await exited;
        clearTimeout(timer);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error('Temporary MCP server exited during startup');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* Waiting for loopback listener. */
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error('Temporary MCP server did not become ready');
    const config = loadConfig({
      env: {
        ...process.env,
        ADMIN_TOKEN: auth,
        DB_PATH: dbPath,
        LOG_LEVEL: 'silent',
        MCP_URL: `http://127.0.0.1:${port}/mcp`,
        MCP_AUTH_TOKEN: mcpAuth,
        SIMULATOR: 'off',
        ...(live ? {} : { LLM_PROVIDER: 'ollama', LLM_MODEL: 'scripted', LLM_API_KEY: '' }),
      },
    });
    runtime = openRuntime(config, live ? {} : { agent: { provider: scriptedProvider() } });
    if (live) {
      const listTools = runtime.mcp.listTools.bind(runtime.mcp);
      const callTool = runtime.mcp.callTool.bind(runtime.mcp);
      const reads = new Set();
      runtime.mcp.listTools = async (options) => {
        const tools = (await listTools(options)).filter(
          (tool) => tool.annotations?.readOnlyHint === true,
        );
        for (const tool of tools) reads.add(tool.name);
        return tools;
      };
      runtime.mcp.callTool = async (name, args, options) => {
        if (!reads.has(name)) throw new Error('Live diagnostic permits read tools only');
        return callTool(name, args, options);
      };
    }
    app = buildApp({ config, runtime });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    return { url, auth, runtime, dbPath, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function chatTranscript(fixture, message, onEvent = async () => {}, signal) {
  const response = await fetch(`${fixture.url}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok || !response.body) throw new Error(`Chat HTTP ${response.status}`);
  const { readSse } = await import('../apps/api/dist/llm/http.js');
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        yield part.value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const events = [];
  let runId;
  for await (const frame of readSse(chunks())) {
    const event = JSON.parse(frame.data);
    if (frame.event !== event.type) throw new Error('SSE type mismatch');
    if (event.type === 'run.started') runId = event.run_id;
    events.push(event);
    await onEvent(event, runId);
    if (event.type === 'run.error')
      throw new Error('Chat run failed; inspect sanitized transcript');
  }
  if (events.at(-1)?.type !== 'run.completed') throw new Error('Chat stream did not complete');
  return events;
}
