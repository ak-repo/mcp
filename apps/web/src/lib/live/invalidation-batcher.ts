import type { QueryKey } from '@tanstack/react-query';
import { hashKey } from '@tanstack/react-query';
import { queryKeys as keys } from '../api/query-keys.js';
import type { LiveEvent } from './events.js';

export function invalidationKeys(event: LiveEvent): QueryKey[] {
  if (event.type === 'mcp.call') return [keys.mcpCalls()];
  const id = event.data.order_id;
  const detail = id ? [keys.order(id)] : [];
  switch (event.type) {
    case 'order.updated':
      return [keys.orders(), ...detail, keys.deliveries(), keys.metrics()];
    case 'delivery.updated':
      return [keys.deliveries(), ...detail, keys.partners(), keys.metrics()];
    case 'partner.updated':
      return [keys.partners(), keys.deliveries(), ...detail];
    case 'payment.updated':
      return [keys.orders(), ...detail, ...(id ? [keys.invoice(id)] : []), keys.metrics()];
    case 'invoice.updated':
      return [...detail, ...(id ? [keys.invoice(id)] : [])];
  }
}

export function createInvalidationBatcher(invalidate: (key: QueryKey) => void) {
  const pending = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(event: LiveEvent) {
      for (const key of invalidationKeys(event)) pending.set(hashKey(key), key);
      timer ??= setTimeout(() => {
        timer = undefined;
        const keys = [...pending.values()];
        pending.clear();
        keys.forEach((key) => invalidate(key));
      }, 1000);
    },
    clear() {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
