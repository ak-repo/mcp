import source from '../../public/theme-init.js?raw';
import { describe, expect, it, vi } from 'vitest';

function initialize(values: Record<string, string>, dark = false, blocked = false) {
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const storage = {
    getItem: (key: string) => {
      if (blocked) throw new Error('Storage blocked');
      return values[key] ?? null;
    },
  };
  const media = vi.fn(() => ({ matches: dark }));
  const run = new Function('document', 'localStorage', 'matchMedia', source);
  run({ documentElement: root }, storage, media);
  return root;
}
describe('external theme initialization', () => {
  it('follows system default before React starts', () => {
    expect(initialize({}, true)).toMatchObject({
      dataset: { theme: 'dark', density: 'comfortable' },
      style: { colorScheme: 'dark' },
    });
    expect(initialize({}, false).dataset.theme).toBe('light');
  });
  it('honors explicit theme and density preferences', () => {
    expect(
      initialize({ 'foodops.theme': 'light', 'foodops.density': 'compact' }, true).dataset,
    ).toEqual({ theme: 'light', density: 'compact' });
    expect(initialize({ 'foodops.theme': 'dark' }, false).dataset.theme).toBe('dark');
  });
  it('handles invalid preferences and unavailable storage', () => {
    expect(
      initialize({ 'foodops.theme': 'invalid', 'foodops.density': 'invalid' }, true).dataset,
    ).toEqual({ theme: 'dark', density: 'comfortable' });
    expect(initialize({}, true, true).dataset.theme).toBe('dark');
  });
});
