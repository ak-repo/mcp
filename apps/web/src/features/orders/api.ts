import {
  AdvancePreviewResponseSchema,
  CancelPreviewResponseSchema,
  OrderDetailsSchema,
  OrderMutationSchema,
  OrderPageSchema,
  RefundPreviewResponseSchema,
  RefundResultSchema,
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

export type WriteOperation = 'advance' | 'cancel' | 'refund';
export type PreviewInput =
  | { operation: 'advance'; to_status: string; reason: string }
  | { operation: 'cancel'; reason: string }
  | { operation: 'refund'; reason: string; amount_paise: number };

export async function previewOrder(id: string, input: PreviewInput, signal?: AbortSignal) {
  const schema = (
    input.operation === 'advance'
      ? AdvancePreviewResponseSchema
      : input.operation === 'cancel'
        ? CancelPreviewResponseSchema
        : RefundPreviewResponseSchema
  ) as ResponseSchema<AdvancePreviewResponse | CancelPreviewResponse | RefundPreviewResponse>;
  const body =
    input.operation === 'advance'
      ? { reason: input.reason, to_status: input.to_status }
      : input.operation === 'cancel'
        ? { reason: input.reason }
        : { reason: input.reason, amount_paise: input.amount_paise };
  return apiFetch(`/api/orders/${encodeURIComponent(id)}/${input.operation}/preview`, schema, {
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
        : { reason: input.reason, amount_paise: input.amount_paise, confirmation_token };
  return apiFetchWithMeta<unknown>(
    `/api/orders/${encodeURIComponent(id)}/${input.operation}`,
    (input.operation === 'refund'
      ? RefundResultSchema
      : OrderMutationSchema) as ResponseSchema<unknown>,
    { method: 'POST', body, idempotencyKey, ...(signal ? { signal } : {}) },
  );
}
