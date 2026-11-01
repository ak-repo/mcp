import {
  DeliverySchema,
  InvoiceSchema,
  OrderEventSchema,
  OrderListFiltersSchema,
  OrderSchema,
  PaymentSchema,
  RefundSchema,
} from '@foodops/shared';
import { assertTransition } from '../domain/order-state-machine.js';
import { assertCancellation, requiresRefundConfirmation } from '../domain/policies.js';
import {
  id,
  keys,
  newId,
  now,
  nullable,
  object,
  parse,
  required,
  singleton,
  writeInput,
  type Repositories,
  type ServiceContext,
} from './context.js';
import { paymentFor, refundBalance, applyRefund } from './refund.service.js';
import { issueInvoice } from './invoice.service.js';
import { advanceDelivery } from './delivery.service.js';
import type {
  AdvanceInput,
  OrderDetails,
  OrderListInput,
  OrderMutationResult,
  OrderWriteInput,
} from './types.js';

function cancellationPlan(repos: Repositories, input: OrderWriteInput) {
  const order = required(repos.order.get(input.orderId), 'Order');
  assertCancellation(order.status);
  const payment = paymentFor(repos, order);
  let amount = 0;
  if (payment && (payment.status === 'paid' || payment.status === 'partially_refunded'))
    amount = refundBalance(repos, order, payment).remaining;
  return { order, payment, amount };
}
function cancel(repos: Repositories, input: OrderWriteInput): OrderMutationResult {
  const { order, payment, amount } = cancellationPlan(repos, input);
  const at = now();
  const updated = OrderSchema.parse({
    ...order,
    status: 'cancelled',
    cancel_reason: input.reason,
    updated_at: at,
  });
  repos.order.update(updated);
  const event = OrderEventSchema.parse({
    id: newId(),
    order_id: order.id,
    from_status: order.status,
    to_status: 'cancelled',
    actor: input.actor,
    reason: input.reason,
    at,
  });
  repos.order.insertEvent(event);
  const result =
    payment && amount > 0 ? applyRefund(repos, updated, payment, amount, input, true) : null;
  return {
    order: updated,
    event,
    payment: result?.payment ?? payment,
    refund: result?.refund ?? null,
    invoice: repos.invoice.forOrder(order.id),
    delivery: singleton(repos.delivery.forOrder(order.id), 'delivery'),
  };
}
export function decodeOrderMutation(value: unknown): OrderMutationResult {
  const row = object(value);
  return {
    order: OrderSchema.parse(row['order']),
    event: OrderEventSchema.parse(row['event']),
    payment: nullable(PaymentSchema, row['payment']),
    refund: nullable(RefundSchema, row['refund']),
    invoice: nullable(InvoiceSchema, row['invoice']),
    delivery: nullable(DeliverySchema, row['delivery']),
  };
}
export function createOrderService(context: ServiceContext) {
  const validateCancel = (input: OrderWriteInput) => {
    writeInput(input, ['orderId']);
    id(input.orderId);
    return input;
  };
  return {
    getOrder(orderId: string) {
      id(orderId);
      return context.read((repos): OrderDetails => {
        const order = required(repos.order.get(orderId), 'Order');
        const address = required(repos.catalog.address(order.address_id), 'Address');
        if (address.customer_id !== order.customer_id)
          throw new Error('Order address belongs to another customer');
        return {
          order,
          items: repos.order.items(orderId),
          customer: required(repos.catalog.customer(order.customer_id), 'Customer'),
          address,
          payment: paymentFor(repos, order),
          delivery: singleton(repos.delivery.forOrder(orderId), 'delivery'),
          timeline: repos.order.events(orderId),
        };
      });
    },
    listOrders(input: OrderListInput = {}) {
      keys(input, ['status', 'customerId', 'restaurantId', 'from', 'to', 'cursor', 'limit']);
      const filters = parse(
        OrderListFiltersSchema,
        {
          status: input.status,
          customer_id: input.customerId,
          restaurant_id: input.restaurantId,
          from: input.from,
          to: input.to,
          cursor: input.cursor,
          limit: input.limit,
        },
        'order filters',
      );
      return context.read((repos) => repos.order.list(filters));
    },
    previewCancel(input: OrderWriteInput) {
      validateCancel(input);
      return context.read((repos) => {
        const { order, payment, amount } = cancellationPlan(repos, input);
        return {
          order_id: order.id,
          from_status: order.status,
          to_status: 'cancelled',
          cancel_reason: input.reason,
          payment_id: payment?.id ?? null,
          payment_status_after: amount > 0 ? 'refunded' : (payment?.status ?? null),
          refund_amount_paise: amount,
          requiresConfirmation: requiresRefundConfirmation(amount),
        };
      });
    },
    executeCancel(input: OrderWriteInput) {
      validateCancel(input);
      return context.mutate(
        'order.executeCancel',
        input,
        (repos) => cancel(repos, input),
        decodeOrderMutation,
      );
    },
    advanceStatus(input: AdvanceInput) {
      writeInput(input, ['orderId', 'toStatus']);
      id(input.orderId);
      parse(OrderSchema.shape.status, input.toStatus, 'target status');
      return context.mutate(
        'order.advanceStatus',
        input,
        (repos): OrderMutationResult => {
          const order = required(repos.order.get(input.orderId), 'Order');
          assertTransition(order.status, input.toStatus);
          if (input.toStatus === 'cancelled') return cancel(repos, input);
          const at = now();
          const updated = OrderSchema.parse({ ...order, status: input.toStatus, updated_at: at });
          const delivery = advanceDelivery(repos, updated, at);
          repos.order.update(updated);
          const event = OrderEventSchema.parse({
            id: newId(),
            order_id: order.id,
            from_status: order.status,
            to_status: input.toStatus,
            actor: input.actor,
            reason: input.reason,
            at,
          });
          repos.order.insertEvent(event);
          const invoice =
            input.toStatus === 'delivered'
              ? issueInvoice(repos, updated, at)
              : repos.invoice.forOrder(order.id);
          return {
            order: updated,
            event,
            payment: paymentFor(repos, order),
            refund: null,
            invoice,
            delivery,
          };
        },
        decodeOrderMutation,
      );
    },
  };
}
