import type { OrderStatus, PaymentStatus } from '@foodops/shared';

/** A pending payment on a cancelled order was never collected; do not present it as outstanding. */
export function paymentLabel(
  payment: { status: PaymentStatus } | null | undefined,
  orderStatus: OrderStatus,
): string {
  if (!payment) return 'No payment';
  return payment.status === 'pending' && orderStatus === 'cancelled'
    ? 'Not collected: order cancelled'
    : payment.status;
}
