# Contributing to CloudAtlas

Thank you for your interest in contributing to CloudAtlas! This document provides everything you need to get started.

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Architecture Decisions](#architecture-decisions)

---

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/cloudatlas.git
   cd cloudatlas
   git remote add upstream https://github.com/GOODBOY008/cloudatlas.git
   ```
3. **Set up** your development environment (see [Development Setup](#development-setup))
4. **Create a branch** for your work:
   ```bash
   git checkout -b feat/my-feature    # for features
   git checkout -b fix/my-bug-fix     # for bug fixes
   ```

---

## Development Setup

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust | 1.78+ | [rustup.rs](https://rustup.rs/) |
| Node.js | 20+ | [nodejs.org](https://nodejs.org/) |
| Docker & Docker Compose | 24+ / 2.20+ | [docs.docker.com](https://docs.docker.com/get-docker/) |
| PostgreSQL | 15+ | Via Docker or [postgresql.org](https://www.postgresql.org/download/) |

### One-Time Setup

```bash
# Automated setup: creates .env, installs npm deps, installs cargo-watch + sqlx-cli
make setup

# Or manually:
cp .env.example .env
cd frontend && npm install && cd ..
cargo install cargo-watch
cargo install sqlx-cli --features postgres
```

### Start the Dev Stack

```bash
# Full stack: PostgreSQL + backend (cargo-watch) + frontend (Vite HMR)
make dev

# Or start services individually:
make dev-db           # PostgreSQL only (port 5432)
make dev-backend      # Backend with hot reload (port 8080)
make dev-frontend     # Vite dev server only (port 5173)
```

Once running:

| Service | URL |
|---------|-----|
| Frontend (Vite HMR) | `http://localhost:5173` |
| Backend API | `http://localhost:8080/api/v1` |
| Swagger UI | `http://localhost:8080/swagger-ui/` |
| PostgreSQL | `localhost:5432` |

### Seed Credentials

```
Email:    admin@acme.com
Password: Password123!
```

---

## Development Workflow

### Branch Naming

Use conventional prefixes:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New feature | `feat/cost-forecast-chart` |
| `fix/` | Bug fix | `fix/pool-budget-calculation` |
| `refactor/` | Code restructuring | `refactor/auth-middleware` |
| `docs/` | Documentation | `docs/api-examples` |
| `test/` | Tests | `test/cmdb-impact-analysis` |
| `chore/` | Tooling, deps | `chore/upgrade-axum` |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(expense): add cost anomaly detection endpoint

- Implement 7-day rolling baseline comparison
- Add threshold_factor parameter to organization_constraints
- Include structured evidence in alert_events

Closes #42
```

**Types**: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `style`

**Scopes**: `auth`, `cloud`, `cmdb`, `expense`, `recommendation`, `alert`, `webhook`, `tagging`, `rules`, `constraints`, `power_schedule`, `scheduler`, `frontend`, `infra`

### Before You Submit

```bash
make fmt              # Format all code
make lint             # Clippy (Rust) + ESLint (TypeScript)
make test             # Run all tests
make api-test         # Smoke test against running server
```

---

## Coding Standards

### Rust Backend

```rust
// Module structure
// Every module: mod.rs + handlers.rs + models.rs + dto.rs (+ service.rs if complex)

// Error handling — always use AppError, never unwrap() in production paths
pub async fn list_foos(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<FooQuery>,
) -> AppResult<Json<Value>> { ... }

// Database queries — use sqlx bind params, NEVER format!() with user data
let rows = sqlx::query_as::<_, Foo>(
    "SELECT id, name FROM foos WHERE org_id = $1 AND deleted_at = 0"
)
.bind(org_id)
.fetch_all(&state.db).await?;

// OpenAPI — annotate all public handlers
#[utoipa::path(
    get, path = "/orgs/{org_id}/foos",
    params(("org_id" = Uuid, Path), ...),
    responses((status = 200, body = Vec<Foo>))
)]

// Soft deletes — deleted_at = 0 (active), UNIX timestamp (deleted)
// Timestamps — BIGINT UNIX epoch (seconds)
// UUIDs — gen_random_uuid() in DB, uuid::Uuid in Rust
// Logging — tracing::info!/warn!/error! with structured fields
```

### SQL Migrations

```sql
-- File naming: NNN_description.sql (sequential, zero-padded to 3 digits)
-- Every table MUST include:
--   created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
--   updated_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
--   deleted_at  BIGINT NOT NULL DEFAULT 0
-- Primary keys: UUID DEFAULT gen_random_uuid()
-- Indexes: prefix idx_{table}_{column}, use partial indexes WHERE deleted_at = 0
-- Unique: UNIQUE(org_id, name, deleted_at) pattern for soft-delete-safe uniqueness
```

### TypeScript Frontend

```typescript
// API calls go through src/lib/api.ts (axios instance with auth interceptor)
// Types in src/types/index.ts
// Zustand for client state, React Query for server state
// Pages in src/pages/, reusable components in src/components/

// Component pattern:
// Cards/panels:    bg-gray-900 border border-gray-800 rounded-xl
// Text:            text-white (values), text-gray-400 (labels)
// Inputs:          bg-gray-800 border border-gray-700 rounded-lg
// Buttons:         bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg
// Error messages:  bg-red-900/40 border border-red-700 text-red-400

// Light mode is handled automatically via CSS overrides in index.html
// No need to add dark: variants — use dark-first classes
```

---

## Testing

### Backend Tests

```bash
# All tests
cd backend && cargo test

# Specific test suite
cargo test --test cmdb_tests
cargo test --test auth_tests
cargo test --test expense_tests
cargo test --test billing_tests
cargo test --test rec_tests

# With output
cargo test -- --nocapture
```

### Frontend Tests

```bash
cd frontend
npm run build        # Type-check + bundle (must pass with 0 errors)
```

### E2E Tests (Playwright)

```bash
cd e2e
npm install
npx playwright test
```

### API Smoke Tests

```bash
# Requires a running server on localhost:8080
make api-test
# Or directly:
./scripts/smoke_test.sh
```

---

## Pull Request Process

### 1. Create Your PR

- Target the `main` branch
- Fill out the [PR template](.github/pull_request_template.md)
- Link related issues with `Closes #N` or `Fixes #N`
- Include screenshots for UI changes

### 2. PR Checklist

Before requesting review, ensure:

- [ ] Code follows the project's coding standards
- [ ] `make fmt` has been run (no formatting diffs)
- [ ] `make lint` passes (no new warnings)
- [ ] `make test` passes (all tests green)
- [ ] New/changed APIs have `#[utoipa::path]` annotations
- [ ] DB changes have a numbered migration file
- [ ] Frontend builds cleanly (`npm run build` — 0 TS errors)
- [ ] No `unwrap()`, `expect()`, or `panic!()` in production paths
- [ ] Commit messages follow Conventional Commits

### 3. Review

- At least **1 approval** is required to merge
- Address all review comments before re-requesting review
- Keep the PR focused — avoid unrelated changes

### 4. Merge

- PRs are **squash-merged** to keep a clean commit history
- The merge commit message is derived from the PR title

---

## Reporting Issues

### Bug Reports

Use the [Bug Report template](https://github.com/GOODBOY008/cloudatlas/issues/new?template=bug_report.md) and include:

- Steps to reproduce
- Expected vs. actual behavior
- Environment details (OS, Rust version, browser)
- Relevant logs or screenshots

### Feature Requests

Use the [Feature Request template](https://github.com/GOODBOY008/cloudatlas/issues/new?template=feature_request.md) and describe:

- The problem you're trying to solve
- Your proposed solution
- Alternatives you've considered

---

## Architecture Decisions

Major architectural decisions are recorded as [ADRs](docs/adr/) and require discussion before implementation. Current decisions:

| ADR | Decision |
|-----|----------|
| [ADR-001](docs/adr/ADR-001-modular-monolith.md) | Modular monolith over microservices |
| [ADR-002](docs/adr/ADR-002-postgresql-only.md) | PostgreSQL as the only data store (no Redis/Kafka/ES) |
| [ADR-003](docs/adr/ADR-003-rust-axum.md) | Rust + Axum for the HTTP API layer |

If your contribution touches architecture, please open a discussion or ADR draft first.

---

## Questions?

- Open a [Discussion](https://github.com/GOODBOY008/cloudatlas/discussions) on GitHub
- Check existing [issues](https://github.com/GOODBOY008/cloudatlas/issues) and [PRs](https://github.com/GOODBOY008/cloudatlas/pulls)

Thank you for contributing! 🎉
