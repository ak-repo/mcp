# FoodOps MCP

Seeded food-order, delivery, refund, and invoice operations exposed through Model Context Protocol. Node.js 22, strict TypeScript, pnpm, SQLite, Zod, and the pinned MCP SDK. The current applications are the MCP backend and the dashboard REST API.

From the workspace root, with Node 22 and pnpm 10 active:

```sh
pnpm install
cp .env.example .env
pnpm migrate
pnpm seed
pnpm build
pnpm --silent dev:mcp
```

Copy `.env.example` only when creating your local `.env`; preserve existing settings. Stdio waits for an MCP host on stdin and writes only JSON-RPC to stdout. Use Ctrl+C to stop it. Start HTTP with `MCP_AUTH_TOKEN` set using `pnpm start:http`.

See the [MCP server guide](apps/mcp-server/README.md) for environment variables, the tool catalog, authenticated HTTP, complete Inspector/Claude Desktop verification, and troubleshooting. The [project documentation](docs/FoodOps%20MCP%20Project%20Documentation%20%26%20MVP%20Plan.md) is the source of truth.

Validation:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```

Transport tests start temporary loopback listeners and child processes. They use seeded temporary databases and do not change `data/foodops.sqlite`.

## MCP environment

Process values override the workspace `.env`.

| Variable             | Default                 | Meaning                                                                                                                                                        |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PATH`            | `./data/foodops.sqlite` | Initialized SQLite file; relative to workspace root.                                                                                                           |
| `MCP_HOST`           | `127.0.0.1`             | HTTP bind address; non-loopback access also needs an explicit allowlist.                                                                                       |
| `PORT`               | `3001`                  | HTTP port, integer 1–65535.                                                                                                                                    |
| `MCP_PORT`           | unset                   | Legacy port fallback when `PORT` is absent.                                                                                                                    |
| `ALLOWED_HOSTS`      | loopback at `PORT`      | Comma-separated `host:port` authorities for request Host and Origin. Defaults: `127.0.0.1`, `localhost`, `[::1]` with the listener port. No URLs or wildcards. |
| `MCP_AUTH_TOKEN`     | unset                   | Required for HTTP: at least 32 characters without whitespace. Stdio is trusted locally.                                                                        |
| `MCP_CONFIRM_SECRET` | random per process      | Optional shared HMAC secret, at least 32 characters without surrounding whitespace; sharing supports multiple processes, rotation invalidates tokens.          |
| `LOG_LEVEL`          | `info`                  | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                                                               |

Choose stdio or HTTP through its entrypoint. Preview write tools without a token, show the preview to the user, then execute with its five-minute `confirmation_token` after approval. The host enforces human approval. See the server guide for retry behavior and the isolated stdio verification command.

## Dashboard API foundation

Set a separate `ADMIN_TOKEN` in `.env` (32+ characters, no whitespace), then run `pnpm dev:api`, or `pnpm build` followed by `pnpm start:api`. Public probes: `GET /api/health` for liveness and `GET /api/ready` for a core DB read. Domain routes require bearer authentication; operator writes require explicit confirmation and an idempotency key. See the [REST endpoint reference](docs/api.md). See the [API guide](apps/api/README.md) for security, error contracts, and lifecycle ownership.

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

### Live updates

Use `POST /api/stream/ticket` with bearer auth, then `GET /api/stream?ticket=...` within 30 seconds. Tickets are single-use; reconnect with a fresh ticket and `Last-Event-ID` for retained database changes. Never put the admin token in a URL. See [the API reference](docs/api.md) for event/replay contracts.

| Variable              | Default | Bounds/purpose                |
| --------------------- | ------- | ----------------------------- |
| `CHANGE_FEED_POLL_MS` | 500     | 100–60000 ms                  |
| `SSE_MAX_STREAMS`     | 50      | 1–1000 concurrent streams     |
| `SSE_REPLAY_LIMIT`    | 1000    | 1–10000 durable replay events |

`SIMULATOR=off` remains required until the simulator phase.
