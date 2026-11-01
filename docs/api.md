# FoodOps REST API

The API is a thin adapter over `@foodops/core`. Base URL: `http://127.0.0.1:3002`.
Run `pnpm install`, initialize the database with `pnpm migrate` and `pnpm seed`, set `ADMIN_TOKEN` in the workspace `.env`, then run `pnpm dev:api` (or `pnpm build` and `pnpm start:api`). See [API configuration](../apps/api/README.md).

## Authentication and transport

Send exactly one `Authorization: Bearer <ADMIN_TOKEN>` header. The configured token must contain at least 32 characters without whitespace. Every domain route requires auth; only exact `GET /api/health`, `GET /api/ready`, and valid CORS preflights are public. Duplicate Authorization headers return 401. Probe exceptions apply only to GET.

JSON bodies use `Content-Type: application/json` and must not exceed 102400 bytes. Responses are JSON, except successful preflights (204) and HEAD responses (no body). Safe `X-Request-Id` values are echoed; otherwise the server generates a UUID. CORS allows exact configured `WEB_ORIGIN` values with credentials disabled. `Idempotency-Key` is allowed in preflights and `Idempotency-Replayed` is exposed to browser clients. Proxy headers are not trusted.

Global limits apply to all requests. All eight POST endpoints also consume the separate stricter write bucket (one quarter of `RATE_LIMIT_PER_MIN`, minimum one, per IP per minute). Limits are per process; exceeding one returns 429 and `Retry-After`.

## Endpoint reference

All domain successes, including writes and replays, use HTTP 200. Paths are case-sensitive. Parameter `id` or `orderId` is a nonblank entity ID; `orderId` in reassign URLs is an **order ID**, not a delivery ID. Unknown query/body fields, repeated query fields, invalid types, and client actor fields return 400.

| Method  | Path                                        | Query or JSON body                                                                    | Response                  | Service                         | Success |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- | ------- |
| GET     | `/api/health`                               | none                                                                                  | `{ status: "ok" }`        | No DB call                      | 200     |
| GET     | `/api/ready`                                | none                                                                                  | `{ status: "ready" }`     | Core catalog read               | 200     |
| GET     | `/api/restaurants`                          | Restaurant filters                                                                    | `Page<Restaurant>`        | `catalog.searchRestaurants`     | 200     |
| GET     | `/api/restaurants/:id/menu`                 | Menu filters                                                                          | `Page<PresentedMenuItem>` | `catalog.getMenu`               | 200     |
| GET     | `/api/orders`                               | Order filters                                                                         | `Page<PresentedOrder>`    | `order.listOrders`              | 200     |
| GET     | `/api/orders/:id`                           | none                                                                                  | `OrderDetails`            | `order.getOrder`                | 200     |
| GET     | `/api/orders/:id/invoice`                   | none                                                                                  | `InvoiceDetails`          | `invoice.getInvoice`            | 200     |
| GET     | `/api/deliveries`                           | Delivery filters                                                                      | `Page<DeliveryTracking>`  | `delivery.listDeliveries`       | 200     |
| GET     | `/api/delivery-partners`                    | Partner filters                                                                       | `Page<DeliveryPartner>`   | `delivery.listDeliveryPartners` | 200     |
| GET     | `/api/metrics/summary`                      | Summary filters                                                                       | `SalesSummary`            | `metrics.getSalesSummary`       | 200     |
| GET     | `/api/mcp/calls`                            | Audit filters                                                                         | `Page<ToolCallLog>`       | `audit.listCalls`               | 200     |
| POST    | `/api/orders/:id/advance/preview`           | `{ reason, to_status }`                                                               | `AdvancePreview`          | `order.previewAdvanceStatus`    | 200     |
| POST    | `/api/orders/:id/cancel/preview`            | `{ reason }`                                                                          | `CancelPreview`           | `order.previewCancel`           | 200     |
| POST    | `/api/orders/:id/refund/preview`            | `{ reason, amount_paise }`                                                            | `RefundPreview`           | `refund.previewRefund`          | 200     |
| POST    | `/api/deliveries/:orderId/reassign/preview` | `{ reason, partner_id }`                                                              | `ReassignPreview`         | `delivery.previewReassign`      | 200     |
| POST    | `/api/orders/:id/advance`                   | `{ reason, to_status, confirm: true }`                                                | `OrderMutationResult`     | `order.advanceStatus`           | 200     |
| POST    | `/api/orders/:id/cancel`                    | `{ reason, confirm: true }`                                                           | `OrderMutationResult`     | `order.executeCancel`           | 200     |
| POST    | `/api/orders/:id/refund`                    | `{ reason, amount_paise, confirm: true }`                                             | `RefundResult`            | `refund.executeRefund`          | 200     |
| POST    | `/api/deliveries/:orderId/reassign`         | `{ reason, partner_id, confirm: true }`                                               | `ReassignResult`          | `delivery.executeReassign`      | 200     |
| OPTIONS | `*`                                         | Valid Origin + Access-Control-Request-Method; optional Access-Control-Request-Headers | Empty preflight response  | CORS plugin                     | 204     |

`GET /api/ready` returns 503 when its core read fails. MCP connectivity checks, the MCP tool catalog, SSE, chat, providers, and simulator remain deferred.

### Query filters

Every list accepts `cursor` (opaque `next_cursor` from the previous response) and `limit` (integer 1–50, default 20). Lists return `{ "data": [...], "next_cursor": null }` when complete; otherwise `next_cursor` is a string. Preserve filters while following a cursor. Empty lists succeed with `data: []`. Order/delivery cursors sort by order `placed_at DESC, id DESC`; audit cursors by `at DESC, id DESC`; restaurant, menu, and partner lists by `id DESC`.

| Filter group | Optional fields                                                                | Rules                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restaurant   | `query`, `cuisine`, `area`, `open_now`, `cursor`, `limit`                      | Text filters are nonblank; `open_now` is exactly `true` or `false`. `query` searches restaurant names using the existing catalog matching rules.                                  |
| Menu         | `veg_only`, `available_only`, `cursor`, `limit`                                | Booleans are exactly `true` or `false`; restaurant comes from the path. Missing restaurant is 404.                                                                                |
| Order        | `status`, `customer_id`, `restaurant_id`, `from`, `to`, `q`, `cursor`, `limit` | `q` is a literal substring across order ID, customer name, restaurant name, and notes. SQLite ASCII case folding applies; `%` and `_` are literal text. Filters combine with AND. |
| Delivery     | `status`, `partner_id`, `cursor`, `limit`                                      | Active orders/deliveries only: pending (including unassigned), assigned, picked_up, out_for_delivery. Terminal status filters return an empty list.                               |
| Partner      | `status`, `cursor`, `limit`                                                    | Status is available, busy, or offline.                                                                                                                                            |
| Audit        | `tool`, `status`, `cursor`, `limit`                                            | Exact tool name; status is success or error. Returns MCP audit rows; REST calls do not create tool-call rows.                                                                     |

Summary filters **require** `from`, `to`, and `group_by` (`day`, `restaurant`, `status`). There is no summary pagination. Dates accept ISO calendar dates or UTC ISO timestamps. `from <= to` is required. A date-only `to` includes its entire UTC calendar day; timestamp upper bounds are inclusive. Groups and totals use the existing core metrics: all-order counts/cancel rate, delivered-order GMV/AOV, and average completed delivery duration from placement.

Order status: placed, accepted, preparing, ready, picked_up, out_for_delivery, delivered, cancelled. Delivery status: pending, assigned, picked_up, out_for_delivery, delivered, cancelled. Money inputs must be safe non-negative integer paise; `amount_paise` for refunds must be positive. Reason must contain non-whitespace text.

### Response DTOs

Schemas live in [shared response contracts](../packages/shared/src/schemas/responses.ts). Single objects, previews, and execute results are returned directly, without a `data` wrapper. Money values come directly from services; integer `*_paise` fields retain their matching INR `*_display` strings. Nullable fields remain null.

- **Restaurant:** `id, name, cuisine, city, area, rating, prep_time_min, is_open`.
- **PresentedMenuItem:** `id, restaurant_id, name, price_paise, price_display, is_veg, is_available`.
- **PresentedOrder:** `id, customer_id, restaurant_id, address_id, status, notes, cancel_reason, placed_at, updated_at`; money pairs for subtotal, tax, delivery_fee, platform_fee, discount, total.
- **OrderDetails:** `order, items, customer, address, payment, delivery, timeline`. Items contain ID/order/menu references, `name, qty, unit_price_paise, unit_price_display`. Customer contains `id, name, phone, email, created_at`; address contains `id, customer_id, label, line1, area, city, pincode`. Payment contains `id, order_id, method, status, amount_paise, amount_display, txn_ref`; delivery has the fields below. Timeline events contain `id, order_id, from_status, to_status, actor, reason, at`.
- **InvoiceDetails:** `{ invoice, items }`. Invoice has `id, order_id, invoice_no, issued_at`, and money pairs for subtotal, tax, fees, discount, total. Invoice is immutable and is issued on delivery. Missing order or unissued invoice is 404.
- **DeliveryTracking:** `order_id, order_status, delivery, partner, is_late`. Delivery contains `id, order_id, partner_id, status, eta_min, assigned_at, picked_up_at, delivered_at`. Partner may be null; ETA/timestamps may be null. Lateness uses assigned time plus ETA and the core clock.
- **DeliveryPartner:** `id, name, phone, vehicle, status`.
- **ToolCallLog:** `id, session_id, tool, args_json, status, error_code, latency_ms, actor, at`. `args_json` remains a JSON string.
- **SalesSummary:** `from, to, group_by, totals, groups`. Metrics: `orders, gmv_paise, gmv_display, avg_order_value_paise, avg_order_value_display, cancel_rate, avg_delivery_time_min`; each group adds `key`. Cancel rate is a fraction, and average delivery time is null without completed deliveries.
- **AdvancePreview:** `order_id, from_status, to_status, reason, delivery_status_after, partner_id, partner_status_after, invoice_will_be_issued, payment_status_after, refund_amount_paise, refund_amount_display, requiresConfirmation, requiresPaymentConfirmation`.
- **CancelPreview:** `order_id, from_status, to_status, cancel_reason, payment_id, payment_status_after, delivery_status_after, partner_id, partner_status_after, refund_amount_paise, refund_amount_display, requiresConfirmation, requiresPaymentConfirmation`.
- **RefundPreview:** `order_id, payment_id, refund_amount_paise, refund_amount_display, remaining_before_paise, remaining_before_display, remaining_after_paise, remaining_after_display, payment_status_after, requiresConfirmation`.
- **ReassignPreview:** `order_id, delivery_id, previous_partner_id, partner_id, previous_partner_status_after, partner_status_after, delivery_status_after, refund_amount_paise, refund_amount_display, requiresConfirmation`.
- **OrderMutationResult:** `order, event, payment, refund, invoice, delivery, partner`; optional effects use null. Cancellation returns updated delivery/partner states and the remaining captured-payment refund.
- **RefundResult:** `order_id, payment, refund`. Refund contains `id, order_id, payment_id, amount_paise, amount_display, reason, actor, idempotency_key, created_at`.
- **ReassignResult:** `order_id, delivery, previous_partner, partner`. Previous partner is null when previously unassigned.

Names, notes, and audit arguments are untrusted plain data. A note containing an instruction never invokes another service or overrides approval.

## Operator write flow

1. Read the order/assignment, then POST to its `/preview` endpoint with the operation fields and reason. Preview is a successful read with no DB changes. It requires neither a key nor confirmation; `confirm`, `actor`, and body idempotency fields are rejected.
2. Show the preview to the operator. The preview's `requiresConfirmation` and `requiresPaymentConfirmation` are domain advisory flags; **every REST execute requires `confirm: true`**, regardless of their values.
3. Execute using the same operation fields/reason, `confirm: true`, and one `Idempotency-Key` header matching `[A-Za-z0-9._:-]{8,128}`. Actor is always set to `ops` on the server.
4. Retry failures using the same key and identical semantic request. A detectable stored replay returns the identical original body with `Idempotency-Replayed: true`; fresh writes omit the header. Same key with different fields, reason, order, or operation returns 409 CONFLICT. Keys share the core's global namespace, including MCP requests.

Previews are advisory snapshots. REST execution does not use MCP tokens or require a recorded preview; current state is checked transactionally at execution. The host/operator is responsible for explicit approval. Replayed execute requests still require auth, a valid key, and `confirm: true`. A concurrent process can cause replay inside core after the preliminary lookup; absence of the replay header does not prove a fresh write.

Cancellation is allowed only before pickup and atomically refunds remaining captured payment, cancels nonterminal delivery work, and frees its busy partner when no other active delivery owns it. Refunds are allowed on delivered/cancelled orders and cannot exceed paid minus refunded. Reassignment requires a pre-pickup order and an available partner. Invalid transitions are 409; refund balance limits are 422.

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://127.0.0.1:3002/api/orders?status=accepted&limit=2'

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://127.0.0.1:3002/api/metrics/summary?from=2026-10-01&to=2026-11-01&group_by=day'

curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"Customer requested cancellation"}' \
  http://127.0.0.1:3002/api/orders/O-EDGE-UNASSIGNED/cancel/preview

# After reviewing the preview and receiving operator approval:
curl -i -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: ops-cancel-example-0001' \
  -d '{"reason":"Customer requested cancellation","confirm":true}' \
  http://127.0.0.1:3002/api/orders/O-EDGE-UNASSIGNED/cancel
```

Example page: `{ "data": [], "next_cursor": null }`. Example error:

```json
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Explicit confirmation is required",
    "hint": "Review the preview with the user, then submit confirm: true to this execute endpoint"
  }
}
```

## Error reference

| HTTP | Code                  | Typical cause                                                                                       |
| ---- | --------------------- | --------------------------------------------------------------------------------------------------- |
| 400  | VALIDATION            | Invalid path/query/body, missing/invalid/duplicate Idempotency-Key, actor injection, malformed JSON |
| 401  | UNAUTHORIZED          | Missing, invalid, malformed, or duplicate Authorization                                             |
| 403  | FORBIDDEN             | Origin or CORS preflight method/header denied                                                       |
| 404  | NOT_FOUND             | Missing order/restaurant, unissued invoice, or unknown route                                        |
| 405  | VALIDATION            | Unsupported method; `Allow` lists accepted methods                                                  |
| 409  | INVALID_TRANSITION    | Illegal advancement, cancellation after pickup, or refund on an ineligible order                    |
| 409  | CONFLICT              | Idempotency-key mismatch, unavailable partner, or conflicting database state                        |
| 413  | LIMIT_EXCEEDED        | Request body exceeds 100 KB                                                                         |
| 415  | VALIDATION            | Unsupported request media type                                                                      |
| 422  | LIMIT_EXCEEDED        | Refund exceeds remaining captured balance                                                           |
| 428  | CONFIRMATION_REQUIRED | Execute has no confirmation or `confirm: false`                                                     |
| 429  | LIMIT_EXCEEDED        | Global/write request rate exceeded; honor `Retry-After`                                             |
| 500  | INTERNAL              | Unexpected failure; public response excludes internal details, SQL, and stacks                      |
| 503  | INTERNAL              | Readiness failure or server shutdown                                                                |

All errors have `{ error: { code, message, hint } }`. Malformed confirmation types are 400. Missing key validation precedes missing confirmation; no failed validation writes an idempotency record. Use the response `X-Request-Id` when reporting failures.
