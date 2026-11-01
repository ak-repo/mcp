import { AppError, ErrorCode, type OrderStatus } from '@foodops/shared';

export const ORDER_TRANSITIONS = {
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['picked_up', 'cancelled'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  const allowed: readonly OrderStatus[] = ORDER_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new AppError(
      ErrorCode.INVALID_TRANSITION,
      `Cannot advance ${from} to ${to}`,
      allowed.length
        ? `Choose one of: ${allowed.join(', ')}`
        : 'This order is terminal; no further status changes are allowed',
    );
  }
}
