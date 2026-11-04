# FoodOps Web

React 18 and Vite foundation for the operations dashboard. Feature UI is intentionally deferred to Phase 5a. Business rules, pricing, database access and write policies belong in core. The browser calls only the API: never import another app or connect directly to SQLite, MCP or an LLM provider.

## Commands

Use Node 22 and pnpm 10 from the workspace root. Run pnpm install, then pnpm dev:web. Open http://127.0.0.1:5173. The strict port prevents silent fallback.

- pnpm build: backend compilation first, then web typecheck and production bundle.
- pnpm build:web: shared build, independent web typecheck and Vite bundle.
- pnpm --filter @foodops/web typecheck: strict browser and tooling checks.
- pnpm --filter @foodops/web test: real shared-schema import/parse test.
- pnpm --filter @foodops/web lint: browser/hooks/refresh rules with zero warnings.
- pnpm --filter @foodops/web preview: serve the built output at port 5173.

Shared is consumed through its built package exports without aliases. Dev, typecheck and test build shared first; restart or rebuild shared after editing its contracts. Web is outside the backend tsc project-reference chain. Vite emits dist with an ES2022 target and no production sourcemaps.

## Environment and proxy

Vite reads local env files in apps/web. All VITE_ values are public: never store ADMIN_TOKEN, MCP tokens or provider keys in them. Authentication belongs in browser memory, never localStorage.

The optional non-secret VITE_API_BASE_URL is reserved for the future HTTP client; it is not consumed by this empty foundation. Its intended default is same-origin /api. The development proxy forwards /api to http://127.0.0.1:3002. A deployment must route /api to the API or configure the future client explicitly.

API WEB_ORIGIN defaults to http://localhost:5173. The root example includes both localhost and 127.0.0.1 origins. For an existing private .env, add http://127.0.0.1:5173 to WEB_ORIGIN before using this dev server; local files are never changed automatically.

## Contracts for Phase 5

The authoritative HTTP reference is ../../docs/api.md; browser-safe schemas are in @foodops/shared.

- Validate bearer auth with GET /api/me. Handle the error envelope and HTTP status together.
- REST writes use a flat preview plus confirmation_token/expires_at, then the same fields with the token and Idempotency-Key after human approval. Old confirm and actor fields are rejected. Stored replays return Idempotency-Replayed:true; 409 stale state requires a new preview, 428 requires a valid token.
- Database SSE uses a fresh single-use ticket on every reconnect and fetch streaming with Last-Event-ID. mcp.call is live-only without replay IDs. These are invalidations, not full records.
- Chat uses POST fetch streaming without replay IDs. Render approval.required directly; approval tokens stay in the host. Approved writes may complete after browser disconnect/cancel.
- Provider keys are write-only; settings are temporary. Changed provider origins clear unreplaced credentials. Discovery routes expose sanitized MCP schemas and connection status.
- CORS exposes Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Idempotency-Replayed and X-Request-Id.
