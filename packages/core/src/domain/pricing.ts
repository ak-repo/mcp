import {
  addPaise,
  AppError,
  assertPaise,
  ErrorCode,
  percentOf,
  subtractPaise,
} from '@foodops/shared';

export interface PricingItem {
  unit_price_paise: number;
  qty: number;
}
export interface PricingInput {
  items: readonly PricingItem[];
  delivery_fee_paise: number;
  platform_fee_paise: number;
  discount_paise: number;
}
export interface Pricing {
  subtotal_paise: number;
  tax_paise: number;
  delivery_fee_paise: number;
  platform_fee_paise: number;
  discount_paise: number;
  total_paise: number;
}
export function calculatePricing(input: PricingInput): Pricing {
  try {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'At least one order item is required',
        'Supply snapshot unit prices and positive integer quantities',
      );
    }
    let subtotal = 0n;
    for (const item of input.items) {
      if (!Number.isSafeInteger(item.qty) || item.qty <= 0) {
        throw new AppError(
          ErrorCode.VALIDATION,
          'Quantity must be a positive safe integer',
          'Use whole quantities greater than zero',
        );
      }
      subtotal += BigInt(assertPaise(item.unit_price_paise)) * BigInt(item.qty);
    }
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Subtotal exceeds safe integer paise',
        'Reduce quantities or unit prices',
      );
    }
    const subtotal_paise = Number(subtotal);
    const tax_paise = percentOf(subtotal_paise, 5);
    const delivery_fee_paise = assertPaise(input.delivery_fee_paise);
    const platform_fee_paise = assertPaise(input.platform_fee_paise);
    const discount_paise = assertPaise(input.discount_paise);
    const gross = addPaise(subtotal_paise, tax_paise, delivery_fee_paise, platform_fee_paise);
    if (discount_paise > gross) {
      throw new AppError(
        ErrorCode.VALIDATION,
        'Discount exceeds the gross amount',
        'Use a discount no greater than subtotal, tax and fees combined',
      );
    }
    return {
      subtotal_paise,
      tax_paise,
      delivery_fee_paise,
      platform_fee_paise,
      discount_paise,
      total_paise: subtractPaise(gross, discount_paise),
    };
  } catch (error) {
    if (error instanceof AppError)
      throw new AppError(
        error.code,
        error.message,
        error.hint ?? 'Supply safe integer paise and reduce quantities or fees',
        error.details,
      );
    throw new AppError(
      ErrorCode.VALIDATION,
      'Invalid pricing input',
      'Supply non-empty items, positive integer quantities and integer paise',
    );
  }
}
