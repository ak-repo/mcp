import { useSyncExternalStore } from 'react';

type AuthSnapshot = { authenticated: boolean; generation: number; message: string };

export function createAuthStore() {
  let token: string | null = null;
  let snapshot: AuthSnapshot = { authenticated: false, generation: 0, message: '' };
  const listeners = new Set<() => void>();
  function publish(message: string) {
    snapshot = { authenticated: token !== null, generation: snapshot.generation + 1, message };
    listeners.forEach((listener) => listener());
  }
  return {
    getToken: () => token,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    login(value: string) {
      token = value;
      publish('');
    },
    logout(message = '') {
      token = null;
      publish(message);
    },
    expire(generation: number) {
      if (snapshot.generation === generation) {
        token = null;
        publish('Your session expired. Sign in again.');
      }
    },
  };
}

export const authStore = createAuthStore();
export const useAuth = () => useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
