import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '@foodops/shared';
export function createChatStreams() {
  const clients = new Set<() => void>();
  let stopped = false;
  return {
    open(response: ServerResponse, onClose: () => void) {
      if (stopped) throw new Error('Chat streaming is stopping');
      let closed = false;
      const waiters = new Set<(value: boolean) => void>();
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clients.delete(close);
        onClose();
        for (const resolve of waiters) resolve(false);
        waiters.clear();
        response.off('close', close);
        response.off('error', close);
        response.end();
        const timer = setTimeout(() => response.destroy(), 1000);
        timer.unref();
        response.once('finish', () => clearTimeout(timer));
      };
      const frame = async (text: string): Promise<boolean> => {
        if (closed || response.destroyed) return false;
        if (response.writableLength + Buffer.byteLength(text) > 262144) {
          close();
          return false;
        }
        if (response.write(text)) return true;
        return new Promise((resolve) => {
          const finish = (ok: boolean) => {
            waiters.delete(finish);
            response.off('drain', drain);
            resolve(ok);
          };
          const drain = () => finish(true);
          waiters.add(finish);
          response.once('drain', drain);
          if (closed) finish(false);
        });
      };
      const heartbeat = setInterval(() => {
        if (!closed && response.writableLength === 0) void frame(': heartbeat\n\n');
      }, 15000);
      heartbeat.unref();
      clients.add(close);
      response.once('close', close);
      response.once('error', close);
      return {
        send: (event: AgentEvent) =>
          frame(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        close,
      };
    },
    close() {
      stopped = true;
      for (const close of [...clients]) close();
    },
  };
}
