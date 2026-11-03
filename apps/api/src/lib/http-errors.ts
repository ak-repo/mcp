import { AppError, ErrorCode } from '@foodops/shared';
export type HttpErrorCode = ErrorCode | 'UNAUTHORIZED' | 'FORBIDDEN';
export interface HttpErrorBody {
  error: { code: HttpErrorCode; message: string; hint: string };
}
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: HttpErrorCode,
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
/** Only application-owned, secret-free messages may cross the upstream boundary. */
export class UpstreamHttpError extends HttpError {
  constructor(message: string, hint: string) {
    super(502, ErrorCode.INTERNAL, message, hint);
  }
}
const statuses: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.INVALID_TRANSITION]: 409,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.LIMIT_EXCEEDED]: 422,
  [ErrorCode.CONFIRMATION_REQUIRED]: 428,
  [ErrorCode.INTERNAL]: 500,
};
export function mapHttpError(error: unknown): { status: number; body: HttpErrorBody } {
  let status = 500;
  let code: HttpErrorCode = ErrorCode.INTERNAL;
  let message = 'The request could not be completed';
  let hint = 'Retry later; contact the operator with X-Request-Id if the problem persists';
  if (error instanceof UpstreamHttpError) {
    status = 502;
    message = error.message;
    hint = error.hint;
  } else if (error instanceof AppError && error.code !== ErrorCode.INTERNAL) {
    status = statuses[error.code];
    code = error.code;
    message = error.message;
    hint = error.hint ?? 'Check the request and current state before retrying';
  } else if (error instanceof HttpError && error.statusCode < 500) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
    hint = error.hint;
  } else if (error instanceof HttpError && error.statusCode === 503) {
    status = 503;
    message = 'Service is not ready';
    hint = 'Retry after the service becomes ready';
  } else if (error !== null && typeof error === 'object') {
    const frameworkCode = 'code' in error ? String(error.code) : '';
    const statusCode = 'statusCode' in error ? error.statusCode : undefined;
    if (frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      status = 413;
      code = ErrorCode.LIMIT_EXCEEDED;
      message = 'Request body exceeds 100 KB';
      hint = 'Send a body no larger than 102400 bytes';
    } else if (frameworkCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      status = 415;
      code = ErrorCode.VALIDATION;
      message = 'Unsupported content type';
      hint = 'Use Content-Type: application/json';
    } else if (statusCode === 400 || 'validation' in error) {
      status = 400;
      code = ErrorCode.VALIDATION;
      message = 'Invalid request';
      hint = 'Check JSON syntax, request fields, and documented types';
    } else if (statusCode === 429) {
      status = 429;
      code = ErrorCode.LIMIT_EXCEEDED;
      message = 'Too many requests';
      hint = 'Wait for the Retry-After interval before retrying';
    } else if (statusCode === 503) {
      status = 503;
      message = 'Service is not ready';
      hint = 'Retry after the service becomes ready';
    }
  }
  return { status, body: { error: { code, message, hint } } };
}
