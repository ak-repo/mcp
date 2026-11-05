import { ApiErrorEnvelopeSchema } from '@foodops/shared';
import { authStore, type createAuthStore } from './auth-store.js';
import { ApiError, ContractError, NetworkError, TimeoutError, retryAfter } from './errors.js';

export interface ResponseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}
type AuthStore = ReturnType<typeof createAuthStore>;
export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
  auth?: boolean;
  token?: string;
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

export function createApiClient(options: {
  origin: string;
  fetch?: typeof fetch;
  auth?: AuthStore;
}) {
  const base = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Invalid API origin.');
  const store = options.auth ?? authStore;
  const fetcher: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  function url(path: string): URL {
    const target = new URL(path, base);
    if (
      !path.startsWith('/api/') ||
      target.origin !== base.origin ||
      target.username ||
      target.password
    )
      throw new Error('Invalid API path.');
    return target;
  }
  async function check(response: Response, generation?: number, secret?: string): Promise<void> {
    // A bearer 401 invalidates the session even if its error body is malformed.
    if (response.status === 401 && generation !== undefined) store.expire(generation);
    if (response.ok) return;
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ContractError();
    }
    const parsed = ApiErrorEnvelopeSchema.safeParse(value);
    if (!parsed.success) throw new ContractError();
    const safe = (text: string) => (secret ? text.split(secret).join('[REDACTED]') : text);
    throw new ApiError(
      response.status,
      parsed.data.error.code,
      safe(parsed.data.error.message),
      safe(parsed.data.error.hint),
      safe(response.headers.get('X-Request-Id') ?? '') || null,
      retryAfter(response.headers.get('Retry-After')),
    );
  }
  async function apiFetch<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: ApiOptions = {},
  ): Promise<T> {
    const result = await apiFetchWithMeta(path, schema, init);
    return result.data;
  }
  async function apiFetchWithMeta<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: ApiOptions = {},
  ): Promise<ApiResponse<T>> {
    const target = url(path);
    const generation = store.getSnapshot().generation;
    const token = init.auth === false ? null : (init.token ?? store.getToken());
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, init.timeoutMs ?? 15000);
    const headers = new Headers({ Accept: 'application/json' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);
    try {
      controller.signal.throwIfAborted();
      const response = await fetcher(target, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      await check(response, token ? generation : undefined, token ?? undefined);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new ContractError();
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ContractError();
      return { data: parsed.data, headers: response.headers };
    } catch (error) {
      if (init.signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      if (timedOut) throw new TimeoutError();
      if (error instanceof ApiError || error instanceof ContractError) throw error;
      throw new NetworkError();
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    }
  }
  async function openStream(ticket: string, lastId: number | undefined, signal: AbortSignal) {
    const target = url(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
    const headers = new Headers({ Accept: 'text/event-stream' });
    if (lastId !== undefined) headers.set('Last-Event-ID', String(lastId));
    let response: Response;
    try {
      response = await fetcher(target, { headers, signal, credentials: 'omit', redirect: 'error' });
    } catch {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      throw new NetworkError();
    }
    await check(response);
    if (!response.headers.get('Content-Type')?.startsWith('text/event-stream') || !response.body)
      throw new ContractError();
    return response.body;
  }
  async function openChat(
    body: unknown,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const target = url('/api/chat');
    const generation = store.getSnapshot().generation;
    const token = store.getToken();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetcher(target, {
        method: 'POST',
        headers: new Headers({
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      await check(response, token ? generation : undefined, token ?? undefined);
      if (!response.headers.get('Content-Type')?.startsWith('text/event-stream') || !response.body)
        throw new ContractError();
      return response.body;
    } catch (error) {
      if (signal.aborted) throw new DOMException('Request cancelled.', 'AbortError');
      if (error instanceof ApiError || error instanceof ContractError) throw error;
      throw new NetworkError();
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return { apiFetch, apiFetchWithMeta, openStream, openChat };
}

export const api = createApiClient({
  origin: import.meta.env.VITE_API_BASE_URL || window.location.origin,
});
export const apiFetch = api.apiFetch;
export const apiFetchWithMeta = api.apiFetchWithMeta;
export const openChat = api.openChat;
