---
description: "Use when writing SQL migrations, database schema, or sqlx queries for CloudAtlas. Covers PostgreSQL conventions, naming patterns, indexes, soft-delete, JSONB, and migration file structure."
applyTo: ["backend/migrations/**", "backend/src/**/*.rs"]
---

# Database Patterns

## Migration File Convention

```
backend/migrations/
  001_identity.sql          # users, organizations, members, roles
  002_cloud_accounts.sql    # cloud_accounts, sync_jobs
  003_cmdb.sql              # ci_types, cis, associations
  004_expenses.sql          # expenses, pools, budgets
  005_finops.sql            # recommendations
  006_scheduler.sql         # scheduler_jobs
  007_seed.sql              # demo data
  008_cmdb_extended.sql     # extended CMDB tables
  009_finops_extended.sql   # extended FinOps tables
  010_seed_extended.sql     # extended seed data
```

Naming: `NNN_description.sql`. Always sequential. Never renumber existing files.

## Table Template

```sql
CREATE TABLE IF NOT EXISTS table_name (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id),
    name        VARCHAR(256) NOT NULL,
    -- domain columns
    meta        JSONB NOT NULL DEFAULT '{}',
    created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    updated_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    deleted_at  BIGINT NOT NULL DEFAULT 0
);
```

## Mandatory Columns (every table)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID | `gen_random_uuid()` | PK |
| `created_at` | BIGINT | epoch now | UNIX seconds |
| `updated_at` | BIGINT | epoch now | UNIX seconds |
| `deleted_at` | BIGINT | `0` | 0 = active, timestamp = deleted |
| `organization_id` | UUID | — | FK to organizations, every domain table |

## Soft Delete Uniqueness Pattern

```sql
-- Use deleted_at in unique constraints to allow re-create after delete
UNIQUE(organization_id, name, deleted_at)
UNIQUE(organization_id, cloud_resource_id, cloud_account_id, deleted_at)
```

## Index Naming & Patterns

```sql
-- Standard partial index (excludes deleted rows)
CREATE INDEX idx_resources_org ON resources(organization_id) WHERE deleted_at = 0;
CREATE INDEX idx_resources_cloud_account ON resources(cloud_account_id) WHERE deleted_at = 0;

-- JSONB GIN index (for @>, ?, ?| operators)
CREATE INDEX idx_ci_meta_gin ON ci USING gin(meta) WHERE deleted_at = 0;
CREATE INDEX idx_resources_tags_gin ON resources USING gin(tags) WHERE deleted_at = 0;

-- Prefix: idx_{table}_{column(s)}
```

## JSONB Usage

```sql
-- Store semi-structured data (meta, tags, config, attributes)
meta        JSONB NOT NULL DEFAULT '{}'
tags        JSONB NOT NULL DEFAULT '{}'
config      JSONB NOT NULL DEFAULT '{}'

-- Query by JSONB key
WHERE meta->>'region' = 'us-east-1'
WHERE tags @> '{"env": "production"}'::jsonb
WHERE meta ? 'instance_type'
```

## Time-Series Pattern (no TimescaleDB)

```sql
-- Partition expenses by month manually using range partitioning
CREATE TABLE expenses (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    resource_id     UUID,
    date            DATE NOT NULL,
    cost            NUMERIC(14,6) NOT NULL,
    ...
) PARTITION BY RANGE (date);

-- Monthly partitions
CREATE TABLE expenses_2024_01 PARTITION OF expenses
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

Or use a regular table with `date DATE NOT NULL` and rely on the index:
```sql
CREATE INDEX idx_expenses_org_date ON expenses(organization_id, date) WHERE deleted_at = 0;
```

## Recursive CTE (hierarchy/topology)

```sql
-- Pool hierarchy cost rollup
WITH RECURSIVE pool_tree AS (
    SELECT id, parent_id, budget_limit, 0 AS depth
    FROM pools WHERE id = $1 AND deleted_at = 0
    UNION ALL
    SELECT p.id, p.parent_id, p.budget_limit, t.depth + 1
    FROM pools p JOIN pool_tree t ON p.parent_id = t.id
    WHERE p.deleted_at = 0
)
SELECT * FROM pool_tree;
```

## Seed Data Pattern

```sql
-- Use INSERT ... ON CONFLICT DO NOTHING for idempotent seeds
INSERT INTO ci_classifications (id, name, label, created_at, updated_at)
VALUES
    ('00000000-0000-0000-0000-000000000001', 'cloud_compute', 'Cloud Compute', 0, 0),
    ('00000000-0000-0000-0000-000000000002', 'storage', 'Storage', 0, 0)
ON CONFLICT (id) DO NOTHING;
```

## Never Do

- Never `DELETE` rows in production code — use soft delete (`UPDATE ... SET deleted_at = now()`)
- Never use `NOW()` in application code — store UNIX timestamps as BIGINT
- Never use `TEXT` for structured enums — use `VARCHAR(50)` with application-level validation
- Never store secrets/credentials in plaintext — use `credentials_enc` (AES-256-GCM encrypted BYTEA or TEXT)
