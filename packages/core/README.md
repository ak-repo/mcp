# @foodops/core

Owns SQLite connections, numbered migrations, deterministic seed data, repositories, domain policies, and business services. Depends only on shared within the workspace. All business rules, transactions, and idempotency belong here.

MCP concepts, HTTP adapters, LLM integrations, and UI code must not live here. Adapters must call services rather than repositories directly.

This scaffold contains empty source modules and an empty migration. From the workspace root, run `pnpm --filter @foodops/core build`, `typecheck`, `lint`, or `test`. `pnpm seed` currently executes the empty seed entrypoint and creates no database; data-layer behavior arrives in Phase 1. Faker is a development dependency used only by this package.
