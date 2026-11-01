import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServices } from '@foodops/core';
import { openReadOnly, openWritable } from '@foodops/core/db/connection';
import { z } from 'zod';
import { createConfirmationGate, CONFIRMATION_TTL_MS } from '../lib/confirmation.js';
import {
  CancelPreviewSchema,
  OrderMutationSchema,
  writeResultSchema,
} from '../tools/write-schemas.js';
import { isMain } from './runtime.js';
import { seedFixture } from './test-helpers.js';

const cancellationResult = writeResultSchema(CancelPreviewSchema, OrderMutationSchema);
const trackingSchema = z.object({
  partner: z.object({ id: z.string(), status: z.string() }).nullable(),
});

/** Isolated client-side smoke check; the server child keeps stdout JSON-RPC only. */
export async function verifyConfirmation(report: (message: string) => void): Promise<void> {
  const fixture = seedFixture();
  const secret = randomBytes(32).toString('hex');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../dist/transports/stdio.js', import.meta.url))],
    env: { DB_PATH: fixture.config.DB_PATH, LOG_LEVEL: 'silent', MCP_CONFIRM_SECRET: secret },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'foodops-confirmation-verification', version: '1.0.0' });
  const write = openWritable(fixture.config.DB_PATH);
  const read = openReadOnly(fixture.config.DB_PATH);
  try {
    const services = createServices({ write, read });
    await client.connect(transport);
    async function call(name: string, args: Record<string, unknown>) {
      return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    }
    async function preview(args: Record<string, unknown>) {
      const result = await call('cancel_order', args);
      assert.notEqual(result.isError, true);
      const data = cancellationResult.parse(result.structuredContent?.['data']);
      assert.equal(data.requires_user_approval, true);
      return data;
    }
    const order = services.order
      .listOrders({ status: 'ready' })
      .items.find((item) => services.delivery.trackDelivery(item.id).partner !== null);
    assert(order, 'Seed must include a ready order with an assigned partner');
    const beforeResponse = await call('track_delivery', { order_id: order.id });
    const before = trackingSchema.parse(beforeResponse.structuredContent?.['data']);
    assert.equal(before.partner?.status, 'busy');
    const args = {
      order_id: order.id,
      reason: 'Smoke-test user-approved cancellation',
      idempotency_key: 'confirmation-smoke-cancel',
    };
    const approval = await preview(args);
    const executed = await call('cancel_order', {
      ...args,
      confirmation_token: approval.confirmation_token,
    });
    assert.notEqual(executed.isError, true);
    const committed = cancellationResult.parse(executed.structuredContent?.['data']);
    assert.equal(committed.requires_user_approval, false);
    assert.equal(committed.result.partner?.status, 'available');
    const afterResponse = await call('track_delivery', { order_id: order.id });
    const after = trackingSchema.parse(afterResponse.structuredContent?.['data']);
    assert.equal(after.partner?.status, 'available');
    report(
      `cancel ${order.id}; partner ${before.partner?.id}: ${before.partner?.status} -> ${after.partner?.status}`,
    );
    const replay = await call('cancel_order', {
      ...args,
      confirmation_token: approval.confirmation_token,
    });
    assert.deepEqual(replay.structuredContent, executed.structuredContent);
    report('idempotent retry: identical stored result');

    const invalidArgs = { order_id: 'O-EDGE-UNASSIGNED', reason: 'Verify approval rejection' };
    const fresh = await preview(invalidArgs);
    async function rejected(label: string, controls: Record<string, unknown>) {
      const result = await call('cancel_order', { ...invalidArgs, action: 'execute', ...controls });
      assert.equal(result.isError, true);
      assert(
        result.content.some(
          (item) => item.type === 'text' && item.text.startsWith('CONFIRMATION_REQUIRED:'),
        ),
      );
      report(`${label}: CONFIRMATION_REQUIRED; no cancellation`);
    }
    await rejected('missing token', {});
    const [payload, signature] = fresh.confirmation_token.split('.');
    const tampered = `${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    await rejected('tampered token', { confirmation_token: tampered });
    // An independently signed expired fixture avoids a five-minute wait without a server clock override.
    const expired = createConfirmationGate({
      secret,
      now: () => Date.now() - CONFIRMATION_TTL_MS - 1000,
    }).issue('cancel_order', invalidArgs, fresh.preview);
    await rejected('expired token', { confirmation_token: expired.confirmation_token });
    services.order.advanceStatus({
      orderId: invalidArgs.order_id,
      toStatus: 'preparing',
      actor: 'ops',
      reason: 'Concurrent operator update',
    });
    await rejected('state changed', { confirmation_token: fresh.confirmation_token });
    assert.equal(services.order.getOrder(invalidArgs.order_id).order.status, 'preparing');
  } finally {
    await client.close();
    await transport.close();
    read.close();
    write.close();
    fixture.close();
  }
}
if (isMain(import.meta.url)) {
  try {
    await verifyConfirmation((message) => process.stdout.write(message + '\n'));
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  }
}
