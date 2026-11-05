import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';
const media = window.matchMedia('(prefers-color-scheme: dark)');
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const savedTheme = read('foodops.theme');
const savedDensity = read('foodops.density');
let snapshot: { theme: Theme; density: Density; resolvedTheme: 'light' | 'dark' } = {
  theme: savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system',
  density: savedDensity === 'compact' ? 'compact' : 'comfortable',
  resolvedTheme: 'light',
};
const listeners = new Set<() => void>();
function apply() {
  const resolvedTheme =
    snapshot.theme === 'system' ? (media.matches ? 'dark' : 'light') : snapshot.theme;
  snapshot = { ...snapshot, resolvedTheme };
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.density = snapshot.density;
  document.documentElement.style.colorScheme = resolvedTheme;
  listeners.forEach((listener) => listener());
}
apply();
function subscribe(listener: () => void) {
  if (!listeners.size) media.addEventListener('change', apply);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) media.removeEventListener('change', apply);
  };
}
export function setPreferences(values: { theme?: Theme; density?: Density }) {
  snapshot = { ...snapshot, ...values };
  try {
    localStorage.setItem('foodops.theme', snapshot.theme);
    localStorage.setItem('foodops.density', snapshot.density);
  } catch {
    /* Preferences still work in memory. */
  }
  apply();
}
export function usePreferences() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
