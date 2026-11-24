-- Run with psql -v workspace_name=... -v pre_org_id=... -v prod_org_id=...
--               -v catalog_editor_id=... -f scripts/configure_cmdb_workspace.sql
-- Existing organization UUIDs become the environment partitions; member grants stay scoped.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE requested_business_workspace ON COMMIT DROP AS
SELECT :'workspace_name'::text AS name, :'pre_org_id'::uuid AS pre_id,
       :'prod_org_id'::uuid AS prod_id, :'catalog_editor_id'::uuid AS editor_id;
DO $$
DECLARE
    request requested_business_workspace%ROWTYPE;
    workspace UUID;
BEGIN
    SELECT * INTO STRICT request FROM requested_business_workspace;
    IF request.pre_id=request.prod_id OR
       (SELECT count(*) FROM organizations WHERE id IN (request.pre_id,request.prod_id) AND deleted_at IS NULL)<>2 THEN
        RAISE EXCEPTION 'Two distinct active environment scopes are required';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM organization_members WHERE user_id=request.editor_id
          AND organization_id IN (request.pre_id,request.prod_id)
    ) THEN
        RAISE EXCEPTION 'The catalog editor must be a member of an environment';
    END IF;
    INSERT INTO business_workspaces(name) VALUES (request.name)
    ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO workspace;
    INSERT INTO workspace_environments(organization_id,workspace_id,environment)
    VALUES (request.pre_id,workspace,'pre'),(request.prod_id,workspace,'prod')
    ON CONFLICT DO NOTHING;
    IF (SELECT count(*) FROM workspace_environments WHERE workspace_id=workspace
        AND ((organization_id=request.pre_id AND environment='pre')
          OR (organization_id=request.prod_id AND environment='prod')))<>2 THEN
        RAISE EXCEPTION 'An environment is already assigned to another workspace or scope';
    END IF;
    INSERT INTO workspace_catalog_editors(workspace_id,user_id) VALUES (workspace,request.editor_id)
    ON CONFLICT DO NOTHING;
END $$;
COMMIT;
