import { AgentEventSchema, type AgentEvent } from '@foodops/shared';

type Frame = { event: string; data: string };

function frameFromText(text: string): Frame | null {
  let event = '';
  const data: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

export function parseChatFrame(frame: string): AgentEvent | null {
  const parsedFrame = frameFromText(frame.replace(/\r\n|\r/g, '\n'));
  if (!parsedFrame) return null;
  let value: unknown;
  try {
    value = JSON.parse(parsedFrame.data);
  } catch {
    if (import.meta.env.DEV) console.warn('Ignoring malformed chat event JSON');
    return null;
  }
  const parsed = AgentEventSchema.safeParse(value);
  if (!parsed.success || (parsedFrame.event && parsedFrame.event !== parsed.data.type)) {
    if (import.meta.env.DEV) console.warn('Ignoring unknown or invalid chat event');
    return null;
  }
  return parsed.data;
}

export async function readChatSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n|\r/g, '\n');
      if (buffer.length > 262144) throw new Error('Chat event exceeded the maximum frame size.');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseChatFrame(frame);
        if (event && !signal.aborted) onEvent(event);
        end = buffer.indexOf('\n\n');
      }
    }
    const tail = buffer.trim();
    if (tail && !signal.aborted) {
      const event = parseChatFrame(tail);
      if (event) onEvent(event);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
