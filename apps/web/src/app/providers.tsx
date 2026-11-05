import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { authStore } from '../lib/api/auth-store.js';
import { queryRetry } from '../lib/api/errors.js';
import { LiveProvider } from '../lib/live/live-provider.js';
import { TooltipProvider } from '../components/ui/tooltip.js';
import { Toaster } from '../components/ui/sonner.js';

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: queryRetry,
            retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
            staleTime: 15000,
          },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(
    () =>
      authStore.subscribe(() => {
        if (!authStore.getSnapshot().authenticated) {
          void client.cancelQueries();
          client.clear();
        }
      }),
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={350}>
        <LiveProvider>
          {children}
          <Toaster />
        </LiveProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
