# FoodOps MCP: thin wrappers over the pnpm scripts. Run `make` or `make help`.
# Requires Node 22 and pnpm 10 (see package.json "engines").

PNPM ?= pnpm
PKG  ?= core
# Process tests spawn pnpm and time out under load, so tests run one package at a time.
TEST_FLAGS ?= -r --workspace-concurrency=1 --no-bail

.DEFAULT_GOAL := help

.PHONY: help install migrate seed seed-reset \
	dev dev-api dev-web dev-mcp start-http start-api \
	build build-web typecheck lint lint-fix format check \
	test test-shared test-core test-mcp test-api test-web test-pkg \
	smoke-api smoke-chat llm-live ports clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---- Setup ------------------------------------------------------------------
install: ## Install pinned dependencies
	$(PNPM) install --frozen-lockfile

migrate: ## Apply database migrations
	$(PNPM) migrate

seed: ## Populate deterministic demo data
	$(PNPM) seed

seed-reset: ## Replace the demo database (stop servers first)
	$(PNPM) seed --reset

# ---- Servers ----------------------------------------------------------------
dev-api: ## Run the REST/SSE API with watch (tsx)
	$(PNPM) dev:api

dev-web: ## Run the web app on 127.0.0.1:5173 (Vite)
	$(PNPM) dev:web

dev-mcp: ## Run the MCP server over stdio (JSON-RPC on stdout only)
	$(PNPM) --silent dev:mcp

dev: ## Run API and web together (Ctrl+C stops both)
	@trap 'kill 0' INT TERM EXIT; \
	$(PNPM) dev:api & $(PNPM) dev:web & wait

start-http: build ## Build, then run the compiled MCP HTTP server
	$(PNPM) start:http

start-api: build ## Build, then run the compiled API
	$(PNPM) start:api

ports: ## Show what is listening on the dev ports (3001, 3002, 5173)
	@ss -ltnp 2>/dev/null | grep -E ':(3001|3002|5173)\b' || echo "nothing listening on 3001, 3002 or 5173"

# ---- Quality gates ----------------------------------------------------------
build: ## Compile backend packages, then typecheck and bundle web
	$(PNPM) build

build-web: ## Build shared and web only
	$(PNPM) build:web

typecheck: ## Typecheck every package
	$(PNPM) typecheck

lint: ## ESLint with zero warnings allowed
	$(PNPM) lint

lint-fix: ## ESLint with --fix
	$(PNPM) exec eslint . --max-warnings 0 --fix

format: ## Prettier-write (pass FILES="path ..." to limit the scope)
	$(PNPM) exec prettier --write $(if $(FILES),$(FILES),.)

check: typecheck build lint test ## Full acceptance run: typecheck, build, lint, test

# ---- Tests ------------------------------------------------------------------
test: ## All package tests, one package at a time (build first for process tests)
	$(PNPM) $(TEST_FLAGS) test

test-shared: ## Tests for @foodops/shared
	$(PNPM) --filter @foodops/shared test

test-core: ## Tests for @foodops/core
	$(PNPM) --filter @foodops/core test

test-mcp: ## Tests for the MCP server (needs `make build`)
	$(PNPM) --filter @foodops/mcp-server test

test-api: ## Tests for the API (needs `make build`)
	$(PNPM) --filter @foodops/api test

test-web: ## Tests for the web app
	$(PNPM) --filter @foodops/web test

test-pkg: ## Tests for one package: make test-pkg PKG=core ARGS="-t name"
	$(PNPM) --filter @foodops/$(PKG) test $(if $(ARGS),-- $(ARGS),)

# ---- Smoke scripts ----------------------------------------------------------
smoke-api: ## Smoke-test the running API
	$(PNPM) smoke:api

smoke-chat: ## Smoke-test chat streaming against the scripted provider
	$(PNPM) smoke:chat

llm-live: ## Probe the configured live LLM provider (makes real LLM calls)
	$(PNPM) llm:live

# ---- Cleanup ----------------------------------------------------------------
clean: ## Remove compiled output (dist/ and tsbuildinfo); keeps data/ and node_modules
	find packages apps -maxdepth 2 \( -name dist -o -name '*.tsbuildinfo' \) -not -path '*/node_modules/*' -prune -exec rm -rf {} +
