# FoodOps API

Production foundation for the dashboard HTTP API. This package owns Fastify lifecycle, authentication, HTTP validation, logging, and response mapping. Business rules and database queries belong in `@foodops/core`; DTOs and domain validation belong in `@foodops/shared`. Never import from `apps/mcp-server`.

Domain REST routes and health probes are implemented. See the [complete REST reference](../../docs/api.md) for inputs, responses, examples, and preview/execute approval. Ticket-authenticated SSE and the optional simulator are implemented. LLM adapters and agent execution belong to later phases.

## Setup and commands

Use Node 22 and pnpm 10 from the workspace root:

```sh
pnpm install
# Create .env from .env.example only if .env does not already exist.
pnpm migrate
pnpm seed
# Set ADMIN_TOKEN in the workspace .env to a strong token of 32+ characters.
pnpm dev:api
```

`pnpm dev:api` runs `tsx watch`; `pnpm build` compiles to `apps/api/dist`; `pnpm start:api` runs the compiled entrypoint. Startup requires an initialized database and never migrates or seeds automatically. The existing migration CLI reads `DATABASE_PATH` for a custom location; set it to the same file as `DB_PATH` when migrating a custom database.

```sh
curl -i http://127.0.0.1:3002/api/health
curl -i http://127.0.0.1:3002/api/ready
pnpm typecheck && pnpm build && pnpm lint && pnpm test
pnpm --filter @foodops/api test
```

Tests use temporary core-seeded databases. Build before process tests, which launch compiled files. No tests change the workspace database.

## Environment

Process environment overrides the workspace-root `.env`; defaults apply only when a value is absent. Empty values are invalid. Tokens and rejected configuration values are never logged.

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

## HTTP behavior

- `GET /api/health`: liveness, `200 { "status": "ok" }`, without DB access.
- `GET /api/ready`: core read-only service check, `200 { "status": "ready" }`; unavailable DB returns a safe 503 error. MCP connectivity checks are deferred until the API has an MCP client.
- All other requests require exactly one `Authorization: Bearer <ADMIN_TOKEN>` header. Duplicate fields are rejected; token digests are compared in constant time. Probe exceptions apply only to exact GET paths. Valid browser CORS preflights are unauthenticated.
- CORS permits the exact configured origins with credentials disabled. Requests without Origin are accepted. Allowed response headers expose `X-Request-Id` and `Idempotency-Replayed`; preflights allow `Idempotency-Key`.
- Requests are limited to 102400 body bytes. Global limits include public probes, failed auth, unknown paths, and preflights. Limiting is local to one process; distributed deployment requires a shared store in a later change.
- Write routes attach `preHandler: app.writeRateLimit`; this adds an independent stricter bucket alongside the global limiter. Production execute and preview routes use this stricter limiter.
- Safe single `X-Request-Id` values (`[A-Za-z0-9._:-]{1,128}`) are accepted; otherwise UUIDs are generated. Responses echo the ID. Request logs carry `request_id` and `run_id`; startup/shutdown logs have no request context. API Pino JSON goes to stdout; secrets are redacted.

Errors have `{ error: { code, message, hint } }`. Shared mappings: VALIDATION 400, NOT_FOUND 404, INVALID_TRANSITION/CONFLICT 409, LIMIT_EXCEEDED 422, CONFIRMATION_REQUIRED 428, INTERNAL 500. HTTP-only codes UNAUTHORIZED/FORBIDDEN use 401/403. Transport validation uses 400/405/415 with VALIDATION, body size uses 413 with LIMIT_EXCEEDED, rate limits use 429 with LIMIT_EXCEEDED, readiness uses 503 with INTERNAL. Internal messages, SQL, and stacks are logged server-side only.

## Ownership and shutdown

`buildApp({ config, runtime })` returns an unstarted instance and owns neither signals nor DB lifetime. Embedded callers must close Fastify before closing their runtime. `startApi` owns the listener/runtime lifecycle and supports idempotent `shutdown()`.

SIGINT/SIGTERM stop accepting connections, stop simulator/polling and end SSE streams, drain in-flight requests, close Fastify, then close both DB handles. The deadline is ten seconds. On timeout the CLI force-closes sockets and exits 1; it does not close handles while handlers could still resume. Embedded callers must treat a rejected shutdown as fatal or await Fastify closure before reusing or disposing resources.

## Dependency baseline

Exact versions were selected against the 2026-10-18 publication cutoff (14 days before 2026-11-01): Fastify 5.12.7 (Oct 13), CORS 11.3.1 (Oct 8), rate-limit 11.2.1 (Oct 8), Helmet 13.2.0 (Oct 13), fastify-plugin 6.0.1 (Oct 10), Pino 10.4.0 (Oct 2), Zod 4.6.7 (Oct 12). Pino and Zod match the workspace. Shared Zod parsing is used directly; no type-provider is installed.

## REST writes

Read and show the preview to the operator, then execute with `confirmation_token` and one `Idempotency-Key` header (8–128 safe characters). The actor is always server-assigned `ops`. REST tokens bind the request and preview state; hosts enforce operator approval. MCP uses a separate signature domain. Replays return the original result; `Idempotency-Replayed: true` is set for every stored replay, including transaction-level races. See [docs/api.md](../../docs/api.md) for the full contract and transactional replay metadata.

### Live updates and simulator

Use `POST /api/stream/ticket` with bearer auth, then `GET /api/stream?ticket=...` within 30 seconds. Tickets are single-use; reconnect with a fresh ticket and `Last-Event-ID` for retained database changes. Never put the admin token in a URL. See [the API reference](../../docs/api.md) for event/replay and simulator control contracts.

| Variable                | Default | Bounds/purpose                               |
| ----------------------- | ------- | -------------------------------------------- |
| `CHANGE_FEED_POLL_MS`   | 500     | 100–60000 ms                                 |
| `SSE_MAX_STREAMS`       | 50      | 1–1000 concurrent streams                    |
| `SSE_REPLAY_LIMIT`      | 1000    | 1–10000 durable replay events                |
| `SIMULATOR_INTERVAL_MS` | 5000    | 1000–60000 ms, ±10% jitter clamped to bounds |
| `SIMULATOR_SEED`        | 42      | Unsigned 32-bit action seed                  |

`SIMULATOR=off` is the default. With `on`, synthetic actions use core services as `system`. GET/POST `/api/simulator` reports statistics and changes runtime settings; restart restores environment defaults. Run `pnpm smoke:api` after building to exercise SSE and REST cancellation on an isolated temporary seed.


## LLM core

Native Node 22 fetch helpers, normalized provider types, bounded FIFO concurrency, byte deadlines, safe errors and schema profiles live in `src/llm`. No chat routes or agent loop are exposed. Missing model/key does not prevent API boot. Reuse a provider instance to share concurrency. No extra dependencies are installed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai-compatible`, or `anthropic`; only native Ollama implemented in this phase. |
| `LLM_BASE_URL` | `https://ollama.com` | HTTP(S) base; native adapter appends `/api/chat` or `/api/tags`. No userinfo/query/fragment or link-local metadata targets. Local/private hosts allowed. |
| `LLM_MODEL` | unset | Required only when chat starts, not at boot or model listing. |
| `LLM_API_KEY` | unset | Optional bearer key; required by direct Ollama cloud. Never logged. |
| `LLM_TOOL_MODE` | `auto` | Native adapter uses native tools for auto/native; prompted tools deferred and rejected explicitly. |
| `LLM_NUM_CTX` | `16384` | Positive context window. |
| `LLM_TEMPERATURE` | `0.2` | Finite number 0–2. |
| `LLM_FIRST_BYTE_TIMEOUT_MS` | `60000` | Connect/headers/first body byte deadline, max 2147483647 ms. |
| `LLM_IDLE_TIMEOUT_MS` | `30000` | Between-byte deadline, max 2147483647 ms. |
| `LLM_MAX_CONCURRENCY` | `1` | Positive concurrent operations per reused provider; queue capped at 100. |
| `LLM_MAX_RETRIES` | `2` | 0–10 retries, only before the first normalized event. |
| `LLM_THINK` | `off` | Explicit boolean off/on; model support varies. |
| `LLM_CONTEXT_BUDGET_TOKENS` | `12000` | Positive budget reserved for the later history-trimming layer. |

HTTP redirects are disabled. URL validation blocks literal link-local/metadata targets but does not prevent DNS rebinding. Retries apply only before any normalized event; callers must not retry a partially consumed stream. Errors use application-owned messages and do not echo provider bodies. Thinking is excluded from outbound history.


### Native Ollama adapter and opt-in live check

`createOllamaProvider(config)` in `src/llm` uses POST `/api/chat` and GET `/api/tags`. It sends bearer auth only when a key is configured. Set `LLM_BASE_URL=http://localhost:11434` for local Ollama, or keep the cloud default and set `LLM_API_KEY`. Select a tool-capable model using `LLM_MODEL`.

```sh
pnpm build
LLM_LIVE=1 pnpm llm:live
```

The script loads workspace `.env` with process overrides, prints redacted model/stream results, requests a harmless dummy tool, executes nothing, and exits non-zero if no valid call is returned. It is excluded from tests. Without `LLM_LIVE=1` it refuses network access. No API server or initialized DB is needed.

The adapter sends `think:false` when off and `think:true` when on; models that do not support the requested control may reject it. Thinking is streamed separately and omitted from outbound history. Native arguments are objects; defensive indexed string fragments are buffered until the terminal chunk. Ambiguous unindexed fragments fail. Call IDs are stable for a given request and ordinal, with provider IDs preserved. Capability flags describe adapter support; model probing remains planned. `auto` uses native tools until the future probe/fallback layer exists; `prompted` with tools fails explicitly.

REST operations now require preview → explicit operator approval → execute with `confirmation_token` and Idempotency-Key. Previews add a token and five-minute expiry; the old confirm field is rejected. REST/MCP tokens are channel-separated. `API_CONFIRM_SECRET` is optional (32+ characters, no whitespace); unset uses a random process-local key. A stored semantic replay is returned before token verification, after auth and strict validation.

Rate limits are independent per IP: overall `RATE_LIMIT_PER_MIN=1200` (including auth failures and unknown routes), write/preview/simulator `RATE_LIMIT_WRITE_PER_MIN=60`, and ticket issuance `RATE_LIMIT_TICKET_PER_MIN=60`. All must be positive integers. Tickets consume overall + ticket, not write quota. CORS exposes Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotency-Replayed and X-Request-Id on ordinary, 429 and SSE responses. Allowed request headers include Authorization, Content-Type, Idempotency-Key, Last-Event-ID, X-Request-Id, and existing X-Run-Id.

Simulator backlog: `SIMULATOR_MAX_ACTIVE=60` (positive safe integer) prevents simulator placement when all active orders, including failed payments, reach the cap. External writers are not capped. Progression samples oldest untouched candidates per status (`updated_at ASC, id ASC`), excluding failed payments. Status adds `ticks_waiting_for_partner`, counting once per tick where any pickup candidate waits for a partner; other actions may still progress.

Audit history retention is controlled by CALL_LOG_RETENTION_DAYS (default 30). Its feed cursor is monotonic across pruning. Runtime.shutdown() stops and awaits background work, closes streams/tickets, and then closes DB handles; close() returns the same shutdown promise and must be awaited. Close Fastify before disposing an embedded runtime so HTTP handlers can drain.
