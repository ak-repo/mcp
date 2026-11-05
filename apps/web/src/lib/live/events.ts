import type { LiveChangeEvent, McpCallEvent } from '@foodops/shared';

export type LiveEvent =
  | {
      [T in LiveChangeEvent['type']]: { type: T; data: Extract<LiveChangeEvent, { type: T }> };
    }[LiveChangeEvent['type']]
  | { type: 'mcp.call'; data: McpCallEvent };

export function createEventBus() {
  const handlers = new Set<(event: LiveEvent) => void>();
  return {
    publish(event: LiveEvent) {
      handlers.forEach((handler) => handler(event));
    },
    subscribe(handler: (event: LiveEvent) => void) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    clear() {
      handlers.clear();
    },
  };
}
