# Backend folder structure

Dependency direction: **mcp-server → core → shared; never the reverse.** Shared owns contracts, core owns data and business rules, and MCP is a thin adapter that calls core services. No API, LLM layer, or frontend is included.

```text
.
├── .env.example
├── .gitignore
├── .nvmrc
├── .prettierrc
├── LICENSE
├── README.md
├── apps/
│   └── mcp-server/
│       ├── README.md
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── lib/
│       │   │   ├── config.ts
│       │   │   ├── create-server.ts
│       │   │   ├── error-mapper.ts
│       │   │   ├── logger.ts
│       │   │   └── tool-log.ts
│       │   ├── prompts/
│       │   │   ├── daily-ops-report.ts
│       │   │   ├── index.ts
│       │   │   ├── order-triage.ts
│       │   │   └── refund-review.ts
│       │   ├── resources/
│       │   │   ├── index.ts
│       │   │   ├── invoice-template.ts
│       │   │   ├── policies.ts
│       │   │   └── schema.ts
│       │   ├── tools/
│       │   │   ├── advance-order-status.ts
│       │   │   ├── cancel-order.ts
│       │   │   ├── get-invoice.ts
│       │   │   ├── get-menu.ts
│       │   │   ├── get-order.ts
│       │   │   ├── get-sales-summary.ts
│       │   │   ├── index.ts
│       │   │   ├── issue-refund.ts
│       │   │   ├── list-delivery-partners.ts
│       │   │   ├── list-orders.ts
│       │   │   ├── reassign-delivery.ts
│       │   │   ├── search-restaurants.ts
│       │   │   └── track-delivery.ts
│       │   └── transports/
│       │       ├── http.ts
│       │       └── stdio.ts
│       ├── tsconfig.json
│       ├── tsconfig.typecheck.json
│       └── vitest.config.ts
├── data/
│   └── .gitkeep
├── docs/
│   ├── FoodOps MCP Project Documentation & MVP Plan.md
│   └── architecture/
│       └── folder-structure.md
├── eslint.config.js
├── package.json
├── packages/
│   ├── core/
│   │   ├── README.md
│   │   ├── migrations/
│   │   │   └── 0001_init.sql
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── db/
│   │   │   │   ├── connection.ts
│   │   │   │   └── migrate.ts
│   │   │   ├── domain/
│   │   │   │   ├── order-state-machine.ts
│   │   │   │   ├── policies.ts
│   │   │   │   └── pricing.ts
│   │   │   ├── index.ts
│   │   │   ├── repositories/
│   │   │   │   ├── audit.repo.ts
│   │   │   │   ├── catalog.repo.ts
│   │   │   │   ├── delivery.repo.ts
│   │   │   │   ├── invoice.repo.ts
│   │   │   │   ├── metrics.repo.ts
│   │   │   │   ├── order.repo.ts
│   │   │   │   ├── payment.repo.ts
│   │   │   │   └── refund.repo.ts
│   │   │   ├── seed/
│   │   │   │   ├── factories.ts
│   │   │   │   └── seed.ts
│   │   │   └── services/
│   │   │       ├── catalog.service.ts
│   │   │       ├── delivery.service.ts
│   │   │       ├── invoice.service.ts
│   │   │       ├── metrics.service.ts
│   │   │       ├── order.service.ts
│   │   │       └── refund.service.ts
│   │   ├── tsconfig.json
│   │   ├── tsconfig.typecheck.json
│   │   └── vitest.config.ts
│   └── shared/
│       ├── README.md
│       ├── package.json
│       ├── src/
│       │   ├── errors.ts
│       │   ├── index.ts
│       │   ├── money.ts
│       │   └── schemas/
│       │       ├── customer.ts
│       │       ├── delivery.ts
│       │       ├── invoice.ts
│       │       ├── menu.ts
│       │       ├── metrics.ts
│       │       ├── order.ts
│       │       ├── payment.ts
│       │       ├── refund.ts
│       │       └── restaurant.ts
│       ├── tsconfig.json
│       ├── tsconfig.typecheck.json
│       └── vitest.config.ts
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Use Node 22 (at least 22.13) and pnpm 10.34.9. Direct external dependencies are pinned exactly; internal packages use `workspace:*`. The lockfile fixes transitive resolutions. pnpm permits native install scripts only for better-sqlite3 and esbuild.

Run `pnpm install`, `pnpm typecheck`, `pnpm build`, `pnpm test`, and `pnpm lint` from the workspace root. Each package also exposes build, typecheck, lint, and test scripts. Typecheck emits declarations into ignored `.typecheck/` directories so project references work before a build; builds emit JavaScript and declarations into ignored `dist/` directories.

All source modules contain only `export {};`. The migration is empty. Seed and MCP development commands execute empty entrypoints until their respective implementation phases. Vitest configurations intentionally allow zero tests. No runtime environment loading or transport is implemented in this scaffold.
