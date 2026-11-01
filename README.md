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
