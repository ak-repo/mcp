import { Toaster as Primitive } from 'sonner';
import { usePreferences } from '../../lib/preferences.js';
export function Toaster() {
  const { resolvedTheme } = usePreferences();
  return <Primitive theme={resolvedTheme} richColors closeButton position="bottom-right" />;
}
