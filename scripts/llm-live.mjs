#!/usr/bin/env node
import { setTimeout, clearTimeout } from 'node:timers';
const { AbortController } = globalThis;
import console from 'node:console';
import process from 'node:process';
if (process.env.LLM_LIVE !== '1') {
  console.error('Live LLM check is disabled. Set LLM_LIVE=1 to opt in, and build first.');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const deadline = setTimeout(stop, 180000);
  deadline.unref();
  let fixture;
  try {
    const { startChatFixture, chatTranscript } = await import('./chat-fixture.mjs');
    fixture = await startChatFixture({ live: true });
    const manager = fixture.runtime.agent.providers;
    if (manager.publicView().provider !== 'ollama')
      throw new Error('Select Ollama for the live scenario');
    const print = (value) => console.log(manager.redact(JSON.stringify(value)));
    const probe = await manager.probe(controller.signal);
    print({ probe });
    if (!probe.ok) throw new Error('Provider probe failed');
    const events = await chatTranscript(
      fixture,
      'Read-only task: inspect delivery for order O-EDGE-LATE and briefly report whether it is late. Never request a write.',
      async (event) => {
        print(event);
        if (
          event.type === 'approval.required' ||
          (event.type === 'tool.call' && event.kind === 'write')
        )
          throw new Error('Write attempted in read-only diagnostic');
      },
      controller.signal,
    );
    if (!events.some((event) => event.type === 'tool.result' && event.status === 'ok'))
      throw new Error('No successful read tool result');
    print({ ok: true, writes_executed: 0 });
  } catch {
    console.error(
      'Live LLM diagnostic failed; check the sanitized probe/transcript, model identifier, credentials and provider limits.',
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await fixture?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
