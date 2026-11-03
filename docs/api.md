# FoodOps REST API

The API is a thin adapter over `@foodops/core`. Base URL: `http://127.0.0.1:3002`.
Run `pnpm install`, initialize the database with `pnpm migrate` and `pnpm seed`, set `ADMIN_TOKEN` in the workspace `.env`, then run `pnpm dev:api` (or `pnpm build` and `pnpm start:api`). See [API configuration](../apps/api/README.md).

## Authentication and transport

Send exactly one `Authorization: Bearer <ADMIN_TOKEN>` header. The configured token must contain at least 32 characters without whitespace. Every domain route requires auth; only exact `GET /api/health`, `GET /api/ready`, and valid CORS preflights are public. Duplicate Authorization headers return 401. Probe exceptions apply only to GET. Exact `GET /api/stream` instead requires a single-use ticket, as described below.

JSON bodies use `Content-Type: application/json` and must not exceed 102400 bytes. Responses are JSON, except SSE streams, successful preflights (204) and HEAD responses (no body). Safe `X-Request-Id` values are echoed; otherwise the server generates a UUID. CORS allows exact configured `WEB_ORIGIN` values with credentials disabled. `Idempotency-Key` is allowed in preflights and `Idempotency-Replayed` is exposed to browser clients. Proxy headers are not trusted.

Overall limits cover auth failures and unknown routes. Writes/previews/simulator POSTs use an independent write bucket; ticket POSTs use the ticket bucket instead. Limits are per IP and process; 429 responses include Retry-After.

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
| POST    | `/api/orders/:id/advance`                   | `{ reason, to_status, confirmation_token }`                                                | `OrderMutationResult`     | `order.advanceStatus`           | 200     |
| POST    | `/api/orders/:id/cancel`                    | `{ reason, confirmation_token }`                                                           | `OrderMutationResult`     | `order.executeCancel`           | 200     |
| POST    | `/api/orders/:id/refund`                    | `{ reason, amount_paise, confirmation_token }`                                             | `RefundResult`            | `refund.executeRefund`          | 200     |
| POST    | `/api/deliveries/:orderId/reassign`         | `{ reason, partner_id, confirmation_token }`                                               | `ReassignResult`          | `delivery.executeReassign`      | 200     |
| GET | `/api/me` | Empty query; bearer auth | `{ actor: "ops", auth: "bearer" }` | Authentication plugin | 200 |
| OPTIONS | `*`                                         | Valid Origin + Access-Control-Request-Method; optional Access-Control-Request-Headers | Empty preflight response  | CORS plugin                     | 204     |

`GET /api/ready` returns 503 when its core read fails. MCP connectivity checks, the MCP tool catalog, chat and providers remain deferred. SSE and simulator endpoints are documented below.

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

1. POST the operation fields and reason to `/preview`; no idempotency key is needed. The flat preview adds `confirmation_token` and `expires_at`. No rows are written.
2. Show the preview to the operator and obtain explicit approval. Domain confirmation flags are advisory; every new REST mutation needs a signed token.
3. Execute with exactly the same fields/reason and `confirmation_token`, plus one `Idempotency-Key` header matching `[A-Za-z0-9._:-]{8,128}`. Actor is always server-assigned `ops`; obsolete `confirm` and injected `actor` fields are rejected.
4. Retry using the same semantic request and key. After auth/strict validation, matching stored requests return the original body and `Idempotency-Replayed: true` before token verification, even with an expired, missing or invalid token. Different semantic fields/operation/order with the same key return 409. Tokens and keys are not semantic request fields.

Tokens last five minutes and bind the channel, operation, order, fields, and canonical preview. The current preview is checked transactionally before effects. Invalid/expired/wrong-arguments tokens return 428; changed state returns 409 with hint "Re-run the preview and confirm again". REST and MCP tokens are not interchangeable even with the same secret. Set API_CONFIRM_SECRET for stable multi-process REST verification; otherwise restart invalidates pending tokens. Hosts still enforce explicit operator approval.

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
  -d '{"reason":"Customer requested cancellation","confirmation_token":"<token from preview>"}' \
  http://127.0.0.1:3002/api/orders/O-EDGE-UNASSIGNED/cancel
```

Example page: `{ "data": [], "next_cursor": null }`. Example error:

```json
{
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "Execution requires a valid token for the current preview",
    "hint": "Obtain a fresh preview, show it to the user, obtain explicit approval, then execute with its confirmation_token"
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
| 409  | CONFLICT              | Idempotency-key mismatch, changed signed preview, unavailable partner, or database conflict                        |
| 413  | LIMIT_EXCEEDED        | Request body exceeds 100 KB                                                                         |
| 415  | VALIDATION            | Unsupported request media type                                                                      |
| 422  | LIMIT_EXCEEDED        | Refund exceeds remaining captured balance                                                           |
| 428  | CONFIRMATION_REQUIRED | Missing, expired, tampered or wrong-arguments token                                                     |
| 429  | LIMIT_EXCEEDED        | Overall/write/ticket rate exceeded; honor `Retry-After`                                             |
| 500  | INTERNAL              | Unexpected failure; public response excludes internal details, SQL, and stacks                      |
| 503  | INTERNAL              | Readiness failure or server shutdown                                                                |

All errors have `{ error: { code, message, hint } }`. Malformed confirmation types are 400. Missing key validation precedes missing confirmation; no failed validation writes an idempotency record. Use the response `X-Request-Id` when reporting failures.

## Live stream

| Method | Path                 | Purpose                                                                           |
| ------ | -------------------- | --------------------------------------------------------------------------------- |
| POST   | `/api/stream/ticket` | Bearer-authenticated, body omitted or `{}`; returns `{ticket, expires_at}` (200). |
| GET    | `/api/stream`        | Ticket-authenticated SSE; query `ticket`; optional `Last-Event-ID` header.        |

Obtain a fresh ticket with bearer authentication, then connect within 30 seconds. Tickets are random, single-use, in-memory credentials; they do not survive restart. Never put `ADMIN_TOKEN` in a URL. Every reconnect needs a new ticket. Use `fetch` streaming to supply the last durable ID explicitly rather than letting EventSource retry a consumed ticket URL. CORS allows `Last-Event-ID`, with credentials disabled.

```js
const issued = await fetch('/api/stream/ticket', {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken}` },
}).then((r) => r.json());
const stream = await fetch(`/api/stream?ticket=${encodeURIComponent(issued.ticket)}`, {
  headers: lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {},
});
// Parse event-stream frames from stream.body; retain IDs from durable events.
```

Successful streams return `text/event-stream`. Frames contain `event`, JSON `data`, and (for database changes) numeric `id` fields, separated by a blank line. Heartbeat comments arrive every 15 seconds. Events are invalidations: refetch authoritative REST data, and treat all text as data.

- `order.updated`, `delivery.updated`, `partner.updated`, `payment.updated`, `invoice.updated`: data `{id, type, order_id, entity, at}`. Refund changes emit `payment.updated` with `entity: "refund"`. An unassigned partner has `order_id: null`; assigned partners emit a row for each active associated order.
- `mcp.call`: data `{tool, status, error_code, latency_ms, at}`, without args or SSE ID. They are not replayed after reconnect. Audit notifications are live-only; REST `/api/mcp/calls` supplies history.

The feed polls every 500 ms by default and sees writes from API, MCP and other SQLite processes. At boot it starts at current maxima. A connection without `Last-Event-ID` receives future changes; one with the header replays retained rows then transitions to live without duplicate durable IDs. Change history is retained for 24 hours and pruned hourly. Invalid cursors produce 400; missing/expired/used tickets produce 401. Unavailable history, future IDs, or replay beyond `SSE_REPLAY_LIMIT` produce 409 `CONFLICT` before streaming: refresh REST state, request a new ticket, and reconnect without the header. Ticket and stream capacity limits produce 429 `LIMIT_EXCEEDED`. The default concurrent-stream limit is 50. Slow consumers are disconnected when their bounded queue fills; reconnect using the last received durable ID. Shutdown ends streams before database handles close.

## Simulator

| Method | Path             | Purpose                                                                                 |
| ------ | ---------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/simulator` | Bearer-authenticated configuration and cumulative counters (200).                       |
| POST   | `/api/simulator` | Bearer-authenticated runtime configuration; strict body `{enabled, interval_ms}` (200). |

`interval_ms` must be an integer from 1000 to 60000; both fields are required on POST. Response: `{enabled, interval_ms, ticks, orders_placed, advanced, cancelled, errors, ticks_waiting_for_partner}`. POST uses the write rate limiter. Invalid bodies/unknown fields return 400 `VALIDATION`; auth failures return 401; rate limits return 429.

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3002/api/simulator
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"interval_ms":5000}' http://127.0.0.1:3002/api/simulator
```

Simulator activity is explicitly enabled autonomous synthetic traffic, with actor `system`; it does not interpret order notes. It is off by default. Each jittered tick may place one order and processes up to three orders, with a 5% pre-pickup cancellation chance per selected order. It skips failed payments, assigns available partners before pickup, and uses the normal core transactions, pricing, invoices and cancellation/refund rules. Disabling waits for the current tick and stops future scheduling. Errors are logged/counted independently. Runtime controls and counters are in memory: restart restores environment defaults and continues existing database orders; no duplicate startup loop is created.

REST confirmation config: `API_CONFIRM_SECRET` defaults to unset (random per-process), or must have at least 32 characters without whitespace. The signature domain changes on this deployment; previously issued MCP preview tokens must be refreshed.

Rate limits are independent per IP: overall `RATE_LIMIT_PER_MIN=1200` (including auth failures and unknown routes), write/preview/simulator `RATE_LIMIT_WRITE_PER_MIN=60`, and ticket issuance `RATE_LIMIT_TICKET_PER_MIN=60`. All must be positive integers. Tickets consume overall + ticket, not write quota. CORS exposes Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotency-Replayed and X-Request-Id on ordinary, 429 and SSE responses. Allowed request headers include Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-Request-Id, and existing X-Run-Id.

`GET /api/me` validates the UI bearer token. Missing, wrong or duplicate Authorization returns the standard 401 UNAUTHORIZED error; it is not a public health endpoint.

Simulator backlog: `SIMULATOR_MAX_ACTIVE=60` (positive safe integer) prevents simulator placement when all active orders, including failed payments, reach the cap. External writers are not capped. Progression samples oldest untouched candidates per status (`updated_at ASC, id ASC`), excluding failed payments. Status adds `ticks_waiting_for_partner`, counting once per tick where any pickup candidate waits for a partner; other actions may still progress.

## Complete API configuration

Process environment overrides workspace-root `.env`. Empty API_CONFIRM_SECRET means unset. Secrets are never logged.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DB_PATH` | `./data/foodops.sqlite` | Existing initialized SQLite file; relative to workspace root. |
| `API_HOST` | `127.0.0.1` | Listener host; trustProxy is false. |
| `API_PORT` | `3002` | Integer 1–65535. |
| `ADMIN_TOKEN` | `required` | 32+ characters without whitespace; bearer auth. |
| `API_CONFIRM_SECRET` | `unset` | Optional 32+ characters without whitespace; random per-process when unset/empty. |
| `WEB_ORIGIN` | `http://localhost:5173` | Comma-separated exact HTTP(S) origins; credentials disabled. |
| `LOG_LEVEL` | `info` | fatal, error, warn, info, debug, trace, silent. |
| `RATE_LIMIT_PER_MIN` | `1200` | Positive safe integer; overall per-IP requests/minute. |
| `RATE_LIMIT_WRITE_PER_MIN` | `60` | Positive safe integer; independent write/preview/simulator bucket. |
| `RATE_LIMIT_TICKET_PER_MIN` | `60` | Positive safe integer; independent ticket issuance bucket. |
| `SIMULATOR` | `off` | off or on; explicitly authorized synthetic traffic. |
| `SIMULATOR_INTERVAL_MS` | `5000` | 1000–60000 ms; jitter ±10%, clamped to bounds. |
| `SIMULATOR_SEED` | `42` | Unsigned 32-bit deterministic action RNG seed. |
| `SIMULATOR_MAX_ACTIVE` | `60` | Positive safe integer; simulator placement admission cap. |
| `CHANGE_FEED_POLL_MS` | `500` | 100–60000 ms; single non-overlapping poller. |
| `SSE_MAX_STREAMS` | `50` | 1–1000 concurrent streams. |
| `SSE_REPLAY_LIMIT` | `1000` | 1–10000 durable change events per reconnect. |
| `CALL_LOG_RETENTION_DAYS` | `30` | 1–1000000 days; audit history pruned hourly, together with 24-hour change history. |

Audit feed sequences are internal; mcp.call has no SSE id and is not replayed after reconnect. REST history pagination is unchanged. Apply migration 0004 before restarting the API against an existing database. No historical migration is edited.

### LLM configuration (provider layer only)

No chat/settings routes or agent loop exist yet. Provider settings updates are in memory only. See project documentation section 9 for streaming, prompted tools and explicit probes. An omitted base URL selects the provider default; an explicit URL is preserved.

| Variable                    | Default            | Meaning                                                                                                                                         |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`              | `ollama`           | ollama, openai-compatible, anthropic.                                                                                                           |
| `LLM_BASE_URL`              | provider-dependent | https://ollama.com; https://api.openai.com/v1; https://api.anthropic.com. HTTP(S), no userinfo/query/fragment or metadata/link-local addresses. |
| `LLM_MODEL`                 | unset              | Required at chat time, not boot. Exact model identifier.                                                                                        |
| `LLM_API_KEY`               | unset              | Server-only credential; manager exposes only api_key_set.                                                                                       |
| `LLM_TOOL_MODE`             | `auto`             | native, prompted, auto; auto defaults native until an explicit probe recommends prompted.                                                       |
| `LLM_NUM_CTX`               | `16384`            | Positive context size; sent natively by Ollama only.                                                                                            |
| `LLM_TEMPERATURE`           | `0.2`              | 0–2; individual providers/models may restrict support.                                                                                          |
| `LLM_FIRST_BYTE_TIMEOUT_MS` | `60000`            | Connect/headers/first-byte deadline.                                                                                                            |
| `LLM_IDLE_TIMEOUT_MS`       | `30000`            | Between-byte deadline.                                                                                                                          |
| `LLM_MAX_CONCURRENCY`       | `1`                | Shared manager concurrency across replacements; queue cap 100.                                                                                  |
| `LLM_MAX_RETRIES`           | `2`                | 0–10; retry only before the first normalized event. Probes override to zero.                                                                    |
| `LLM_THINK`                 | `off`              | Ollama only outbound. Anthropic/OpenAI-compatible reject on; thinking never enters outbound history.                                            |
| `LLM_CONTEXT_BUDGET_TOKENS` | `12000`            | Reserved for future history trimming.                                                                                                           |
