import type { ApprovalDecision } from '@foodops/shared';
export interface PendingApproval {
  runId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  preview: unknown;
  token: string;
  expiresAt: string;
  idempotencyKey: string;
}
export function createApprovals(options: { now?: () => number } = {}) {
  const pending = new Map<
    string,
    { value: PendingApproval; finish: (decision: ApprovalDecision) => void }
  >();
  const decisions = new Map<string, { decision: ApprovalDecision; at: number }>();
  const now = options.now ?? Date.now;
  let closed = false;
  const key = (runId: string, callId: string) => JSON.stringify([runId, callId]);
  return {
    wait(value: PendingApproval, signal?: AbortSignal): Promise<ApprovalDecision> {
      if (closed || signal?.aborted) return Promise.resolve('cancelled');
      if ([...pending.values()].some((entry) => entry.value.runId === value.runId))
        throw new Error('Run already has a pending approval');
      const ttl = Date.parse(value.expiresAt) - now();
      if (!Number.isFinite(ttl) || ttl <= 0) return Promise.resolve('expired');
      return new Promise((resolve) => {
        const id = key(value.runId, value.callId);
        const cancel = () => finish('cancelled');
        const timer = setTimeout(() => finish('expired'), Math.min(ttl, 2147483647));
        const finish = (decision: ApprovalDecision) => {
          if (!pending.delete(id)) return;
          decisions.set(id, { decision, at: now() });
          for (const [key, value] of decisions)
            if (now() - value.at >= 1800000) decisions.delete(key);
          while (decisions.size > 10000) decisions.delete(decisions.keys().next().value!);
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          resolve(decision);
        };
        pending.set(id, { value: structuredClone(value), finish });
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    resolve(
      runId: string,
      callId: string,
      decision: 'approved' | 'rejected' | 'cancelled',
    ): boolean {
      const entry = pending.get(key(runId, callId));
      if (!entry) return false;
      entry.finish(Date.parse(entry.value.expiresAt) <= now() ? 'expired' : decision);
      return true;
    },
    inspect(runId: string, callId: string): ApprovalDecision | 'pending' | undefined {
      const id = key(runId, callId);
      const entry = pending.get(id);
      if (entry && Date.parse(entry.value.expiresAt) <= now()) entry.finish('expired');
      if (pending.has(id)) return 'pending';
      const previous = decisions.get(id);
      if (previous && now() - previous.at < 1800000) return previous.decision;
      decisions.delete(id);
      return undefined;
    },
    cancelRun(runId: string) {
      for (const entry of pending.values())
        if (entry.value.runId === runId) entry.finish('cancelled');
    },
    close() {
      closed = true;
      for (const entry of pending.values()) entry.finish('cancelled');
    },
    get size() {
      return pending.size;
    },
  };
}
export type Approvals = ReturnType<typeof createApprovals>;
