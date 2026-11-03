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

`GET /api/ready` returns 503 when its core read fails. Chat, provider settings, approvals and lazy MCP discovery are implemented below. SSE and simulator endpoints are documented below.

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

Chat, settings and approval routes expose the in-memory provider/agent layer. Provider settings updates are in memory only. See project documentation section 9 for streaming, prompted tools and explicit probes. An omitted base URL selects the provider default; an explicit URL is preserved.

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
| `LLM_CONTEXT_BUDGET_TOKENS` | `12000`            | Agent history and tool-schema budget (characters/4).                                                                                                           |

### MCP client configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_URL` | `http://127.0.0.1:3001/mcp` | Lazy Streamable HTTP connection; HTTP(S), no credentials/query/fragment or metadata targets. |
| `MCP_AUTH_TOKEN` | unset | Required at connection time, 32+ non-whitespace characters; server-side only. |
| `MCP_CALL_TIMEOUT_MS` | `10000` | Per-request timeout and maximum total timeout. |
| `MCP_TOOLS_TTL_MS` | `60000` | Tool catalog freshness; manual refresh and reconnect invalidate it. |

### Agent configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MAX_ITERATIONS` | `6` | 1–100 model iterations per run. |
| `AGENT_MAX_TOOL_CALLS` | `12` | 1–100 model-requested calls; preview and execute are phases of one call. |
| `AGENT_RUN_TIMEOUT_MS` | `300000` | Whole-run deadline, including approval waits. |

## Chat, approvals, provider settings, and MCP discovery

All endpoints below require exactly one bearer header. No credentials belong in URLs. Bodies and queries are strict; these routes accept no query parameters. Existing `/api/mcp/calls` is unchanged.

| Method | Path | Query or JSON body | Response | Owner | Success |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/chat` | `{session_id?, message}` | AgentEvent SSE | Agent host | 200 |
| POST | `/api/chat/:runId/approve` | `{call_id, decision}` | `{run_id,call_id,decision}` | Approval registry | 200 |
| POST | `/api/chat/:runId/cancel` | empty optional object | `{run_id,status:"cancelled"}` | Agent host | 200 |
| GET | `/api/providers` | none | ProviderPublicConfig plus last_probe | Provider manager | 200 |
| PUT | `/api/providers` | ProviderUpdate | ProviderPublicConfig | Provider manager | 200 |
| GET | `/api/providers/models` | none | `{models:[{name,sizeBytes?}]}` | Active provider | 200 |
| POST | `/api/providers/test` | empty optional object | ProbeResult | Explicit probe | 200 |
| GET | `/api/mcp/tools` | none | `{tools:[{name,description,input_schema,kind}]}` | Sanitized discovery cache | 200 |
| GET | `/api/mcp/status` | none | `{connected,last_error,tool_count}` | Lazy MCP client | 200 |

`message` is a nonblank string of 1–4000 characters; optional `session_id` is a nonblank ID of at most 128 characters. Omit it for a new session. `run.started` announces run_id and session_id. One run may be active per session. Session histories are in memory, bounded to 100 sessions, 40 messages each and a 30-minute idle TTL.

### Fetch streaming protocol

Use POST fetch, not EventSource. Supply Authorization and Content-Type: application/json; read the response body as SSE. Event names equal AgentEvent.type, and each data object contains the complete AgentEvent including type. Heartbeats are `: heartbeat` comments every 15 seconds. There are no event IDs, Last-Event-ID replay, or reconnection semantics for chat. The separate database `/api/stream` protocol remains unchanged.

```js
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Cancel order O-0192 after showing the preview' }),
  signal: abortController.signal,
});
if (!response.ok) throw await response.json();
// Parse response.body as SSE, allowing arbitrary byte boundaries and heartbeat comments.
```

CORS, exposed headers, security headers, rate-limit headers and X-Request-Id are copied to the hijacked response. Writes respect socket backpressure; a 256 KiB blocked buffer closes/aborts the run rather than accumulating unlimited output. Client disconnect aborts the LLM, approval wait and MCP requests. An in-flight write may already have committed: cancellation does not imply rollback. Refresh order state before starting another write.

Complete example transcript (IDs, preview fields and timings illustrative):

```text
event: run.started
data: {"type":"run.started","run_id":"run-1","session_id":"session-1","provider":"ollama","model":"your-exact-model-id"}

event: tool.call
data: {"type":"tool.call","call_id":"call-1","name":"cancel_order","arguments":{"order_id":"O-0192","reason":"Operator request"},"kind":"write"}

event: text.delta
data: {"type":"text.delta","text":"Proposed cancellation of O-0192 and refund ₹494.35. Explicit approval is required."}

event: approval.required
data: {"type":"approval.required","call_id":"call-1","name":"cancel_order","preview":{"order_id":"O-0192","to_status":"cancelled","refund_amount_paise":49435,"refund_amount_display":"₹494.35"},"expires_at":"2026-11-03T12:05:00Z"}

: heartbeat

event: approval.resolved
data: {"type":"approval.resolved","call_id":"call-1","decision":"approved"}

event: tool.result
data: {"type":"tool.result","call_id":"call-1","name":"cancel_order","status":"ok","latency_ms":1200,"summary":"Confirmed operation completed.","truncated":false}

event: text.delta
data: {"type":"text.delta","text":"The order was cancelled."}

event: run.completed
data: {"type":"run.completed","usage":{"promptTokens":500,"completionTokens":80},"iterations":2}
```

Between approval.required and approval.resolved, the model is paused. The operator separately sends:

```http
POST /api/chat/run-1/approve
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json

{"call_id":"call-1","decision":"approved"}
```

Decision is only `approved` or `rejected`; use the cancel endpoint to stop a run. The response repeats `{run_id,call_id,decision}`. Identical decisions replay 200 without another execution; conflicting/expired/cancelled decisions return 409 CONFLICT. Unknown runs/call IDs return 404 NOT_FOUND. Completed runs retain identity for 30 minutes, at most 100 completed records; active records are never evicted. Expired retention returns 404. Cancellation repeats return 200; cancelling a normally completed run returns 409. Approval tokens and execution idempotency keys remain private to the host and are never accepted from the client.

Before stream headers, errors use the standard JSON envelope. After headers, failures use terminal `run.error {kind,message,retryable}`; limits instead emit explanatory text and run.completed. Exactly one terminal AgentEvent ends normal delivery. Full AgentEvent schemas live in packages/shared; thinking.delta is streamed separately and never persisted in model history.

### Provider settings and diagnostics

ProviderPublicConfig is `{provider,base_url,model,tool_mode,effective_tool_mode,temperature,num_ctx,api_key_set,capabilities:{toolCalling,streaming,thinking}}`. `model` may be null. GET adds `last_probe` (current-config result within the ten-minute cache, or null). No API key is returned, including after PUT.

ProviderUpdate accepts only optional `provider`, `base_url`, `model`, `tool_mode`, `temperature` (0–2), `num_ctx` (positive safe integer), write-only `api_key`, and `clear_api_key`. Set and clear together is invalid. URLs use the existing HTTP(S)/no-credentials/no-metadata restrictions. Updates validate atomically, invalidate probe results, affect subsequent runs, and never persist to disk. Changing provider selects its default URL and clears an old key unless replacements are supplied. Existing runs retain their captured provider instance.

```json
{"provider":"ollama","base_url":"https://ollama.com","model":"your-exact-model-id","tool_mode":"auto","api_key":"<server-only-key>"}
```

ProbeResult is `{ok,steps:[{name,ok,detail,latency_ms}],models,model_found,tool_calling,recommended_tool_mode,warnings}`. It lists models, verifies the exact model identifier, then tests a harmless native call, with prompted fallback if needed. At most two generation requests, thinking off, 256 output tokens each, no retries/repair, ten-minute caching. It never runs at boot. Failed probes return a safe 502 error; GET /providers exposes the retained failed result. Local API probe quota returns 429; upstream provider rate limiting returns 502 with a helpful rate-limit message. Models listing and discovery failures also return 502; secrets/provider bodies never cross the error boundary.

MCP tools expose the same sanitized schemas given to the model, with host controls removed from write schemas and kind read/write derived from annotations. Catalog lookup may connect lazily. Status lookup does not connect. These do not expose the MCP bearer token.

| Condition | HTTP / error code | Action |
| --- | --- | --- |
| Invalid chat/settings/approval input | 400 VALIDATION | Correct the strict body/schema. |
| Missing/wrong/duplicate dashboard token | 401 UNAUTHORIZED | Send exactly one bearer header. |
| Unknown run/call ID | 404 NOT_FOUND | Use IDs from this run's events. |
| Session busy, conflicting decision, expired approval, completed cancel | 409 CONFLICT | Inspect state and start a new run/preview if necessary. |
| Chat/probe quota or concurrent run cap | 429 LIMIT_EXCEEDED | Honor Retry-After; cancel/wait for a run. |
| Provider auth/rate/model/network failure or MCP discovery unavailable | 502 INTERNAL | Follow safe message/hint; correct upstream settings or retry later. |
| Runtime stopping | 503 INTERNAL | Retry after restart. |

### Additional admission and rate-limit configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_MAX_CONCURRENT_RUNS` | `4` | 1–100 active/reserved runs, including approval waits, per process. |
| `RATE_LIMIT_CHAT_PER_MIN` | `20` | Positive per-IP chat starts/minute, independent of writes/tickets/probes. |
| `RATE_LIMIT_PROBE_PER_MIN` | `5` | Positive per-IP explicit probes/minute. Cached probes still consume request quota. |

All new endpoints also consume the overall bucket. Approval/cancel/PUT settings use the write bucket; chat quota cannot consume that bucket. LLM_MAX_CONCURRENCY (default 1) is separate from run admission: admitted runs may queue for generation or wait for approval. Runtime shutdown rejects admission, aborts/drains runs, cancels approvals, closes chat streams and MCP, then closes DB handles. All earlier LLM_*, AGENT_*, MCP_* and API variables remain documented in the configuration tables above.

`pnpm smoke:chat` builds on local compiled modules, starts temporary MCP/API listeners and a scripted provider, reads late delivery data, approves cancellation over HTTP and verifies actor ai in order_events. It never contacts an external provider. Build first. `LLM_LIVE=1 pnpm llm:live` is opt-in and may incur usage: it runs a real Ollama probe plus one read-only seeded-DB question through a temporary MCP/API fixture. Only read tools are available, no write can execute, and printed output is redacted.

In auto mode, Ollama catalogs with schemas that its native profile cannot represent use strict prompted tools for that call, even if the dummy native probe succeeds. Explicit native mode fails clearly. This avoids weakening JSON Schema constraints. Capabilities and effective_tool_mode describe the general selected mode; actual catalog compatibility may force this per-call fallback.
