import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@foodops/shared';
import { z } from 'zod';

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const claimsSchema = z.strictObject({
  v: z.literal(1),
  tool: z.string().min(1).max(100),
  args: z.string().regex(/^[a-f0-9]{64}$/),
  preview: z.string().regex(/^[a-f0-9]{64}$/),
  expiry: z.number().int().positive().safe(),
});
type Claims = z.infer<typeof claimsSchema>;
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
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function argumentsDigest(args: Record<string, unknown>): string {
  return digest(
    Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => !['action', 'confirmation_token', 'idempotency_key'].includes(key),
      ),
    ),
  );
}
export function createConfirmationGate(options: { secret?: string; now?: () => number } = {}) {
  if (
    options.secret !== undefined &&
    (options.secret.length < 32 || options.secret.trim() !== options.secret)
  )
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid confirmation secret',
      'Use MCP_CONFIRM_SECRET with at least 32 characters and no surrounding whitespace',
    );
  const secret =
    options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
  const now = options.now ?? Date.now;
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  return {
    issue(tool: string, args: Record<string, unknown>, preview: unknown) {
      const expiry = now() + CONFIRMATION_TTL_MS;
      const claims = claimsSchema.parse({
        v: 1,
        tool,
        args: argumentsDigest(args),
        preview: digest(preview),
        expiry,
      });
      const payload = Buffer.from(canonical(claims)).toString('base64url');
      return {
        confirmation_token: payload + '.' + sign(payload).toString('base64url'),
        expires_at: new Date(expiry).toISOString(),
      };
    },
    authenticate(token: string): Claims {
      if (token.length > 2048) throw confirmationRequired();
      const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) throw confirmationRequired();
      const payload = match[1]!;
      const supplied = Buffer.from(match[2]!, 'base64url');
      const expected = sign(payload);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(expected, supplied) ||
        supplied.toString('base64url') !== match[2]
      )
        throw confirmationRequired();
      try {
        const bytes = Buffer.from(payload, 'base64url');
        if (bytes.toString('base64url') !== payload) throw confirmationRequired();
        return claimsSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        throw confirmationRequired();
      }
    },
    assertArguments(claims: Claims, tool: string, args: Record<string, unknown>): void {
      if (claims.tool !== tool || claims.args !== argumentsDigest(args))
        throw confirmationRequired();
    },
    assertCurrent(claims: Claims, preview: unknown): void {
      if (
        now() >= claims.expiry ||
        claims.expiry > now() + CONFIRMATION_TTL_MS ||
        claims.preview !== digest(preview)
      )
        throw confirmationRequired();
    },
  };
}
export type ConfirmationGate = ReturnType<typeof createConfirmationGate>;

interface WriteControls extends Record<string, unknown> {
  action?: 'preview' | 'execute' | undefined;
  confirmation_token?: string | undefined;
  idempotency_key?: string | undefined;
}
export function writeFlow<P, R>(options: {
  tool: string;
  input: WriteControls;
  confirmation: ConfirmationGate;
  preview: () => P;
  replay: () => R | undefined;
  execute: (preview: P) => R;
}) {
  const { input, confirmation } = options;
  if (input.action === 'preview' && input.confirmation_token !== undefined)
    throw new AppError(
      ErrorCode.VALIDATION,
      'Preview cannot include a confirmation token',
      'Omit the token to preview or use action:execute',
    );
  if (input.action !== 'execute' && input.confirmation_token === undefined) {
    const preview = options.preview();
    return {
      preview,
      ...confirmation.issue(options.tool, input, preview),
      requires_user_approval: true as const,
    };
  }
  if (!input.confirmation_token) throw confirmationRequired();
  const claims = confirmation.authenticate(input.confirmation_token);
  const replay = options.replay();
  confirmation.assertArguments(claims, options.tool, input);
  if (replay !== undefined) return { requires_user_approval: false as const, result: replay };
  let preview: P;
  try {
    preview = options.preview();
  } catch (error) {
    if (error instanceof AppError && error.code !== ErrorCode.INTERNAL)
      throw confirmationRequired();
    throw error;
  }
  confirmation.assertCurrent(claims, preview);
  try {
    return { requires_user_approval: false as const, result: options.execute(preview) };
  } catch (error) {
    if (
      error instanceof AppError &&
      error.details !== null &&
      typeof error.details === 'object' &&
      'precondition' in error.details &&
      error.details.precondition === 'preview_changed'
    )
      throw confirmationRequired();
    throw error;
  }
}
