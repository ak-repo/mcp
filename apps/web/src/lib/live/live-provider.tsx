import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StreamTicketResponseSchema } from '@foodops/shared';
import { api } from '../api/client.js';
import { useAuth } from '../api/auth-store.js';
import { queryKeys } from '../api/query-keys.js';
import { createInvalidationBatcher } from './invalidation-batcher.js';
import { createLiveManager } from './live-manager.js';
import { LiveContext } from './live-context.js';

export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const [manager] = useState(() => {
    const batcher = createInvalidationBatcher((queryKey) => {
      void queryClient.invalidateQueries({ queryKey });
    });
    return createLiveManager({
      ticket: (signal) =>
        api.apiFetch('/api/stream/ticket', StreamTicketResponseSchema, { method: 'POST', signal }),
      open: api.openStream,
      invalidateAll: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.all });
      },
      onEvent: batcher.add,
      clearBatch: batcher.clear,
    });
  });
  useEffect(() => {
    if (!auth.authenticated) return;
    const online = () => manager.setOnline(navigator.onLine);
    const hidden = () => manager.setHidden(document.hidden);
    online();
    manager.start();
    hidden();
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
      document.removeEventListener('visibilitychange', hidden);
      manager.stop();
    };
  }, [manager, auth.authenticated, auth.generation]);
  return <LiveContext.Provider value={manager}>{children}</LiveContext.Provider>;
}
