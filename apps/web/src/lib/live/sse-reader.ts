import { LiveChangeEventSchema, McpCallEventSchema } from '@foodops/shared';
import { ContractError } from '../api/errors.js';
import type { LiveEvent } from './events.js';

export function decodeFrame(frame: string): LiveEvent | null {
  let type = '';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    if (field === 'data') data.push(value);
    if (field === 'id') id = value;
  }
  if (!data.length) return null;
  let value: unknown;
  try {
    value = JSON.parse(data.join('\n'));
  } catch {
    throw new ContractError();
  }
  if (type === 'mcp.call') {
    const parsed = McpCallEventSchema.safeParse(value);
    if (!parsed.success || id !== undefined) throw new ContractError();
    return { type, data: parsed.data };
  }
  const parsed = LiveChangeEventSchema.safeParse(value);
  if (!parsed.success || type !== parsed.data.type || id !== String(parsed.data.id))
    throw new ContractError();
  const event = parsed.data;
  switch (event.type) {
    case 'order.updated':
      return { type: event.type, data: event };
    case 'delivery.updated':
      return { type: event.type, data: event };
    case 'partner.updated':
      return { type: event.type, data: event };
    case 'payment.updated':
      return { type: event.type, data: event };
    case 'invoice.updated':
      return { type: event.type, data: event };
  }
}

export async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: LiveEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCr = false;
  // Bound both stalled connections and malformed unbounded frames.
  let idle: ReturnType<typeof setTimeout>;
  let idleExpired = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleExpired = true;
      cancel();
    }, 45000);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) return;
    resetIdle();
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      let chunk = decoder.decode(value, { stream: true });
      if (pendingCr && chunk.startsWith('\n')) chunk = chunk.slice(1);
      pendingCr = chunk.endsWith('\r');
      buffer += chunk.replace(/\r\n|\r/g, '\n');
      if (buffer.length > 262144) throw new ContractError();
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = decodeFrame(frame);
        if (event && !signal.aborted) onEvent(event);
      }
    }
    if (idleExpired) throw new Error('Live connection timed out.');
  } finally {
    clearTimeout(idle!);
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
