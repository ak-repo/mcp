# Repository folder structure

Dependency direction: **apps → packages; core → shared**. Applications never import other applications. Shared owns browser-safe schemas/DTOs and helpers; core owns SQL and all domain rules. MCP tools and API routes are adapters.

```text
.
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   ├── events/
│   │   │   ├── lib/
│   │   │   ├── llm/
│   │   │   ├── mcp/
│   │   │   ├── plugins/
│   │   │   ├── routes/
│   │   │   ├── simulator/
│   │   │   └── tests/
│   │   └── README.md
│   ├── mcp-server/
│   │   ├── src/{lib,tools,resources,prompts,transports}/
│   │   └── README.md
│   └── web/
│       ├── src/{App.tsx,main.tsx,shared.test.ts}
│       ├── index.html
│       ├── package.json
│       ├── tsconfig{,.app,.node}.json
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       └── README.md
├── packages/
│   ├── core/
│   │   ├── migrations/
│   │   └── src/{db,domain,repositories,services,seed}/
│   └── shared/
│       └── src/{schemas,index.ts,errors.ts,money.ts}
├── data/
├── docs/
├── scripts/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── eslint.config.js
```

Tests are colocated or under package test directories; build output is ignored dist/. SQLite files belong in ignored data/. One root lockfile controls all workspaces. Direct external dependencies are exact-pinned; workspace links use workspace:*.

Use Node 22 and pnpm 10. Root build compiles shared → core → backend apps through tsc -b, then runs the independent web build. Web uses Bundler resolution and noEmit and stays outside backend project references. It consumes built shared exports; its dev/typecheck/test scripts build shared first. Root typecheck/test recurse across packages, while root lint applies browser/React rules to web and backend rules elsewhere.

The web package is only a verified foundation. UI features, routing, styles and query libraries arrive in Phase 5a. Browser requests go through the API; database, MCP and LLM access remain server-side.
