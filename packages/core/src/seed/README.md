# Deterministic demo seed

Run `pnpm seed` from the workspace root after building the workspace. The command loads the root `.env`, using `DB_PATH` or the legacy `DATABASE_PATH`; process environment settings override the file. Relative paths resolve from the workspace root. The default is `data/foodops.sqlite`.

`pnpm seed --reset` removes the SQLite database and its journal sidecars, then migrates and recreates it. A normal rerun verifies the existing seed without changing application rows. If application data differs, it returns `CONFLICT` and requires an explicit reset.

The factory uses an isolated Faker instance seeded with `42` and the fixed anchor `2026-11-01T12:00:00.000Z`. All IDs, timestamps, prices, event paths, refunds, and invoice numbers are deterministic. Active partner assignments are unique. Cancellation records retain their unassigned, pending deliveries, matching the cancellation service's rule that it changes no delivery or partner state.

Seeding and invariant validation run in one transaction after migrations. Validation covers DTOs, foreign keys, pricing, event chains, payment/refund balances, delivered-only invoices, delivery timestamps, and partner availability. The content hash covers all logical application rows, including the empty audit/idempotency tables; it excludes SQLite file metadata and installation timestamps in `schema_migrations`.

The final stderr JSON report contains counts, the content hash, the anchor, and these stable order IDs:

| Scenario                                | Order ID                    |
| --------------------------------------- | --------------------------- |
| Late delivery at the fixed anchor       | `O-EDGE-LATE`               |
| Failed payment                          | `O-EDGE-FAILED-PAYMENT`     |
| Partial refund                          | `O-EDGE-PARTIAL-REFUND`     |
| Unassigned delivery                     | `O-EDGE-UNASSIGNED`         |
| Cancelled and fully refunded            | `O-EDGE-CANCELLED-REFUNDED` |
| Injection-style note, preserved as data | `O-EDGE-INJECTION`          |
