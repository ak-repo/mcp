// Keep preference names and validation aligned with lib/preferences.ts.
(() => {
  let theme = 'system';
  let density = 'comfortable';
  try {
    const savedTheme = localStorage.getItem('foodops.theme');
    const savedDensity = localStorage.getItem('foodops.density');
    if (['system', 'light', 'dark'].includes(savedTheme)) theme = savedTheme;
    if (['comfortable', 'compact'].includes(savedDensity)) density = savedDensity;
  } catch {
    /* Storage is optional. */
  }
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = density;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
