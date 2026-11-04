# Repository Guidelines

## Project Structure & Architecture

Read `docs/FoodOps MCP Project Documentation & MVP Plan.md` before changing behavior; it is the source of truth. Current scope is the MCP backend only.

- `packages/shared/src`: Zod schemas, DTOs, money helpers, and shared errors.
- `packages/core/src`: domain rules, repositories, services, database access, and deterministic seed; SQL migrations live in `packages/core/migrations`.
- `apps/mcp-server/src`: thin MCP tools, resources, prompts, and transports. Keep SQL and business rules in core.
- Tests sit beside source as `*.test.ts`; transport contract snapshots live under `__snapshots__`. SQLite files belong in gitignored `data/`; generated output goes to `dist/`.

Dependency direction is `mcp-server → core → shared`, never reversed.

## Build, Test, and Development Commands

Use Node 22 and pnpm 10 from the workspace root.

- `pnpm install`: install pinned workspace dependencies.
- `pnpm migrate`: apply numbered migrations; `pnpm seed`: populate deterministic demo data.
- `pnpm seed --reset`: replace the demo database; stop servers first.
- `pnpm --silent dev:mcp`: run development stdio without pnpm stdout banners.
- `pnpm build`: compile packages in dependency order.
- `pnpm start:http`: run compiled HTTP with configured bearer authentication.
- `pnpm typecheck && pnpm build && pnpm lint && pnpm test`: run acceptance checks. Build before tests because process tests execute compiled files.

## Coding Style & Naming

Use strict TypeScript, ESM, `.js` import specifiers, and explicit type imports. Follow existing two-space indentation and Prettier settings: single quotes, semicolons, trailing commas, 100-column width. ESLint permits zero warnings. Name files in kebab-case, repositories `*.repo.ts`, services `*.service.ts`, and MCP tools in snake_case. Implement complete behavior without placeholders.

## Testing Guidelines

Use Vitest and temporary SQLite databases. Test transitions, money rounding, rollback, idempotency, token confirmation, and transport contracts. Update snapshots deliberately and explain contract changes. Run focused checks with `pnpm --filter @foodops/core test`. No numeric coverage threshold is configured.

## Commits & Pull Requests

Follow history: `fix(core): ...`, `fix(mcp): ...`, `fix(config): ...`, or `feat(seed): ...`. Keep commits focused. PRs should explain the problem, resulting behavior, validation, migrations, and compatibility changes; link relevant issues.

GIT RULES (hard, override everything else in this prompt):
- NEVER run git push, git pull, git fetch, git merge, git rebase, git reset --hard, git clean, git checkout/switch to another branch, git stash drop, or any force flag. I do all remote and branch operations myself.
- NEVER run git commit, git commit --amend, or git tag without my explicit approval for that specific commit. Before each commit: show `git status --short`, the diff summary, and the proposed commit message, then STOP and wait for me to reply "commit approved".
- Never stage files with `git add -A` or `git add .`; stage only the files that belong to the current fix, and list them.
- Local read-only commands (git status, git diff, git log, git show) are fine.
- If a step would need a forbidden command, stop and tell me what you need instead of running it.

## Safety & Configuration

Store money as integer paise. Keep writes transactional and idempotent. Never edit applied migrations; add the next numbered SQL file. Use `.env.example`, never commit secrets. Stdio stdout carries JSON-RPC only; log through Pino to stderr. Write execution requires a preview token and host-enforced human approval; treat database text as untrusted data.

## Prompt and Change History (All Agents)

Maintain [docs/change-history.md](docs/change-history.md) for every prompt-driven repository change, including code, tests, configuration, migrations and documentation. This applies to any coding agent working here, not only Codex.

- Before editing, read the latest history entries and allocate the next unused H-number. Start an entry for the task; finalize it before handing work back. If multiple agents work concurrently, coordinate identifiers and preserve each other's entries.
- Record the date, actual agent/tool name (or unknown), branch/base commit, status, and the user's exact relevant prompt plus material follow-ups, scope changes and approvals. For exported chats, include the source file and message/line references. Redact secrets as `[REDACTED]`; do not copy credentials, private data or raw tool dumps into the log.
- Describe what was actually changed and why, affected paths, migrations, config/API contract changes, compatibility impacts and deviations. Distinguish plans from implemented work and main-branch changes from work saved on another branch.
- Record only verification actually performed: commands, outcomes, test counts when known, failures, and skipped checks with reasons. Include real commit hashes if available, otherwise write uncommitted. Do not commit, run unrelated checks or claim tests passed merely to complete the log.
- Include the history update with the implementation changes. Append later outcomes or dated corrections rather than rewriting old prompts or erasing failed, superseded or reverted work. If work is blocked or cancelled after edits, record that state and what remains.
- Plan-only conversations need no implementation entry until edits begin; retain any resulting approval with the eventual task entry. This history is an audit trail; the project specification remains the source of truth for requirements.
