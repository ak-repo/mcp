import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '../llm/types.js';
import { boundHistory } from './history.js';
export function createSessions(options: { now?: () => number; max?: number; ttlMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const sessions = new Map<
    string,
    { history: NormalizedMessage[]; touched: number; active: boolean }
  >();
  let closed = false;
  return {
    acquire(id: string = randomUUID()) {
      if (closed) throw new Error('Session store is closed');
      for (const [key, session] of sessions)
        if (!session.active && now() - session.touched >= (options.ttlMs ?? 1800000))
          sessions.delete(key);
      let session = sessions.get(id);
      if (session?.active) throw new Error('Session already has an active run');
      if (!session) {
        if (sessions.size >= (options.max ?? 100)) {
          const idle = [...sessions]
            .filter(([, s]) => !s.active)
            .sort((a, b) => a[1].touched - b[1].touched)[0];
          if (!idle) throw new Error('All session slots have active runs');
          sessions.delete(idle[0]);
        }
        session = { history: [], touched: now(), active: false };
        sessions.set(id, session);
      }
      session.active = true;
      const selected = session;
      let released = false;
      return {
        id,
        history: structuredClone(session.history),
        release(history?: readonly NormalizedMessage[]) {
          if (released) return;
          released = true;
          if (history) selected.history = boundHistory(history);
          selected.active = false;
          selected.touched = now();
        },
      };
    },
    close() {
      closed = true;
      sessions.clear();
    },
    get size() {
      return sessions.size;
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
