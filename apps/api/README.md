# FoodOps API

Production foundation for the dashboard HTTP API. This package owns Fastify lifecycle, authentication, HTTP validation, logging, and response mapping. Business rules and database queries belong in `@foodops/core`; DTOs and domain validation belong in `@foodops/shared`. Never import from `apps/mcp-server`.

Domain REST routes and health probes are implemented. See the [complete REST reference](../../docs/api.md) for inputs, responses, examples, and preview/execute approval. SSE, simulator, LLM adapters, and agent execution belong to later phases.

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

| Variable             | Default                 | Meaning                                                                                                   |
| -------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `DB_PATH`            | `./data/foodops.sqlite` | Existing initialized SQLite file, relative to workspace root.                                             |
| `API_HOST`           | `127.0.0.1`             | Listener IP address or hostname; proxy headers are never trusted.                                         |
| `API_PORT`           | `3002`                  | Integer 1–65535.                                                                                          |
| `ADMIN_TOKEN`        | required                | At least 32 characters without whitespace; separate from MCP authentication.                              |
| `WEB_ORIGIN`         | `http://localhost:5173` | Comma-separated exact HTTP(S) origins; no wildcards, trailing slash, paths, or credentials.               |
| `LOG_LEVEL`          | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                          |
| `SIMULATOR`          | `off`                   | `off` or `on`; `on` fails startup until the simulator phase is implemented.                               |
| `RATE_LIMIT_PER_MIN` | `120`                   | Positive safe integer; per-IP, per-process requests per minute. Write hook uses one quarter, minimum one. |

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

SIGINT/SIGTERM stop accepting connections, drain in-flight requests, close Fastify, then close both DB handles. The deadline is ten seconds. On timeout the CLI force-closes sockets and exits 1; it does not close handles while handlers could still resume. Embedded callers must treat a rejected shutdown as fatal or await Fastify closure before reusing or disposing resources.

## Dependency baseline

Exact versions were selected against the 2026-10-18 publication cutoff (14 days before 2026-11-01): Fastify 5.12.7 (Oct 13), CORS 11.3.1 (Oct 8), rate-limit 11.2.1 (Oct 8), Helmet 13.2.0 (Oct 13), fastify-plugin 6.0.1 (Oct 10), Pino 10.4.0 (Oct 2), Zod 4.6.7 (Oct 12). Pino and Zod match the workspace. Shared Zod parsing is used directly; no type-provider is installed.

## REST writes

Read and show the preview to the operator, then execute with `confirm: true` and one `Idempotency-Key` header (8–128 safe characters). The actor is always server-assigned `ops`. REST confirmation is an operator contract; previews are advisory and are not token-bound. MCP retains its separate signed-token protocol. Replays return the original result; `Idempotency-Replayed: true` is set when detectable. See [docs/api.md](../../docs/api.md) for the full contract and cross-process detection limits.
