import type { Services } from '@foodops/core';
import type { Change } from '@foodops/shared';
import type { Logger } from 'pino';
export interface FeedEvent {
  id?: number;
  type:
    | 'order.updated'
    | 'delivery.updated'
    | 'partner.updated'
    | 'payment.updated'
    | 'invoice.updated'
    | 'mcp.call';
  data: Record<string, unknown>;
}
export function changeEvent(change: Change): FeedEvent {
  return {
    id: change.id,
    type: change.entity === 'refund' ? 'payment.updated' : `${change.entity}.updated`,
    data: {
      id: change.id,
      type: change.entity === 'refund' ? 'payment.updated' : `${change.entity}.updated`,
      order_id: change.order_id,
      entity: change.entity,
      at: change.at,
    },
  };
}
export function createChangeFeed(services: Services, logger: Logger, intervalMs: number) {
  const listeners = new Set<(event: FeedEvent) => void>();
  let changeId = 0;
  let callId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight: Promise<void> | undefined;
  let prunedAt = Date.now();
  function publish(event: FeedEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.error({ err: error }, 'Change-feed subscriber failed');
      }
    }
  }
  async function poll() {
    // Yield before reading so start/stop and tests share one explicit in-flight promise.
    await Promise.resolve();
    if (!running) return;
    try {
      for (let batch = 0; batch < 10; batch++) {
        const changes = services.audit.listChangesAfter(changeId, 1000);
        for (const change of changes) {
          publish(changeEvent(change));
          changeId = change.id;
        }
        if (changes.length < 1000) break;
      }
      for (let batch = 0; batch < 10; batch++) {
        const calls = services.audit.listCallsAfterRowId(callId, 1000);
        for (const { rowid, ...call } of calls) {
          publish({ type: 'mcp.call', data: call });
          callId = rowid;
        }
        if (calls.length < 1000) break;
      }
      if (Date.now() - prunedAt >= 3600000) {
        services.audit.pruneChangesBefore(new Date(Date.now() - 86400000).toISOString());
        prunedAt = Date.now();
      }
    } catch (error) {
      logger.error({ err: error }, 'Change-feed poll failed');
    }
  }
  function schedule() {
    if (!running) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = poll().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, intervalMs);
    timer.unref();
  }
  return {
    subscribe(listener: (event: FeedEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (running) return;
      changeId = services.audit.maxChangeId();
      callId = services.audit.maxCallRowId();
      running = true;
      prunedAt = Date.now();
      schedule();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
      listeners.clear();
    },
  };
}
export type ChangeFeed = ReturnType<typeof createChangeFeed>;
