import {
  AppError,
  ErrorCode,
  OrderSchema,
  PaiseSchema,
  PaymentSchema,
  RefundSchema,
  type Order,
  type Payment,
} from '@foodops/shared';
import {
  assertRefund,
  remainingRefund,
  requiresRefundConfirmation,
  CAPTURED_PAYMENT_STATUSES,
} from '../domain/policies.js';
import {
  assertExpectedPreview,
  id,
  newId,
  now,
  object,
  parse,
  required,
  singleton,
  writeInput,
  type Presented,
  type Repositories,
  type ServiceContext,
} from './context.js';
import type { RefundInput, RefundResult } from './types.js';

export function paymentFor(repos: Repositories, order: Order): Payment | null {
  return singleton(repos.payment.forOrder(order.id), 'payment');
}
export function refundBalance(
  repos: Repositories,
  order: Order,
  payment: Payment,
): { paid: number; refunded: number; remaining: number } {
  const refunds = repos.refund.forPayment(payment.id);
  if (refunds.some((refund) => refund.order_id !== order.id))
    throw new AppError(
      ErrorCode.CONFLICT,
      'Refund is linked to a different order',
      'Reconcile the payment and refund records',
    );
  const total = refunds.reduce((sum, refund) => sum + BigInt(refund.amount_paise), 0n);
  if (total > BigInt(payment.amount_paise))
    throw new AppError(
      ErrorCode.CONFLICT,
      'Recorded refunds exceed the captured payment',
      'Reconcile payment and refund records before retrying',
    );
  const refunded = Number(total);
  const captured = CAPTURED_PAYMENT_STATUSES.includes(payment.status);
  if (
    (!captured && refunded !== 0) ||
    (payment.status === 'refunded' && refunded !== payment.amount_paise)
  ) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'Payment status disagrees with refund records',
      'Reconcile the captured payment and refund balance',
    );
  }
  const paid = captured ? payment.amount_paise : 0;
  return { paid, refunded, remaining: remainingRefund(paid, refunded) };
}
export function refundPlan(repos: Repositories, input: RefundInput) {
  const order = required(repos.order.get(input.orderId), 'Order');
  const payment = required(paymentFor(repos, order), 'Payment');
  const balance = refundBalance(repos, order, payment);
  assertRefund(order.status, input.amountPaise, balance.paid, balance.refunded);
  return { order, payment, balance };
}
export function applyRefund(
  repos: Repositories,
  order: Order,
  payment: Payment,
  amount: number,
  input: { actor: RefundInput['actor']; reason: string; idempotencyKey?: string },
  cancellation = false,
): RefundResult {
  const balance = refundBalance(repos, order, payment);
  assertRefund(order.status, amount, balance.paid, balance.refunded, cancellation);
  const refund = RefundSchema.parse({
    id: newId(),
    order_id: order.id,
    payment_id: payment.id,
    amount_paise: amount,
    reason: input.reason,
    actor: input.actor,
    idempotency_key: input.idempotencyKey ?? null,
    created_at: now(),
  });
  repos.refund.insert(refund);
  const updated = PaymentSchema.parse({
    ...payment,
    status: amount === balance.remaining ? 'refunded' : 'partially_refunded',
  });
  repos.payment.update(updated);
  return { order_id: order.id, payment: updated, refund };
}
export function decodeRefund(value: unknown): RefundResult {
  const row = object(value);
  return {
    order_id: OrderSchema.shape.id.parse(row['order_id']),
    payment: PaymentSchema.parse(row['payment']),
    refund: RefundSchema.parse(row['refund']),
  };
}
function refundPreview(repos: Repositories, input: RefundInput) {
  const { order, payment, balance } = refundPlan(repos, input);
  return {
    order_id: order.id,
    payment_id: payment.id,
    refund_amount_paise: input.amountPaise,
    remaining_before_paise: balance.remaining,
    remaining_after_paise: balance.remaining - input.amountPaise,
    payment_status_after:
      input.amountPaise === balance.remaining ? 'refunded' : 'partially_refunded',
    requiresConfirmation: requiresRefundConfirmation(input.amountPaise),
  } as const;
}
export function createRefundService(context: ServiceContext) {
  const validate = (input: RefundInput) => {
    writeInput(input, ['orderId', 'amountPaise']);
    id(input.orderId);
    parse(PaiseSchema, input.amountPaise, 'refund amount');
    return input;
  };
  function executeRefundWithMetadata(
    input: RefundInput,
    options?: {
      expectedPreview?: Presented<ReturnType<typeof refundPreview>>;
      expectedPreviewHash?: string;
    },
  ) {
    validate(input);
    return context.mutateWithMetadata(
      'refund.executeRefund',
      input,
      (repos) => {
        assertExpectedPreview(
          options?.expectedPreview,
          () => refundPreview(repos, input),
          options?.expectedPreviewHash,
        );
        const { order, payment } = refundPlan(repos, input);
        return applyRefund(repos, order, payment, input.amountPaise, input);
      },
      decodeRefund,
    );
  }
  return {
    previewRefund(input: RefundInput) {
      validate(input);
      return context.read((repos) => refundPreview(repos, input));
    },
    replayRefund(input: RefundInput) {
      validate(input);
      return context.replay('refund.executeRefund', input, decodeRefund);
    },
    executeRefund(
      input: RefundInput,
      options?: {
        expectedPreview?: Presented<ReturnType<typeof refundPreview>>;
        expectedPreviewHash?: string;
      },
    ) {
      return executeRefundWithMetadata(input, options).result;
    },
    executeRefundWithMetadata,
  };
}
