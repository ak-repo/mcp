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
