import { z } from 'zod';
import { MAX_PAISE } from '../money.js';

export const IdSchema = z.string().min(1).regex(/\S/, 'Must not be blank');
export const TextSchema = z.string().min(1).regex(/\S/, 'Must not be blank');
export const TimestampSchema = z.iso.datetime();
export const DateBoundarySchema = z.union([z.iso.date(), TimestampSchema]);
export const PaiseSchema = z.number().int().min(0).max(MAX_PAISE);
export const JsonTextSchema = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, 'Must contain valid JSON');
export const ActorSchema = z.enum(['system', 'ops', 'ai']);
export type Actor = z.infer<typeof ActorSchema>;

export function validateDateRange(
  value: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    value.from !== undefined &&
    value.to !== undefined &&
    Date.parse(value.from) > Date.parse(value.to)
  ) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be on or after from' });
  }
}
