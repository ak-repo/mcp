import { defineTool } from '../lib/define-tool.js';
import { RestaurantListFiltersSchema, RestaurantSchema, createPageSchema } from '@foodops/shared';
import { defined } from './schemas.js';

export const tool = defineTool({
  name: 'search_restaurants',
  description:
    'Search restaurants by name, cuisine, area, and current open status. Use it to discover restaurant IDs before reading menus or filtering orders. Returns a cursor page of restaurant details.',
  inputSchema: RestaurantListFiltersSchema,
  dataSchema: createPageSchema(RestaurantSchema),
  hint: 'Narrow filters or reduce limit, then follow next_cursor.',
  execute: (input, services) =>
    services.catalog.searchRestaurants(
      defined({
        query: input.query,
        cuisine: input.cuisine,
        area: input.area,
        openNow: input.open_now,
        cursor: input.cursor,
        limit: input.limit,
      }),
    ),
  summarize: (data) => `Returned ${data.items.length} restaurants.`,
});
