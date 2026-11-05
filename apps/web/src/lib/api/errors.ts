import type { ApiErrorEnvelope } from '@foodops/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorEnvelope['error']['code'],
    message: string,
    public readonly hint: string,
    public readonly requestId: string | null,
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ContractError extends Error {
  constructor() {
    super('The API returned an unexpected response.');
    this.name = 'ContractError';
  }
}
export class NetworkError extends Error {
  constructor() {
    super('The API could not be reached.');
    this.name = 'NetworkError';
  }
}
export class TimeoutError extends Error {
  constructor() {
    super('The API request timed out.');
    this.name = 'TimeoutError';
  }
}

export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function queryRetry(failureCount: number, error: unknown): boolean {
  return (
    failureCount < 2 &&
    (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500))
  );
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many requests. Please wait before retrying.';
    if (error.status === 401) return 'Sign in again to continue.';
    return `${error.message} ${error.hint}`;
  }
  if (
    error instanceof ContractError ||
    error instanceof NetworkError ||
    error instanceof TimeoutError
  )
    return error.message;
  return 'Something went wrong. Please try again.';
}
