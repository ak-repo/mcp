import { expect, it } from 'vitest';
import { parseChatFrame } from './sse-parser.js';

const sample = 'event: text.delta\r\ndata: {"type":"text.delta","text":"hello"}\r\n\r\n';

it('parses CRLF frames and multiline data', () => {
  expect(parseChatFrame('event: text.delta\r\ndata: {"type":"text.delta",\r\ndata: "text":"hello"}\r\n')).toEqual({ type: 'text.delta', text: 'hello' });
  expect(parseChatFrame(sample)).toEqual({ type: 'text.delta', text: 'hello' });
});

it('ignores heartbeat, malformed and unknown events', () => {
  expect(parseChatFrame(': heartbeat\n')).toBeNull();
  expect(parseChatFrame('event: text.delta\ndata: {bad}\n')).toBeNull();
  expect(parseChatFrame('event: future\ndata: {"type":"future"}\n')).toBeNull();
});

it.each(Array.from({ length: sample.length - 1 }, (_, index) => index + 1))(
  'accepts a frame split at byte boundary %i',
  (boundary) => {
    const first = sample.slice(0, boundary);
    const second = sample.slice(boundary);
    expect(parseChatFrame(first + second)).toEqual({ type: 'text.delta', text: 'hello' });
  },
);
