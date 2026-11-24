-- A business workspace owns one catalog. Its environment IDs are existing organization
-- partitions so inventory, jobs, cost history and role grants keep their original keys.
CREATE TABLE business_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE CHECK (btrim(name) <> '')
);
CREATE TABLE workspace_environments (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id),
    workspace_id UUID NOT NULL REFERENCES business_workspaces(id),
    environment TEXT NOT NULL CHECK (environment IN ('pre','prod')),
    UNIQUE (workspace_id, environment),
    UNIQUE (workspace_id, organization_id)
);
CREATE VIEW organization_workspace_scopes AS
SELECT e.organization_id, jsonb_build_object('id', w.id, 'name', w.name, 'environment', e.environment) AS workspace
FROM workspace_environments e JOIN business_workspaces w ON w.id=e.workspace_id;

CREATE TABLE workspace_catalog_editors (
    workspace_id UUID NOT NULL REFERENCES business_workspaces(id),
    user_id UUID NOT NULL REFERENCES users(id),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE workspace_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES business_workspaces(id),
    name VARCHAR(160) NOT NULL CHECK (btrim(name) <> ''),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name)
);
CREATE TABLE workspace_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES business_workspaces(id),
    name VARCHAR(160) NOT NULL CHECK (btrim(name) <> ''),
    team_id UUID,
    system_name VARCHAR(160),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, name),
    FOREIGN KEY (workspace_id, team_id) REFERENCES workspace_teams(workspace_id, id)
);
-- Consumers that count or search services see logical definitions in grouped workspaces.
CREATE VIEW visible_business_services AS
SELECT e.organization_id, s.id, s.name, s.name AS display_name
FROM workspace_environments e JOIN workspace_services s ON s.workspace_id=e.workspace_id
UNION ALL
SELECT s.organization_id, s.id, s.name, COALESCE(s.display_name,s.name)
FROM services s WHERE s.deleted_at IS NULL
AND NOT EXISTS (SELECT 1 FROM workspace_environments e WHERE e.organization_id=s.organization_id);

ALTER TABLE services ADD CONSTRAINT services_org_id_id UNIQUE (organization_id, id);
CREATE TABLE workspace_service_deployments (
    deployment_id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    catalog_service_id UUID NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (organization_id, deployment_id) REFERENCES services(organization_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, organization_id) REFERENCES workspace_environments(workspace_id, organization_id),
    FOREIGN KEY (workspace_id, catalog_service_id) REFERENCES workspace_services(workspace_id, id)
);
CREATE INDEX idx_workspace_deployments_service ON workspace_service_deployments(organization_id, catalog_service_id);
CREATE UNIQUE INDEX idx_workspace_deployments_default ON workspace_service_deployments(organization_id, catalog_service_id) WHERE is_default;

-- Environment deployment deletion should release the catalog reference and default slot.
CREATE FUNCTION detach_archived_catalog_deployment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM workspace_service_deployments WHERE deployment_id=NEW.id;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_detach_catalog_deployment AFTER UPDATE OF deleted_at ON services
FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION detach_archived_catalog_deployment();

-- Use the actual cloud-account FK on every discovery/upsert and manual tag write.
-- Credentials, account names and incoming labels do not participate in attribution.
CREATE FUNCTION enforce_cloud_account_environment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    account_scope UUID;
    env TEXT;
BEGIN
    IF NEW.cloud_account_id IS NULL THEN RETURN NEW; END IF;
    SELECT a.organization_id, CASE WHEN a.provider='alibaba' THEN e.environment END
      INTO account_scope, env
      FROM cloud_accounts a LEFT JOIN workspace_environments e ON e.organization_id=a.organization_id
      WHERE a.id=NEW.cloud_account_id;
    IF account_scope IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'Account and inventory must belong to the same environment' USING ERRCODE='23503';
    END IF;
    IF env IS NOT NULL THEN
        NEW.tags := (CASE WHEN jsonb_typeof(NEW.tags)='object' THEN NEW.tags ELSE '{}'::jsonb END)
                    || jsonb_build_object('env', env);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_cis_cloud_environment BEFORE INSERT OR UPDATE OF tags, cloud_account_id, organization_id ON cis
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_account_environment();
CREATE TRIGGER trg_resources_cloud_environment BEFORE INSERT OR UPDATE OF tags, cloud_account_id, organization_id ON resources
FOR EACH ROW EXECUTE FUNCTION enforce_cloud_account_environment();

CREATE FUNCTION label_existing_environment_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE cis c SET tags=jsonb_set(COALESCE(NULLIF(c.tags,'null'::jsonb),'{}'),'{env}',to_jsonb(NEW.environment))
    FROM cloud_accounts a WHERE a.id=c.cloud_account_id AND a.organization_id=NEW.organization_id
      AND c.organization_id=NEW.organization_id AND a.provider='alibaba' AND c.deleted_at IS NULL
      AND c.tags->>'env' IS DISTINCT FROM NEW.environment;
    UPDATE resources r SET tags=jsonb_set(COALESCE(NULLIF(r.tags,'null'::jsonb),'{}'),'{env}',to_jsonb(NEW.environment))
    FROM cloud_accounts a WHERE a.id=r.cloud_account_id AND a.organization_id=NEW.organization_id
      AND r.organization_id=NEW.organization_id AND a.provider='alibaba' AND r.tags->>'env' IS DISTINCT FROM NEW.environment;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_backfill_account_environment AFTER INSERT OR UPDATE OF environment ON workspace_environments
FOR EACH ROW EXECUTE FUNCTION label_existing_environment_inventory();
