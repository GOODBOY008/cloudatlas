-- ============================================================================
-- CloudAtlas — consolidated schema migration (001_init.sql)
-- Merges the former 001_identity.sql .. 037_cmdb_compliance_targets.sql into
-- one file. Each source section keeps its original header comment; sections
-- run top-to-bottom in the original version order inside a single transaction.
-- Existing databases created before the merge must be recreated.
-- ============================================================================

-- ── source: 001_identity.sql ──
-- Migration 001: Identity, Tenancy, RBAC
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ──────────────────────────────────────────────────────────────
-- Organizations (tenant root)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    description     TEXT,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_organizations_slug ON organizations(slug);

-- ──────────────────────────────────────────────────────────────
-- Users
-- ──────────────────────────────────────────────────────────────
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    display_name    VARCHAR(255) NOT NULL,
    password_hash   TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);

-- ──────────────────────────────────────────────────────────────
-- Roles
-- ──────────────────────────────────────────────────────────────
CREATE TYPE role_scope AS ENUM ('system', 'organization');

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    scope           role_scope NOT NULL DEFAULT 'organization',
    is_builtin      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_roles_org ON roles(organization_id);

-- ──────────────────────────────────────────────────────────────
-- Permissions
-- ──────────────────────────────────────────────────────────────
CREATE TABLE permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource    VARCHAR(100) NOT NULL,
    action      VARCHAR(50) NOT NULL,
    description TEXT,
    UNIQUE(resource, action)
);

CREATE TABLE role_permissions (
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- ──────────────────────────────────────────────────────────────
-- Organization Members
-- ──────────────────────────────────────────────────────────────
CREATE TABLE organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, user_id)
);

CREATE INDEX idx_org_members_org ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

-- ──────────────────────────────────────────────────────────────
-- User Roles (within an organization)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE user_roles (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by     UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id, organization_id)
);

CREATE INDEX idx_user_roles_user_org ON user_roles(user_id, organization_id);

-- ──────────────────────────────────────────────────────────────
-- Sessions (JWT refresh tokens)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token   TEXT NOT NULL UNIQUE,
    ip_address      INET,
    user_agent      TEXT,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(refresh_token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ──────────────────────────────────────────────────────────────
-- API Keys
-- ──────────────────────────────────────────────────────────────
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,
    key_prefix      VARCHAR(20) NOT NULL,
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- ──────────────────────────────────────────────────────────────
-- Audit Logs
-- ──────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          VARCHAR(100) NOT NULL,
    resource_type   VARCHAR(100),
    resource_id     UUID,
    before_state    JSONB,
    after_state     JSONB,
    ip_address      INET,
    user_agent      TEXT,
    request_id      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_roles_updated_at
    BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Seed: Built-in permissions
-- ──────────────────────────────────────────────────────────────
INSERT INTO permissions (resource, action, description) VALUES
    ('organization', 'read',   'View organization details'),
    ('organization', 'write',  'Update organization settings'),
    ('organization', 'delete', 'Delete organization'),
    ('cloud_account','read',   'View cloud accounts'),
    ('cloud_account','write',  'Create/update cloud accounts'),
    ('cloud_account','delete', 'Delete cloud accounts'),
    ('cloud_account','sync',   'Trigger cloud sync'),
    ('expense',      'read',   'View cost data'),
    ('ci',           'read',   'View CMDB configuration items'),
    ('ci',           'write',  'Create/update configuration items'),
    ('ci',           'delete', 'Delete configuration items'),
    ('recommendation','read',  'View recommendations'),
    ('recommendation','action','Dismiss/apply recommendations'),
    ('budget',       'read',   'View budgets'),
    ('budget',       'write',  'Create/update budgets'),
    ('user',         'read',   'View team members'),
    ('user',         'write',  'Invite/manage team members');

-- ── source: 002_cloud_accounts.sql ──
-- Migration 002: Cloud Accounts & Resource Discovery
-- ============================================================

CREATE TYPE cloud_provider AS ENUM ('aws', 'alibaba', 'azure', 'gcp', 'mock');
CREATE TYPE sync_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- ──────────────────────────────────────────────────────────────
-- Cloud Accounts
-- ──────────────────────────────────────────────────────────────
CREATE TABLE cloud_accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    provider            cloud_provider NOT NULL,
    credentials_enc     TEXT NOT NULL,
    config              JSONB NOT NULL DEFAULT '{}',
    is_active           BOOLEAN NOT NULL DEFAULT true,
    last_sync_at        TIMESTAMPTZ,
    last_sync_status    sync_status,
    resource_count      INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_cloud_accounts_org ON cloud_accounts(organization_id);
CREATE INDEX idx_cloud_accounts_provider ON cloud_accounts(provider);

CREATE TRIGGER trg_cloud_accounts_updated_at
    BEFORE UPDATE ON cloud_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Cloud Regions
-- ──────────────────────────────────────────────────────────────
CREATE TABLE cloud_regions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cloud_account_id    UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    region_id           VARCHAR(100) NOT NULL,
    display_name        VARCHAR(255),
    is_enabled          BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cloud_account_id, region_id)
);

CREATE INDEX idx_cloud_regions_account ON cloud_regions(cloud_account_id);

-- ──────────────────────────────────────────────────────────────
-- Sync Jobs
-- ──────────────────────────────────────────────────────────────
CREATE TABLE sync_jobs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cloud_account_id     UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status               sync_status NOT NULL DEFAULT 'pending',
    started_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    resources_discovered INTEGER,
    resources_created    INTEGER,
    resources_updated    INTEGER,
    resources_deleted    INTEGER,
    error_message        TEXT,
    triggered_by         VARCHAR(50) NOT NULL DEFAULT 'scheduler',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_jobs_account ON sync_jobs(cloud_account_id, created_at DESC);
CREATE INDEX idx_sync_jobs_org ON sync_jobs(organization_id, created_at DESC);
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status) WHERE status IN ('pending', 'running');

-- ── source: 003_cmdb.sql ──
-- Migration 003: CMDB
-- ============================================================

CREATE TYPE ci_lifecycle_state AS ENUM (
    'provisioning', 'active', 'maintenance',
    'decommissioning', 'decommissioned', 'retired', 'failed'
);

CREATE TYPE ci_attribute_type AS ENUM (
    'string', 'integer', 'float', 'boolean', 'datetime',
    'enum', 'list', 'json', 'url', 'ip_address', 'cidr'
);

CREATE TYPE association_cardinality AS ENUM (
    'one_to_one', 'one_to_many', 'many_to_one', 'many_to_many'
);

CREATE TABLE ci_classifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    icon            VARCHAR(100),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_builtin      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE TRIGGER trg_ci_classifications_updated_at
    BEFORE UPDATE ON ci_classifications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE ci_types (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
    classification_id   UUID REFERENCES ci_classifications(id) ON DELETE SET NULL,
    name                VARCHAR(100) NOT NULL,
    display_name        VARCHAR(255) NOT NULL,
    description         TEXT,
    icon                VARCHAR(100),
    cloud_provider      cloud_provider,
    is_builtin          BOOLEAN NOT NULL DEFAULT false,
    is_abstract         BOOLEAN NOT NULL DEFAULT false,
    parent_type_id      UUID REFERENCES ci_types(id),
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_ci_types_org ON ci_types(organization_id);
CREATE INDEX idx_ci_types_classification ON ci_types(classification_id);

CREATE TRIGGER trg_ci_types_updated_at
    BEFORE UPDATE ON ci_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE ci_attributes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    attribute_type  ci_attribute_type NOT NULL,
    is_required     BOOLEAN NOT NULL DEFAULT false,
    is_unique       BOOLEAN NOT NULL DEFAULT false,
    default_value   TEXT,
    enum_values     JSONB,
    validation_rule TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_builtin      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ci_type_id, name)
);

CREATE INDEX idx_ci_attributes_type ON ci_attributes(ci_type_id);

CREATE TABLE cis (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ci_type_id          UUID NOT NULL REFERENCES ci_types(id),
    cloud_account_id    UUID REFERENCES cloud_accounts(id) ON DELETE SET NULL,
    cloud_resource_id   VARCHAR(500),
    cloud_provider      cloud_provider,
    cloud_region        VARCHAR(100),
    name                VARCHAR(500) NOT NULL,
    display_name        VARCHAR(500),
    meta                JSONB NOT NULL DEFAULT '{}',
    tags                JSONB NOT NULL DEFAULT '{}',
    lifecycle_state     ci_lifecycle_state NOT NULL DEFAULT 'active',
    parent_ci_id        UUID REFERENCES cis(id) ON DELETE SET NULL,
    pool_id             UUID,
    discovered_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    UNIQUE(organization_id, cloud_account_id, cloud_resource_id)
);

CREATE INDEX idx_cis_org ON cis(organization_id);
CREATE INDEX idx_cis_type ON cis(ci_type_id);
CREATE INDEX idx_cis_cloud_account ON cis(cloud_account_id);
CREATE INDEX idx_cis_lifecycle ON cis(lifecycle_state);
CREATE INDEX idx_cis_parent ON cis(parent_ci_id) WHERE parent_ci_id IS NOT NULL;
CREATE INDEX idx_cis_cloud_resource ON cis(cloud_resource_id) WHERE cloud_resource_id IS NOT NULL;
CREATE INDEX idx_cis_tags ON cis USING GIN(tags);
CREATE INDEX idx_cis_meta ON cis USING GIN(meta);

CREATE TRIGGER trg_cis_updated_at
    BEFORE UPDATE ON cis
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE ci_association_kinds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    is_directional  BOOLEAN NOT NULL DEFAULT true,
    is_builtin      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE TABLE ci_object_associations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID REFERENCES organizations(id) ON DELETE CASCADE,
    src_ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    association_kind_id UUID NOT NULL REFERENCES ci_association_kinds(id) ON DELETE CASCADE,
    dst_ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    cardinality         association_cardinality NOT NULL DEFAULT 'many_to_many',
    description         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(src_ci_type_id, association_kind_id, dst_ci_type_id)
);

CREATE TABLE ci_instance_associations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    src_ci_id               UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    object_association_id   UUID NOT NULL REFERENCES ci_object_associations(id) ON DELETE CASCADE,
    dst_ci_id               UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    meta                    JSONB NOT NULL DEFAULT '{}',
    created_by              UUID REFERENCES users(id),
    source                  VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(src_ci_id, object_association_id, dst_ci_id)
);

CREATE INDEX idx_ci_assoc_src ON ci_instance_associations(src_ci_id);
CREATE INDEX idx_ci_assoc_dst ON ci_instance_associations(dst_ci_id);
CREATE INDEX idx_ci_assoc_org ON ci_instance_associations(organization_id);

CREATE TABLE ci_lifecycle_transitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_state      ci_lifecycle_state,
    to_state        ci_lifecycle_state NOT NULL,
    reason          TEXT,
    triggered_by    UUID REFERENCES users(id),
    source          VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ci_lifecycle_ci ON ci_lifecycle_transitions(ci_id, created_at DESC);

CREATE TABLE ci_audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id),
    operation       VARCHAR(50) NOT NULL,
    field_changes   JSONB,
    source          VARCHAR(50) NOT NULL DEFAULT 'user',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ci_audit_ci ON ci_audit_logs(ci_id, created_at DESC);
CREATE INDEX idx_ci_audit_org ON ci_audit_logs(organization_id, created_at DESC);

CREATE TABLE ci_dynamic_groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    ci_type_id      UUID REFERENCES ci_types(id),
    conditions      JSONB NOT NULL DEFAULT '[]',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dynamic_groups_org ON ci_dynamic_groups(organization_id);

-- ──────────────────────────────────────────────────────────────
-- Seed: Built-in CI data
-- ──────────────────────────────────────────────────────────────
INSERT INTO ci_classifications (id, name, display_name, description, icon, sort_order, is_builtin, organization_id) VALUES
    ('10000000-0000-0000-0000-000000000001', 'cloud_compute',    'Cloud Compute',    'Virtual machines and containers',     'server',   10, true, NULL),
    ('10000000-0000-0000-0000-000000000002', 'cloud_storage',    'Cloud Storage',    'Disks, snapshots, object storage',    'database', 20, true, NULL),
    ('10000000-0000-0000-0000-000000000003', 'cloud_network',    'Cloud Network',    'Load balancers and IP addresses',     'network',  30, true, NULL),
    ('10000000-0000-0000-0000-000000000004', 'cloud_commitment', 'Cloud Commitment', 'Reserved instances and savings plans','savings',  40, true, NULL),
    ('10000000-0000-0000-0000-000000000005', 'cloud_database',   'Cloud Database',   'Managed database services',           'table',    50, true, NULL),
    ('10000000-0000-0000-0000-000000000006', 'on_premise',       'On-Premise',       'Physical and virtual on-prem assets', 'building', 60, true, NULL);

INSERT INTO ci_types (id, name, display_name, description, classification_id, cloud_provider, is_builtin, organization_id) VALUES
    ('20000000-0000-0000-0000-000000000001', 'cloud_instance',   'Cloud Instance',        'Virtual machine (EC2/ECS)',            '10000000-0000-0000-0000-000000000001', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000002', 'cloud_rds',        'Cloud RDS',             'Managed relational database',          '10000000-0000-0000-0000-000000000005', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000003', 'cloud_volume',     'Cloud Volume',          'Block storage (EBS/Cloud Disk)',        '10000000-0000-0000-0000-000000000002', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000004', 'cloud_snapshot',   'Cloud Snapshot',        'Volume snapshot',                      '10000000-0000-0000-0000-000000000002', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000005', 'cloud_bucket',     'Object Storage Bucket', 'S3/OSS bucket',                        '10000000-0000-0000-0000-000000000002', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000006', 'cloud_lb',         'Load Balancer',         'Application/network load balancer',    '10000000-0000-0000-0000-000000000003', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000007', 'cloud_ip',         'Elastic IP',            'Static public IP address',             '10000000-0000-0000-0000-000000000003', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000008', 'reserved_instance','Reserved Instance',     'Cloud reserved compute commitment',    '10000000-0000-0000-0000-000000000004', NULL,     true, NULL),
    ('20000000-0000-0000-0000-000000000009', 'savings_plan',     'Savings Plan',          'Flexible spend commitment',            '10000000-0000-0000-0000-000000000004', 'aws',    true, NULL),
    ('20000000-0000-0000-0000-000000000010', 'on_prem_server',   'On-Prem Server',        'Physical/virtual on-premise server',   '10000000-0000-0000-0000-000000000006', NULL,     true, NULL);

INSERT INTO ci_association_kinds (id, name, display_name, description, is_directional, is_builtin, organization_id) VALUES
    ('30000000-0000-0000-0000-000000000001', 'belong_to',   'Belongs To',   'CI belongs to parent CI',             true,  true, NULL),
    ('30000000-0000-0000-0000-000000000002', 'run_on',      'Runs On',      'CI runs on another CI',               true,  true, NULL),
    ('30000000-0000-0000-0000-000000000003', 'backed_by',   'Backed By',    'CI is backed by storage CI',          true,  true, NULL),
    ('30000000-0000-0000-0000-000000000004', 'connects_to', 'Connects To',  'Network connection between CIs',      false, true, NULL),
    ('30000000-0000-0000-0000-000000000005', 'contains',    'Contains',     'CI contains sub-CIs',                 true,  true, NULL),
    ('30000000-0000-0000-0000-000000000006', 'managed_by',  'Managed By',   'CI is managed by a service or team',  true,  true, NULL);

INSERT INTO ci_object_associations (organization_id, src_ci_type_id, association_kind_id, dst_ci_type_id, cardinality) VALUES
    (NULL, '20000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'many_to_one'),
    (NULL, '20000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'many_to_one'),
    (NULL, '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000006', 'many_to_many'),
    (NULL, '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000010', 'many_to_one');

-- ── source: 004_expenses.sql ──
-- Migration 004: Expense & Cost Allocation
-- ============================================================

CREATE TYPE resource_type AS ENUM (
    'instance', 'rds_instance', 'k8s_pod', 'volume', 'snapshot',
    'bucket', 'snapshot_chain', 'image', 'ip_address', 'load_balancer',
    'reserved_instance', 'savings_plan', 'other'
);

-- ──────────────────────────────────────────────────────────────
-- Cost Pools (hierarchical cost centers)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE pools (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES pools(id) ON DELETE SET NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    pool_type       VARCHAR(50) NOT NULL DEFAULT 'team',  -- team|project|env|business_unit
    owner_id        UUID REFERENCES users(id),
    monthly_budget  NUMERIC(18,4),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_pools_org ON pools(organization_id);
CREATE INDEX idx_pools_parent ON pools(parent_id) WHERE parent_id IS NOT NULL;

CREATE TRIGGER trg_pools_updated_at
    BEFORE UPDATE ON pools
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add FK from cis to pools (can't be in migration 003 as pools didn't exist yet)
ALTER TABLE cis ADD CONSTRAINT fk_cis_pool
    FOREIGN KEY (pool_id) REFERENCES pools(id) ON DELETE SET NULL;

-- ──────────────────────────────────────────────────────────────
-- Raw Expenses (cloud-native billing line items, append-only)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE raw_expenses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cloud_account_id    UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    -- Cloud-native line item identity
    external_id         VARCHAR(500),    -- cloud-specific record ID
    billing_period      DATE NOT NULL,   -- YYYY-MM-01
    -- Resource info
    cloud_resource_id   VARCHAR(500),
    resource_name       VARCHAR(500),
    resource_type       resource_type NOT NULL DEFAULT 'other',
    cloud_region        VARCHAR(100),
    -- Cost
    cost                NUMERIC(18,6) NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'USD',
    -- Service info
    service_name        VARCHAR(255),
    usage_type          VARCHAR(255),
    operation           VARCHAR(255),
    -- Raw data preservation
    cloud_specific      JSONB NOT NULL DEFAULT '{}',
    -- Import tracking
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(cloud_account_id, external_id, billing_period)
);

CREATE INDEX idx_raw_expenses_org ON raw_expenses(organization_id, billing_period DESC);
CREATE INDEX idx_raw_expenses_account ON raw_expenses(cloud_account_id, billing_period DESC);
CREATE INDEX idx_raw_expenses_resource ON raw_expenses(cloud_resource_id, billing_period DESC);

-- ──────────────────────────────────────────────────────────────
-- Expenses (aggregated per resource per day)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE expenses (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cloud_account_id    UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    cloud_resource_id   VARCHAR(500) NOT NULL,
    resource_name       VARCHAR(500),
    resource_type       resource_type NOT NULL DEFAULT 'other',
    cloud_region        VARCHAR(100),
    service_name        VARCHAR(255),
    -- Cost
    date                DATE NOT NULL,
    cost                NUMERIC(18,6) NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'USD',
    -- Pool assignment (from assignment rules or manual)
    pool_id             UUID REFERENCES pools(id) ON DELETE SET NULL,
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Tags snapshot at time of import
    tags                JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, cloud_account_id, cloud_resource_id, date)
);

CREATE INDEX idx_expenses_org_date ON expenses(organization_id, date DESC);
CREATE INDEX idx_expenses_account_date ON expenses(cloud_account_id, date DESC);
CREATE INDEX idx_expenses_resource ON expenses(cloud_resource_id, date DESC);
CREATE INDEX idx_expenses_pool ON expenses(pool_id, date DESC) WHERE pool_id IS NOT NULL;
CREATE INDEX idx_expenses_service ON expenses(service_name, date DESC);
CREATE INDEX idx_expenses_region ON expenses(cloud_region, date DESC);

CREATE TRIGGER trg_expenses_updated_at
    BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Assignment Rules (auto-assign resources to pools/owners)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE assignment_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    priority        INTEGER NOT NULL DEFAULT 100,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    conditions      JSONB NOT NULL DEFAULT '[]',
    -- [{"field": "tags.env", "op": "eq", "value": "prod"}, ...]
    pool_id         UUID REFERENCES pools(id) ON DELETE SET NULL,
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assignment_rules_org ON assignment_rules(organization_id, priority);

CREATE TRIGGER trg_assignment_rules_updated_at
    BEFORE UPDATE ON assignment_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── source: 005_finops.sql ──
-- Migration 005: Recommendations & Budgets
-- ============================================================

CREATE TYPE recommendation_type AS ENUM (
    'abandoned_instance', 'abandoned_volume', 'abandoned_snapshot',
    'abandoned_ip', 'abandoned_lb', 'rightsizing_instance', 'rightsizing_rds',
    'reserved_instance', 'savings_plan', 'instance_generation_upgrade',
    's3_intelligent_tiering', 'insecure_security_group', 'inactive_iam_user'
);

CREATE TYPE recommendation_status AS ENUM (
    'active', 'dismissed', 'applied', 'obsolete'
);

-- ──────────────────────────────────────────────────────────────
-- Recommendation Runs (engine execution history)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE recommendation_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status          sync_status NOT NULL DEFAULT 'pending',
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    modules_run     JSONB NOT NULL DEFAULT '[]',
    findings_count  INTEGER NOT NULL DEFAULT 0,
    potential_savings NUMERIC(18,4),
    error_message   TEXT,
    triggered_by    VARCHAR(50) NOT NULL DEFAULT 'scheduler',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recommendation_runs_org ON recommendation_runs(organization_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────
-- Recommendations
-- ──────────────────────────────────────────────────────────────
CREATE TABLE recommendations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    run_id              UUID REFERENCES recommendation_runs(id) ON DELETE SET NULL,
    cloud_account_id    UUID REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    ci_id               UUID REFERENCES cis(id) ON DELETE SET NULL,
    cloud_resource_id   VARCHAR(500),
    rec_type            recommendation_type NOT NULL,
    status              recommendation_status NOT NULL DEFAULT 'active',
    title               VARCHAR(500) NOT NULL,
    description         TEXT,
    -- Cost impact
    current_monthly_cost   NUMERIC(18,4),
    potential_savings      NUMERIC(18,4),
    savings_percent        NUMERIC(5,2),
    -- Type-specific details
    details             JSONB NOT NULL DEFAULT '{}',
    -- User actions
    dismissed_by        UUID REFERENCES users(id),
    dismissed_at        TIMESTAMPTZ,
    dismiss_reason      TEXT,
    applied_at          TIMESTAMPTZ,
    -- AI enrichment (future use)
    ai_explanation      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recommendations_org ON recommendations(organization_id, status);
CREATE INDEX idx_recommendations_type ON recommendations(rec_type, status);
CREATE INDEX idx_recommendations_resource ON recommendations(cloud_resource_id);
CREATE INDEX idx_recommendations_ci ON recommendations(ci_id);

CREATE TRIGGER trg_recommendations_updated_at
    BEFORE UPDATE ON recommendations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Budgets
-- ──────────────────────────────────────────────────────────────
CREATE TYPE budget_period AS ENUM ('monthly', 'quarterly', 'annual');
CREATE TYPE budget_alert_type AS ENUM ('absolute', 'percentage');

CREATE TABLE budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id         UUID REFERENCES pools(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    amount          NUMERIC(18,4) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    period          budget_period NOT NULL DEFAULT 'monthly',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_budgets_org ON budgets(organization_id);
CREATE INDEX idx_budgets_pool ON budgets(pool_id);

CREATE TRIGGER trg_budgets_updated_at
    BEFORE UPDATE ON budgets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Budget Alerts
-- ──────────────────────────────────────────────────────────────
CREATE TABLE budget_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_id       UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    alert_type      budget_alert_type NOT NULL,
    threshold       NUMERIC(18,4) NOT NULL,  -- amount or percentage (0-100)
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    last_triggered_value NUMERIC(18,4),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_budget_alerts_budget ON budget_alerts(budget_id);
CREATE INDEX idx_budget_alerts_org ON budget_alerts(organization_id);

-- ──────────────────────────────────────────────────────────────
-- Alert Events (history of fired alerts)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    budget_alert_id UUID REFERENCES budget_alerts(id) ON DELETE SET NULL,
    budget_id       UUID REFERENCES budgets(id) ON DELETE SET NULL,
    pool_id         UUID REFERENCES pools(id) ON DELETE SET NULL,
    alert_type      budget_alert_type NOT NULL,
    threshold       NUMERIC(18,4) NOT NULL,
    actual_value    NUMERIC(18,4) NOT NULL,
    message         TEXT NOT NULL,
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_events_org ON alert_events(organization_id, created_at DESC);

-- ── source: 006_scheduler.sql ──
-- Migration 006: Scheduler
-- ============================================================

CREATE TYPE job_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped', 'disabled');

-- ──────────────────────────────────────────────────────────────
-- Scheduled Jobs (job definitions)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE scheduled_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    -- NULL = global system job
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    job_type        VARCHAR(100) NOT NULL,
    -- e.g. 'cloud_sync', 'billing_import', 'recommendation_run', 'budget_check'
    cron_expression VARCHAR(100) NOT NULL,  -- standard 5-field cron
    is_enabled      BOOLEAN NOT NULL DEFAULT true,
    payload         JSONB NOT NULL DEFAULT '{}',
    -- e.g. {"cloud_account_id": "uuid"} for targeted sync
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at) WHERE is_enabled = true;
CREATE INDEX idx_scheduled_jobs_org ON scheduled_jobs(organization_id);

CREATE TRIGGER trg_scheduled_jobs_updated_at
    BEFORE UPDATE ON scheduled_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Job Runs (execution history)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE job_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    status          job_status NOT NULL DEFAULT 'pending',
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    duration_ms     INTEGER,
    result          JSONB,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_runs_job ON job_runs(job_id, created_at DESC);
CREATE INDEX idx_job_runs_org ON job_runs(organization_id, created_at DESC);
CREATE INDEX idx_job_runs_status ON job_runs(status) WHERE status IN ('pending', 'running');

-- ──────────────────────────────────────────────────────────────
-- Seed: Default global scheduled jobs
-- ──────────────────────────────────────────────────────────────
INSERT INTO scheduled_jobs (name, description, job_type, cron_expression, is_enabled, payload) VALUES
    ('global_billing_import',       'Daily billing import for all cloud accounts', 'billing_import',       '0 6 * * *',   true, '{}'),
    ('global_recommendation_run',   'Daily recommendation engine run',              'recommendation_run',   '0 8 * * *',   true, '{}'),
    ('global_budget_check',         'Hourly budget threshold check',                'budget_check',         '0 * * * *',   true, '{}'),
    ('global_orphan_reconciliation','Daily orphan CI reconciliation',               'orphan_reconcile',     '0 2 * * *',   true, '{}'),
    ('global_audit_cleanup',        'Weekly audit log cleanup (retain 90 days)',    'audit_cleanup',        '0 3 * * 0',   true, '{"retain_days": 90}');

-- ── source: 007_seed.sql ──
-- Migration 007: Seed Data (Development / Demo)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Demo Organization
-- ──────────────────────────────────────────────────────────────
INSERT INTO organizations (id, name, slug, description) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'Acme Corp', 'acme-corp', 'Demo organization for development');

-- ──────────────────────────────────────────────────────────────
-- Demo Users (password = "Password123!")
-- Hash generated with argon2id
-- ──────────────────────────────────────────────────────────────
INSERT INTO users (id, email, display_name, password_hash, is_active, email_verified) VALUES
    ('b0000000-0000-0000-0000-000000000001', 'admin@acme.com',   'Admin User',   '$argon2id$v=19$m=19456,t=2,p=1$F4ZVBSDtdbMc+v55ShiRRw$s0fTcQaf/clveBFOcdqC55dKglBzWQTCOYJftNnREVk', true, true),
    ('b0000000-0000-0000-0000-000000000002', 'alice@acme.com',   'Alice Chen',   '$argon2id$v=19$m=19456,t=2,p=1$F4ZVBSDtdbMc+v55ShiRRw$s0fTcQaf/clveBFOcdqC55dKglBzWQTCOYJftNnREVk', true, true),
    ('b0000000-0000-0000-0000-000000000003', 'bob@acme.com',     'Bob Smith',    '$argon2id$v=19$m=19456,t=2,p=1$F4ZVBSDtdbMc+v55ShiRRw$s0fTcQaf/clveBFOcdqC55dKglBzWQTCOYJftNnREVk', true, true);

-- ──────────────────────────────────────────────────────────────
-- Org Membership
-- ──────────────────────────────────────────────────────────────
INSERT INTO organization_members (organization_id, user_id) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
    ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'),
    ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003');

-- ──────────────────────────────────────────────────────────────
-- Roles
-- ──────────────────────────────────────────────────────────────
INSERT INTO roles (id, organization_id, name, description, is_builtin) VALUES
    ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Owner',      'Organization owner with full access',    true),
    ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Member',     'Read-only organization member',          true),
    ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'FinOps',     'FinOps access: costs, recommendations',   true),
    ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'CMDB Editor','Create and update configuration items',   true);

INSERT INTO user_roles (user_id, role_id, organization_id) VALUES
    ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),
    ('b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001'),
    ('b0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001');

-- ──────────────────────────────────────────────────────────────
-- Mock Cloud Account
-- ──────────────────────────────────────────────────────────────
INSERT INTO cloud_accounts (id, organization_id, name, provider, credentials_enc, config) VALUES
    ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Acme AWS (mock)', 'mock',
     'bW9jaw==',  -- base64("mock") - placeholder encrypted creds
     '{"account_id": "123456789012", "default_region": "us-east-1", "mock": true}');

-- ──────────────────────────────────────────────────────────────
-- Cost Pools
-- ──────────────────────────────────────────────────────────────
INSERT INTO pools (id, organization_id, parent_id, name, pool_type, monthly_budget) VALUES
    ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', NULL,                                           'Root Pool',     'business_unit', 50000.00),
    ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',          'Engineering',   'team',          30000.00),
    ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',          'Data Science',  'team',          15000.00),
    ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',          'Backend',       'project',        8000.00),
    ('e0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',          'Frontend',      'project',        4000.00);

-- ──────────────────────────────────────────────────────────────
-- Demo CIs (discovered from mock cloud)
-- ──────────────────────────────────────────────────────────────
INSERT INTO cis (id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id, cloud_provider, cloud_region, name, meta, tags, lifecycle_state, pool_id, discovered_at) VALUES
    ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f001', 'mock', 'us-east-1', 'web-server-01',  '{"instance_type": "t3.medium", "cpu_count": 2, "memory_gb": 4}',  '{"env": "prod", "team": "backend"}',  'active',        'e0000000-0000-0000-0000-000000000004', NOW()),
    ('f0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f002', 'mock', 'us-east-1', 'api-server-01',  '{"instance_type": "t3.large",  "cpu_count": 2, "memory_gb": 8}',  '{"env": "prod", "team": "backend"}',  'active',        'e0000000-0000-0000-0000-000000000004', NOW()),
    ('f0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f003', 'mock', 'us-east-1', 'idle-server-01', '{"instance_type": "m5.2xlarge","cpu_count": 8, "memory_gb": 32}', '{"env": "dev",  "team": "backend"}',  'active',        'e0000000-0000-0000-0000-000000000004', NOW()),
    ('f0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'db-0a1b2c3d4e5f001','mock', 'us-east-1', 'prod-mysql-01',  '{"instance_class": "db.t3.medium","engine": "mysql","version": "8.0"}', '{"env": "prod", "team": "backend"}', 'active', 'e0000000-0000-0000-0000-000000000004', NOW()),
    ('f0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'vol-0a1b2c3d001',   'mock', 'us-east-1', 'data-volume-01', '{"size_gb": 500, "volume_type": "gp3"}', '{"env": "prod"}', 'active',        NULL,                                    NOW()),
    ('f0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'vol-0a1b2c3d002',   'mock', 'us-east-1', 'orphan-volume',  '{"size_gb": 200, "volume_type": "gp2"}', '{}',              'active',        NULL,                                    NOW()),
    ('f0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001', 'arn:aws:s3:::acme-data-bucket', 'mock', NULL, 'acme-data-bucket', '{"region": "us-east-1"}', '{"env": "prod"}', 'active', NULL, NOW());

-- ──────────────────────────────────────────────────────────────
-- Demo Expenses (last 30 days)
-- ──────────────────────────────────────────────────────────────
INSERT INTO expenses (organization_id, cloud_account_id, cloud_resource_id, resource_name, resource_type, cloud_region, service_name, date, cost, pool_id) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f001', 'web-server-01',  'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 1,  48.50, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f001', 'web-server-01',  'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 2,  48.50, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f002', 'api-server-01',  'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 1,  73.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f002', 'api-server-01',  'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 2,  73.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f003', 'idle-server-01', 'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 1, 292.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'i-0a1b2c3d4e5f003', 'idle-server-01', 'instance',      'us-east-1', 'Amazon EC2', CURRENT_DATE - 2, 292.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'db-0a1b2c3d4e5f001','prod-mysql-01',  'rds_instance',  'us-east-1', 'Amazon RDS', CURRENT_DATE - 1,  55.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'db-0a1b2c3d4e5f001','prod-mysql-01',  'rds_instance',  'us-east-1', 'Amazon RDS', CURRENT_DATE - 2,  55.00, 'e0000000-0000-0000-0000-000000000004'),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'vol-0a1b2c3d001',   'data-volume-01', 'volume',        'us-east-1', 'Amazon EBS', CURRENT_DATE - 1,  50.00, NULL),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'vol-0a1b2c3d002',   'orphan-volume',  'volume',        'us-east-1', 'Amazon EBS', CURRENT_DATE - 1,  20.00, NULL),
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'arn:aws:s3:::acme-data-bucket', 'acme-data-bucket', 'bucket', NULL, 'Amazon S3', CURRENT_DATE - 1, 12.50, NULL);

-- ──────────────────────────────────────────────────────────────
-- Demo Recommendations
-- ──────────────────────────────────────────────────────────────
INSERT INTO recommendations (organization_id, cloud_account_id, ci_id, cloud_resource_id, rec_type, status, title, description, current_monthly_cost, potential_savings, savings_percent, details) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
     'f0000000-0000-0000-0000-000000000003', 'i-0a1b2c3d4e5f003', 'abandoned_instance', 'active',
     'Idle instance: idle-server-01',
     'Instance i-0a1b2c3d4e5f003 has CPU usage below 5% and network below 1000bps for 7+ days.',
     292.00 * 30, 292.00 * 30 * 0.9, 90.0,
     '{"cpu_avg": 2.1, "network_bps_avg": 450, "days_idle": 12}'),

    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
     'f0000000-0000-0000-0000-000000000006', 'vol-0a1b2c3d002', 'abandoned_volume', 'active',
     'Unattached volume: orphan-volume',
     'Volume vol-0a1b2c3d002 (200 GB) has been detached for 14 days.',
     20.00 * 30, 20.00 * 30, 100.0,
     '{"size_gb": 200, "days_detached": 14}'),

    ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
     'f0000000-0000-0000-0000-000000000003', 'i-0a1b2c3d4e5f003', 'rightsizing_instance', 'active',
     'Rightsizing: idle-server-01 (m5.2xlarge → t3.medium)',
     'Instance consistently uses <10% CPU. Downsize from m5.2xlarge to t3.medium.',
     292.00 * 30, (292.00 - 48.50) * 30, 83.4,
     '{"current_type": "m5.2xlarge", "recommended_type": "t3.medium", "cpu_p99": 8.3}');

-- ──────────────────────────────────────────────────────────────
-- Demo Budget
-- ──────────────────────────────────────────────────────────────
INSERT INTO budgets (organization_id, pool_id, name, amount, period) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 'Engineering Monthly Budget', 30000.00, 'monthly'),
    ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'Total Org Budget',           50000.00, 'monthly');

-- ── source: 008_cmdb_extended.sql ──
-- Migration 008: CMDB Extended Schema
-- ============================================================
-- Adds: services, ci_baselines, ci_drift, compliance, cost_centers,
--       business_capabilities, external_cmdb tables
-- (ci_types, cis, ci_attributes, associations, audit_logs, dynamic_groups
--  already exist in migration 003)

-- ──────────────────────────────────────────────────────────────
-- Services / Application mapping
-- ──────────────────────────────────────────────────────────────
CREATE TABLE services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    display_name    VARCHAR(255),
    description     TEXT,
    service_type    VARCHAR(50) NOT NULL DEFAULT 'application',  -- application|platform|infrastructure
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    pool_id         UUID REFERENCES pools(id) ON DELETE SET NULL,
    tags            JSONB NOT NULL DEFAULT '{}',
    meta            JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_services_org ON services(organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_services_updated_at
    BEFORE UPDATE ON services
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE service_cis (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id  UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    ci_id       UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    role        VARCHAR(100),  -- 'primary', 'dependency', 'optional'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, ci_id)
);

CREATE INDEX idx_service_cis_service ON service_cis(service_id);
CREATE INDEX idx_service_cis_ci ON service_cis(ci_id);

-- ──────────────────────────────────────────────────────────────
-- Configuration Baselines and Drift Detection
-- ──────────────────────────────────────────────────────────────
CREATE TABLE ci_baselines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    desired_state   JSONB NOT NULL DEFAULT '{}',  -- key-value pairs of expected CI attributes
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ci_baselines_ci ON ci_baselines(ci_id);
CREATE INDEX idx_ci_baselines_org ON ci_baselines(organization_id);

CREATE TRIGGER trg_ci_baselines_updated_at
    BEFORE UPDATE ON ci_baselines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TYPE drift_status AS ENUM ('open', 'acknowledged', 'resolved', 'ignored');

CREATE TABLE ci_drift (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_id     UUID NOT NULL REFERENCES ci_baselines(id) ON DELETE CASCADE,
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    field_name      VARCHAR(255) NOT NULL,
    expected_value  TEXT,
    actual_value    TEXT,
    status          drift_status NOT NULL DEFAULT 'open',
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX idx_ci_drift_ci ON ci_drift(ci_id, detected_at DESC);
CREATE INDEX idx_ci_drift_org ON ci_drift(organization_id, status);
CREATE INDEX idx_ci_drift_baseline ON ci_drift(baseline_id);

-- ──────────────────────────────────────────────────────────────
-- Compliance Policies
-- ──────────────────────────────────────────────────────────────
CREATE TABLE compliance_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    ci_type_id      UUID REFERENCES ci_types(id) ON DELETE SET NULL,
    rules           JSONB NOT NULL DEFAULT '[]',
    -- [{"field": "tags.env", "op": "exists"}, {"field": "meta.backup_enabled", "op": "eq", "value": "true"}]
    severity        VARCHAR(20) NOT NULL DEFAULT 'medium',  -- low|medium|high|critical
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_compliance_policies_org ON compliance_policies(organization_id);

CREATE TRIGGER trg_compliance_policies_updated_at
    BEFORE UPDATE ON compliance_policies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE ci_compliance (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    policy_id       UUID NOT NULL REFERENCES compliance_policies(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    is_compliant    BOOLEAN NOT NULL DEFAULT false,
    violations      JSONB NOT NULL DEFAULT '[]',
    last_evaluated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ci_id, policy_id)
);

CREATE INDEX idx_ci_compliance_ci ON ci_compliance(ci_id);
CREATE INDEX idx_ci_compliance_org ON ci_compliance(organization_id, is_compliant);

-- ──────────────────────────────────────────────────────────────
-- Financial Hierarchy
-- ──────────────────────────────────────────────────────────────
CREATE TABLE cost_centers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code            VARCHAR(100) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    parent_id       UUID REFERENCES cost_centers(id),
    owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, code)
);

CREATE INDEX idx_cost_centers_org ON cost_centers(organization_id);

CREATE TRIGGER trg_cost_centers_updated_at
    BEFORE UPDATE ON cost_centers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE business_capabilities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    cost_center_id  UUID REFERENCES cost_centers(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_business_capabilities_org ON business_capabilities(organization_id);

-- ──────────────────────────────────────────────────────────────
-- External CMDB Integration
-- ──────────────────────────────────────────────────────────────
CREATE TABLE external_cmdb_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    provider        VARCHAR(50) NOT NULL,  -- servicenow|rest|jira
    base_url        TEXT NOT NULL,
    auth_config     JSONB NOT NULL DEFAULT '{}',  -- encrypted credentials stored in meta
    field_mapping   JSONB NOT NULL DEFAULT '{}',  -- local_field -> remote_field
    sync_direction  VARCHAR(10) NOT NULL DEFAULT 'pull',  -- pull|push|bidirectional
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_external_cmdb_org ON external_cmdb_configs(organization_id);

CREATE TRIGGER trg_external_cmdb_updated_at
    BEFORE UPDATE ON external_cmdb_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE external_cmdb_sync_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id       UUID NOT NULL REFERENCES external_cmdb_configs(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    records_pulled  INTEGER NOT NULL DEFAULT 0,
    records_pushed  INTEGER NOT NULL DEFAULT 0,
    records_created INTEGER NOT NULL DEFAULT 0,
    records_updated INTEGER NOT NULL DEFAULT 0,
    records_failed  INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'running'  -- running|success|failed
);

CREATE INDEX idx_ext_cmdb_sync_config ON external_cmdb_sync_logs(config_id, started_at DESC);

-- ──────────────────────────────────────────────────────────────
-- Seed: Builtin CI Attributes for all CI types
-- ──────────────────────────────────────────────────────────────

-- cloud_instance attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000001', NULL, 'instance_type',  'Instance Type',  'string',  false, true, 10),
    ('20000000-0000-0000-0000-000000000001', NULL, 'cpu_count',      'vCPU Count',     'integer', false, true, 20),
    ('20000000-0000-0000-0000-000000000001', NULL, 'memory_gb',      'Memory (GB)',    'float',   false, true, 30),
    ('20000000-0000-0000-0000-000000000001', NULL, 'os_type',        'OS Type',        'enum',    false, true, 40),
    ('20000000-0000-0000-0000-000000000001', NULL, 'os_version',     'OS Version',     'string',  false, true, 50),
    ('20000000-0000-0000-0000-000000000001', NULL, 'private_ip',     'Private IP',     'ip_address', false, true, 60),
    ('20000000-0000-0000-0000-000000000001', NULL, 'public_ip',      'Public IP',      'ip_address', false, true, 70),
    ('20000000-0000-0000-0000-000000000001', NULL, 'state',          'State',          'enum',    false, true, 80),
    ('20000000-0000-0000-0000-000000000001', NULL, 'vpc_id',         'VPC ID',         'string',  false, true, 90),
    ('20000000-0000-0000-0000-000000000001', NULL, 'subnet_id',      'Subnet ID',      'string',  false, true, 100);

-- cloud_rds attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000002', NULL, 'engine',         'DB Engine',      'enum',    false, true, 10),
    ('20000000-0000-0000-0000-000000000002', NULL, 'engine_version', 'Engine Version', 'string',  false, true, 20),
    ('20000000-0000-0000-0000-000000000002', NULL, 'instance_class', 'Instance Class', 'string',  false, true, 30),
    ('20000000-0000-0000-0000-000000000002', NULL, 'storage_gb',     'Storage (GB)',   'integer', false, true, 40),
    ('20000000-0000-0000-0000-000000000002', NULL, 'multi_az',       'Multi-AZ',       'boolean', false, true, 50),
    ('20000000-0000-0000-0000-000000000002', NULL, 'endpoint',       'Endpoint',       'string',  false, true, 60),
    ('20000000-0000-0000-0000-000000000002', NULL, 'status',         'Status',         'enum',    false, true, 70);

-- cloud_volume attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000003', NULL, 'volume_type',    'Volume Type',    'enum',    false, true, 10),
    ('20000000-0000-0000-0000-000000000003', NULL, 'size_gb',        'Size (GB)',      'integer', false, true, 20),
    ('20000000-0000-0000-0000-000000000003', NULL, 'iops',           'IOPS',           'integer', false, true, 30),
    ('20000000-0000-0000-0000-000000000003', NULL, 'throughput_mbps','Throughput (MB/s)','float', false, true, 40),
    ('20000000-0000-0000-0000-000000000003', NULL, 'state',          'State',          'enum',    false, true, 50),
    ('20000000-0000-0000-0000-000000000003', NULL, 'encrypted',      'Encrypted',      'boolean', false, true, 60),
    ('20000000-0000-0000-0000-000000000003', NULL, 'attached_to',    'Attached To',    'string',  false, true, 70);

-- cloud_snapshot attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000004', NULL, 'source_volume_id','Source Volume', 'string',  false, true, 10),
    ('20000000-0000-0000-0000-000000000004', NULL, 'size_gb',        'Size (GB)',      'integer', false, true, 20),
    ('20000000-0000-0000-0000-000000000004', NULL, 'state',          'State',          'enum',    false, true, 30),
    ('20000000-0000-0000-0000-000000000004', NULL, 'encrypted',      'Encrypted',      'boolean', false, true, 40);

-- cloud_bucket attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000005', NULL, 'object_count',   'Object Count',   'integer', false, true, 10),
    ('20000000-0000-0000-0000-000000000005', NULL, 'total_size_gb',  'Total Size (GB)','float',   false, true, 20),
    ('20000000-0000-0000-0000-000000000005', NULL, 'versioning',     'Versioning',     'boolean', false, true, 30),
    ('20000000-0000-0000-0000-000000000005', NULL, 'public_access',  'Public Access',  'boolean', false, true, 40),
    ('20000000-0000-0000-0000-000000000005', NULL, 'encryption',     'Encryption',     'boolean', false, true, 50);

-- cloud_lb attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000006', NULL, 'lb_type',        'LB Type',        'enum',    false, true, 10),
    ('20000000-0000-0000-0000-000000000006', NULL, 'dns_name',       'DNS Name',       'string',  false, true, 20),
    ('20000000-0000-0000-0000-000000000006', NULL, 'scheme',         'Scheme',         'enum',    false, true, 30),
    ('20000000-0000-0000-0000-000000000006', NULL, 'state',          'State',          'enum',    false, true, 40);

-- cloud_ip (Elastic IP) attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000007', NULL, 'ip_address',     'IP Address',     'ip_address', false, true, 10),
    ('20000000-0000-0000-0000-000000000007', NULL, 'associated',     'Associated',     'boolean', false, true, 20),
    ('20000000-0000-0000-0000-000000000007', NULL, 'association_id', 'Association ID', 'string',  false, true, 30);

-- reserved_instance attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000008', NULL, 'instance_type',  'Instance Type',  'string',  false, true, 10),
    ('20000000-0000-0000-0000-000000000008', NULL, 'term_years',     'Term (Years)',   'integer', false, true, 20),
    ('20000000-0000-0000-0000-000000000008', NULL, 'payment_option', 'Payment Option', 'enum',    false, true, 30),
    ('20000000-0000-0000-0000-000000000008', NULL, 'utilization_pct','Utilization %',  'float',   false, true, 40),
    ('20000000-0000-0000-0000-000000000008', NULL, 'expiry_date',    'Expiry Date',    'datetime',false, true, 50);

-- savings_plan attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000009', NULL, 'plan_type',      'Plan Type',      'enum',    false, true, 10),
    ('20000000-0000-0000-0000-000000000009', NULL, 'commitment_usd', 'Commitment ($/hr)','float', false, true, 20),
    ('20000000-0000-0000-0000-000000000009', NULL, 'term_years',     'Term (Years)',   'integer', false, true, 30),
    ('20000000-0000-0000-0000-000000000009', NULL, 'utilization_pct','Utilization %',  'float',   false, true, 40),
    ('20000000-0000-0000-0000-000000000009', NULL, 'expiry_date',    'Expiry Date',    'datetime',false, true, 50);

-- on_prem_server attributes
INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000010', NULL, 'cpu_count',      'CPU Count',      'integer', false, true, 10),
    ('20000000-0000-0000-0000-000000000010', NULL, 'memory_gb',      'Memory (GB)',    'float',   false, true, 20),
    ('20000000-0000-0000-0000-000000000010', NULL, 'disk_tb',        'Disk (TB)',      'float',   false, true, 30),
    ('20000000-0000-0000-0000-000000000010', NULL, 'rack_location',  'Rack Location',  'string',  false, true, 40),
    ('20000000-0000-0000-0000-000000000010', NULL, 'ip_address',     'IP Address',     'ip_address', false, true, 50),
    ('20000000-0000-0000-0000-000000000010', NULL, 'os_type',        'OS Type',        'enum',    false, true, 60);

-- ── source: 009_finops_extended.sql ──
-- Migration 009: FinOps Extended Schema
-- ============================================================
-- Adds: resources, organization_constraints, webhooks, power_schedules, checklist

-- ──────────────────────────────────────────────────────────────
-- Resources (tracked cloud resources with full metadata)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE resources (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cloud_account_id    UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    cloud_resource_id   VARCHAR(500) NOT NULL,
    resource_type       resource_type NOT NULL DEFAULT 'other',
    service_name        VARCHAR(255),
    name                VARCHAR(512),
    cloud_region        VARCHAR(100),
    tags                JSONB NOT NULL DEFAULT '{}',
    meta                JSONB NOT NULL DEFAULT '{}',
    pool_id             UUID REFERENCES pools(id) ON DELETE SET NULL,
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active              BOOLEAN NOT NULL DEFAULT true,
    total_cost          NUMERIC(18,4) NOT NULL DEFAULT 0,
    last_month_cost     NUMERIC(18,4) NOT NULL DEFAULT 0,
    recommendations     JSONB NOT NULL DEFAULT '[]',  -- cached rec IDs
    dismissed_recs      JSONB NOT NULL DEFAULT '[]',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, cloud_account_id, cloud_resource_id)
);

CREATE INDEX idx_resources_org ON resources(organization_id, active);
CREATE INDEX idx_resources_account ON resources(cloud_account_id);
CREATE INDEX idx_resources_type ON resources(resource_type, active);
CREATE INDEX idx_resources_pool ON resources(pool_id) WHERE pool_id IS NOT NULL;
CREATE INDEX idx_resources_tags ON resources USING GIN(tags);
CREATE INDEX idx_resources_meta ON resources USING GIN(meta);

CREATE TRIGGER trg_resources_updated_at
    BEFORE UPDATE ON resources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Organization Constraints (anomaly detection thresholds)
-- ──────────────────────────────────────────────────────────────
CREATE TYPE constraint_type AS ENUM (
    'expense_anomaly',
    'resource_count',
    'total_expense_limit',
    'resource_tag_coverage'
);

CREATE TABLE organization_constraints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    constraint_type constraint_type NOT NULL,
    filters         JSONB NOT NULL DEFAULT '{}',
    -- For expense_anomaly: {"threshold_factor": 2.0, "lookback_days": 7}
    -- For resource_count: {"max_count": 100, "resource_type": "instance"}
    -- For total_expense_limit: {"monthly_limit": 10000}
    -- For tag_coverage: {"required_tags": ["env", "owner"]}
    limit_value     NUMERIC(18,4),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_org_constraints_org ON organization_constraints(organization_id, constraint_type);

CREATE TRIGGER trg_org_constraints_updated_at
    BEFORE UPDATE ON organization_constraints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Webhooks (outbound notifications)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    url             TEXT NOT NULL,
    secret          TEXT,  -- HMAC signing secret (encrypted at rest)
    events          JSONB NOT NULL DEFAULT '[]',
    -- ["recommendation.created", "budget.exceeded", "anomaly.detected", "resource.discovered"]
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    last_status     INTEGER,  -- HTTP status of last delivery
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_org ON webhooks(organization_id, is_active);

CREATE TRIGGER trg_webhooks_updated_at
    BEFORE UPDATE ON webhooks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE webhook_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id  UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type  VARCHAR(100) NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|delivered|failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_retry  TIMESTAMPTZ,
    response_status INTEGER,
    response_body TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_webhook_events_webhook ON webhook_events(webhook_id, created_at DESC);
CREATE INDEX idx_webhook_events_status ON webhook_events(status, next_retry) WHERE status = 'pending';

-- ──────────────────────────────────────────────────────────────
-- Power Schedules (automated start/stop)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE power_schedules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    resource_filter JSONB NOT NULL DEFAULT '{}',
    -- {"pool_id": "...", "tags": {"env": "dev"}, "resource_type": "instance"}
    timezone        VARCHAR(100) NOT NULL DEFAULT 'UTC',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_power_schedules_org ON power_schedules(organization_id, is_active);

CREATE TRIGGER trg_power_schedules_updated_at
    BEFORE UPDATE ON power_schedules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE power_schedule_triggers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id     UUID NOT NULL REFERENCES power_schedules(id) ON DELETE CASCADE,
    cron_expression VARCHAR(100) NOT NULL,  -- "0 8 * * MON-FRI"
    action          VARCHAR(10) NOT NULL,   -- start|stop
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_power_triggers_schedule ON power_schedule_triggers(schedule_id);
CREATE INDEX idx_power_triggers_next ON power_schedule_triggers(next_run_at) WHERE next_run_at IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- Checklist (recommendation engine state per org)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE checklist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    last_run_at         TIMESTAMPTZ,
    last_completed_at   TIMESTAMPTZ,
    last_error          TEXT,
    run_status          VARCHAR(20) NOT NULL DEFAULT 'idle',  -- idle|running|completed|failed
    modules_config      JSONB NOT NULL DEFAULT '{}',  -- per-module enable/threshold config
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id)
);

CREATE TRIGGER trg_checklist_updated_at
    BEFORE UPDATE ON checklist
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ──────────────────────────────────────────────────────────────
-- Tagging Policies (tag governance)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE tagging_policies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    required_tags   JSONB NOT NULL DEFAULT '[]',  -- [{"key": "env", "allowed_values": ["dev","prod"]}]
    apply_to        JSONB NOT NULL DEFAULT '[]',  -- resource_types this policy applies to
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tagging_policies_org ON tagging_policies(organization_id, is_active);

CREATE TRIGGER trg_tagging_policies_updated_at
    BEFORE UPDATE ON tagging_policies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── source: 010_seed_extended.sql ──
-- Migration 010: Extended Seed Data
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- Demo Services (linked to the demo org a0000000-...-001)
-- ──────────────────────────────────────────────────────────────
INSERT INTO services (id, organization_id, name, display_name, description, service_type) VALUES
    ('50000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000001',
     'web-frontend', 'Web Frontend',
     'Customer-facing React application running on ECS', 'application'),
    ('50000000-0000-0000-0000-000000000002',
     'a0000000-0000-0000-0000-000000000001',
     'api-backend', 'API Backend',
     'CloudAtlas Rust/Axum API service', 'application'),
    ('50000000-0000-0000-0000-000000000003',
     'a0000000-0000-0000-0000-000000000001',
     'data-pipeline', 'Data Pipeline',
     'Cost data ingestion and processing pipeline', 'platform');

-- ──────────────────────────────────────────────────────────────
-- Cost Centers
-- ──────────────────────────────────────────────────────────────
INSERT INTO cost_centers (id, organization_id, code, name, description) VALUES
    ('60000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000001',
     'ENG', 'Engineering', 'Engineering and product development costs'),
    ('60000000-0000-0000-0000-000000000002',
     'a0000000-0000-0000-0000-000000000001',
     'INFRA', 'Infrastructure', 'Shared infrastructure and platform costs');

-- ──────────────────────────────────────────────────────────────
-- Business Capabilities
-- ──────────────────────────────────────────────────────────────
INSERT INTO business_capabilities (id, organization_id, name, description, cost_center_id) VALUES
    ('61000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000001',
     'Customer Experience', 'Frontend and UX capabilities',
     '60000000-0000-0000-0000-000000000001'),
    ('61000000-0000-0000-0000-000000000002',
     'a0000000-0000-0000-0000-000000000001',
     'Core Platform', 'API and backend platform capabilities',
     '60000000-0000-0000-0000-000000000002');

-- ──────────────────────────────────────────────────────────────
-- Organization Constraints (demo anomaly thresholds)
-- ──────────────────────────────────────────────────────────────
INSERT INTO organization_constraints (organization_id, name, constraint_type, filters, limit_value) VALUES
    ('a0000000-0000-0000-0000-000000000001',
     'Daily Spend Anomaly', 'expense_anomaly',
     '{"threshold_factor": 2.5, "lookback_days": 7}', 2.5),
    ('a0000000-0000-0000-0000-000000000001',
     'Monthly Total Limit', 'total_expense_limit',
     '{}', 50000),
    ('a0000000-0000-0000-0000-000000000001',
     'Instance Count Limit', 'resource_count',
     '{"resource_type": "instance"}', 100),
    ('a0000000-0000-0000-0000-000000000001',
     'Required Tag Coverage', 'resource_tag_coverage',
     '{"required_tags": ["env", "team", "project"]}', NULL);

-- ──────────────────────────────────────────────────────────────
-- Demo Compliance Policies
-- ──────────────────────────────────────────────────────────────
INSERT INTO compliance_policies (organization_id, name, description, ci_type_id, rules, severity) VALUES
    ('a0000000-0000-0000-0000-000000000001',
     'Instance Must Have Env Tag', 'All instances must be tagged with "env"',
     '20000000-0000-0000-0000-000000000001',
     '[{"field": "tags.env", "op": "exists"}]',
     'medium'),
    ('a0000000-0000-0000-0000-000000000001',
     'Instance Must Have Team Tag', 'All instances must be tagged with "team"',
     '20000000-0000-0000-0000-000000000001',
     '[{"field": "tags.team", "op": "exists"}]',
     'medium'),
    ('a0000000-0000-0000-0000-000000000001',
     'Unencrypted Volumes Prohibited', 'All block volumes must be encrypted',
     '20000000-0000-0000-0000-000000000003',
     '[{"field": "meta.encrypted", "op": "eq", "value": "true"}]',
     'high');

-- ──────────────────────────────────────────────────────────────
-- Initialize checklist for demo org
-- ──────────────────────────────────────────────────────────────
INSERT INTO checklist (organization_id, modules_config) VALUES
    ('a0000000-0000-0000-0000-000000000001',
     '{
       "idle": {"enabled": true, "days_threshold": 7},
       "rightsizing": {"enabled": true},
       "storage": {"enabled": true, "snapshot_age_days": 3},
       "commitment": {"enabled": true, "min_usage_days": 90},
       "security": {"enabled": true}
     }');

-- ──────────────────────────────────────────────────────────────
-- Demo Tagging Policy
-- ──────────────────────────────────────────────────────────────
INSERT INTO tagging_policies (organization_id, name, description, required_tags, apply_to) VALUES
    ('a0000000-0000-0000-0000-000000000001',
     'Mandatory Tags Policy',
     'All compute resources must have env, team, and project tags',
     '[
       {"key": "env", "allowed_values": ["dev", "staging", "prod"]},
       {"key": "team"},
       {"key": "project"}
     ]',
     '["instance", "rds_instance", "volume"]');

-- ──────────────────────────────────────────────────────────────
-- Link demo CIs to demo service
-- ──────────────────────────────────────────────────────────────
INSERT INTO service_cis (service_id, ci_id, role)
SELECT '50000000-0000-0000-0000-000000000002', id, 'primary'
FROM cis
WHERE organization_id = 'a0000000-0000-0000-0000-000000000001'
  AND deleted_at IS NULL
LIMIT 3;

-- ── source: 011_rec_types_extended.sql ──
-- Migration 011: Extended Recommendation Types
-- ============================================================
-- Adds new recommendation_type enum values used by the extended engine modules.

DO $$
BEGIN
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'abandoned_s3_bucket';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'instance_for_shutdown';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'savings_plan_opportunity';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END$$;

-- ── source: 012_recommendations_dedupe_and_checklist.sql ──
-- Migration 012: Recommendation dedupe + checklist read path safety
-- ============================================================

-- Remove duplicate active recommendations before enforcing uniqueness.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY
                organization_id,
                rec_type,
                COALESCE(cloud_resource_id, ''),
                COALESCE(cloud_account_id::text, ''),
                COALESCE(ci_id::text, '')
            ORDER BY created_at DESC, id DESC
        ) AS rn
    FROM recommendations
    WHERE status = 'active'
)
UPDATE recommendations r
SET
    status = 'obsolete'::recommendation_status,
    updated_at = NOW(),
    description = COALESCE(r.description, '') || CASE
        WHEN COALESCE(r.description, '') = '' THEN 'Auto-obsoleted by migration 012 dedupe policy'
        ELSE ' | Auto-obsoleted by migration 012 dedupe policy'
    END
FROM ranked x
WHERE r.id = x.id
  AND x.rn > 1;

-- Keep only one active recommendation per org/type/resource scope.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_recommendations_active_scope
ON recommendations (
    organization_id,
    rec_type,
    COALESCE(cloud_resource_id, ''),
    COALESCE(cloud_account_id::text, ''),
    COALESCE(ci_id::text, '')
)
WHERE status = 'active';

-- ── source: 013_shared_envs_lifecycle_k8s.sql ──
-- Migration 013: Shared Environments, Resource Lifecycle, K8s Rightsizing
-- Adds three new feature domains to CloudAtlas

-- ─── Shared Environments ───────────────────────────────────────────────────

CREATE TABLE shared_environments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    resource_id         UUID REFERENCES resources(id) ON DELETE SET NULL,
    cloud_account_id    UUID REFERENCES cloud_accounts(id) ON DELETE SET NULL,
    auto_release_hours  INTEGER NOT NULL DEFAULT 8,
    status              VARCHAR(32) NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available', 'booked', 'maintenance', 'archived')),
    meta                JSONB NOT NULL DEFAULT '{}',
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shared_envs_org ON shared_environments(organization_id);
CREATE INDEX idx_shared_envs_status ON shared_environments(organization_id, status);

CREATE TABLE environment_bookings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id      UUID NOT NULL REFERENCES shared_environments(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    booked_by           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    status              VARCHAR(32) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'released', 'expired', 'cancelled')),
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_env_bookings_env ON environment_bookings(environment_id, status);
CREATE INDEX idx_env_bookings_org ON environment_bookings(organization_id);
CREATE INDEX idx_env_bookings_user ON environment_bookings(booked_by, status);

-- ─── Resource Lifecycle Policies ──────────────────────────────────────────

CREATE TABLE resource_lifecycle_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                VARCHAR(255) NOT NULL,
    description         TEXT,
    policy_type         VARCHAR(64) NOT NULL DEFAULT 'ttl'
                            CHECK (policy_type IN ('ttl', 'idle_shutdown', 'tag_based', 'schedule_based')),
    -- TTL: days since last_seen before auto-decommission
    ttl_days            INTEGER,
    -- idle_shutdown: days with zero cost before flagging
    idle_days           INTEGER,
    -- Resource filter (applies to matching resource types/tags)
    resource_filter     JSONB NOT NULL DEFAULT '{}',
    action              VARCHAR(32) NOT NULL DEFAULT 'flag'
                            CHECK (action IN ('flag', 'notify', 'decommission', 'stop')),
    is_active           BOOLEAN NOT NULL DEFAULT true,
    last_evaluated_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lifecycle_policies_org ON resource_lifecycle_policies(organization_id);

CREATE TABLE resource_lifecycle_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    policy_id           UUID REFERENCES resource_lifecycle_policies(id) ON DELETE SET NULL,
    resource_id         UUID REFERENCES resources(id) ON DELETE CASCADE,
    cloud_resource_id   VARCHAR(512),
    resource_type       VARCHAR(128),
    event_type          VARCHAR(64) NOT NULL
                            CHECK (event_type IN ('flagged', 'notified', 'decommissioned', 'stopped', 'exempted', 'restored')),
    reason              TEXT,
    meta                JSONB NOT NULL DEFAULT '{}',
    actor_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lifecycle_events_org ON resource_lifecycle_events(organization_id, created_at DESC);
CREATE INDEX idx_lifecycle_events_resource ON resource_lifecycle_events(resource_id);

-- ─── K8s Rightsizing ──────────────────────────────────────────────────────

CREATE TABLE k8s_clusters (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cloud_account_id    UUID REFERENCES cloud_accounts(id) ON DELETE SET NULL,
    name                VARCHAR(255) NOT NULL,
    region              VARCHAR(128),
    provider            VARCHAR(64),         -- 'aws', 'azure', 'gcp', 'on-prem'
    node_count          INTEGER,
    total_vcpu          NUMERIC(10,2),
    total_memory_gb     NUMERIC(10,2),
    monthly_cost        NUMERIC(14,2),
    meta                JSONB NOT NULL DEFAULT '{}',
    last_synced_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_k8s_clusters_org ON k8s_clusters(organization_id);
ALTER TABLE k8s_clusters ADD CONSTRAINT uq_k8s_cluster_org_name UNIQUE (organization_id, name);

CREATE TABLE k8s_workload_metrics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cluster_id          UUID NOT NULL REFERENCES k8s_clusters(id) ON DELETE CASCADE,
    namespace           VARCHAR(255) NOT NULL,
    workload_name       VARCHAR(255) NOT NULL,
    workload_type       VARCHAR(64) NOT NULL DEFAULT 'Deployment'
                            CHECK (workload_type IN ('Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob')),
    container_name      VARCHAR(255),
    -- Requested resources
    cpu_request_m       INTEGER,             -- millicores
    mem_request_mi      INTEGER,             -- MiB
    -- Limit resources
    cpu_limit_m         INTEGER,
    mem_limit_mi        INTEGER,
    -- Observed usage (P95 over observation window)
    cpu_p95_m           NUMERIC(10,2),
    mem_p95_mi          NUMERIC(10,2),
    -- Recommended resources
    cpu_rec_m           INTEGER,
    mem_rec_mi          INTEGER,
    -- Cost data
    monthly_cost        NUMERIC(14,2),
    potential_savings   NUMERIC(14,2),
    -- Evaluation window
    observation_days    INTEGER NOT NULL DEFAULT 14,
    evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_k8s_workloads_org ON k8s_workload_metrics(organization_id);
CREATE INDEX idx_k8s_workloads_cluster ON k8s_workload_metrics(cluster_id, namespace);
CREATE INDEX idx_k8s_workloads_savings ON k8s_workload_metrics(organization_id, potential_savings DESC NULLS LAST);
CREATE UNIQUE INDEX uq_k8s_workload ON k8s_workload_metrics(organization_id, cluster_id, namespace, workload_name, COALESCE(container_name, ''));

-- ── source: 014_cmdb_model_service_templates.sql ──
-- Migration 014: CMDB Model Extensions — Service Templates, Field Templates, CI Apply Rules
-- ============================================================
-- Adds:
--   service_templates + service_template_items (standard CI compositions)
--   field_templates (reusable attribute group definitions)
--   ci_apply_rules (auto-fill CI attributes from match rules)
-- All tables follow the one-binary / one-database / tenant-isolated constraints.

-- ──────────────────────────────────────────────────────────────
-- Service Templates
-- A template defines the expected CI type composition of a service.
-- Allows operators to quickly provision standard service shapes.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE service_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    display_name    VARCHAR(255),
    description     TEXT,
    service_type    VARCHAR(50) NOT NULL DEFAULT 'application'
                        CHECK (service_type IN ('application','platform','infrastructure','middleware')),
    tags            JSONB NOT NULL DEFAULT '{}',
    meta            JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_svc_tmpl_org ON service_templates(organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_svc_tmpl_updated_at
    BEFORE UPDATE ON service_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Each item in a service template defines a required CI type
CREATE TABLE service_template_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     UUID NOT NULL REFERENCES service_templates(id) ON DELETE CASCADE,
    ci_type_id      UUID NOT NULL REFERENCES ci_types(id),
    role            VARCHAR(100),        -- 'primary', 'dependency', 'sidecar', 'storage'
    is_required     BOOLEAN NOT NULL DEFAULT true,
    min_count       INTEGER NOT NULL DEFAULT 1,
    max_count       INTEGER,
    default_meta    JSONB NOT NULL DEFAULT '{}',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(template_id, ci_type_id, role)
);

CREATE INDEX idx_svc_tmpl_items_tmpl ON service_template_items(template_id);
CREATE INDEX idx_svc_tmpl_items_type ON service_template_items(ci_type_id);

-- ──────────────────────────────────────────────────────────────
-- Field Templates
-- Reusable named sets of attribute definitions that can be
-- referenced from CI types (字段组合模板).
-- ──────────────────────────────────────────────────────────────

CREATE TABLE field_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    display_name    VARCHAR(255),
    description     TEXT,
    -- JSON array of attribute-definition objects, same shape as ci_attributes rows
    attributes      JSONB NOT NULL DEFAULT '[]',
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE(organization_id, name)
);

CREATE INDEX idx_field_tmpl_org ON field_templates(organization_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_field_tmpl_updated_at
    BEFORE UPDATE ON field_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Track which CI types have adopted which field templates
CREATE TABLE ci_type_field_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    template_id     UUID NOT NULL REFERENCES field_templates(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(ci_type_id, template_id)
);

CREATE INDEX idx_ci_type_ft ON ci_type_field_templates(ci_type_id);

-- ──────────────────────────────────────────────────────────────
-- CI Apply Rules
-- Rules that automatically set attribute values on CIs that
-- match specified conditions, within a given CI type scope.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE ci_apply_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    -- Condition array: [{field, operator, value}] — same format as dynamic_groups
    conditions      JSONB NOT NULL DEFAULT '[]',
    -- Key-value pairs of attribute names → values to apply
    attributes      JSONB NOT NULL DEFAULT '{}',
    -- Higher priority rules are applied last (overwrite lower priority)
    priority        INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_ci_apply_rules_org ON ci_apply_rules(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_ci_apply_rules_type ON ci_apply_rules(ci_type_id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_ci_apply_rules_updated_at
    BEFORE UPDATE ON ci_apply_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Track applications: which CIs were mutated by which rule
CREATE TABLE ci_apply_rule_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id     UUID NOT NULL REFERENCES ci_apply_rules(id) ON DELETE CASCADE,
    ci_id       UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rule_id, ci_id)
);

CREATE INDEX idx_ci_apply_results_rule ON ci_apply_rule_results(rule_id);
CREATE INDEX idx_ci_apply_results_ci ON ci_apply_rule_results(ci_id);

-- ── source: 015_compliance_schema_fix.sql ──
-- Migration 015: Fix compliance_policies schema gaps
-- The compliance_policies table was missing deleted_at (needed for soft-delete)
-- and the handler referenced ::compliance_severity which is just a VARCHAR column.

ALTER TABLE compliance_policies
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_compliance_policies_deleted
    ON compliance_policies(organization_id, deleted_at)
    WHERE deleted_at IS NULL;

-- ── source: 016_perf_indexes.sql ──
-- 016_perf_indexes.sql
-- Adds composite indexes for the Cost Explorer / compliance hot paths.
-- The existing single-column indexes (idx_expenses_service, idx_expenses_region)
-- cannot be used efficiently for org-scoped GROUP BY queries; these composites
-- let PostgreSQL filter by organization_id and group by dimension in one pass.

CREATE INDEX idx_expenses_org_service ON expenses(organization_id, service_name);
CREATE INDEX idx_expenses_org_region  ON expenses(organization_id, cloud_region);

-- Compliance evaluation joins ci_compliance → policy_id for result listing.
CREATE INDEX idx_ci_compliance_policy ON ci_compliance(policy_id);

-- ── source: 017_webhook_channels.sql ──
-- 017_webhook_channels.sql
-- Adds a delivery channel to webhooks. Channels:
--   generic    → raw JSON POST (default, backwards compatible)
--   slack      → Slack-compatible payload ({text: ...})
--   teams      → Microsoft Teams connector card ({text: ...})
--   pagerduty  → PagerDuty Events API v2 payload
--   email      → SMTP delivery; `url` holds the recipient address

ALTER TABLE webhooks ADD COLUMN channel VARCHAR(20) NOT NULL DEFAULT 'generic';

-- ── source: 018_bi_export_integrations.sql ──
-- 018_bi_export_integrations.sql
-- Adds BI export definitions + run history, and third-party integration
-- connections. Also extends the cloud provider enum with kubernetes.

ALTER TYPE cloud_provider ADD VALUE IF NOT EXISTS 'kubernetes';

-- ─── BI Exports ──────────────────────────────────────────────────────────────
CREATE TABLE bi_exports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    format          VARCHAR(10) NOT NULL DEFAULT 'csv',    -- csv | json
    scope           VARCHAR(30) NOT NULL DEFAULT 'expenses', -- expenses | recommendations | resources
    filters         JSONB NOT NULL DEFAULT '{}',           -- {"start_date": "...", "end_date": "..."}
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, name)
);

CREATE TABLE bi_export_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    export_id       UUID NOT NULL REFERENCES bi_exports(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'completed', -- completed | failed
    row_count       BIGINT NOT NULL DEFAULT 0,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bi_export_runs_export ON bi_export_runs(export_id, created_at DESC);

-- ─── Integrations ────────────────────────────────────────────────────────────
CREATE TABLE integrations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider        VARCHAR(30) NOT NULL, -- slack | teams | pagerduty | jira | github | generic_webhook
    name            VARCHAR(255) NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    status          VARCHAR(20) NOT NULL DEFAULT 'unknown', -- unknown | connected | error
    last_checked_at TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, provider, name)
);

CREATE INDEX idx_integrations_org ON integrations(organization_id, is_active);

-- ── source: 019_ai_features.sql ──
-- 019_ai_features.sql
-- AI feature support: per-org feature toggles and a notes corpus for the RAG
-- pipeline (embeddings stored as JSONB arrays — pgvector remains an upgrade
-- path for larger corpora).

CREATE TABLE ai_settings (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_enabled   BOOLEAN NOT NULL DEFAULT true,
    smart_recs_enabled  BOOLEAN NOT NULL DEFAULT true,
    forecast_enabled    BOOLEAN NOT NULL DEFAULT true,
    anomaly_enabled     BOOLEAN NOT NULL DEFAULT true,
    rag_enabled         BOOLEAN NOT NULL DEFAULT true,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ai_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title           VARCHAR(255) NOT NULL,
    body            TEXT NOT NULL,
    embedding       JSONB NOT NULL DEFAULT '[]',  -- float array (dim 1536 for text-embedding-3-small)
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_notes_org ON ai_notes(organization_id);

-- ── source: 020_rec_types_phase1.sql ──
-- 020_rec_types_phase1.sql
-- Adds the recommendation_type enum values needed by Phase 1 detectors
-- (spec §6.2). Guarded like 011 so re-runs are safe.

DO $$
BEGIN
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'abandoned_image';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'abandoned_kinesis_stream';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'instance_in_stopped_state';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'obsolete_snapshot_chain';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'snapshot_with_non_used_image';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 's3_public_bucket';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'inactive_user';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'inactive_console_user';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'instance_subscription';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE recommendation_type ADD VALUE IF NOT EXISTS 'short_living_instance';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END$$;

-- ── source: 021_ai_conversations.sql ──
-- 021_ai_conversations.sql
-- AI depth (roadmap Phase 3 / G3 + G4 + G9):
-- persistent copilot conversations, message history, analysis run history,
-- and LLM anomaly explanations.

CREATE TABLE ai_conversation (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(256),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_conversation_org ON ai_conversation(organization_id, updated_at DESC);

CREATE TABLE ai_message (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES ai_conversation(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL,   -- user | assistant | system | tool
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_message_conv ON ai_message(conversation_id, created_at);

-- Forecast / anomaly run history (G9).
CREATE TABLE ai_analysis_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind            VARCHAR(20) NOT NULL,   -- forecast | anomaly
    params          JSONB NOT NULL DEFAULT '{}',
    result          JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_analysis_org ON ai_analysis_runs(organization_id, created_at DESC);

-- Cached LLM root-cause explanation for an alert event (G4).
ALTER TABLE alert_events ADD COLUMN ai_explanation TEXT;

-- ── source: 022_rag_notifications.sql ──
-- 022_rag_notifications.sql
-- RAG over resources (G5) + in-app notification inbox (G11).

-- Resource embeddings for semantic search (embedding stored as JSONB float
-- array; cosine computed in-app — pgvector remains an upgrade path).
CREATE TABLE resource_embeddings (
    resource_id     UUID PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    embedding       JSONB NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resource_embeddings_org ON resource_embeddings(organization_id);

-- In-app notification inbox (G11): org-wide or per-user notifications.
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = org-wide
    kind            VARCHAR(30) NOT NULL,   -- budget_alert | anomaly | recommendation | webhook | system
    title           VARCHAR(255) NOT NULL,
    body            TEXT NOT NULL,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_org ON notifications(organization_id, read_at, created_at DESC);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at) WHERE user_id IS NOT NULL;

-- ── source: 023_platform_features.sql ──
-- 023_platform_features.sql
-- Product gap closure: password resets (I3), invites (C1), rec apply/verify (C2),
-- metrics ingestion (D1), expense archive (D3), per-account sync intervals (D5).

-- ── I3: password resets ───────────────────────────────────────────────────────
CREATE TABLE password_resets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        VARCHAR(20) NOT NULL DEFAULT 'password', -- password | email_verify
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, kind, used_at);

-- ── C1: invites ───────────────────────────────────────────────────────────────
CREATE TABLE invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           VARCHAR(254) NOT NULL,
    role_name       VARCHAR(50) NOT NULL DEFAULT 'Member',
    token_hash      TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | accepted | declined | expired
    expires_at      TIMESTAMPTZ NOT NULL,
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(organization_id, email)
);

-- ── C2: recommendation apply/verify ──────────────────────────────────────────
-- (applied_at already exists from migration 005)
ALTER TABLE recommendations ADD COLUMN applied_by UUID REFERENCES users(id);
ALTER TABLE recommendations ADD COLUMN verified_at TIMESTAMPTZ;
ALTER TABLE recommendations ADD COLUMN verified_by UUID REFERENCES users(id);
ALTER TABLE recommendations ADD COLUMN actual_savings NUMERIC(14,2);

-- ── D1: resource metrics ──────────────────────────────────────────────────────
CREATE TABLE metrics (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    metric_name VARCHAR(50) NOT NULL,   -- cpu_utilization | network_in | network_out
    value       DOUBLE PRECISION NOT NULL,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_metrics_resource ON metrics(resource_id, metric_name, ts DESC);
CREATE INDEX idx_metrics_org ON metrics(organization_id, metric_name, ts DESC);

-- ── D3: expense archive ───────────────────────────────────────────────────────
CREATE TABLE expense_archive (
    id              UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    cloud_account_id UUID NOT NULL,
    cloud_resource_id VARCHAR(500) NOT NULL,
    resource_name   VARCHAR(512),
    service_name    VARCHAR(255),
    date            DATE NOT NULL,
    cloud_region    VARCHAR(100),
    resource_type   VARCHAR(50),
    cost            NUMERIC(14,6) NOT NULL,
    currency        VARCHAR(10),
    tags            JSONB DEFAULT '{}',
    archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_expense_archive_org ON expense_archive(organization_id, date);

-- ── I5: TOTP two-factor ────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN totp_secret TEXT;

-- ── D5: per-account sync intervals ────────────────────────────────────────────
ALTER TABLE cloud_accounts ADD COLUMN sync_interval_hours INT NOT NULL DEFAULT 1;

-- ── P4: multi-instance scheduler locks ────────────────────────────────────────
CREATE TABLE scheduler_job_locks (
    job_key     TEXT PRIMARY KEY,
    locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── source: 024_currency_fx.sql ──
-- 024: Multi-provider currency (FX) handling
-- Per-account native currency + editable org exchange rates. Conversion to the
-- org display currency happens at ingest; native values stay in raw_expenses.

ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';

-- Alibaba accounts bill in CNY by default (China-region).
UPDATE cloud_accounts SET currency = 'CNY' WHERE provider = 'alibaba';

CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_currency CHAR(3) NOT NULL,
  to_currency CHAR(3) NOT NULL,
  rate NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, from_currency, to_currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_org ON exchange_rates(organization_id);

-- Seed both directions for every existing org (admin-editable afterwards).
INSERT INTO exchange_rates (organization_id, from_currency, to_currency, rate)
SELECT o.id, f.fc, f.tc, f.r
FROM organizations o
CROSS JOIN (VALUES
  ('USD', 'CNY', 7.25), ('CNY', 'USD', 0.1379),
  ('USD', 'EUR', 0.92), ('EUR', 'USD', 1.0870),
  ('USD', 'GBP', 0.79), ('GBP', 'USD', 1.2658),
  ('USD', 'JPY', 155.0), ('JPY', 'USD', 0.00645),
  ('USD', 'AUD', 1.52), ('AUD', 'USD', 0.6579),
  ('USD', 'CAD', 1.37), ('CAD', 'USD', 0.7299)
) AS f(fc, tc, r)
ON CONFLICT (organization_id, from_currency, to_currency) DO NOTHING;

-- ── source: 025_ai_provider_config.sql ──
-- 025: org-level AI provider config (spec 2026-08-14-ai-provider-config-ui-design.md §4.1)
-- NULL = not set here → fall through to env defaults at resolve time.
ALTER TABLE ai_settings
    ADD COLUMN ai_provider_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN ai_base_url     TEXT,
    ADD COLUMN ai_api_key_enc  TEXT,
    ADD COLUMN ai_chat_model   TEXT,
    ADD COLUMN ai_embed_model  TEXT;

-- ── source: 026_bugfix_lifecycle_enum_resources_unique_type_softdelete.sql ──
-- 026_bugfix_lifecycle_enum_resources_unique_type_softdelete.sql
-- Fixes found by the 2026-08-15 guided e2e:
--  D-8: lifecycle transitions from the UI always 500 — frontend sends
--       'stopped'/'terminated' which were not part of ci_lifecycle_state.
--  D-3: sync/discovery could not upsert into `resources` (no unique constraint
--       matching the ON CONFLICT specification).
--  D-11: deleting a CI type failed with FK violation from soft-deleted CIs —
--       ci_types now soft-deletes like every other entity.

-- D-8: extend lifecycle enum with the UI states (PostgreSQL 12+ allows
-- ALTER TYPE ADD VALUE inside a transaction; the new values may only be
-- *used* after commit, which is fine — the API starts after migrations).
ALTER TYPE ci_lifecycle_state ADD VALUE IF NOT EXISTS 'stopped';
ALTER TYPE ci_lifecycle_state ADD VALUE IF NOT EXISTS 'terminated';

-- D-3: resources upsert key (org, account, cloud_resource_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_unique
    ON resources (organization_id, cloud_account_id, cloud_resource_id);

-- D-11: soft-delete column for ci_types (convention: deleted_at NULL = active).
ALTER TABLE ci_types ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Allow re-creating a type with the same name after it was soft-deleted:
-- replace the (organization_id, name) unique constraint with a partial index.
ALTER TABLE ci_types DROP CONSTRAINT IF EXISTS ci_types_organization_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_types_org_name
    ON ci_types (organization_id, name) WHERE deleted_at IS NULL;

-- ── source: 027_cloud_provider_enum_extend.sql ──
-- Extend cloud_provider so the UI "Other" option (mock-backed demo accounts)
-- and the backend's kubernetes provider are creatable. ADD VALUE is
-- supported inside a transaction on PostgreSQL 12+.
ALTER TYPE cloud_provider ADD VALUE IF NOT EXISTS 'other';
ALTER TYPE cloud_provider ADD VALUE IF NOT EXISTS 'kubernetes';

-- ── source: 028_k8s_usage_samples.sql ──
-- Rolling usage samples for k8s workload rightsizing (P95 window).
CREATE TABLE k8s_usage_samples (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    cluster_id      UUID NOT NULL REFERENCES k8s_clusters(id) ON DELETE CASCADE,
    namespace       VARCHAR(255) NOT NULL,
    workload_name   VARCHAR(255) NOT NULL,
    workload_type   VARCHAR(64)  NOT NULL,
    cpu_usage_m     NUMERIC(10,2) NOT NULL,
    mem_usage_mi    NUMERIC(10,2) NOT NULL,
    sample_time     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_k8s_samples_workload
    ON k8s_usage_samples(cluster_id, namespace, workload_name, sample_time);

-- Migration 013 created k8s_workload_metrics without updated_at; the pipeline
-- upsert touches it on every sync.
ALTER TABLE k8s_workload_metrics
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── source: 029_k8s_cluster_resource_type.sql ──
-- Alibaba ACK (Container Service) clusters are discovered as a new
-- resource_type so the Resources list can distinguish clusters from pods.
ALTER TYPE resource_type ADD VALUE IF NOT EXISTS 'k8s_cluster';

-- ── source: 030_async_jobs.sql ──
-- Migration 030: Generalize sync_jobs into an async job table for
-- discovery + billing import (spec 2026-09-09-async-jobs-design §4.1).
--
-- Additive only: existing rows default to job_kind='discovery', which is
-- what they are; phase/progress stay NULL for historical rows (the UI treats
-- NULL as "no detail").

ALTER TABLE sync_jobs
    ADD COLUMN job_kind         VARCHAR(30)  NOT NULL DEFAULT 'discovery',
    ADD COLUMN phase            VARCHAR(40),
    ADD COLUMN progress_current INTEGER,
    ADD COLUMN progress_total   INTEGER,
    ADD COLUMN params           JSONB        NOT NULL DEFAULT '{}',
    ADD COLUMN result           JSONB        NOT NULL DEFAULT '{}',
    ADD COLUMN updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW();

-- One active job of a kind per account (exclusion is also enforced in code
-- with a friendly 409; the index backs that lookup).
CREATE INDEX idx_sync_jobs_active_kind
    ON sync_jobs(cloud_account_id, job_kind)
    WHERE status IN ('pending', 'running');

-- comments kept accurate for the two widened vocabularies
COMMENT ON COLUMN sync_jobs.job_kind IS 'discovery | billing_import';
COMMENT ON COLUMN notifications.kind IS 'budget_alert | anomaly | recommendation | webhook | sync | system';

-- ── source: 031_cmdb_unique_constraints_model_audit.sql ──
-- Migration 031: CMDB unique constraints + model-level audit support
-- (gap closure T2 + T4)
--
-- T2: ci_unique_constraints — composite uniqueness rules per CI type
--     (single-field uniqueness already has ci_attributes.is_unique).
-- T4: ci_audit_logs gains a resource_type dimension so model-layer writes
--     (ci_type / ci_attribute / classification / association / service /
--     service_template / field_template) are audited alongside CI writes.

-- ──────────────────────────────────────────────────────────────
-- T2: unique constraints
-- ──────────────────────────────────────────────────────────────
CREATE TABLE ci_unique_constraints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ci_type_id      UUID NOT NULL REFERENCES ci_types(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    attr_names      TEXT[] NOT NULL,          -- composite key, e.g. {hostname} or {name, region}
    created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    updated_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    deleted_at      BIGINT NOT NULL DEFAULT 0,
    UNIQUE (organization_id, ci_type_id, name, deleted_at)
);

CREATE INDEX idx_ci_unique_constraints_type
    ON ci_unique_constraints(ci_type_id) WHERE deleted_at = 0;
CREATE INDEX idx_ci_unique_constraints_org
    ON ci_unique_constraints(organization_id) WHERE deleted_at = 0;

-- ──────────────────────────────────────────────────────────────
-- T4: model-layer audit support on ci_audit_logs
-- ──────────────────────────────────────────────────────────────
-- ci_id must become nullable: model-layer rows (resource_type <> 'ci') are not
-- attached to any single CI.
ALTER TABLE ci_audit_logs ALTER COLUMN ci_id DROP NOT NULL;

ALTER TABLE ci_audit_logs ADD COLUMN resource_type VARCHAR(50) NOT NULL DEFAULT 'ci';
ALTER TABLE ci_audit_logs ADD COLUMN resource_id   VARCHAR(255);
ALTER TABLE ci_audit_logs ADD COLUMN resource_name VARCHAR(512);

CREATE INDEX idx_ci_audit_resource
    ON ci_audit_logs(organization_id, resource_type, created_at DESC);

-- ── source: 032_cmdb_ci_events.sql ──
-- Migration 032: CMDB CI change event stream (gap closure T6)
--
-- Lightweight polling resource watch: every CI write
-- path appends an event row; clients page with `?after=<id>` cursor.

CREATE TABLE ci_events (
    id              BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_type      VARCHAR(50) NOT NULL,   -- ci.created | ci.updated | ci.deleted | ci.lifecycle_changed | ci.association_changed
    ci_id           UUID NOT NULL REFERENCES cis(id) ON DELETE CASCADE,
    ci_name         VARCHAR(512),
    payload         JSONB NOT NULL DEFAULT '{}',
    created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX idx_ci_events_org_cursor
    ON ci_events(organization_id, id DESC);
CREATE INDEX idx_ci_events_ci
    ON ci_events(ci_id, id DESC);

-- ── source: 033_cmdb_fulltext_trgm.sql ──
-- Migration 033: CMDB full-text search index (gap closure T8)
--
-- pg_trgm was installed in migration 001 but never indexed. This expression
-- GIN index covers the name + display_name + cloud_resource_id search surface;
-- meta/tags matching stays a JSONB ::text ILIKE fallback (not trigram-indexed).

CREATE INDEX idx_cis_trgm
    ON cis USING gin (
        (lower(
            name || ' ' ||
            COALESCE(display_name, '') || ' ' ||
            COALESCE(cloud_resource_id, '')
        )) gin_trgm_ops
    )
    WHERE deleted_at IS NULL;

-- ── source: 034_cmdb_stats_daily.sql ──
-- Migration 034: CMDB daily stats snapshots (gap closure T14)

CREATE TABLE cmdb_stats_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    snapshot_date   DATE NOT NULL,
    total_cis       INTEGER NOT NULL DEFAULT 0,
    by_type         JSONB NOT NULL DEFAULT '{}',
    by_lifecycle    JSONB NOT NULL DEFAULT '{}',
    change_count    INTEGER NOT NULL DEFAULT 0,
    created_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    UNIQUE (organization_id, snapshot_date)
);

CREATE INDEX idx_cmdb_stats_daily_org
    ON cmdb_stats_daily(organization_id, snapshot_date DESC);

-- ── source: 035_cmdb_k8s_modeling.sql ──
-- Migration 035: K8s objects as CMDB CIs (gap closure T15)
--
-- Builtin CI types for the container hierarchy plus the object associations
-- wiring contains / run_on between them. The k8s pipeline upserts CIs into
-- these types during each cluster sync.

INSERT INTO ci_classifications (id, name, display_name, description, icon, sort_order, is_builtin, organization_id) VALUES
    ('10000000-0000-0000-0000-000000000007', 'container', 'Container', 'Kubernetes clusters and workloads', 'box', 70, true, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ci_types (id, name, display_name, description, classification_id, cloud_provider, is_builtin, organization_id) VALUES
    ('20000000-0000-0000-0000-000000000011', 'k8s_cluster',   'K8s Cluster',   'Kubernetes cluster',                 '10000000-0000-0000-0000-000000000007', NULL,      true, NULL),
    ('20000000-0000-0000-0000-000000000012', 'k8s_namespace', 'K8s Namespace', 'Kubernetes namespace',               '10000000-0000-0000-0000-000000000007', NULL,      true, NULL),
    ('20000000-0000-0000-0000-000000000013', 'k8s_node',      'K8s Node',      'Kubernetes worker node',             '10000000-0000-0000-0000-000000000007', NULL,      true, NULL),
    ('20000000-0000-0000-0000-000000000014', 'k8s_workload',  'K8s Workload',  'Deployment/StatefulSet/DaemonSet/Job', '10000000-0000-0000-0000-000000000007', NULL, true, NULL),
    ('20000000-0000-0000-0000-000000000015', 'k8s_pod',       'K8s Pod',       'Pod scheduled on a node',            '10000000-0000-0000-0000-000000000007', NULL,      true, NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ci_attributes (ci_type_id, organization_id, name, display_name, attribute_type, is_required, is_builtin, sort_order) VALUES
    ('20000000-0000-0000-0000-000000000011', NULL, 'region',         'Region',         'string', false, true, 10),
    ('20000000-0000-0000-0000-000000000011', NULL, 'provider',       'Provider',       'string', false, true, 20),
    ('20000000-0000-0000-0000-000000000011', NULL, 'node_count',     'Node Count',     'integer', false, true, 30),
    ('20000000-0000-0000-0000-000000000011', NULL, 'total_vcpu',     'Total vCPU',     'float',   false, true, 40),
    ('20000000-0000-0000-0000-000000000011', NULL, 'total_memory_gb','Total Memory GB','float',   false, true, 50),
    ('20000000-0000-0000-0000-000000000012', NULL, 'cluster_name',   'Cluster Name',   'string', false, true, 10),
    ('20000000-0000-0000-0000-000000000013', NULL, 'cpu_cores',      'CPU Cores',      'float',   false, true, 10),
    ('20000000-0000-0000-0000-000000000013', NULL, 'memory_gb',      'Memory GB',      'float',   false, true, 20),
    ('20000000-0000-0000-0000-000000000013', NULL, 'region',         'Region',         'string', false, true, 30),
    ('20000000-0000-0000-0000-000000000013', NULL, 'provider',       'Provider',       'string', false, true, 40),
    ('20000000-0000-0000-0000-000000000014', NULL, 'workload_type',  'Workload Type',  'string', false, true, 10),
    ('20000000-0000-0000-0000-000000000014', NULL, 'namespace',      'Namespace',      'string', false, true, 20),
    ('20000000-0000-0000-0000-000000000014', NULL, 'replicas',       'Replicas',       'integer', false, true, 30),
    ('20000000-0000-0000-0000-000000000014', NULL, 'cpu_request_m',  'CPU Request (m)','integer', false, true, 40),
    ('20000000-0000-0000-0000-000000000014', NULL, 'mem_request_mi', 'Mem Request (Mi)','integer', false, true, 50),
    ('20000000-0000-0000-0000-000000000014', NULL, 'cpu_limit_m',    'CPU Limit (m)',  'integer', false, true, 60),
    ('20000000-0000-0000-0000-000000000014', NULL, 'mem_limit_mi',   'Mem Limit (Mi)', 'integer', false, true, 70),
    ('20000000-0000-0000-0000-000000000015', NULL, 'namespace',      'Namespace',      'string', false, true, 10),
    ('20000000-0000-0000-0000-000000000015', NULL, 'workload_name',  'Workload Name',  'string', false, true, 20)
ON CONFLICT (ci_type_id, name) DO NOTHING;

-- contains: cluster → namespace → workload → pod; run_on: pod → node.
INSERT INTO ci_object_associations (organization_id, src_ci_type_id, association_kind_id, dst_ci_type_id, cardinality) VALUES
    (NULL, '20000000-0000-0000-0000-000000000011', '30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000012', 'one_to_many'),
    (NULL, '20000000-0000-0000-0000-000000000012', '30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000014', 'one_to_many'),
    (NULL, '20000000-0000-0000-0000-000000000014', '30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000015', 'one_to_many'),
    (NULL, '20000000-0000-0000-0000-000000000015', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000013', 'many_to_one')
ON CONFLICT (src_ci_type_id, association_kind_id, dst_ci_type_id) DO NOTHING;

-- ── source: 036_cmdb_external_sync.sql ──
-- Migration 036: external CMDB sync engine support (gap closure T13)
--
-- The sync engine needs a local CI type binding, provider options
-- (list path / table / object id / push path), and a poll interval.

ALTER TABLE external_cmdb_configs ADD COLUMN IF NOT EXISTS ci_type_id UUID REFERENCES ci_types(id) ON DELETE SET NULL;
ALTER TABLE external_cmdb_configs ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';
ALTER TABLE external_cmdb_configs ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER NOT NULL DEFAULT 60;

CREATE INDEX IF NOT EXISTS idx_external_cmdb_due
    ON external_cmdb_configs(is_active, last_synced_at);

-- ── source: 037_cmdb_compliance_targets.sql ──
-- Migration 037: compliance policy targeting (gap closure T16)
--
-- Policies can target all CIs, one CI type, or the members of a dynamic group.

CREATE TYPE compliance_target_type AS ENUM ('all', 'ci_type', 'dynamic_group');

ALTER TABLE compliance_policies ADD COLUMN target_type compliance_target_type NOT NULL DEFAULT 'all';
ALTER TABLE compliance_policies ADD COLUMN target_group_id UUID REFERENCES ci_dynamic_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_compliance_policies_target
    ON compliance_policies(organization_id, target_type) WHERE deleted_at IS NULL;
