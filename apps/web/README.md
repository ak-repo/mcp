# FoodOps Web

React 18 operations console. The app includes login, a responsive shell, System status, Overview analytics, Orders table/board, order details and preview-confirm writes. The browser calls only the REST/SSE API. Contracts come from `@foodops/shared` and [docs/api.md](../../docs/api.md).

## Run and verify

Use Node 22 and pnpm 10 from the workspace root:

```sh
pnpm install
pnpm build
pnpm start:http
pnpm start:api
pnpm dev:web
```

Run the three servers in separate terminals with server-side environment configured per their READMEs. Open http://127.0.0.1:5173. MCP is needed to produce MCP audit activity, not for API readiness or login. The System status page checks database readiness and displays the last 20 live events received in this browser session.

```sh
pnpm --filter @foodops/web typecheck
pnpm --filter @foodops/web lint
pnpm --filter @foodops/web test
pnpm --filter @foodops/web build
pnpm typecheck && pnpm build && pnpm lint && pnpm test
```

Web dev/typecheck/test rebuild shared's existing exports. `pnpm build:web` builds web independently; `pnpm --filter @foodops/web preview` serves the production output. Build backend before root tests, whose process tests execute compiled files.

## Environment and deployment

Vite reads local env files in apps/web. `VITE_API_BASE_URL` is optional and public: set it to an HTTP(S) **origin**, for example `http://127.0.0.1:3002`, without a path, credentials, query or fragment. Default is the browser origin, with `/api` forwarded to port 3002 by the development proxy. Production hosting must serve the SPA for browser routes and proxy `/api`, or configure the API origin explicitly. Serve `/theme-init.js` as an external script; a `script-src 'self'` policy needs no inline theme script. Tailwind and fonts are bundled locally.

API `WEB_ORIGIN` must include the exact web origin, including scheme, hostname and port. Its default `http://localhost:5173` differs from Vite's `http://127.0.0.1:5173`; add the latter in server configuration. Credentials/cookies are disabled. The API allows Last-Event-ID and Idempotency-Key, and exposes Retry-After, X-Request-Id, Idempotency-Replayed and rate-limit headers. Do not put tokens in VITE variables.

## Architecture

- `app/`: provider composition, route definitions, shell and route error handling.
- `lib/api/`: memory-only auth store, schema-validating fetch client, safe errors and hierarchical query keys.
- `lib/live/`: bounded fetch SSE reader, connection lifecycle, typed subscriptions and one-second invalidation batching.
- `features/auth/`, `features/system/`, `features/overview/` and `features/orders/`: authentication, readiness, metrics, order browsing and signed write flows.
- `components/ui/`: locally authored shadcn-style components using pinned Radix primitives, cmdk and Sonner. `components/common/`: page header, status badges and asynchronous states.
- `styles/`: Tailwind 4 through PostCSS and CSS-variable light/dark tokens. `lib/status-config.ts` centralizes order labels, token names and icons.

Tests are colocated. Vitest uses jsdom, Testing Library, injected fetch and fake readable streams; MSW is not required. The external theme initializer is tested as the actual script source. Recharts is pinned and lazy-loaded for Overview charts. Preview tokens remain component-memory-only; execute requests use a stable idempotency key and read the exposed `Idempotency-Replayed` header. Invoice is intentionally disabled until 5c.

## Authentication, requests and errors

Login validates the entered token using GET /api/me. The token is held only in memory. Refreshing requires signing in again. Logout clears the token, query cache and live state. A bearer-authenticated 401 expires the session; an expired stream ticket 401 reconnects with a fresh ticket instead. Generation guards prevent stale requests from expiring newer sessions.

`apiFetch(path, schema, options)` requires a shared response schema. It supports JSON, caller cancellation, a 15-second default timeout and explicit Idempotency-Key. Bearer headers can go only to the configured API origin; redirects are rejected. ApiError carries status/code/message/hint/requestId/retryAfterMs. Malformed JSON or schema mismatch produces a safe ContractError. Raw response bodies and transport errors are not exposed. Retry-After supports seconds and HTTP dates.

Queries retry only network/5xx failures, at most twice. Writes never retry automatically. Later domain writes must still obtain a signed preview and explicit approval, then execute with unchanged fields and a stable idempotency key. Money displays use API `*_display` strings; money input must use shared string-to-integer-paise helpers.

## Live updates

Each connection obtains a fresh single-use ticket through bearer-authenticated POST /api/stream/ticket. Fetch GET /api/stream sends the ticket in its query and resumes using the **Last-Event-ID header**. EventSource cannot set this header on a new connection and would reuse consumed ticket URLs, so it is not used. No admin token is included in a stream URL or stream request.

The reader validates payloads with LiveChangeEventSchema/McpCallEventSchema, checks durable frame IDs and suppresses duplicate durable events. MCP notifications have no cursor and cannot replay. The reader handles UTF-8 chunk boundaries, multiline data and heartbeat comments, with bounded frame buffering and a 45-second idle watchdog.

Reconnects back off from one second to 30 seconds with jitter and respect Retry-After. A resume 409 invalidates all server queries, clears the cursor and reconnects with another ticket; data resyncs after connection. A tab hidden for 60 seconds pauses the reader; returning reconnects and resyncs. Offline browsers stop retries. Logout and StrictMode cleanup abort readers, requests and timers. Malformed events invalidate data and stop automatic reconnect until explicit retry.

`useLiveEvents(type, handler)` supplies typed event subscriptions for later features. Cache invalidations are batched for 1000 ms and deduplicated by structural query key:

| Event                              | Invalidated queries                                        |
| ---------------------------------- | ---------------------------------------------------------- |
| order.updated                      | Order lists/detail, deliveries, metrics                    |
| delivery.updated                   | Deliveries, associated order detail, partners, metrics     |
| partner.updated                    | Partners, deliveries, associated order detail when present |
| payment.updated, including refunds | Order lists/detail, invoice, metrics                       |
| invoice.updated                    | Invoice and associated order detail                        |
| mcp.call                           | MCP call history                                           |
| Resume gap or return after pause   | All server queries                                         |

REST remains authoritative; invalidation events never invent domain records.

## Theme, accessibility and security

Theme defaults to system, with light/dark choices. Theme and comfortable/compact density are the only persistent preferences (`foodops.theme`, `foodops.density`). External theme initialization runs before React to avoid a theme flash; storage failures fall back safely.

The shell includes a skip link, keyboard navigation, focus states, responsive drawer and Ctrl/Cmd+K palette. Status includes text and icons; reduced motion is respected. Database/event text renders only as text, with a root ESLint ban on dangerouslySetInnerHTML. Tokens, ticket URLs and raw errors are not logged or stored. The UI connects to neither SQLite nor MCP/LLM providers directly.
