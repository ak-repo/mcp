import type { StreamTicketResponse } from '@foodops/shared';
import { ApiError, ContractError } from '../api/errors.js';
import { createEventBus, type LiveEvent } from './events.js';
import { readSse } from './sse-reader.js';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';
export interface LiveSnapshot {
  status: LiveStatus;
  message: string;
  events: readonly LiveEvent[];
}

export function createLiveManager(deps: {
  ticket: (signal: AbortSignal) => Promise<StreamTicketResponse>;
  open: (
    ticket: string,
    cursor: number | undefined,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  invalidateAll: () => void;
  onEvent: (event: LiveEvent) => void;
  clearBatch: () => void;
  random?: () => number;
}) {
  let snapshot: LiveSnapshot = { status: 'offline', message: 'Sign in to connect.', events: [] };
  const listeners = new Set<() => void>();
  const bus = createEventBus();
  let generation = 0;
  let enabled = false;
  let online = true;
  let paused = false;
  let cursor: number | undefined;
  let failures = 0;
  let controller: AbortController | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  let needsResync = true;
  function publish(status: LiveStatus, message: string, events = snapshot.events) {
    snapshot = { status, message, events };
    listeners.forEach((listener) => listener());
  }
  function disconnect() {
    generation++;
    controller?.abort();
    controller = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  async function connect() {
    if (!enabled || !online || paused) return;
    disconnect();
    const mine = generation;
    const active = new AbortController();
    controller = active;
    const current = () => generation === mine && !active.signal.aborted;
    publish(failures ? 'reconnecting' : 'connecting', 'Connecting to live updates…');
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The connection deadline ends once headers arrive, not during the SSE body.
      connectTimer = setTimeout(() => active.abort(), 15000);
      const issued = await deps.ticket(active.signal);
      if (!current()) return;
      const body = await deps.open(issued.ticket, cursor, active.signal);
      clearTimeout(connectTimer);
      if (!current()) {
        await body.cancel();
        return;
      }
      publish('live', 'Receiving live updates.');
      if (needsResync) {
        deps.invalidateAll();
        needsResync = false;
      }
      await readSse(body, active.signal, (event) => {
        if (!current()) return;
        if (event.type !== 'mcp.call') {
          if (cursor !== undefined && event.data.id <= cursor) return;
          cursor = event.data.id;
        }
        failures = 0;
        deps.onEvent(event);
        bus.publish(event);
        publish('live', 'Receiving live updates.', [event, ...snapshot.events].slice(0, 20));
      });
      if (!current()) return;
      throw new Error('Stream closed.');
    } catch (error) {
      if (generation !== mine || !enabled || !online || paused) return;
      if (error instanceof ContractError) {
        deps.invalidateAll();
        publish('offline', 'Live response format was unexpected. Retry the connection.');
        return;
      }
      if (error instanceof ApiError && error.status === 409 && cursor !== undefined) {
        cursor = undefined;
        needsResync = true;
        deps.invalidateAll();
      }
      failures++;
      const delay = Math.max(
        Math.min(
          30000,
          1000 * 2 ** Math.min(failures - 1, 5) * (1 + (deps.random ?? Math.random)() * 0.2),
        ),
        error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0,
      );
      publish('reconnecting', 'Connection interrupted. Reconnecting…');
      retryTimer = setTimeout(
        () => {
          void connect();
        },
        Math.min(delay, 2147483647),
      );
    } finally {
      clearTimeout(connectTimer);
    }
  }
  return {
    bus,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start() {
      if (enabled) return;
      enabled = true;
      void connect();
    },
    stop() {
      enabled = false;
      disconnect();
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      paused = false;
      cursor = undefined;
      failures = 0;
      needsResync = true;
      deps.clearBatch();
      publish('offline', 'Sign in to connect.', []);
    },
    setOnline(value: boolean) {
      if (online === value) return;
      online = value;
      if (!value) {
        disconnect();
        publish('offline', 'Browser is offline.');
      } else {
        needsResync = true;
        void connect();
      }
    },
    setHidden(hidden: boolean) {
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (hidden && enabled) {
        hiddenTimer = setTimeout(() => {
          paused = true;
          disconnect();
          publish('offline', 'Live updates paused while this tab is hidden.');
        }, 60000);
      } else if (!hidden && paused) {
        paused = false;
        needsResync = true;
        deps.invalidateAll();
        void connect();
      }
    },
    retry() {
      failures = 0;
      needsResync = true;
      void connect();
    },
  };
}
