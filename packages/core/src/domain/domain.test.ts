import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode, OrderStatusSchema } from '@foodops/shared';
import { assertTransition } from './order-state-machine.js';
import { calculatePricing } from './pricing.js';
import {
  assertCancellation,
  assertReassignment,
  assertRefund,
  remainingRefund,
  requiresRefundConfirmation,
} from './policies.js';

const valid = new Set([
  'placed:accepted',
  'placed:cancelled',
  'accepted:preparing',
  'accepted:cancelled',
  'preparing:ready',
  'preparing:cancelled',
  'ready:picked_up',
  'ready:cancelled',
  'picked_up:out_for_delivery',
  'out_for_delivery:delivered',
]);
const pairs = OrderStatusSchema.options.flatMap((from) =>
  OrderStatusSchema.options.map((to) => ({ from, to })),
);
describe('exact order transitions', () => {
  it.each(pairs)('$from → $to', ({ from, to }) => {
    if (valid.has(`${from}:${to}`)) expect(() => assertTransition(from, to)).not.toThrow();
    else
      expect(() => assertTransition(from, to)).toThrow(
        expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION, hint: expect.any(String) }),
      );
  });
});

describe('pricing', () => {
  it('calculates snapshot subtotal, tax, supplied fees and discount', () => {
    expect(
      calculatePricing({
        items: [
          { unit_price_paise: 101, qty: 2 },
          { unit_price_paise: 99, qty: 1 },
        ],
        delivery_fee_paise: 30,
        platform_fee_paise: 5,
        discount_paise: 20,
      }),
    ).toEqual({
      subtotal_paise: 301,
      tax_paise: 15,
      delivery_fee_paise: 30,
      platform_fee_paise: 5,
      discount_paise: 20,
      total_paise: 331,
    });
  });
  it.each([
    [9, 0],
    [10, 1],
    [30, 2],
    [100, 5],
  ])('rounds 5%% tax on %i to %i paise', (price, tax) => {
    expect(
      calculatePricing({
        items: [{ unit_price_paise: price, qty: 1 }],
        delivery_fee_paise: 0,
        platform_fee_paise: 0,
        discount_paise: 0,
      }).tax_paise,
    ).toBe(tax);
  });
  it('allows zero-priced items and a discount equal to the gross amount', () => {
    expect(
      calculatePricing({
        items: [{ unit_price_paise: 0, qty: 1 }],
        delivery_fee_paise: 10,
        platform_fee_paise: 0,
        discount_paise: 10,
      }).total_paise,
    ).toBe(0);
  });
  it('rejects empty items, invalid quantities, unsafe products and excessive discounts', () => {
    const base = {
      items: [{ unit_price_paise: 100, qty: 1 }],
      delivery_fee_paise: 0,
      platform_fee_paise: 0,
      discount_paise: 0,
    };
    expect(() => calculatePricing({ ...base, items: [] })).toThrow(AppError);
    expect(() =>
      calculatePricing({ ...base, items: null } as unknown as Parameters<
        typeof calculatePricing
      >[0]),
    ).toThrow(AppError);
    expect(() =>
      calculatePricing(null as unknown as Parameters<typeof calculatePricing>[0]),
    ).toThrow(AppError);
    for (const qty of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => calculatePricing({ ...base, items: [{ unit_price_paise: 1, qty }] })).toThrow(
        AppError,
      );
    expect(() =>
      calculatePricing({ ...base, items: [{ unit_price_paise: Number.MAX_SAFE_INTEGER, qty: 2 }] }),
    ).toThrow(AppError);
    expect(() =>
      calculatePricing({ ...base, items: [{ unit_price_paise: Number.MAX_SAFE_INTEGER, qty: 1 }] }),
    ).toThrow(AppError);
    expect(() => calculatePricing({ ...base, discount_paise: 106 })).toThrow(AppError);
    expect(() => calculatePricing({ ...base, delivery_fee_paise: 0.1 })).toThrow(AppError);
  });
});

describe('policies', () => {
  it.each(OrderStatusSchema.options)('cancellation and reassignment in %s', (status) => {
    if (['placed', 'accepted', 'preparing', 'ready'].includes(status)) {
      expect(() => assertCancellation(status)).not.toThrow();
      expect(() => assertReassignment(status, 'available')).not.toThrow();
    } else {
      expect(() => assertCancellation(status)).toThrow(AppError);
      expect(() => assertReassignment(status, 'available')).toThrow(AppError);
    }
  });
  it.each(['picked_up', 'out_for_delivery', 'delivered', 'cancelled'] as const)(
    'reports reassignment (not cancellation) when reassigning in %s',
    (status) => {
      expect(() => assertReassignment(status, 'available')).toThrow(
        expect.objectContaining({
          code: ErrorCode.INVALID_TRANSITION,
          message: `Cannot reassign delivery for an order in ${status}`,
          hint: 'Reassignment is allowed only before pickup',
        }),
      );
    },
  );
  it('rejects unavailable partners', () => {
    for (const status of ['busy', 'offline'] as const)
      expect(() => assertReassignment('ready', status)).toThrow(
        expect.objectContaining({ code: ErrorCode.CONFLICT }),
      );
  });
  it('enforces remaining balance, positive amounts, order eligibility and the cancellation exception', () => {
    expect(remainingRefund(500, 200)).toBe(300);
    expect(() => remainingRefund(100, 101)).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFLICT }),
    );
    expect(() => assertRefund('delivered', 300, 500, 200)).not.toThrow();
    expect(() => assertRefund('cancelled', 300, 500, 200)).not.toThrow();
    expect(() => assertRefund('ready', 300, 500, 200, true)).not.toThrow();
    expect(() => assertRefund('ready', 1, 500, 0)).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_TRANSITION }),
    );
    expect(() => assertRefund('delivered', 0, 500, 0)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(() => assertRefund('delivered', 301, 500, 200)).toThrow(
      expect.objectContaining({ code: ErrorCode.LIMIT_EXCEEDED }),
    );
    expect(() => assertRefund('delivered', -1, 500, 0)).toThrow(AppError);
    expect(() => remainingRefund(-1, 0)).toThrow(AppError);
    expect(() => requiresRefundConfirmation(-1)).toThrow(AppError);
  });
  it('flags large refunds strictly above 200000 paise', () => {
    expect(requiresRefundConfirmation(200000)).toBe(false);
    expect(requiresRefundConfirmation(200001)).toBe(true);
    expect(requiresRefundConfirmation(0)).toBe(false);
  });
});
