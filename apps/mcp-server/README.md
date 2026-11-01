# @foodops/mcp-server

Thin MCP adapter over core services. Owns tool, resource, and prompt registration, error mapping, configuration, tool-call logging integration, and stdio/Streamable HTTP transport lifecycle. Depends on core, which depends on shared.

SQL, repositories, business rules, payment calculations, LLM calls, and frontend code must not live here. In stdio mode stdout is reserved for MCP protocol traffic; application logs must go to stderr.

This scaffold contains empty modules only. From the workspace root, run `pnpm --filter @foodops/mcp-server build`, `typecheck`, `lint`, or `test`. `pnpm dev:mcp` watches the empty entrypoint; it does not yet start an MCP server. Transport behavior arrives in Phase 2.
