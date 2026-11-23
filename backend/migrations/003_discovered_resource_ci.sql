-- Keep the provider's billing ID on the inventory row and the stable topology ID on the CI.
ALTER TABLE resources ADD COLUMN ci_id UUID REFERENCES cis(id) ON DELETE SET NULL;
CREATE INDEX idx_resources_ci ON resources(ci_id) WHERE ci_id IS NOT NULL;

-- Earlier Kubernetes discovery recorded the provider ID in the topology CI's metadata.
WITH matches AS (
    SELECT DISTINCT ON (r.id) r.id AS resource_id, c.id AS ci_id
    FROM resources r
    JOIN cis c ON c.organization_id = r.organization_id AND c.cloud_account_id = r.cloud_account_id
        AND c.meta->>'provider_resource_id' = r.cloud_resource_id
    WHERE c.deleted_at IS NULL AND c.discovered_at IS NOT NULL AND (
        (r.resource_type = 'k8s_pod' AND c.ci_type_id = '20000000-0000-0000-0000-000000000015'
            AND starts_with(c.cloud_resource_id, 'k8s/pod/'))
        OR (r.resource_type = 'k8s_cluster' AND c.ci_type_id = '20000000-0000-0000-0000-000000000011'
            AND starts_with(c.cloud_resource_id, 'k8s/cluster/'))
    )
    ORDER BY r.id, c.discovered_at DESC, c.id
)
UPDATE resources r SET ci_id = m.ci_id FROM matches m WHERE r.id = m.resource_id;

-- Direct IDs also cover manual CIs and expenses imported before inventory discovery.
CREATE VIEW ci_finops_resource_ids AS
    SELECT id AS ci_id, organization_id, cloud_account_id, cloud_resource_id
    FROM cis WHERE deleted_at IS NULL AND cloud_resource_id IS NOT NULL
    UNION ALL
    SELECT c.id, r.organization_id, r.cloud_account_id, r.cloud_resource_id
    FROM resources r JOIN cis c ON c.id = r.ci_id
        AND c.organization_id = r.organization_id AND c.cloud_account_id = r.cloud_account_id
    WHERE c.deleted_at IS NULL AND r.cloud_resource_id IS DISTINCT FROM c.cloud_resource_id;
