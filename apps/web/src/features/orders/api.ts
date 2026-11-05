import {
  AdvancePreviewResponseSchema,
  CancelPreviewResponseSchema,
  OrderDetailsSchema,
  OrderMutationSchema,
  OrderPageSchema,
  RefundPreviewResponseSchema,
  RefundResultSchema,
  InvoiceDetailsSchema,
  DeliveryPageSchema,
  PartnerPageSchema,
  ReassignPreviewResponseSchema,
  ReassignResultSchema,
  SalesSummarySchema,
  type AdvancePreviewResponse,
  type CancelPreviewResponse,
  type RefundPreviewResponse,
} from '@foodops/shared';
import { apiFetch, apiFetchWithMeta, type ResponseSchema } from '../../lib/api/client.js';

export type OrderFilters = {
  status?: string | undefined;
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  restaurant_id?: string | undefined;
  customer_id?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export function query(filters: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function listOrders(filters: OrderFilters, signal?: AbortSignal) {
  return apiFetch(`/api/orders${query(filters)}`, OrderPageSchema, signal ? { signal } : {});
}
export function getOrder(id: string, signal?: AbortSignal) {
  return apiFetch(
    `/api/orders/${encodeURIComponent(id)}`,
    OrderDetailsSchema,
    signal ? { signal } : {},
  );
}
export function getInvoice(id: string, signal?: AbortSignal) {
  return apiFetch(
    `/api/orders/${encodeURIComponent(id)}/invoice`,
    InvoiceDetailsSchema,
    signal ? { signal } : {},
  );
}
export type DeliveryFilters = {
  status?: string;
  partner_id?: string;
  cursor?: string;
  limit?: number;
};
export function listDeliveries(filters: DeliveryFilters = {}, signal?: AbortSignal) {
  return apiFetch(`/api/deliveries${query(filters)}`, DeliveryPageSchema, signal ? { signal } : {});
}
export type PartnerFilters = { status?: string; cursor?: string; limit?: number };
export function listPartners(filters: PartnerFilters = {}, signal?: AbortSignal) {
  return apiFetch(
    `/api/delivery-partners${query(filters)}`,
    PartnerPageSchema,
    signal ? { signal } : {},
  );
}
export function getSummary(
  filters: { from: string; to: string; group_by: 'day' | 'restaurant' | 'status' },
  signal?: AbortSignal,
) {
  return apiFetch(
    `/api/metrics/summary${query(filters)}`,
    SalesSummarySchema,
    signal ? { signal } : {},
  );
}

export type WriteOperation = 'advance' | 'cancel' | 'refund' | 'reassign';
export type PreviewInput =
  | { operation: 'advance'; to_status: string; reason: string }
  | { operation: 'cancel'; reason: string }
  | { operation: 'refund'; reason: string; amount_paise: number }
  | { operation: 'reassign'; reason: string; partner_id: string };

export async function previewOrder(id: string, input: PreviewInput, signal?: AbortSignal) {
  const schema = (
    input.operation === 'advance'
      ? AdvancePreviewResponseSchema
      : input.operation === 'cancel'
        ? CancelPreviewResponseSchema
        : input.operation === 'refund'
          ? RefundPreviewResponseSchema
      : ReassignPreviewResponseSchema
  ) as ResponseSchema<
    AdvancePreviewResponse | CancelPreviewResponse | RefundPreviewResponse | Record<string, unknown>
  >;
  const body =
    input.operation === 'advance'
      ? { reason: input.reason, to_status: input.to_status }
      : input.operation === 'cancel'
        ? { reason: input.reason }
        : input.operation === 'refund'
          ? { reason: input.reason, amount_paise: input.amount_paise }
          : { reason: input.reason, partner_id: input.partner_id };
  const path =
    input.operation === 'reassign'
      ? `/api/deliveries/${encodeURIComponent(id)}/reassign/preview`
      : `/api/orders/${encodeURIComponent(id)}/${input.operation}/preview`;
  return apiFetch(path, schema, {
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
}

export async function executeOrder(
  id: string,
  input: PreviewInput,
  confirmation_token: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  const body =
    input.operation === 'advance'
      ? { reason: input.reason, to_status: input.to_status, confirmation_token }
      : input.operation === 'cancel'
        ? { reason: input.reason, confirmation_token }
        : input.operation === 'refund'
          ? { reason: input.reason, amount_paise: input.amount_paise, confirmation_token }
          : { reason: input.reason, partner_id: input.partner_id, confirmation_token };
  const path =
    input.operation === 'reassign'
      ? `/api/deliveries/${encodeURIComponent(id)}/reassign`
      : `/api/orders/${encodeURIComponent(id)}/${input.operation}`;
  return apiFetchWithMeta<unknown>(
    path,
    (input.operation === 'refund'
      ? RefundResultSchema
      : input.operation === 'reassign'
        ? ReassignResultSchema
        : OrderMutationSchema) as ResponseSchema<unknown>,
    { method: 'POST', body, idempotencyKey, ...(signal ? { signal } : {}) },
  );
}
