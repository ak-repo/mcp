import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { LoginPage } from './login-page.js';
import { ProtectedRoute } from './protected-route.js';
import { authStore } from '../../lib/api/auth-store.js';

beforeEach(() => authStore.logout());
function show() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<p>Protected workspace</p>} />
        </Route>
        <Route path="/login" element={<LoginPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}
describe('login', () => {
  it('protects routes, shows the refresh notice, validates /me and enters the workspace', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ actor: 'ops', auth: 'bearer' })));
    vi.stubGlobal('fetch', fetcher);
    const user = show();
    expect(screen.getByText(/Refreshing this page requires signing in again/)).toBeInTheDocument();
    const field = screen.getByLabelText('Administrator token');
    await user.type(field, 'private-login-test-token');
    await user.click(screen.getByRole('button', { name: 'Show token' }));
    expect(field).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(field).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Protected workspace')).toBeInTheDocument();
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/api\/me$/);
    expect(authStore.getSnapshot().authenticated).toBe(true);
    expect(localStorage.getItem('token')).toBeNull();
    authStore.logout();
    await waitFor(() => expect(screen.getByLabelText('Administrator token')).toBeInTheDocument());
  });
  it.each([
    [401, 'Invalid token. Check the token and try again.'],
    [429, 'Sign-in is rate limited. Try again in 9 seconds.'],
  ])('shows a distinct message for HTTP %s', async (status, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: status === 401 ? 'UNAUTHORIZED' : 'LIMIT_EXCEEDED',
              message: 'Request denied',
              hint: 'Retry later',
            },
          }),
          { status, headers: { 'Retry-After': '9' } },
        ),
      ),
    );
    const user = show();
    await user.type(screen.getByLabelText('Administrator token'), 'invalid-credential');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByLabelText('Administrator token')).toHaveValue('');
    expect(authStore.getToken()).toBeNull();
  });
  it('reports an unreachable API without exposing credentials or raw errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-value')));
    const user = show();
    await user.type(screen.getByLabelText('Administrator token'), 'secret-value');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/API may be unreachable/)).toBeInTheDocument();
    expect(screen.queryByText('secret-value')).not.toBeInTheDocument();
  });
});
