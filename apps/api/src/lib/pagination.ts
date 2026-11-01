import { PaginationSchema, type Pagination } from '@foodops/shared';
import { z } from 'zod';
import { validate } from './validate.js';
const querySchema = PaginationSchema.extend({
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[0-9]+$/)
        .transform(Number),
    ])
    .optional(),
});
export function parsePagination(query: unknown): Pagination {
  return validate(PaginationSchema, validate(querySchema, query));
}
export function pageResponse<T>(page: { items: T[]; next_cursor: string | null }): {
  data: T[];
  next_cursor: string | null;
} {
  return { data: page.items, next_cursor: page.next_cursor };
}

/** Convert HTTP primitives only; the shared schema owns validation and defaults. */
export function queryFilters<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return validate(schema, value);
  const query: Record<string, unknown> = { ...value };
  if (typeof query['limit'] === 'string' && /^[0-9]+$/.test(query['limit']))
    query['limit'] = Number(query['limit']);
  for (const key of ['open_now', 'veg_only', 'available_only']) {
    if (query[key] === 'true') query[key] = true;
    else if (query[key] === 'false') query[key] = false;
  }
  return validate(schema, query);
}
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
export function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Defined<T>;
}
