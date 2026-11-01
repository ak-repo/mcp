import type { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  RestaurantListFiltersSchema,
  MenuListFiltersSchema,
  RestaurantPageSchema,
  MenuPageSchema,
} from '@foodops/shared';
import type { Runtime } from '../runtime.js';
import { queryFilters, pageResponse, defined } from '../lib/pagination.js';
import { validate } from '../lib/validate.js';
import { IdParamsSchema, responseSchema } from './schemas.js';
const restaurants: FastifyPluginAsync<{ runtime: Runtime }> = async (
  app,
  { runtime: { services } },
) => {
  app.get<{ Reply: z.output<typeof RestaurantPageSchema> }>(
    '/restaurants',
    { schema: responseSchema(RestaurantPageSchema) },
    async (request) => {
      const query = queryFilters(RestaurantListFiltersSchema, request.query);
      return pageResponse(
        services.catalog.searchRestaurants(
          defined({
            query: query.query,
            cuisine: query.cuisine,
            area: query.area,
            openNow: query.open_now,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
    },
  );
  app.get<{ Reply: z.output<typeof MenuPageSchema> }>(
    '/restaurants/:id/menu',
    { schema: responseSchema(MenuPageSchema) },
    async (request) => {
      const params = validate(IdParamsSchema, request.params);
      const query = queryFilters(
        MenuListFiltersSchema.omit({ restaurant_id: true }),
        request.query,
      );
      return pageResponse(
        services.catalog.getMenu(
          defined({
            restaurantId: params.id,
            vegOnly: query.veg_only,
            availableOnly: query.available_only,
            cursor: query.cursor,
            limit: query.limit,
          }),
        ),
      );
    },
  );
};
export default restaurants;
