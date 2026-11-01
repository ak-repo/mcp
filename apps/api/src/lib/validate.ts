import { AppError, ErrorCode } from '@foodops/shared';
import { z } from 'zod';
export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid request data',
      'Use only the documented fields, types, and limits',
    );
  return result.data;
}
