import {
  AppError,
  assertPaise,
  ErrorCode,
  subtractPaise,
  type OrderStatus,
  type PartnerStatus,
} from '@foodops/shared';

function validMoney(value: number): number {
  try {
    return assertPaise(value);
  } catch {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Money must be non-negative safe integer paise',
      'Use whole paise within the JavaScript safe integer range',
    );
  }
}

export const LARGE_REFUND_PAISE = 200000;
const beforePickup: readonly OrderStatus[] = ['placed', 'accepted', 'preparing', 'ready'];

export function assertCancellation(status: OrderStatus): void {
  if (!beforePickup.includes(status)) {
    throw new AppError(
      ErrorCode.INVALID_TRANSITION,
      `Cannot cancel an order in ${status}`,
      'Cancellation is allowed only before pickup',
    );
  }
}
export function remainingRefund(paid: number, refunded: number): number {
  validMoney(paid);
  validMoney(refunded);
  if (refunded > paid) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'Recorded refunds exceed the captured payment',
      'Reconcile payment and refund records before retrying',
    );
  }
  return subtractPaise(paid, refunded);
}
export function assertRefund(
  status: OrderStatus,
  amount: number,
  paid: number,
  refunded: number,
  cancellation = false,
): void {
  validMoney(amount);
  if (amount === 0)
    throw new AppError(
      ErrorCode.VALIDATION,
      'Refund must be greater than zero',
      'Supply a positive amount in paise',
    );
  if (!cancellation && status !== 'delivered' && status !== 'cancelled') {
    throw new AppError(
      ErrorCode.INVALID_TRANSITION,
      `Cannot refund an order in ${status}`,
      'Only delivered or cancelled orders can receive standalone refunds',
    );
  }
  if (amount > remainingRefund(paid, refunded)) {
    throw new AppError(
      ErrorCode.LIMIT_EXCEEDED,
      'Refund exceeds the remaining paid balance',
      'Request an amount no greater than paid minus prior refunds',
    );
  }
}
export function requiresRefundConfirmation(amount: number): boolean {
  return validMoney(amount) > LARGE_REFUND_PAISE;
}
export function assertReassignment(status: OrderStatus, partner: PartnerStatus): void {
  assertCancellation(status);
  if (partner !== 'available') {
    throw new AppError(
      ErrorCode.CONFLICT,
      `Target partner is ${partner}`,
      'Choose an available delivery partner',
    );
  }
}
