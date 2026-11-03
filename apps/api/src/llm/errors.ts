export type LLMErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'model_not_found'
  | 'context_overflow'
  | 'bad_request'
  | 'provider_error'
  | 'network'
  | 'aborted';
export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:authorization|x-api-key|api_key)["']?\s*[:=]\s*["']?)[^\r\n"'}]+/gi,
      '$1[REDACTED]',
    );
}
export class LLMError extends Error {
  constructor(
    public readonly kind: LLMErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly status?: number,
  ) {
    super(redact(message));
    this.name = 'LLMError';
  }
}
export function aborted(): LLMError {
  return new LLMError('aborted', 'LLM request was cancelled', false);
}
export function protocolError(): LLMError {
  return new LLMError(
    'provider_error',
    'The provider returned an invalid or incomplete response',
    false,
  );
}
export function httpError(status: number, body: string, retryAfterMs?: number): LLMError {
  if (status === 401 || status === 403)
    return new LLMError(
      'auth',
      'Provider authentication failed; check LLM_API_KEY',
      false,
      undefined,
      status,
    );
  if (status === 404)
    return new LLMError(
      'model_not_found',
      'The provider could not find the requested model or endpoint',
      false,
      undefined,
      status,
    );
  if (status === 429)
    return new LLMError(
      'rate_limit',
      'Provider rate limit exceeded; retry later',
      true,
      retryAfterMs,
      status,
    );
  if (status >= 500)
    return new LLMError(
      'provider_error',
      'The provider is temporarily unavailable',
      true,
      undefined,
      status,
    );
  if (
    status === 400 &&
    /context.{0,30}(length|window|limit|exceed|large)|too many tokens|input.{0,20}too long/i.test(
      body,
    )
  )
    return new LLMError(
      'context_overflow',
      'The request exceeds the model context window; shorten the conversation',
      false,
      undefined,
      status,
    );
  return new LLMError(
    'bad_request',
    'The provider rejected the request; check the model and generation options',
    false,
    undefined,
    status,
  );
}
