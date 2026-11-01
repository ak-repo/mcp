# FoodOps MCP

Seeded food-order, delivery, refund, and invoice operations exposed through Model Context Protocol. Node.js 22, strict TypeScript, pnpm, SQLite, Zod, and the pinned MCP SDK. The current application is the MCP backend.

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

| Variable | Default | Meaning |
| --- | --- | --- |
| `DB_PATH` | `./data/foodops.sqlite` | Initialized SQLite file; relative to workspace root. |
| `MCP_HOST` | `127.0.0.1` | HTTP bind address; non-loopback access also needs an explicit allowlist. |
| `PORT` | `3001` | HTTP port, integer 1–65535. |
| `MCP_PORT` | unset | Legacy port fallback when `PORT` is absent. |
| `ALLOWED_HOSTS` | loopback at `PORT` | Comma-separated `host:port` authorities for request Host and Origin. Defaults: `127.0.0.1`, `localhost`, `[::1]` with the listener port. No URLs or wildcards. |
| `MCP_AUTH_TOKEN` | unset | Required for HTTP: at least 32 characters without whitespace. Stdio is trusted locally. |
| `MCP_CONFIRM_SECRET` | random per process | Optional shared HMAC secret, at least 32 characters without surrounding whitespace; sharing supports multiple processes, rotation invalidates tokens. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |

Choose stdio or HTTP through its entrypoint. Preview write tools without a token, show the preview to the user, then execute with its five-minute `confirmation_token` after approval. The host enforces human approval. See the server guide for retry behavior and the isolated stdio verification command.
