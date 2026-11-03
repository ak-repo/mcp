import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@foodops/shared';
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export interface ConfirmationContext {
  channel: 'mcp' | 'rest';
  operation: string;
  args: Record<string, unknown>;
  preview: unknown;
}
export interface ConfirmationClaims {
  v: 1;
  tool: string;
  args: string;
  preview: string;
  expiry: number;
}
export function confirmationRequired(): AppError {
  return new AppError(
    ErrorCode.CONFIRMATION_REQUIRED,
    'Execution requires a valid token for the current preview',
    'Obtain a fresh preview, show it to the user, obtain explicit approval, then execute with its confirmation_token',
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child))
        .join(',') +
      '}'
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Confirmation data must be JSON');
  return result;
}
export function confirmationDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function createConfirmationSigner(
  options: { secret?: string; ttlMs?: number; now?: () => number } = {},
) {
  const ttl = options.ttlMs ?? CONFIRMATION_TTL_MS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    (options.secret !== undefined &&
      (options.secret.length < 32 || options.secret.trim() !== options.secret))
  )
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid confirmation secret or lifetime',
      'Use a secret with at least 32 characters and a positive integer lifetime',
    );
  const secret =
    options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
  const now = options.now ?? (() => Date.now());
  const signature = (channel: ConfirmationContext['channel'], payload: string) =>
    createHmac('sha256', secret)
      .update('foodops-confirmation\0' + channel + '\0' + payload)
      .digest();
  const authenticate = (
    token: string,
    channel: ConfirmationContext['channel'],
  ): ConfirmationClaims => {
    if (token.length > 2048) throw confirmationRequired();
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw confirmationRequired();
    const payload = match[1]!;
    const supplied = Buffer.from(match[2]!, 'base64url');
    const expected = signature(channel, payload);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied) ||
      supplied.toString('base64url') !== match[2]
    )
      throw confirmationRequired();
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) throw confirmationRequired();
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw confirmationRequired();
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'args,expiry,preview,tool,v' ||
        record.v !== 1 ||
        typeof record.tool !== 'string' ||
        !record.tool.length ||
        record.tool.length > 100 ||
        typeof record.args !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.args) ||
        typeof record.preview !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.preview) ||
        typeof record.expiry !== 'number' ||
        !Number.isSafeInteger(record.expiry) ||
        record.expiry <= 0
      )
        throw confirmationRequired();
      return record as unknown as ConfirmationClaims;
    } catch {
      throw confirmationRequired();
    }
  };
  const assertArguments = (
    claims: ConfirmationClaims,
    context: Pick<ConfirmationContext, 'operation' | 'args'>,
  ) => {
    if (claims.tool !== context.operation || claims.args !== confirmationDigest(context.args))
      throw confirmationRequired();
  };
  const assertExpiry = (claims: ConfirmationClaims) => {
    const time = now();
    if (time >= claims.expiry || claims.expiry > time + ttl) throw confirmationRequired();
  };
  const assertCurrent = (claims: ConfirmationClaims, preview: unknown) => {
    assertExpiry(claims);
    if (claims.preview !== confirmationDigest(preview))
      throw new AppError(
        ErrorCode.CONFLICT,
        'Operation preview changed',
        'Re-run the preview and confirm again',
        { precondition: 'preview_changed' },
      );
  };
  return {
    sign(context: ConfirmationContext) {
      const expiry = now() + ttl;
      if (!Number.isSafeInteger(expiry) || expiry <= 0) throw confirmationRequired();
      const claims: ConfirmationClaims = {
        v: 1,
        tool: context.operation,
        args: confirmationDigest(context.args),
        preview: confirmationDigest(context.preview),
        expiry,
      };
      const payload = Buffer.from(canonical(claims)).toString('base64url');
      return {
        confirmation_token:
          payload + '.' + signature(context.channel, payload).toString('base64url'),
        expires_at: new Date(expiry).toISOString(),
      };
    },
    authenticate,
    assertArguments,
    assertCurrent,
    verifyRequest(token: string, context: Omit<ConfirmationContext, 'preview'>) {
      const claims = authenticate(token, context.channel);
      assertArguments(claims, context);
      assertExpiry(claims);
      return claims;
    },
    verify(token: string, context: ConfirmationContext) {
      const claims = authenticate(token, context.channel);
      assertArguments(claims, context);
      assertCurrent(claims, context.preview);
      return claims;
    },
  };
}
export type ConfirmationSigner = ReturnType<typeof createConfirmationSigner>;
