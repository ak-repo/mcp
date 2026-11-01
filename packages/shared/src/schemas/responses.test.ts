import { describe, expect, it } from 'vitest';
import {
  PresentedMenuItemSchema,
  PresentedOrderSchema,
  createRestPageSchema,
} from './responses.js';
import { OrderSchema } from './order.js';
import { ToolCallListFiltersSchema } from './audit.js';
describe('public presented response contracts', () => {
  it('requires displays alongside paise and rejects extra fields', () => {
    const item = {
      id: 'M-1',
      restaurant_id: 'R-1',
      name: 'Meal',
      price_paise: 15000,
      price_display: '₹150.00',
      is_veg: true,
      is_available: true,
    };
    expect(PresentedMenuItemSchema.parse(item)).toEqual(item);
    expect(PresentedMenuItemSchema.safeParse({ ...item, price_display: undefined }).success).toBe(
      false,
    );
    expect(PresentedMenuItemSchema.safeParse({ ...item, surprise: true }).success).toBe(false);
    const money = Object.keys(OrderSchema.shape).filter((key) => key.endsWith('_paise'));
    for (const key of money)
      expect(key.slice(0, -6) + '_display' in PresentedOrderSchema.shape).toBe(true);
  });
  it('uses canonical cursors and shared audit filter defaults', () => {
    const page = createRestPageSchema(PresentedMenuItemSchema);
    expect(page.parse({ data: [], next_cursor: null })).toEqual({ data: [], next_cursor: null });
    expect(page.safeParse({ data: [], next_cursor: 'invalid' }).success).toBe(false);
    expect(ToolCallListFiltersSchema.parse({ tool: 'get_order', status: 'success' })).toEqual({
      limit: 20,
      tool: 'get_order',
      status: 'success',
    });
    expect(ToolCallListFiltersSchema.safeParse({ status: 'bad' }).success).toBe(false);
  });
});
