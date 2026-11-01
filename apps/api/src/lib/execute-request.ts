import { AppError, ErrorCode } from '@foodops/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validate } from './validate.js';
import { EmptyQuerySchema, IdempotencyHeaderSchema } from '../routes/schemas.js';

/** HTTP approval and replay metadata only; execution remains transactional in core. */
export function executeRequest<S extends z.ZodType, I, R>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: S,
  toInput: (body: z.output<S>, key: string) => I,
  replay: (input: I) => R | undefined,
  execute: (input: I) => R,
): R {
  validate(EmptyQuerySchema, request.query);
  let count = 0;
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2)
    if (request.raw.rawHeaders[i]?.toLowerCase() === 'idempotency-key') count++;
  if (count !== 1)
    throw new AppError(
      ErrorCode.VALIDATION,
      'Exactly one Idempotency-Key header is required',
      'Supply a unique key of 8–128 characters using letters, digits, dot, underscore, colon, or hyphen',
    );
  const key = validate(IdempotencyHeaderSchema, request.headers['idempotency-key']);
  const body = validate(schema, request.body);
  if (!(body !== null && typeof body === 'object' && 'confirm' in body && body.confirm === true))
    throw new AppError(
      ErrorCode.CONFIRMATION_REQUIRED,
      'Explicit confirmation is required',
      'Review the preview with the user, then submit confirm: true to this execute endpoint',
    );
  const input = toInput(body, key);
  const cached = replay(input);
  if (cached !== undefined) {
    reply.header('Idempotency-Replayed', 'true');
    return cached;
  }
  return execute(input);
}
