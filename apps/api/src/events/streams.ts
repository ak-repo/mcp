import { HttpError } from '../lib/http-errors.js';
import { ErrorCode } from '@foodops/shared';
import type { ServerResponse } from 'node:http';
import type { FeedEvent } from './change-feed.js';
export function encodeEvent(event: FeedEvent): string {
  return `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
export function createStreams(limit: number) {
  let stopped = false;
  const clients = new Set<() => void>();
  return {
    get full() {
      return stopped || clients.size >= limit;
    },
    open(response: ServerResponse, cleanup: () => void) {
      if (stopped)
        throw new HttpError(
          503,
          ErrorCode.INTERNAL,
          'Stream service is stopping',
          'Retry after the API restarts',
        );
      let closed = false;
      let blocked = false;
      let bytes = 0;
      const queue: string[] = [];
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clients.delete(close);
        cleanup();
        response.off('drain', drain);
        response.off('close', close);
        response.off('error', close);
        response.end();
        // Bound shutdown for a peer that stopped reading, without discarding normal buffered frames.
        const destroy = setTimeout(() => response.destroy(), 1000);
        destroy.unref();
        response.once('finish', () => clearTimeout(destroy));
      };
      const send = (frame: string) => {
        if (closed) return;
        if (blocked) {
          queue.push(frame);
          bytes += Buffer.byteLength(frame);
          if (bytes > 262144) close();
          return;
        }
        blocked = !response.write(frame);
      };
      const drain = () => {
        blocked = false;
        while (queue.length && !blocked && !closed) {
          const frame = queue.shift()!;
          bytes -= Buffer.byteLength(frame);
          blocked = !response.write(frame);
        }
      };
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15000);
      heartbeat.unref();
      clients.add(close);
      response.on('drain', drain);
      response.once('close', close);
      response.once('error', close);
      send(': connected\n\n');
      return { send: (event: FeedEvent) => send(encodeEvent(event)), close };
    },
    close() {
      stopped = true;
      for (const close of [...clients]) close();
    },
  };
}
