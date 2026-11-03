import {
  DeliverySchema,
  AppError,
  ErrorCode,
  PlaceOrderInputSchema,
  OrderItemSchema,
  CustomerSchema,
  AddressSchema,
  type PlaceOrderInput,
  DeliveryPartnerSchema,
  InvoiceSchema,
  OrderEventSchema,
  OrderSearchFiltersSchema,
  OrderSchema,
  PaymentSchema,
  RefundSchema,
} from '@foodops/shared';
import { calculatePricing, ORDER_FEES } from '../domain/pricing.js';
import { assertTransition } from '../domain/order-state-machine.js';
import {
  assertCancellation,
  requiresRefundConfirmation,
  CAPTURED_PAYMENT_STATUSES,
} from '../domain/policies.js';
import {
  assertExpectedPreview,
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
  type Presented,
  type Repositories,
  type ServiceContext,
} from './context.js';
import { paymentFor, refundBalance, applyRefund } from './refund.service.js';
import { issueInvoice, planInvoice } from './invoice.service.js';
import {
  advanceDelivery,
  planDeliveryAdvance,
  planDeliveryCancellation,
  cancelDelivery,
} from './delivery.service.js';
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
  if (payment && CAPTURED_PAYMENT_STATUSES.includes(payment.status))
    amount = refundBalance(repos, order, payment).remaining;
  return { order, payment, amount };
}
function cancellationPreview(repos: Repositories, input: OrderWriteInput) {
  const { order, payment, amount } = cancellationPlan(repos, input);
  const delivery = planDeliveryCancellation(repos, order.id);
  return {
    delivery_status_after: delivery.delivery?.status ?? null,
    partner_id: delivery.partner?.id ?? null,
    partner_status_after: delivery.partner?.status ?? null,
    order_id: order.id,
    from_status: order.status,
    to_status: 'cancelled' as const,
    cancel_reason: input.reason,
    payment_id: payment?.id ?? null,
    payment_status_after: amount > 0 ? ('refunded' as const) : (payment?.status ?? null),
    refund_amount_paise: amount,
    requiresConfirmation: requiresRefundConfirmation(amount),
    requiresPaymentConfirmation:
      payment !== null && CAPTURED_PAYMENT_STATUSES.includes(payment.status),
  } as const;
}
function validateAdvance(input: AdvanceInput): void {
  writeInput(input, ['orderId', 'toStatus']);
  id(input.orderId);
  parse(OrderSchema.shape.status, input.toStatus, 'target status');
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
  const delivery = cancelDelivery(repos, order.id);
  const result =
    payment && amount > 0 ? applyRefund(repos, updated, payment, amount, input, true) : null;
  return {
    order: updated,
    event,
    payment: result?.payment ?? payment,
    refund: result?.refund ?? null,
    invoice: repos.invoice.forOrder(order.id),
    delivery: delivery.delivery,
    partner: delivery.partner,
  };
}
export function decodeOrderMutation(value: unknown): OrderMutationResult {
  const row = object(value);
  return {
    partner: row['partner'] === undefined ? null : nullable(DeliveryPartnerSchema, row['partner']),
    order: OrderSchema.parse(row['order']),
    event: OrderEventSchema.parse(row['event']),
    payment: nullable(PaymentSchema, row['payment']),
    refund: nullable(RefundSchema, row['refund']),
    invoice: nullable(InvoiceSchema, row['invoice']),
    delivery: nullable(DeliverySchema, row['delivery']),
  };
}
function advancePreview(repos: Repositories, input: AdvanceInput) {
  const order = required(repos.order.get(input.orderId), 'Order');
  assertTransition(order.status, input.toStatus);
  const at = now();
  const updated = OrderSchema.parse({ ...order, status: input.toStatus, updated_at: at });
  const delivery =
    input.toStatus === 'cancelled'
      ? { ...planDeliveryCancellation(repos, order.id), releasePartner: null }
      : planDeliveryAdvance(repos, updated, at);
  const cancellation = input.toStatus === 'cancelled' ? cancellationPreview(repos, input) : null;
  const invoice = input.toStatus === 'delivered' ? planInvoice(repos, updated, at) : null;
  return {
    order_id: order.id,
    from_status: order.status,
    to_status: input.toStatus,
    reason: input.reason,
    delivery_status_after: delivery.delivery?.status ?? null,
    partner_id: delivery.delivery?.partner_id ?? null,
    partner_status_after:
      cancellation?.partner_status_after ??
      (delivery.releasePartner
        ? ('available' as const)
        : delivery.delivery?.partner_id
          ? required(repos.delivery.partner(delivery.delivery.partner_id), 'Assigned partner')
              .status
          : null),
    invoice_will_be_issued: invoice !== null && invoice.existing === null,
    refund_amount_paise: cancellation?.refund_amount_paise ?? 0,
    payment_status_after:
      cancellation?.payment_status_after ??
      (input.toStatus === 'delivered' &&
      paymentFor(repos, order)?.method === 'cod' &&
      paymentFor(repos, order)?.status === 'pending'
        ? 'paid'
        : (paymentFor(repos, order)?.status ?? null)),
    requiresConfirmation: cancellation?.requiresConfirmation ?? false,
    requiresPaymentConfirmation: cancellation?.requiresPaymentConfirmation ?? false,
  } as const;
}
export function createOrderService(context: ServiceContext) {
  const validateCancel = (input: OrderWriteInput) => {
    writeInput(input, ['orderId']);
    id(input.orderId);
    return input;
  };
  return {
    placeOrder(input: PlaceOrderInput) {
      const { idempotencyKey, ...semantic } = parse(
        PlaceOrderInputSchema,
        input,
        'order placement',
      );
      const request = { ...semantic, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
      if (new Set(request.items.map((item) => item.menuItemId)).size !== request.items.length)
        throw new AppError(
          ErrorCode.VALIDATION,
          'Duplicate menu items',
          'Combine quantities into one line per menu item',
        );
      return context.mutate(
        'order.placeOrder',
        request,
        (repos) => {
          const customer = required(repos.catalog.customer(request.customerId), 'Customer');
          const address = required(repos.catalog.address(request.addressId), 'Address');
          const restaurant = required(repos.catalog.restaurant(request.restaurantId), 'Restaurant');
          if (address.customer_id !== customer.id)
            throw new AppError(
              ErrorCode.VALIDATION,
              'Address belongs to another customer',
              'Choose an address owned by this customer',
            );
          if (!restaurant.is_open)
            throw new AppError(
              ErrorCode.CONFLICT,
              'Restaurant is closed',
              'Choose an open restaurant',
            );
          const orderId = newId();
          const at = now();
          const items = request.items.map((item) => {
            const menu = required(repos.catalog.menuItem(item.menuItemId), 'Menu item');
            if (menu.restaurant_id !== restaurant.id)
              throw new AppError(
                ErrorCode.VALIDATION,
                'Menu item belongs to another restaurant',
                'Select items from the chosen restaurant',
              );
            if (!menu.is_available)
              throw new AppError(
                ErrorCode.CONFLICT,
                'Menu item is unavailable',
                'Choose an available menu item',
              );
            return OrderItemSchema.parse({
              id: newId(),
              order_id: orderId,
              menu_item_id: menu.id,
              name_snapshot: menu.name,
              unit_price_paise: menu.price_paise,
              qty: item.qty,
            });
          });
          const order = OrderSchema.parse({
            id: orderId,
            customer_id: customer.id,
            restaurant_id: restaurant.id,
            address_id: address.id,
            status: 'placed',
            ...calculatePricing({ items, ...ORDER_FEES }),
            notes: request.notes ?? null,
            cancel_reason: null,
            placed_at: at,
            updated_at: at,
          });
          const event = OrderEventSchema.parse({
            id: newId(),
            order_id: orderId,
            from_status: null,
            to_status: 'placed',
            actor: request.actor,
            reason: request.reason,
            at,
          });
          const payment = PaymentSchema.parse({
            id: newId(),
            order_id: orderId,
            method: request.paymentMethod,
            status: request.paymentMethod === 'cod' ? 'pending' : 'paid',
            amount_paise: order.total_paise,
            txn_ref: request.paymentMethod === 'cod' ? null : `demo-${newId()}`,
          });
          const delivery = DeliverySchema.parse({
            id: newId(),
            order_id: orderId,
            partner_id: null,
            status: 'pending',
            eta_min: null,
            assigned_at: null,
            picked_up_at: null,
            delivered_at: null,
          });
          repos.order.insert(order);
          for (const item of items) repos.order.insertItem(item);
          repos.order.insertEvent(event);
          repos.payment.insert(payment);
          repos.delivery.insert(delivery);
          return { order, items, customer, address, payment, delivery, timeline: [event] };
        },
        (value) => {
          // The response decoder validates stored idempotent data as strictly as fresh rows.
          const row = object(value);
          return {
            order: OrderSchema.parse(row['order']),
            items: OrderItemSchema.array().parse(row['items']),
            customer: CustomerSchema.parse(row['customer']),
            address: AddressSchema.parse(row['address']),
            payment: PaymentSchema.parse(row['payment']),
            delivery: DeliverySchema.parse(row['delivery']),
            timeline: OrderEventSchema.array().parse(row['timeline']),
          };
        },
      );
    },
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
      keys(input, [
        'status',
        'customerId',
        'restaurantId',
        'from',
        'to',
        'cursor',
        'limit',
        'query',
      ]);
      const filters = parse(
        OrderSearchFiltersSchema,
        {
          status: input.status,
          q: input.query,
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
      return context.read((repos) => cancellationPreview(repos, input));
    },
    previewAdvanceStatus(input: AdvanceInput) {
      validateAdvance(input);
      return context.read((repos) => advancePreview(repos, input));
    },
    replayCancel(input: OrderWriteInput) {
      validateCancel(input);
      return context.replay('order.executeCancel', input, decodeOrderMutation);
    },
    replayAdvanceStatus(input: AdvanceInput) {
      validateAdvance(input);
      return context.replay('order.advanceStatus', input, decodeOrderMutation);
    },
    executeCancel(
      input: OrderWriteInput,
      options?: {
        expectedPreview?: Presented<ReturnType<typeof cancellationPreview>>;
        expectedPreviewHash?: string;
      },
    ) {
      validateCancel(input);
      return context.mutate(
        'order.executeCancel',
        input,
        (repos) => {
          assertExpectedPreview(
            options?.expectedPreview,
            () => cancellationPreview(repos, input),
            options?.expectedPreviewHash,
          );
          return cancel(repos, input);
        },
        decodeOrderMutation,
      );
    },
    advanceStatus(
      input: AdvanceInput,
      options?: {
        expectedPreview?: Presented<ReturnType<typeof advancePreview>>;
        expectedPreviewHash?: string;
      },
    ) {
      validateAdvance(input);
      return context.mutate(
        'order.advanceStatus',
        input,
        (repos): OrderMutationResult => {
          assertExpectedPreview(
            options?.expectedPreview,
            () => advancePreview(repos, input),
            options?.expectedPreviewHash,
          );
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
          const payment = paymentFor(repos, order);
          if (
            input.toStatus === 'delivered' &&
            payment?.method === 'cod' &&
            payment.status === 'pending'
          ) {
            repos.payment.update({ ...payment, status: 'paid' });
          }
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
            partner: delivery?.partner_id
              ? required(repos.delivery.partner(delivery.partner_id), 'Assigned partner')
              : null,
          };
        },
        decodeOrderMutation,
      );
    },
  };
}
