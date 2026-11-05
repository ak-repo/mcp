import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { MeResponseSchema } from '@foodops/shared';
import { Eye, EyeOff, ArrowRight, UtensilsCrossed } from 'lucide-react';
import { authStore, useAuth } from '../../lib/api/auth-store.js';
import { apiFetch } from '../../lib/api/client.js';
import { ApiError } from '../../lib/api/errors.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';

export function LoginPage() {
  const auth = useAuth();
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (auth.authenticated) return <Navigate to="/" replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const candidate = token;
    const generation = authStore.getSnapshot().generation;
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setMessage('Validating your token…');
    try {
      await apiFetch('/api/me', MeResponseSchema, { token: candidate, signal: active.signal });
      if (!active.signal.aborted && authStore.getSnapshot().generation === generation)
        authStore.login(candidate);
    } catch (error) {
      if (active.signal.aborted) return;
      setMessage(
        error instanceof ApiError && error.status === 401
          ? 'Invalid token. Check the token and try again.'
          : error instanceof ApiError && error.status === 429
            ? `Sign-in is rate limited. Try again in ${Math.max(1, Math.ceil((error.retryAfterMs ?? 60000) / 1000))} seconds.`
            : 'Could not sign in. The API may be unreachable or unavailable.',
      );
    } finally {
      if (!active.signal.aborted) {
        setToken('');
        setPending(false);
      }
    }
  }
  return (
    <main className="login-layout" id="main-content">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <UtensilsCrossed aria-hidden="true" />
          </span>
          FoodOps
        </div>
        <div>
          <p className="eyebrow">A CLEAR VIEW OF EVERY MOVE</p>
          <h1>
            Good food.
            <br />
            Smooth operations.
          </h1>
          <p>
            One workspace to stay connected to the kitchen, the road, and everything in between.
          </p>
        </div>
        <p className="text-sm">Operations console · INR · India</p>
      </section>
      <section className="login-form-panel">
        <form
          className="login-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <p className="eyebrow">WELCOME TO FOODOPS</p>
          <h2>Sign in to your workspace</h2>
          <p className="muted">Use your administrator token to connect.</p>
          <div className="space-y-2">
            <Label htmlFor="admin-token">Administrator token</Label>
            <div className="password-field">
              <Input
                id="admin-token"
                name="token"
                type={visible ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={pending}
                aria-describedby="token-help"
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={visible ? 'Hide token' : 'Show token'}
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </Button>
            </div>
          </div>
          <Button type="submit" disabled={pending || !token.trim()} className="w-full">
            {pending ? 'Signing in…' : 'Sign in'}
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
          <div role="status" aria-live="polite" className="login-message">
            {message || auth.message}
          </div>
          <p id="token-help" className="security-note">
            Your token stays in browser memory. Refreshing this page requires signing in again.
          </p>
        </form>
      </section>
    </main>
  );
}
