import { MenuListFiltersSchema, RestaurantListFiltersSchema } from '@foodops/shared';
import { id, keys, parse, required, type ServiceContext } from './context.js';
import type { MenuInput, RestaurantSearchInput } from './types.js';
export function createCatalogService(context: ServiceContext) {
  return {
    placementCustomers() {
      return context.read((repos) => repos.catalog.placementCustomers());
    },
    searchRestaurants(input: RestaurantSearchInput = {}) {
      keys(input, ['query', 'cuisine', 'area', 'openNow', 'cursor', 'limit']);
      const filters = parse(
        RestaurantListFiltersSchema,
        {
          query: input.query,
          cuisine: input.cuisine,
          area: input.area,
          open_now: input.openNow,
          cursor: input.cursor,
          limit: input.limit,
        },
        'restaurant filters',
      );
      return context.read((repos) => repos.catalog.restaurants(filters));
    },
    getMenu(input: MenuInput) {
      keys(input, ['restaurantId', 'vegOnly', 'availableOnly', 'cursor', 'limit']);
      id(input.restaurantId);
      const filters = parse(
        MenuListFiltersSchema,
        {
          restaurant_id: input.restaurantId,
          veg_only: input.vegOnly,
          available_only: input.availableOnly,
          cursor: input.cursor,
          limit: input.limit,
        },
        'menu filters',
      );
      return context.read((repos) => {
        required(repos.catalog.restaurant(input.restaurantId), 'Restaurant');
        return repos.catalog.menu(filters);
      });
    },
  };
}
