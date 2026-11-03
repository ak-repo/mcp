#!/usr/bin/env node
const { fetch, AbortController } = globalThis;
import console from 'node:console';
import process from 'node:process';
import { startChatFixture, chatTranscript } from './chat-fixture.mjs';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let fixture;
try {
  fixture = await startChatFixture();
  const print = (event) => console.log(JSON.stringify(event));
  await chatTranscript(fixture, 'show late deliveries', print, controller.signal);
  const order = fixture.runtime.services.order
    .listOrders({ status: 'placed', limit: 50 })
    .items.find((order) => order.id !== 'O-EDGE-FAILED-PAYMENT');
  if (!order) throw new Error('No cancellable seeded order');
  let approved = false;
  await chatTranscript(
    fixture,
    `cancel order ${order.id}`,
    async (event, runId) => {
      print(event);
      if (event.type === 'approval.required') {
        if (fixture.runtime.services.order.getOrder(order.id).order.status !== 'placed')
          throw new Error('Preview changed the order');
        const response = await fetch(`${fixture.url}/api/chat/${runId}/approve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${fixture.auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ call_id: event.call_id, decision: 'approved' }),
        });
        if (!response.ok) throw new Error('HTTP approval failed');
        approved = true;
      }
    },
    controller.signal,
  );
  const detail = fixture.runtime.services.order.getOrder(order.id);
  if (
    !approved ||
    detail.order.status !== 'cancelled' ||
    !detail.timeline.some((event) => event.to_status === 'cancelled' && event.actor === 'ai')
  )
    throw new Error('Cancellation or ai audit event was not committed');
  console.log('PASS smoke:chat: read, approval, cancellation, and actor=ai verified');
} catch {
  console.error('FAIL smoke:chat: check the event transcript and build output');
  process.exitCode = 1;
} finally {
  await fixture?.close();
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
