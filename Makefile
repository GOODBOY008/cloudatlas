# ==============================================================================
# CloudAtlas Makefile
# ==============================================================================

.PHONY: help dev build test lint clean migrate seed docker-up docker-down \
        docker-build api-test fmt check \
        e2e-install e2e e2e-smoke e2e-regression e2e-ui e2e-report e2e-docker \
        agent-install agent-e2e agent-smoke agent-auth agent-finops agent-cmdb \
        agent-headed agent-list agent-report

COMPOSE_FILE := docker-compose.yml
COMPOSE_DEV  := docker-compose.dev.yml
BACKEND_DIR  := backend
FRONTEND_DIR := frontend
DB_URL       ?= postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas

# Default target
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────────────────────────────────────
# Development
# ──────────────────────────────────────────────────────────────────────────────
dev: ## Start full dev environment (DB + hot-reload backend + Vite frontend)
	docker compose -f $(COMPOSE_DEV) up

dev-db: ## Start only PostgreSQL
	docker compose -f $(COMPOSE_DEV) up -d postgres

dev-backend: ## Run backend with hot reload (requires cargo-watch)
	cd $(BACKEND_DIR) && cargo watch -x run

dev-frontend: ## Run Vite dev server
	cd $(FRONTEND_DIR) && npm run dev

# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────
build: build-backend build-frontend ## Build everything

build-backend: ## Compile Rust backend (release)
	cd $(BACKEND_DIR) && cargo build --release

build-frontend: ## Build React frontend
	cd $(FRONTEND_DIR) && npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────────
test: test-backend test-frontend ## Run all tests

test-backend: ## Run Rust unit + integration tests
	cd $(BACKEND_DIR) && cargo test

test-frontend: ## Run frontend tests
	cd $(FRONTEND_DIR) && npm test

api-test: ## Run API smoke tests against running server
	@echo "Running API smoke tests..."
	@./scripts/smoke_test.sh

# ──────────────────────────────────────────────────────────────────────────────
# E2E (Playwright) — see e2e/README.md
# ──────────────────────────────────────────────────────────────────────────────

e2e-install: ## Install Playwright deps + browsers for e2e/
	cd e2e && npm ci && npx playwright install chromium firefox

e2e: ## Run full Playwright e2e suite (requires stack: make dev-db + backend + frontend)
	cd e2e && npx playwright test

e2e-smoke: ## Run @smoke e2e tests only (~2 min)
	cd e2e && npx playwright test --grep @smoke

e2e-regression: ## Run @regression e2e tests only
	cd e2e && npx playwright test --grep @regression

e2e-ui: ## Open interactive Playwright UI
	cd e2e && npx playwright test --ui

e2e-report: ## Open last HTML report
	cd e2e && npx playwright show-report

e2e-docker: ## Run e2e suite in Docker against a clean ephemeral stack (CI equivalent)
	docker compose -f docker-compose.e2e.yml up --build --abort-on-container-exit e2e
	docker compose -f docker-compose.e2e.yml down

# ──────────────────────────────────────────────────────────────────────────────
# AI Agent E2E — see e2e-agent/README.md (requires ANTHROPIC_API_KEY in e2e-agent/.env)
# ──────────────────────────────────────────────────────────────────────────────

agent-install: ## Install AI agent e2e deps + chromium
	cd e2e-agent && npm install && npx playwright install chromium

agent-e2e: ## Run full AI agent e2e suite
	cd e2e-agent && npm run agent

agent-smoke: ## Run AI agent smoke scenarios only (~5 min)
	cd e2e-agent && npm run agent:smoke

agent-auth: ## Run AI agent auth suite
	cd e2e-agent && npm run agent:auth

agent-finops: ## Run AI agent finops suite
	cd e2e-agent && npm run agent:finops

agent-cmdb: ## Run AI agent cmdb suite
	cd e2e-agent && npm run agent:cmdb

agent-headed: ## Run AI agent e2e with visible browser
	cd e2e-agent && npm run agent -- --headed

agent-list: ## List all AI agent scenarios
	cd e2e-agent && npm run agent -- --list

agent-report: ## Open latest AI agent HTML report
	cd e2e-agent && npm run agent:report

# ──────────────────────────────────────────────────────────────────────────────
# Code Quality
# ──────────────────────────────────────────────────────────────────────────────
fmt: ## Format all code
	cd $(BACKEND_DIR) && cargo fmt
	cd $(FRONTEND_DIR) && npm run format

lint: ## Lint all code
	cd $(BACKEND_DIR) && cargo clippy -- -D warnings
	cd $(FRONTEND_DIR) && npm run lint

check: fmt lint ## Format + lint (CI step)

# ──────────────────────────────────────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────────────────────────────────────
migrate: ## Run database migrations
	cd $(BACKEND_DIR) && DATABASE_URL=$(DB_URL) cargo sqlx migrate run

migrate-revert: ## Revert last migration
	cd $(BACKEND_DIR) && DATABASE_URL=$(DB_URL) cargo sqlx migrate revert

migrate-status: ## Show migration status
	cd $(BACKEND_DIR) && DATABASE_URL=$(DB_URL) cargo sqlx migrate info

seed: ## Seed data lives in backend/migrations/001_init.sql (no separate seed file)
	@echo "Seed data is embedded in backend/migrations/001_init.sql — run 'make reset-db' to apply it."

reset-db: ## Drop and recreate database (dev only)
	psql $(DB_URL) -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
	$(MAKE) migrate
	$(MAKE) seed

# ──────────────────────────────────────────────────────────────────────────────
# Docker
# ──────────────────────────────────────────────────────────────────────────────
docker-up: ## Start production-like Docker stack
	docker compose -f $(COMPOSE_FILE) up -d

docker-down: ## Stop Docker stack
	docker compose -f $(COMPOSE_FILE) down

docker-build: ## Build all Docker images
	docker compose -f $(COMPOSE_FILE) build

docker-update: ## Rebuild images + restart containers (alias for update_images.sh)
	@./scripts/update_images.sh --restart

docker-update-push: ## Rebuild, tag, push to registry, restart (set REGISTRY= and TAG=)
	@./scripts/update_images.sh --restart --push \
		$(if $(REGISTRY),--registry $(REGISTRY)) \
		$(if $(TAG),--tag $(TAG))

docker-logs: ## Tail logs from all containers
	docker compose -f $(COMPOSE_FILE) logs -f

docker-clean: ## Remove containers, volumes, images
	docker compose -f $(COMPOSE_FILE) down -v --rmi local

# ──────────────────────────────────────────────────────────────────────────────
# Setup
# ──────────────────────────────────────────────────────────────────────────────
setup: ## First-time setup: copy .env, install deps
	@if [ ! -f .env ]; then cp .env.example .env; echo "Created .env from example"; fi
	@cd $(FRONTEND_DIR) && npm install
	@which cargo-watch > /dev/null 2>&1 || cargo install cargo-watch
	@which sqlx > /dev/null 2>&1 || cargo install sqlx-cli --features postgres
	@echo "Setup complete! Run 'make dev' to start."

# ──────────────────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────────────────
clean: ## Clean build artifacts
	cd $(BACKEND_DIR) && cargo clean
	cd $(FRONTEND_DIR) && rm -rf dist node_modules/.vite

env-check: ## Validate required environment variables
	@./scripts/check_env.sh

gen-secret: ## Generate a secure random JWT secret
	@openssl rand -hex 64

logs: docker-logs
