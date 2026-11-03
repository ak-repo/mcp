import { AppError, ErrorCode } from '@foodops/shared';
import {
  createConfirmationSigner,
  confirmationRequired,
  type ConfirmationClaims,
} from '@foodops/core';
export { CONFIRMATION_TTL_MS, confirmationRequired } from '@foodops/core';
function argumentsOnly(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key]) => !['action', 'confirmation_token', 'idempotency_key'].includes(key),
    ),
  );
}
export function createConfirmationGate(options: { secret?: string; now?: () => number } = {}) {
  const signer = createConfirmationSigner(options);
  return {
    issue(tool: string, args: Record<string, unknown>, preview: unknown) {
      return signer.sign({ channel: 'mcp', operation: tool, args: argumentsOnly(args), preview });
    },
    authenticate(token: string) {
      return signer.authenticate(token, 'mcp');
    },
    assertArguments(claims: ConfirmationClaims, tool: string, args: Record<string, unknown>) {
      signer.assertArguments(claims, { operation: tool, args: argumentsOnly(args) });
    },
    assertCurrent(claims: ConfirmationClaims, preview: unknown) {
      try {
        signer.assertCurrent(claims, preview);
      } catch {
        throw confirmationRequired();
      }
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
