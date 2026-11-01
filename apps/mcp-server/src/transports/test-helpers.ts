import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWritable } from '@foodops/core/db/connection';
import { seedDatabase } from '@foodops/core/seed/seed';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { type Config } from '../lib/config.js';

export const TOKEN = 'foodops-integration-secret-32-characters';
export const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
};
export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'foodops-process-test', version: '1.0.0' },
  },
};
export function seedFixture(): { directory: string; config: Config; close(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'foodops-transports-'));
  const path = join(directory, 'db.sqlite');
  const db = openWritable(path);
  try {
    seedDatabase(db);
  } finally {
    db.close();
  }
  return {
    directory,
    config: {
      MCP_HOST: '127.0.0.1',
      DB_PATH: path,
      LOG_LEVEL: 'silent',
      PORT: 3001,
      MCP_AUTH_TOKEN: TOKEN,
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
