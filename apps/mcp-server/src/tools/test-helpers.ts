import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServices, type Services } from '@foodops/core';
import { openReadOnly, openWritable, type DatabaseConnection } from '@foodops/core/db/connection';
import { seedDatabase } from '@foodops/core/seed/seed';
import { createServer } from '../lib/create-server.js';
import { createLogger } from '../lib/logger.js';
import { allTools } from './index.js';

export interface Fixture {
  directory: string;
  write: DatabaseConnection;
  read: DatabaseConnection;
  services: Services;
  client: Client;
  server: ReturnType<typeof createServer>;
  businessHash(): string;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
export async function fixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'foodops-phase2b-'));
  const write = openWritable(join(directory, 'db.sqlite'));
  seedDatabase(write);
  const read = openReadOnly(write.name);
  const services = createServices({ write, read });
  const server = createServer({ services, logger: createLogger('silent') });
  const client = new Client({ name: 'foodops-phase2b-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  return {
    directory,
    write,
    read,
    services,
    client,
    server,
    businessHash() {
      const tables = write
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('tool_call_log', 'schema_migrations') ORDER BY name",
        )
        .all() as { name: string }[];
      return createHash('sha256')
        .update(
          JSON.stringify(
            tables.map(({ name }) => [
              name,
              write.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all(),
            ]),
          ),
        )
        .digest('hex');
    },
    async call(name: string, args: Record<string, unknown>) {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      if (result.structuredContent) {
        const tool = allTools.find((definition) => definition.name === name);
        if (!tool) throw new Error('Unknown test tool');
        tool.outputSchema.parse(result.structuredContent);
      }
      return result;
    },
    async close() {
      await client.close();
      await server.close();
      read.close();
      write.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
