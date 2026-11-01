import { defineTool } from '../lib/define-tool.js';
import { MenuListFiltersSchema, createPageSchema } from '@foodops/shared';
import { PresentedMenuItemSchema } from './schemas.js';
import { defined } from './schemas.js';

export const tool = defineTool({
  name: 'get_menu',
  description:
    'Read a restaurant menu, optionally filtering vegetarian or available items. Use after discovering a restaurant ID. Returns a cursor page of menu items with integer paise and formatted INR prices.',
  inputSchema: MenuListFiltersSchema,
  dataSchema: createPageSchema(PresentedMenuItemSchema),
  hint: 'Narrow filters or reduce limit, then follow next_cursor.',
  execute: (input, services) =>
    services.catalog.getMenu(
      defined({
        restaurantId: input.restaurant_id,
        vegOnly: input.veg_only,
        availableOnly: input.available_only,
        cursor: input.cursor,
        limit: input.limit,
      }),
    ),
  summarize: (data) => `Returned ${data.items.length} menu items.`,
});
