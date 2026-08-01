# CloudAtlas — Technical Design Document

> Unified FinOps + CMDB Platform  
> Version 1.0 · May 2026

---

## 1. Design Foundations

### 1.1 Metadata-Driven CMDB
- **Core ideas adopted**: Metadata-driven object model, three-tier association system, topology trees, polymorphic audit trail, lifecycle state machine, dynamic groups
- **Key innovation**: Runtime-definable CI types without schema changes; three-tier `AssociationKind → ObjectAssociation → InstanceAssociation`

### 1.2 FinOps Cost Pipeline
- **Core ideas adopted**: Rich recommendation types, two-tier billing pipeline (raw + clean), multi-cloud adapters (AWS + Alibaba), hierarchical pool cost allocation, budget alerts
- **Key innovation**: Sign-based expense correction; recommendation state machine with parallel execution

### 1.3 Spec Documents Summary
The four spec files define a unified platform that adopts:
- A three-tier CMDB model applied to cloud resources
- A FinOps cost pipeline and recommendation engine
- AI layer (chat assistant, smart explanations, forecasting)
- Single PostgreSQL with JSONB (no additional datastores)
- Modular monolith with Java/Spring Boot (we use **Rust/Axum**)

---

## 2. Capability Overview

| Capability | CloudAtlas |
|---|---|
| CI type registry | ✅ Runtime-definable |
| Three-tier associations | ✅ |
| Cost pipeline | ✅ Two-tier (raw + clean) |
| Multi-cloud adapters | ✅ (AWS, Alibaba) |
| Recommendations | ✅ core 10 |
| RBAC + multi-tenancy | ✅ Unified |
| Single DB (PG only) | ✅ |
| Rust backend | ✅ |
| Docker-first | ✅ |
| Scheduling (no queue) | ✅ PG-based |

---

## 3. Target Architecture

### 3.1 Overview — Modular Monolith

```
┌─────────────────────────────────────────────────────────┐
│                    CloudAtlas Backend                    │
│                  Rust + Axum + SQLx                      │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │   Auth   │ │  Tenant  │ │  Cloud   │ │ Expense  │  │
│  │  Module  │ │  Module  │ │  Module  │ │  Module  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │   CMDB   │ │  Recom-  │ │  Alert   │ │Scheduler │  │
│  │  Module  │ │  mendation│ │  Module  │ │  Module  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│              Shared: DB Pool │ JWT │ Tracing            │
└─────────────────────────────────────────────────────────┘
              │
              ▼
    ┌──────────────────┐
    │   PostgreSQL 15  │
    │  JSONB + Indexes │
    │  Partitioned     │
    └──────────────────┘
```

### 3.2 Principles
- **Modular monolith**: All modules in one process, clear domain boundaries
- **Async throughout**: tokio + Axum + SQLx async queries
- **Single database**: PostgreSQL only, JSONB for flexible data
- **No external dependencies**: No Redis, Kafka, RabbitMQ, Elasticsearch
- **Background work**: tokio spawned tasks + PostgreSQL advisory locks + job tables
- **Event delivery**: PostgreSQL LISTEN/NOTIFY + webhook HTTP calls

---

## 4. Docker / Runtime Architecture

```
docker-compose.yml (production-like):
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   postgres:15   │  │  cloudatlas-api  │  │cloudatlas-front │
│   Port: 5432    │  │   Port: 8080     │  │   Port: 3000    │
│   Volume: pgdata│  │   Multi-stage    │  │   Nginx serve   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
      ▲                      │
      └──────────────────────┘
           db dependency

docker-compose.dev.yml (extends base):
- Backend: hot-reload via cargo-watch
- Frontend: Vite dev server (HMR)
- Postgres: exposed on localhost:5432
- DB migrations run as init container

Migration strategy:
  cloudatlas-migrate (init container) → runs sqlx migrate → exits 0
  → cloudatlas-api starts
```

### 4.1 Multi-stage Dockerfile (backend)
```
Stage 1 (chef): cargo-chef plan
Stage 2 (cacher): cargo-chef cook --release (cache deps)
Stage 3 (builder): cargo build --release
Stage 4 (runtime): distroless/debian with binary only
```

---

## 5. Domain Model and Database Schema

### 5.1 DDD Bounded Contexts

```
┌──────────────────────┐    ┌──────────────────────┐
│   Identity Context   │    │   Tenant Context      │
│  User, Role, Session │    │  Organization, Member │
│  JWT, Permissions    │◄───│  Pool, CostCenter     │
└──────────────────────┘    └──────────────────────┘
           │                           │
           ▼                           ▼
┌──────────────────────┐    ┌──────────────────────┐
│   Cloud Context      │    │    CMDB Context       │
│  CloudAccount        │    │  CiType, CiInstance   │
│  CloudResource       │───►│  Association, Audit   │
│  SyncJob             │    │  DynamicGroup         │
└──────────────────────┘    └──────────────────────┘
           │
           ▼
┌──────────────────────┐    ┌──────────────────────┐
│   Expense Context    │    │  FinOps Context       │
│  RawExpense          │───►│  Recommendation       │
│  Expense (daily)     │    │  Budget, Alert        │
│  CostSummary         │    │  AssignmentRule       │
└──────────────────────┘    └──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  Scheduler Context   │
│  ScheduledJob        │
│  JobRun, WorkerLock  │
└──────────────────────┘
```

### 5.2 Core Table Summary

**Identity & Tenancy (10 tables)**
- `organizations` — top-level tenant
- `users` — accounts with bcrypt password
- `organization_members` — user↔org membership
- `roles` — org-scoped RBAC roles
- `role_permissions` — fine-grained permissions
- `user_roles` — user↔role assignments
- `sessions` — JWT refresh tokens
- `audit_logs` — cross-module operation log
- `api_keys` — service-to-service auth
- `invitations` — email invites

**Cloud (3 tables)**
- `cloud_accounts` — provider credentials (encrypted)
- `cloud_regions` — available regions per account
- `sync_jobs` — resource discovery run history

**CMDB (10 tables)**
- `ci_classifications` — logical groupings
- `ci_types` — object type definitions
- `ci_attributes` — dynamic attribute schema
- `cis` — CI instances (JSONB meta)
- `ci_association_kinds` — relationship vocabulary
- `ci_object_associations` — schema-level rules
- `ci_instance_associations` — actual relationships
- `ci_dynamic_groups` — saved filter definitions
- `ci_lifecycle_transitions` — state change log
- `ci_audit_logs` — field-level change tracking

**Expense (4 tables)**
- `raw_expenses` — cloud-native line items (JSONB)
- `expenses` — daily aggregated per resource (partitioned)
- `pool_assignments` — resource→pool mapping
- `pools` — hierarchical cost center tree

**FinOps (5 tables)**
- `recommendations` — optimization findings
- `recommendation_runs` — engine execution history
- `budgets` — budget definitions per pool
- `budget_alerts` — threshold alert configs
- `assignment_rules` — auto pool/owner assignment

**Scheduler (3 tables)**
- `scheduled_jobs` — job definitions (cron expression)
- `job_runs` — execution history
- `worker_locks` — distributed lock tracking

---

## 6. API Specifications

Base URL: `https://api.cloudatlas.local/api/v1`

### 6.1 Auth
```
POST /auth/register        Create account
POST /auth/login           Obtain JWT pair
POST /auth/refresh         Refresh access token
GET  /auth/me              Current user profile
POST /auth/logout          Invalidate refresh token
```

### 6.2 Organizations
```
POST   /organizations                Create org
GET    /organizations/:id            Get org details
PUT    /organizations/:id            Update org
GET    /organizations/:id/members    List members
POST   /organizations/:id/members    Invite member
DELETE /organizations/:id/members/:uid Remove member
```

### 6.3 Cloud Accounts
```
GET    /orgs/:org/cloud-accounts          List accounts
POST   /orgs/:org/cloud-accounts          Create account
GET    /orgs/:org/cloud-accounts/:id      Get account
PUT    /orgs/:org/cloud-accounts/:id      Update account
DELETE /orgs/:org/cloud-accounts/:id      Delete account
POST   /orgs/:org/cloud-accounts/:id/test Test connection
POST   /orgs/:org/cloud-accounts/:id/sync Trigger sync
GET    /orgs/:org/cloud-accounts/:id/resources List discovered resources
```

### 6.4 Expenses
```
GET /orgs/:org/expenses                  Query expenses (filters: date, resource, cloud, region)
GET /orgs/:org/expenses/summary          Total cost summary
GET /orgs/:org/expenses/by-cloud         Breakdown by cloud provider
GET /orgs/:org/expenses/by-pool          Breakdown by cost pool
GET /orgs/:org/expenses/by-service       Breakdown by cloud service
GET /orgs/:org/expenses/trend            Daily trend data
GET /orgs/:org/expenses/top-resources    Top N resources by cost
```

### 6.5 Pools
```
GET    /orgs/:org/pools              Pool hierarchy tree
POST   /orgs/:org/pools              Create pool
PUT    /orgs/:org/pools/:id          Update pool
DELETE /orgs/:org/pools/:id          Delete pool
GET    /orgs/:org/pools/:id/expenses Pool cost summary
```

### 6.6 CMDB — CI Types
```
GET    /orgs/:org/ci-types              List types
POST   /orgs/:org/ci-types              Create type
GET    /orgs/:org/ci-types/:id          Get type
PUT    /orgs/:org/ci-types/:id          Update type
DELETE /orgs/:org/ci-types/:id          Delete type
GET    /orgs/:org/ci-types/:id/attributes  List attributes
POST   /orgs/:org/ci-types/:id/attributes  Add attribute
```

### 6.7 CMDB — CI Instances
```
GET    /orgs/:org/cis                      List CIs (filter by type, state, tags)
POST   /orgs/:org/cis                      Create CI
GET    /orgs/:org/cis/:id                  Get CI
PUT    /orgs/:org/cis/:id                  Update CI
DELETE /orgs/:org/cis/:id                  Delete CI
GET    /orgs/:org/cis/:id/associations     Get CI relationships
POST   /orgs/:org/cis/:id/associations     Create association
DELETE /orgs/:org/cis/:id/associations/:aid Delete association
GET    /orgs/:org/cis/:id/history          Audit log for CI
GET    /orgs/:org/cis/:id/impact           Dependency impact analysis
```

### 6.8 Recommendations
```
GET    /orgs/:org/recommendations             List recommendations
GET    /orgs/:org/recommendations/:id         Get recommendation details
POST   /orgs/:org/recommendations/:id/dismiss Dismiss recommendation
POST   /orgs/:org/recommendations/run         Trigger recommendation engine
GET    /orgs/:org/recommendations/summary     Count + savings by type
```

### 6.9 Budgets & Alerts
```
GET    /orgs/:org/budgets              List budgets
POST   /orgs/:org/budgets              Create budget
PUT    /orgs/:org/budgets/:id          Update budget
DELETE /orgs/:org/budgets/:id          Delete budget
GET    /orgs/:org/alerts               List active alerts
POST   /orgs/:org/alerts/:id/ack       Acknowledge alert
```

### 6.10 Scheduler
```
GET    /orgs/:org/jobs        List scheduled jobs
POST   /orgs/:org/jobs        Create job
PUT    /orgs/:org/jobs/:id    Update job (enable/disable)
GET    /orgs/:org/jobs/:id/runs  Execution history
```

---

## 7. Multi-Cloud Support Strategy

### 7.1 Adapter Interface (Rust trait)
```rust
#[async_trait]
pub trait CloudAdapter: Send + Sync {
    async fn test_connection(&self) -> Result<()>;
    async fn discover_resources(&self, region: &str) -> Result<Vec<CloudResource>>;
    async fn fetch_billing(&self, month: NaiveDate) -> Result<Vec<RawExpenseRow>>;
    async fn list_regions(&self) -> Result<Vec<String>>;
}
```

### 7.2 AWS Adapter
- Auth: STS AssumeRole or IAM Access Key
- Resources: EC2, RDS, S3, ELB, Lambda via AWS SDK
- Billing: Cost Explorer API (daily granularity) + CUR S3 (monthly)
- Resource classification: BoxUsage → INSTANCE, EBS:VolumeUsage → VOLUME, etc.

### 7.3 Aliyun (Alibaba Cloud) Adapter
- Auth: RAM User Access Key
- Resources: ECS, RDS, OSS, SLB, Redis via Alibaba SDK
- Billing: BSS DescribeInstanceBill API (daily)
- Resource ID: InstanceID from billing line items

### 7.4 Mock Provider (Dev/Test)
- In-memory mock returning static fixture data
- Configurable delay to simulate API latency
- Enabled via `CLOUD_MOCK_ENABLED=true`

---

## 8. FinOps Cost Allocation & Tagging Model

### 8.1 Two-Tier Expense Pipeline
```
Step 1: raw_expenses  →  raw cloud billing CSVs/API responses (JSONB, preserved)
Step 2: expenses       →  aggregated per (resource_id, date) with resource_type enum
Step 3: pool_assignments → map resource → pool (via assignment rules or manual)
Step 4: roll-up queries → hierarchical pool cost aggregation
```

### 8.2 Tagging Strategy
- Cloud tags synced into `cis.meta->'tags'` JSONB field
- Custom CloudAtlas labels in `cis.meta->'labels'`
- Assignment rules match on tags (key=value conditions)
- Pool assignment priority: manual > rule > default pool

### 8.3 Cost Breakdown Dimensions
- By cloud provider (AWS, Alibaba)
- By region
- By service (ProductCode / service_name)
- By resource type (INSTANCE, VOLUME, RDS, etc.)
- By pool (hierarchical)
- By owner (user email)
- By tag/label

---

## 9. CMDB Resource Modeling

### 9.1 CI Type Hierarchy (Builtin)
```
cloud_compute
  ├── cloud_instance (EC2, ECS)
  ├── cloud_rds (RDS, PolarDB)
  └── cloud_k8s_pod

cloud_storage
  ├── cloud_volume (EBS, Cloud Disk)
  ├── cloud_snapshot
  └── cloud_bucket (S3, OSS)

cloud_network
  ├── cloud_lb (ALB, SLB)
  └── cloud_ip

cloud_commitment
  ├── reserved_instance
  └── savings_plan

on_prem_server (custom)
```

### 9.2 Three-Tier Association System
```
Tier 1: AssociationKind    — vocabulary: belong_to, run_on, contains, backed_by, connects_to
Tier 2: ObjectAssociation  — rules: (src_type, kind, dst_type, cardinality)
Tier 3: InstanceAssociation — data: (src_ci_id, kind_id, dst_ci_id, meta)
```

### 9.3 Lifecycle States
```
provisioning → active → maintenance → decommissioning → decommissioned → retired
                              ↓
                           failed
```

### 9.4 Cloud Resource → CI Auto-Sync
On each cloud sync job:
1. Fetch discovered resources from cloud adapter
2. Upsert CIs by `cloud_resource_id` (idempotent)
3. Infer associations (e.g., volume backed_by instance from attachment metadata)
4. Write lifecycle transition if state changed
5. Write ci_audit_log for every attribute change

---

## 10. RBAC / Tenant Model

### 10.1 Organization Hierarchy
```
Organization (tenant root)
  ├── Pools (cost hierarchy)
  ├── CloudAccounts
  ├── Members (users with roles)
  └── CIs (CMDB scope)
```

### 10.2 Roles
- `org:owner` — full control including billing and deletion
- `org:admin` — full control except org deletion
- `org:member` — read-only access
- `org:finops` — cost data read + recommendation action
- `org:cmdb_editor` — CI create/edit (no delete)
- Custom roles with explicit permission grants

### 10.3 Permission Granularity
```
{resource}:{action}
cloud_account:read | cloud_account:write | cloud_account:delete
expense:read
ci:read | ci:write | ci:delete
recommendation:read | recommendation:action
budget:read | budget:write
```

### 10.4 Data Isolation
- All queries include `WHERE organization_id = $org_id`
- Organization ID injected by auth middleware from JWT claims
- No cross-org data leakage possible at query level

---

## 11. Audit & Operation Logging

### 11.1 Global Audit Log
```sql
audit_logs (
  id, organization_id, user_id, action,
  resource_type, resource_id,
  before_state JSONB, after_state JSONB,
  ip_address, user_agent, created_at
)
```

### 11.2 CMDB Field-Level Audit
```sql
ci_audit_logs (
  id, ci_id, organization_id, user_id,
  operation, -- create/update/delete/associate/lifecycle_change
  field_changes JSONB, -- [{field, before, after}]
  source, -- user/discovery/sync/rule/api
  created_at
)
```

### 11.3 What Gets Audited
- All CRUD on organizations, cloud accounts, CIs, pools, budgets
- All authentication events (login, logout, failed login)
- All cloud sync jobs (start, complete, error)
- All recommendation engine runs
- All assignment rule executions
- All budget alert triggers

---

## 12. Data Synchronization Strategy

### 12.1 Sync Job Flow
```
1. Scheduler triggers sync job for cloud_account
2. Worker acquires PG advisory lock (pg_try_advisory_lock)
3. Call cloud adapter discover_resources()
4. For each resource: upsert CI in cis table
5. Run association inference
6. Apply assignment rules to new resources
7. Run recommendation detection for changed resources
8. Release lock, write job_run record
```

### 12.2 Billing Import Flow
```
1. Scheduler triggers billing import (daily at 06:00 UTC)
2. Fetch previous day's billing via cloud adapter
3. Insert raw_expenses (JSONB preserved)
4. Upsert expenses (aggregate by resource+date)
5. Check budget thresholds → fire alerts if needed
6. Mark job complete
```

### 12.3 Conflict Resolution
- CI upserts use `ON CONFLICT (organization_id, cloud_resource_id) DO UPDATE`
- Expense upserts use `ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id, date) DO UPDATE`
- Raw expenses are append-only (idempotent by external_id)

### 12.4 Reconciliation
- Daily reconciliation job checks for orphaned CIs (cloud resource deleted)
- Sets CI lifecycle_state = 'decommissioned' for missing resources
- Sends alert if reconciliation finds > 10% change in resource count

---

## 13. Scheduling & Reconciliation Mechanisms

### 13.1 Scheduler Design (No External Queue)
```rust
// tokio::time::interval based cron runner
// Job definitions stored in scheduled_jobs table
// Each worker iteration: SELECT FOR UPDATE SKIP LOCKED
// Distributed locking: pg_try_advisory_lock(job_id)

async fn scheduler_loop(pool: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        let due_jobs = fetch_due_jobs(&pool).await;
        for job in due_jobs {
            tokio::spawn(run_job(pool.clone(), job));
        }
    }
}
```

### 13.2 Default Schedule
- Resource sync: every 6 hours per cloud account
- Billing import: daily at 06:00 UTC
- Recommendation run: daily at 08:00 UTC
- Budget threshold check: every 1 hour
- Orphan reconciliation: daily at 02:00 UTC
- Audit log cleanup: weekly (retain 90 days)

---

## 14. Deployment Architecture

### 14.1 Single-Container (MVP)
```
docker-compose.yml:
  postgres (volume: pgdata)
  cloudatlas-migrate (init, runs once)
  cloudatlas-api (backend, port 8080)
  cloudatlas-web (frontend, port 3000)
```

### 14.2 Production-Ready
```
Nginx (TLS termination, reverse proxy)
  → cloudatlas-api (replicated 2x, port 8080)
  → cloudatlas-web (static files or CDN)
  → postgres (managed PG or RDS)

Backups: pg_dump daily, 30-day retention
Monitoring: Prometheus /metrics endpoint + Grafana
Alerting: Dead man's switch on sync jobs
```

---

## 15. Observability Design

### 15.1 Metrics (No External Service)
- Expose `/metrics` (Prometheus text format) via `axum-prometheus` or custom handler
- Key metrics: HTTP request duration, DB query latency, sync job duration, recommendation run time
- All metrics scoped by organization for multi-tenant analysis

### 15.2 Tracing
- `tracing` crate + `tracing-subscriber` with JSON output
- Request IDs injected via tower middleware (UUID v4)
- Log level controlled via `RUST_LOG` env var

### 15.3 Health Checks
- `GET /health` — liveness (server running)
- `GET /health/ready` — readiness (DB connected, migrations current)
- Docker `HEALTHCHECK` using `/health`

---

## 16. Future Extensibility

### 16.1 AI Integration Points (Ready for)
- `recommendations.ai_explanation` JSONB column for LLM-generated text
- `ci_audit_logs.source = 'ai'` for AI-initiated changes
- PostgreSQL pgvector extension for RAG embeddings (addable via migration)
- `/api/v1/ai/chat` endpoint stub

### 16.2 Additional Cloud Providers
- Trait-based `CloudAdapter` allows Azure, GCP, etc. without core changes
- Provider enum extensible via Rust feature flags

### 16.3 Kubernetes Cost Allocation
- K8s node CIs can be child of cloud instance via `run_on` association
- Pod costs can be attributed via namespace tags

### 16.4 Event Webhooks
- `webhooks` table ready for external event delivery
- `outbound_events` queue table (process on next scheduler tick)

### 16.5 SAML/SSO
- `sessions` table includes `provider` column for future OAuth2/SAML
- User model has `external_id` for provider mapping

---

## Naming Conventions & Coding Standards

### Rust
- Snake case for functions and variables (`get_cloud_account`)
- PascalCase for types and traits (`CloudAdapter`, `CiInstance`)
- Error types via `thiserror`, propagation via `?` operator
- All handlers return `Result<impl IntoResponse, AppError>`
- DTOs separate from DB models (no leaking DB types to API)

### Database
- Table names: plural snake_case (`cloud_accounts`, `ci_instances`)
- Column names: snake_case
- Primary keys: `id UUID DEFAULT gen_random_uuid()`
- Foreign keys: `{table_singular}_id` (e.g., `organization_id`)
- Timestamps: `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`
- Soft deletes: `deleted_at TIMESTAMPTZ NULL`

### API
- Resource paths: kebab-case, plural nouns (`/cloud-accounts`)
- Query params: snake_case (`?start_date=`, `?resource_type=`)
- Response envelope: `{ "data": ..., "meta": { "total": N } }`
- Error format: `{ "error": { "code": "NOT_FOUND", "message": "..." } }`
