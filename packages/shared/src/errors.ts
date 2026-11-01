export enum ErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION = 'VALIDATION',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED',
  CONFLICT = 'CONFLICT',
  INTERNAL = 'INTERNAL',
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toToolText(): string {
    const message = this.message.trim().replace(/[.!?]+$/, '');
    return `${this.code}: ${message}.${this.hint ? ` Hint: ${this.hint}` : ''}`;
  }
}
