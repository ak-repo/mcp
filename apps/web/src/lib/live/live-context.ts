import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { createLiveManager } from './live-manager.js';
import type { LiveEvent } from './events.js';

export type LiveManager = ReturnType<typeof createLiveManager>;
export const LiveContext = createContext<LiveManager | null>(null);
export function useLiveManager() {
  const manager = useContext(LiveContext);
  if (!manager) throw new Error('LiveProvider is required.');
  return manager;
}
export function useLive() {
  const manager = useLiveManager();
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot);
}
export function useLiveEvents<T extends LiveEvent['type']>(
  type: T,
  handler: (event: Extract<LiveEvent, { type: T }>) => void,
) {
  const manager = useLiveManager();
  const current = useRef(handler);
  useEffect(() => {
    current.current = handler;
  }, [handler]);
  useEffect(
    () =>
      manager.bus.subscribe((event) => {
        if (event.type === type) current.current(event as Parameters<typeof handler>[0]);
      }),
    [manager, type],
  );
}
