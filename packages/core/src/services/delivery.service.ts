import {
  AppError,
  DeliveryPartnerSchema,
  DeliverySchema,
  DeliveryTrackingSchema,
  ErrorCode,
  PartnerListFiltersSchema,
  type Delivery,
  type Order,
} from '@foodops/shared';
import { assertReassignment } from '../domain/policies.js';
import {
  id,
  keys,
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
import type { PartnerListInput, ReassignInput, ReassignResult } from './types.js';

function reassignPlan(repos: Repositories, input: ReassignInput) {
  const order = required(repos.order.get(input.orderId), 'Order');
  const delivery = required(singleton(repos.delivery.forOrder(order.id), 'delivery'), 'Delivery');
  const partner = required(repos.delivery.partner(input.partnerId), 'Partner');
  assertReassignment(order.status, partner.status);
  if (delivery.partner_id === partner.id)
    throw new AppError(
      ErrorCode.CONFLICT,
      'Partner is already assigned to this delivery',
      'Choose a different available partner',
    );
  if (!['pending', 'assigned'].includes(delivery.status))
    throw new AppError(
      ErrorCode.CONFLICT,
      'Delivery is no longer assignable',
      'Reconcile the order and delivery statuses before retrying',
    );
  const previous =
    delivery.partner_id === null
      ? null
      : required(repos.delivery.partner(delivery.partner_id), 'Previous partner');
  return { order, delivery, partner, previous };
}
export function decodeReassign(value: unknown): ReassignResult {
  const row = object(value);
  return {
    order_id: id(row['order_id']),
    delivery: DeliverySchema.parse(row['delivery']),
    previous_partner: nullable(DeliveryPartnerSchema, row['previous_partner']),
    partner: DeliveryPartnerSchema.parse(row['partner']),
  };
}
/** Project cancellation and release only resources owned exclusively by this delivery. */
export function planDeliveryCancellation(repos: Repositories, orderId: string) {
  const current = singleton(repos.delivery.forOrder(orderId), 'delivery');
  const partner = current?.partner_id
    ? required(repos.delivery.partner(current.partner_id), 'Assigned partner')
    : null;
  const changes = current !== null && !['delivered', 'cancelled'].includes(current.status);
  const release =
    changes &&
    partner?.status === 'busy' &&
    repos.delivery.activeForPartner(partner.id, current.id).length === 0;
  return {
    delivery: changes ? DeliverySchema.parse({ ...current, status: 'cancelled' }) : current,
    partner: release ? DeliveryPartnerSchema.parse({ ...partner, status: 'available' }) : partner,
    changes,
    release,
  };
}
export function cancelDelivery(repos: Repositories, orderId: string) {
  const plan = planDeliveryCancellation(repos, orderId);
  if (plan.changes && plan.delivery) repos.delivery.update(plan.delivery);
  if (plan.release && plan.partner) repos.delivery.updatePartner(plan.partner);
  return plan;
}

/** Validate and project a delivery transition without persistence. */
export function planDeliveryAdvance(repos: Repositories, order: Order, at: string) {
  const delivery = singleton(repos.delivery.forOrder(order.id), 'delivery');
  if (!['picked_up', 'out_for_delivery', 'delivered'].includes(order.status))
    return { delivery, changes: false, releasePartner: null };
  const current = required(delivery, 'Delivery');
  const partner = required(
    current.partner_id === null ? null : repos.delivery.partner(current.partner_id),
    'Assigned partner',
  );
  const expected =
    order.status === 'picked_up'
      ? 'assigned'
      : order.status === 'out_for_delivery'
        ? 'picked_up'
        : 'out_for_delivery';
  if (
    current.status !== expected ||
    partner.status !== 'busy' ||
    current.assigned_at === null ||
    (order.status !== 'picked_up' && current.picked_up_at === null)
  ) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'Delivery state disagrees with the order transition',
      'Check the assignment, partner availability, and delivery timestamps',
    );
  }
  const updated = DeliverySchema.parse({
    ...current,
    status: order.status,
    picked_up_at: order.status === 'picked_up' ? at : current.picked_up_at,
    delivered_at: order.status === 'delivered' ? at : current.delivered_at,
  });
  return {
    delivery: updated,
    changes: true,
    releasePartner: order.status === 'delivered' ? partner : null,
  };
}
export function advanceDelivery(repos: Repositories, order: Order, at: string): Delivery | null {
  const plan = planDeliveryAdvance(repos, order, at);
  if (plan.changes && plan.delivery) repos.delivery.update(plan.delivery);
  if (plan.releasePartner)
    repos.delivery.updatePartner({ ...plan.releasePartner, status: 'available' });
  return plan.delivery;
}
export function createDeliveryService(context: ServiceContext) {
  const validate = (input: ReassignInput) => {
    writeInput(input, ['orderId', 'partnerId']);
    id(input.orderId);
    id(input.partnerId);
  };
  return {
    trackDelivery(orderId: string) {
      id(orderId);
      return context.read((repos) => {
        const order = required(repos.order.get(orderId), 'Order');
        const delivery = singleton(repos.delivery.forOrder(orderId), 'delivery');
        const partner = delivery?.partner_id
          ? required(repos.delivery.partner(delivery.partner_id), 'Partner')
          : null;
        const late =
          delivery !== null &&
          !['delivered', 'cancelled'].includes(delivery.status) &&
          order.status !== 'cancelled' &&
          delivery.assigned_at !== null &&
          delivery.eta_min !== null &&
          Date.parse(now()) > Date.parse(delivery.assigned_at) + delivery.eta_min * 60000;
        return DeliveryTrackingSchema.parse({
          order_id: orderId,
          order_status: order.status,
          delivery,
          partner,
          is_late: late,
        });
      });
    },
    listDeliveryPartners(input: PartnerListInput = {}) {
      keys(input, ['status', 'cursor', 'limit']);
      const filters = parse(PartnerListFiltersSchema, input, 'partner filters');
      return context.read((repos) => repos.delivery.partners(filters));
    },
    previewReassign(input: ReassignInput) {
      validate(input);
      return context.read((repos) => {
        const { order, delivery, partner, previous } = reassignPlan(repos, input);
        return {
          order_id: order.id,
          delivery_id: delivery.id,
          previous_partner_id: previous?.id ?? null,
          partner_id: partner.id,
          previous_partner_status_after: previous ? 'available' : null,
          partner_status_after: 'busy',
          delivery_status_after: 'assigned',
          refund_amount_paise: 0,
          requiresConfirmation: false,
        };
      });
    },
    executeReassign(input: ReassignInput) {
      validate(input);
      return context.mutate(
        'delivery.executeReassign',
        input,
        (repos): ReassignResult => {
          const { order, delivery, partner, previous } = reassignPlan(repos, input);
          const updated = DeliverySchema.parse({
            ...delivery,
            partner_id: partner.id,
            status: 'assigned',
            assigned_at: now(),
          });
          const available = previous
            ? DeliveryPartnerSchema.parse({ ...previous, status: 'available' })
            : null;
          const busy = DeliveryPartnerSchema.parse({ ...partner, status: 'busy' });
          if (available) repos.delivery.updatePartner(available);
          repos.delivery.updatePartner(busy);
          repos.delivery.update(updated);
          return {
            order_id: order.id,
            delivery: updated,
            previous_partner: available,
            partner: busy,
          };
        },
        decodeReassign,
      );
    },
  };
}
