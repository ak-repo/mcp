import type {
  Actor,
  Address,
  Customer,
  Delivery,
  DeliveryPartner,
  Invoice,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  PartnerStatus,
  Payment,
  Refund,
  SalesGroupBy,
  ToolCallLog,
} from '@foodops/shared';
import type { WriteMeta } from './context.js';
export interface PaginationInput {
  cursor?: string;
  limit?: number;
}
export interface OrderListInput extends PaginationInput {
  status?: OrderStatus;
  customerId?: string;
  restaurantId?: string;
  from?: string;
  to?: string;
}
export interface RestaurantSearchInput extends PaginationInput {
  query?: string;
  cuisine?: string;
  area?: string;
  openNow?: boolean;
}
export interface MenuInput extends PaginationInput {
  restaurantId: string;
  vegOnly?: boolean;
  availableOnly?: boolean;
}
export interface PartnerListInput extends PaginationInput {
  status?: PartnerStatus;
}
export interface OrderWriteInput extends WriteMeta {
  orderId: string;
}
export interface AdvanceInput extends OrderWriteInput {
  toStatus: OrderStatus;
}
export interface RefundInput extends OrderWriteInput {
  amountPaise: number;
}
export interface ReassignInput extends OrderWriteInput {
  partnerId: string;
}
export interface MetricsInput {
  from: string;
  to: string;
  groupBy: SalesGroupBy;
}
export interface OrderDetails {
  order: Order;
  items: OrderItem[];
  customer: Customer;
  address: Address;
  payment: Payment | null;
  delivery: Delivery | null;
  timeline: OrderEvent[];
}
export interface OrderMutationResult {
  partner: DeliveryPartner | null;
  order: Order;
  event: OrderEvent;
  payment: Payment | null;
  refund: Refund | null;
  invoice: Invoice | null;
  delivery: Delivery | null;
}
export interface RefundResult {
  order_id: string;
  payment: Payment;
  refund: Refund;
}
export interface ReassignResult {
  order_id: string;
  delivery: Delivery;
  previous_partner: DeliveryPartner | null;
  partner: DeliveryPartner;
}
export type AuditInput = Omit<
  ToolCallLog,
  'id' | 'at' | 'session_id' | 'error_code' | 'actor' | 'latency_ms' | 'args_json'
> & {
  sessionId?: string | null;
  errorCode?: ToolCallLog['error_code'];
  actor: Actor;
  latencyMs: number;
  argsJson: string;
  idempotencyKey?: string;
};
