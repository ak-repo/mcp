# @foodops/shared

Shared validation schemas, DTO types, error codes, and money conventions. This package is the foundation of the dependency chain and has no dependency on core or MCP. Money is represented as integer paise.

Database access, business workflows, MCP registration, transport code, and logging must not live here.

This scaffold contains empty modules only. From the workspace root, run `pnpm --filter @foodops/shared build`, `typecheck`, `lint`, or `test`. Tests may be absent during foundation setup.
