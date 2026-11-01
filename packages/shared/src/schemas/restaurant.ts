import { z } from 'zod';
import { IdSchema, TextSchema } from './common.js';
import { PaginationSchema } from './pagination.js';

export const RestaurantSchema = z.strictObject({
  id: IdSchema,
  name: TextSchema,
  cuisine: TextSchema,
  city: TextSchema,
  area: TextSchema,
  rating: z.number().min(0).max(5),
  prep_time_min: z.number().int().nonnegative(),
  is_open: z.boolean(),
});
export type Restaurant = z.infer<typeof RestaurantSchema>;

export const RestaurantListFiltersSchema = PaginationSchema.extend({
  query: TextSchema.optional(),
  cuisine: TextSchema.optional(),
  area: TextSchema.optional(),
  open_now: z.boolean().optional(),
});
export type RestaurantListFilters = z.infer<typeof RestaurantListFiltersSchema>;
