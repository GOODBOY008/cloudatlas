# CloudAtlas — Copilot Agent Instructions

> Unified FinOps + CMDB platform. Rust (Axum) backend · React/TypeScript frontend · PostgreSQL-only · Modular monolith · Docker runtime.

---

## 1. Project Identity

**CloudAtlas** combines cloud cost optimization (FinOps) with IT asset management (CMDB) in a single modular Rust monolith backed exclusively by PostgreSQL.

**Key constraints — never violate:**
- PostgreSQL only. No Redis, Kafka, RabbitMQ, Elasticsearch, or any additional infra.
- Modular monolith (NOT microservices). One binary, one database.
- Rust backend (Axum 0.7, sqlx 0.7, tokio async).
- Docker + Docker Compose as the only runtime/deployment mechanism.

## 2. Repository Layout

```
cloudatlas/
├── backend/
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs               # Entry: config, DB pool, scheduler, axum serve
│   │   ├── config.rs             # Env-var driven Config struct
│   │   ├── db.rs                 # PgPool creation + run_migrations()
│   │   ├── error.rs              # AppError → HTTP (impl IntoResponse)
│   │   ├── state.rs              # AppState { db: PgPool, config: Config }
│   │   ├── routes.rs             # Router + OpenAPI aggregation
│   │   ├── middleware/
│   │   │   ├── auth.rs           # JWT → Extension<Claims>
│   │   │   └── rbac.rs           # Permission checks
│   │   └── modules/
│   │       ├── auth/             # register, login, refresh, orgs, members
│   │       ├── cloud/            # cloud accounts, adapters, billing import
│   │       ├── cmdb/             # CI types, CIs, associations, audit, topology
│   │       ├── expense/          # expenses, summary, trend, pools
│   │       ├── recommendation/   # engine + 15 rec modules
│   │       ├── scheduler/        # cron jobs (no external queue)
│   │       ├── audit/            # polymorphic audit log service
│   │       ├── rules/            # resource-to-pool assignment rules
│   │       ├── alert/            # budget/pool alerts
│   │       ├── tagging/          # tag policy + cost rollup
│   │       └── health/           # /health, /health/ready
│   └── migrations/               # NNN_description.sql files (sqlx migrate)
├── frontend/
│   ├── src/
│   │   ├── App.tsx               # Routes (react-router-dom v6)
│   │   ├── components/           # Reusable UI components
│   │   ├── pages/                # Dashboard, Expenses, CMDB, etc.
│   │   ├── stores/               # Zustand (auth, ui)
│   │   ├── lib/api.ts            # Axios base client
│   │   └── types/index.ts        # TypeScript interfaces
├── docker/
│   ├── backend.Dockerfile        # Multi-stage: chef → builder → debian-slim
│   ├── frontend.Dockerfile       # Multi-stage: node → nginx-alpine
│   ├── migrate.Dockerfile        # sqlx-cli runner
│   └── nginx.conf                # SPA + API proxy config
├── docker-compose.yml            # Production-like stack
├── docker-compose.dev.yml        # Dev: PostgreSQL + pgadmin only
├── Makefile                      # All dev/build/test commands
├── .env.example                  # All env vars documented
├── AGENTS.md                     # Extended agent instructions + task list
└── TASKS.md                      # 56 detailed tasks across 7 phases
```

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Backend | Rust 1.78+, Axum 0.7, sqlx 0.7 (PostgreSQL async), tokio |
| Frontend | React 18, TypeScript 5, Vite 5, TailwindCSS, Recharts, React Query |
| Database | PostgreSQL 15+ (ONLY — all data, including time-series via partitioning) |
| Auth | JWT (jsonwebtoken crate), Argon2id password hashing |
| OpenAPI | utoipa 4 + utoipa-swagger-ui (available at `/swagger-ui`) |
| Observability | tracing + tracing-subscriber (JSON structured logs) |
| Runtime | Docker + Docker Compose (`docker compose up` to start everything) |

## 4. Architecture Principles

- **Soft deletes**: all tables use `deleted_at BIGINT NOT NULL DEFAULT 0`. Never `DELETE` in production paths.
- **Timestamps**: BIGINT UNIX epoch (seconds) for `created_at`, `updated_at`, `deleted_at`.
- **UUIDs**: `UUID PRIMARY KEY DEFAULT gen_random_uuid()` in DB; `uuid::Uuid` in Rust.
- **Multi-tenancy**: every domain entity has `organization_id UUID NOT NULL`. Always filter by org in queries.
- **Async first**: all DB ops and HTTP handlers are async (`tokio`). No blocking calls.
- **Error handling**: `AppError` enum in `error.rs` implements `IntoResponse`. Use `?` everywhere; no `unwrap()` in production paths.
- **JSONB**: use JSONB columns for semi-structured data (resource meta, billing raw, attributes). No separate document DB.
- **In-process events**: use `tokio::sync::broadcast` for cross-module events (no external message bus).

## 5. Multi-Cloud Strategy

Two primary cloud providers + one mock:

| Provider | Adapter | Auth |
|---|---|---|
| AWS | `modules/cloud/adapters/aws.rs` | Access Key + Secret (HMAC-SHA256) |
| Alibaba Cloud | `modules/cloud/adapters/aliyun.rs` | Access Key + Secret (HMAC-SHA1) |
| Mock | `modules/cloud/adapters/mock.rs` | None (dev/test) |

Cloud credentials stored encrypted in `cloud_accounts.credentials_enc` (AES-256-GCM using `ENCRYPTION_KEY` env var). Never log credentials.

## 6. FinOps Domain Model

Core entities: `organizations` → `pools` (hierarchy) → `resources` → `expenses` (daily aggregated) → `recommendations`.

Key patterns:
- **Pool hierarchy**: parent_id self-reference, budget_limit per pool, recursive cost rollup.
- **Cost allocation**: resources assigned to pools via `rules` engine (tag/name/region/cloud conditions).
- **Billing pipeline**: raw cloud billing → `raw_expenses` → aggregated `expenses` → resource `total_cost`.
- **Recommendations**: 15+ types (idle, rightsizing, storage, security, commitment) run by `RecEngine` via pluggable `RecModule` trait.

## 7. CMDB Domain Model

Core entities: `ci_classifications` → `ci_types` → `ci_attributes` → `ci` (instances) → `ci_instance_associations`.

Key patterns:
- **Three-tier associations**: `ci_association_kind` (schema) → `ci_object_association` (type-level) → `ci_instance_association` (instance-level).
- **Dynamic attributes**: `ci_attributes` defines fields per CI type; CI `meta JSONB` stores values.
- **Lifecycle states**: `provisioning → active → maintenance → decommissioned → retired`.
- **Cloud sync**: cloud discovery populates CMDB; `operate_from = 'discovery'` in audit log.
- **Audit trail**: every mutation writes to `ci_audit_log` with `pre_data`/`cur_data` JSONB.

## 8. RBAC Model

| Role | Permissions |
|---|---|
| `owner` | All permissions |
| `finops` | ViewExpenses, ManagePools, ManageCloudAccounts |
| `cmdb_editor` | ManageCmdb |
| `member` | ViewExpenses (read-only) |

Permission check: `require_permission(db, user_id, org_id, Permission::X).await?` at handler entry.

## 9. Task Execution Protocol

When asked to implement tasks:
1. Read `../docs/TASKS.md` for the full task list (56 tasks, Phases A–G).
2. Read `AGENTS.md` for detailed implementation specs per task.
3. Complete one task at a time. Update progress in AGENTS.md (change 📋 to ✅).
4. After each task: compile check (`cargo check`), run migrations, verify no regressions.
5. Never skip acceptance criteria. If a task has "Acceptance: `cargo sqlx migrate run` succeeds", run it.
6. Continue automatically — do not stop and ask between tasks unless blocked.

## 10. Reference Specifications

- Full unified spec: `../docs/superpowers/specs/2026-05-19-finops-unified-spec.md`
- AI features design: `../docs/superpowers/specs/2026-05-19-ai-features-design.md`

## 11. What Is Already Implemented

**Backend (complete):** auth module, cloud accounts CRUD + adapters (Mock/AWS stub/Aliyun stub), expense CRUD + summaries, pool CRUD, basic CMDB (CI type + CI stubs), migrations 001–007 + seed, OpenAPI/Swagger, health endpoints, Docker Compose + Makefile.

**Frontend (skeleton):** routing, layout/sidebar, login page, page skeletons for Dashboard/Expenses/CloudAccounts/Pools/Recommendations/CMDB.

**Next priority:** Phase A (DB schema), then Phase B (backend services), then Phase C (CMDB full), Phase D (frontend), Phase E (DevOps), Phase F (tests), Phase G (validation).
