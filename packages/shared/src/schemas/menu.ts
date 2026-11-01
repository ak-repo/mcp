import { z } from 'zod';
import { IdSchema, PaiseSchema, TextSchema } from './common.js';
import { PaginationSchema } from './pagination.js';

export const MenuItemSchema = z.strictObject({
  id: IdSchema,
  restaurant_id: IdSchema,
  name: TextSchema,
  price_paise: PaiseSchema,
  is_veg: z.boolean(),
  is_available: z.boolean(),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const MenuListFiltersSchema = PaginationSchema.extend({
  restaurant_id: IdSchema,
  veg_only: z.boolean().optional(),
  available_only: z.boolean().optional(),
});
export type MenuListFilters = z.infer<typeof MenuListFiltersSchema>;
