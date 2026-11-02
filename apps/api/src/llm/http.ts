import { aborted, httpError, LLMError, protocolError } from './errors.js';
export interface HttpOptions {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
}
export interface HttpStream {
  response: Response;
  chunks: AsyncIterable<Uint8Array>;
  close(): void;
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim()))
    return Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export async function openHttp(
  url: string,
  init: RequestInit,
  options: HttpOptions,
  fetcher: typeof fetch = fetch,
): Promise<HttpStream> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  arm(options.firstByteTimeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };
  const failure = (error: unknown): LLMError => {
    if (options.signal?.aborted) return aborted();
    if (timedOut) return new LLMError('timeout', 'The provider response timed out', true);
    if (error instanceof LLMError) return error;
    return new LLMError('network', 'Could not communicate with the LLM provider', true);
  };
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (!response.body) throw protocolError();
    reader = response.body.getReader();
    async function* chunks(): AsyncIterable<Uint8Array> {
      try {
        while (true) {
          const part = await reader!.read();
          if (controller.signal.aborted) throw failure(undefined);
          if (part.done) return;
          arm(options.idleTimeoutMs);
          yield part.value;
        }
      } catch (error) {
        throw failure(error);
      } finally {
        close();
        reader?.releaseLock();
      }
    }
    const stream = chunks();
    if (!response.ok) {
      let body = '';
      try {
        for await (const chunk of stream) {
          body += new TextDecoder().decode(chunk);
          if (body.length > 65536) break;
        }
      } finally {
        close();
      }
      throw httpError(response.status, body, retryAfter(response.headers.get('retry-after')));
    }
    return { response, chunks: stream, close };
  } catch (error) {
    close();
    throw failure(error);
  }
}
const MAX_RECORD = 1024 * 1024;
export async function* readLines(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        if (Buffer.byteLength(line) > MAX_RECORD) throw protocolError();
        buffer = buffer.slice(end + 1);
        yield line;
      }
      if (Buffer.byteLength(buffer) > MAX_RECORD) throw protocolError();
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, '');
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw protocolError();
  }
}
export async function* readNdjson(chunks: AsyncIterable<Uint8Array>): AsyncIterable<unknown> {
  for await (const line of readLines(chunks)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      throw protocolError();
    }
  }
}
export interface SseFrame {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}
export async function* readSse(chunks: AsyncIterable<Uint8Array>): AsyncIterable<SseFrame> {
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let bytes = 0;
  for await (const line of readLines(chunks)) {
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_RECORD) throw protocolError();
    if (line === '') {
      if (data.length)
        yield {
          data: data.join('\n'),
          ...(event === undefined ? {} : { event }),
          ...(id === undefined ? {} : { id }),
          ...(retry === undefined ? {} : { retry }),
        };
      data = [];
      event = undefined;
      retry = undefined;
      bytes = 0;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
      retry = Number(value);
  }
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    let remaining = ms;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(aborted());
    };
    const step = () => {
      const delay = Math.min(remaining, 2147483647);
      remaining -= delay;
      timer = setTimeout(() => {
        if (remaining > 0) step();
        else {
          signal?.removeEventListener('abort', cancel);
          resolve();
        }
      }, delay);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    step();
  });
}
export async function* withRetry<T>(
  attempt: () => AsyncIterable<T>,
  options: { maxRetries: number; signal?: AbortSignal; random?: () => number },
): AsyncIterable<T> {
  let yielded = false;
  for (let retry = 0; ; retry++) {
    if (options.signal?.aborted) throw aborted();
    try {
      for await (const event of attempt()) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (
        yielded ||
        !(error instanceof LLMError) ||
        !error.retryable ||
        retry >= options.maxRetries
      )
        throw error;
      const jitter = Math.floor(
        (options.random ?? Math.random)() * Math.min(30000, 500 * 2 ** retry),
      );
      await sleep(Math.max(jitter, error.retryAfterMs ?? 0), options.signal);
    }
  }
}
