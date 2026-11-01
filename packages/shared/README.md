# @foodops/shared

Shared validation schemas, DTO types, error codes, and money conventions. This package is the foundation of the dependency chain and has no dependency on core or MCP. Money is represented as integer paise.

Database access, business workflows, MCP registration, transport code, and logging must not live here.

Exports strict Zod entity/filter schemas, shared errors, safe integer paise helpers, and pagination contracts. Decimal rupees and percentage calculations use half-up rounding. Cursors encode the order `(placed_at, id)` keyset as canonical base64url; they are opaque pagination positions, not authorization tokens. Entity timestamps use ISO-8601 UTC; date filters also accept calendar dates. Nullable fields represent unassigned or incomplete lifecycle data.

From the workspace root, run `pnpm --filter @foodops/shared build`, `typecheck`, `lint`, or `test`.
