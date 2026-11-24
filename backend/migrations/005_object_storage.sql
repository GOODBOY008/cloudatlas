-- Each published import is a complete snapshot of current keys under one prefix.
CREATE TABLE storage_inventory_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    prefix text NOT NULL,
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
    fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','failed')),
    source text NOT NULL,
    schema_fields text,
    rate_gib_month numeric, rate_currency text, rate_class text, rate_source text,
    object_count bigint, size_bytes numeric, error text,
    UNIQUE(bucket_id,prefix,captured_at)
);
CREATE INDEX idx_storage_inventory_pending ON storage_inventory_imports(created_at) WHERE status='pending';
CREATE INDEX idx_storage_inventory_coverage ON storage_inventory_imports(bucket_id,captured_at DESC) WHERE status='complete';
CREATE TABLE storage_inventory_parts (
    import_id uuid NOT NULL REFERENCES storage_inventory_imports(id) ON DELETE CASCADE,
    filename text NOT NULL, payload bytea NOT NULL, PRIMARY KEY(import_id,filename)
);
CREATE TABLE storage_inventory_objects (
    import_id uuid NOT NULL REFERENCES storage_inventory_imports(id) ON DELETE CASCADE,
    object_key text NOT NULL, version_id text NOT NULL, bytes bigint CHECK(bytes>=0),
    etag text, sha256 text, storage_class text,
    PRIMARY KEY(import_id,object_key)
);
CREATE INDEX idx_storage_objects_digest ON storage_inventory_objects(sha256,bytes) WHERE sha256 IS NOT NULL;

CREATE FUNCTION storage_native_bucket_id(provider text, identifier text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT CASE WHEN provider='aws' THEN regexp_replace(identifier,'^(arn:(aws|aws-cn|aws-us-gov):s3:::|s3:)','') ELSE identifier END
$$;

CREATE VIEW storage_bucket_assets AS
SELECT r.id, r.organization_id, r.cloud_account_id, a.name AS account_name, a.provider::text AS provider,
       r.cloud_resource_id,storage_native_bucket_id(a.provider::text,r.cloud_resource_id) AS native_name, COALESCE(NULLIF(r.name,''),r.cloud_resource_id) AS name, r.cloud_region AS region,
       r.tags, r.meta, r.last_seen, c.id AS ci_id
FROM resources r JOIN cloud_accounts a ON a.id=r.cloud_account_id AND a.organization_id=r.organization_id AND a.deleted_at IS NULL
LEFT JOIN cis c ON c.id=r.ci_id AND c.organization_id=r.organization_id AND c.cloud_account_id=r.cloud_account_id
       AND c.cloud_resource_id=r.cloud_resource_id AND c.deleted_at IS NULL
WHERE r.active AND r.resource_type='bucket';

CREATE VIEW storage_bucket_owners AS
SELECT b.organization_id,b.id AS bucket_id,COALESCE(cs.id,d.id) AS service_id,
       COALESCE(cs.name,d.display_name,d.name) AS service_name,cs.system_name,t.id AS team_id,t.name AS team_name,
       d.id AS deployment_id, COALESCE(d.display_name,d.name) AS deployment_name, COALESCE(m.is_default,false) AS is_default
FROM storage_bucket_assets b JOIN service_cis sc ON sc.ci_id=b.ci_id
JOIN services d ON d.id=sc.service_id AND d.organization_id=b.organization_id AND d.deleted_at IS NULL
LEFT JOIN workspace_environments e ON e.organization_id=b.organization_id
LEFT JOIN workspace_service_deployments m ON m.deployment_id=d.id AND m.organization_id=b.organization_id AND m.workspace_id=e.workspace_id
LEFT JOIN workspace_services cs ON cs.id=m.catalog_service_id AND cs.workspace_id=e.workspace_id
LEFT JOIN workspace_teams t ON t.id=cs.team_id AND t.workspace_id=cs.workspace_id
WHERE e.workspace_id IS NULL OR cs.id IS NOT NULL;

-- Overlapping prefixes and older reimports must not double-count, or resurrect a
-- key absent from a newer snapshot. A newer empty snapshot also supersedes it.
CREATE VIEW storage_current_objects AS
SELECT b.organization_id,b.cloud_account_id,b.id AS bucket_id,b.name AS bucket_name,
       i.id AS import_id,i.prefix,i.captured_at,i.rate_gib_month,i.rate_class,i.rate_currency,i.rate_source,
       o.object_key,o.version_id,o.bytes,o.etag,o.sha256,o.storage_class
FROM storage_bucket_assets b JOIN storage_inventory_imports i ON i.bucket_id=b.id AND i.status='complete'
JOIN storage_inventory_objects o ON o.import_id=i.id
WHERE NOT EXISTS (
    SELECT 1 FROM storage_inventory_imports newer WHERE newer.bucket_id=b.id AND newer.status='complete'
      AND (newer.captured_at,length(newer.prefix))>(i.captured_at,length(i.prefix))
      AND starts_with(o.object_key,newer.prefix)
);

CREATE FUNCTION storage_charge_category(item text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN lower(item) ~ 'retrieval|restore|取回|恢复' THEN 'retrieval'
             WHEN lower(item) ~ 'traffic|transfer|bandwidth|流量|带宽' THEN 'traffic'
             WHEN lower(item) ~ 'request|请求' THEN 'requests'
             WHEN lower(item) ~ 'storage|bytehrs|存储容量|存储空间' THEN 'storage'
             ELSE 'other' END
$$;

-- Daily expenses are the reconciled ledger. New provider evidence retains each
-- converted line; a legacy ledger row without evidence remains one unclassified charge.
CREATE VIEW storage_bill_lines AS
SELECT e.organization_id,e.cloud_account_id,a.name AS account_name,e.id AS expense_id,
       e.cloud_resource_id,e.date,e.currency,match.id AS bucket_id,
       COALESCE(l.cost,e.cost) AS cost,storage_charge_category(COALESCE(l.item,raw.usage_type,raw.operation)) AS category,
       COALESCE(l.service,e.service_name) AS service,raw.id AS raw_id,raw.imported_at,
       l.original_cost,l.original_currency,l.item,l.seq
FROM expenses e JOIN cloud_accounts a ON a.id=e.cloud_account_id AND a.organization_id=e.organization_id
LEFT JOIN raw_expenses raw ON raw.organization_id=e.organization_id AND raw.cloud_account_id=e.cloud_account_id
 AND raw.external_id=e.cloud_resource_id AND raw.billing_period=e.date AND raw.currency=e.currency AND raw.cost=e.cost
LEFT JOIN LATERAL (
 SELECT (CASE WHEN seq=n THEN e.cost - COALESCE(sum(amount) OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
         ELSE amount END) AS cost, COALESCE(doc->>'line_service',doc->>'product_code',doc->>'service_name') AS service,
         COALESCE(doc->>'line_resource_type',doc->>'resource_type') AS resource_type,
         COALESCE(doc->>'original_amount',doc->>'pretax_amount',doc->>'cost_usd') AS original_cost,
         COALESCE(doc->>'original_currency',doc->>'currency') AS original_currency,
         COALESCE(doc->>'billing_item',doc->>'usage_type',doc->>'operation') AS item,seq
 FROM (SELECT parts.*,count(*) OVER () AS n,count(amount) OVER () AS usable,sum(amount) OVER () AS net
       FROM (SELECT doc,seq,CASE
           WHEN jsonb_typeof(doc->'workspace_cost')='number' THEN round((doc->>'workspace_cost')::numeric,6)
           WHEN doc->>'currency'=trim(e.currency) AND jsonb_typeof(COALESCE(doc->'pretax_amount',doc->'cost_usd'))='number'
             THEN round(COALESCE(doc->>'pretax_amount',doc->>'cost_usd')::numeric,6)
         END AS amount
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(raw.cloud_specific->'line_items')='array' THEN raw.cloud_specific->'line_items' ELSE '[]' END) WITH ORDINALITY lines(doc,seq)) parts) v
 WHERE usable=n AND abs(net-e.cost)<=0.000001*n
) l ON true
LEFT JOIN LATERAL (
 SELECT b.id FROM storage_bucket_assets b WHERE b.organization_id=e.organization_id AND b.cloud_account_id=e.cloud_account_id
 AND (b.cloud_resource_id=e.cloud_resource_id OR (a.provider='aws' AND b.cloud_resource_id='s3:'||
    regexp_replace(e.cloud_resource_id,'^arn:(aws|aws-cn|aws-us-gov):s3:::','')))
 ORDER BY (b.cloud_resource_id=e.cloud_resource_id) DESC LIMIT 1
) match ON true
WHERE COALESCE(l.resource_type,e.resource_type::text)='bucket'
   OR lower(trim(COALESCE(l.service,e.service_name,''))) IN ('oss','s3','amazon s3','aws s3','aliyun oss','alibaba cloud oss','amazon simple storage service','object storage','对象存储','对象存储 oss')
   OR (match.id IS NOT NULL AND COALESCE(l.resource_type,e.resource_type::text) IN ('storage','other'));

CREATE VIEW storage_bucket_usage AS
SELECT b.id AS bucket_id, b.organization_id, covers.latest_at,covers.full_at,
       CASE WHEN covers.full_at IS NOT NULL THEN stats.n
            WHEN jsonb_typeof(b.meta->'object_count')='number' THEN (b.meta->>'object_count')::numeric END AS object_count,
       CASE WHEN covers.full_at IS NOT NULL THEN stats.bytes
            WHEN jsonb_typeof(b.meta->'size_bytes')='number' THEN (b.meta->>'size_bytes')::numeric END AS size_bytes,
       CASE WHEN covers.latest_at IS NOT NULL THEN stats.n END AS covered_objects,
       CASE WHEN covers.latest_at IS NOT NULL THEN stats.bytes END AS covered_bytes
FROM storage_bucket_assets b
LEFT JOIN LATERAL (SELECT max(i.captured_at) AS latest_at,max(i.captured_at) FILTER(WHERE i.prefix='') AS full_at
                   FROM storage_inventory_imports i WHERE i.bucket_id=b.id AND i.status='complete') covers ON true
LEFT JOIN LATERAL (SELECT count(*) AS n,CASE WHEN count(bytes)=count(*) THEN coalesce(sum(bytes),0) END AS bytes FROM storage_current_objects o WHERE o.bucket_id=b.id) stats ON true;

-- Agreements use integer basis points and an effective date. An ownership change
-- invalidates a mismatched agreement until an authorized editor confirms a new one.
CREATE TABLE storage_allocation_rules (
    bucket_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    effective_from date NOT NULL, weights jsonb NOT NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(bucket_id,effective_from)
);
CREATE VIEW storage_attributed_lines AS
SELECT f.*,CASE WHEN f.bucket_id IS NULL THEN 'unmatched' WHEN own.n=0 THEN 'unclaimed'
       WHEN own.n=1 OR rule.weights IS NOT NULL AND rule.weights ?& own.ids AND
         (SELECT count(*) FROM jsonb_object_keys(rule.weights))=own.n THEN 'allocated' ELSE 'shared' END AS allocation,
 CASE WHEN own.n=1 THEN jsonb_build_object(own.ids[1],10000)
      WHEN rule.weights ?& own.ids AND (SELECT count(*) FROM jsonb_object_keys(rule.weights))=own.n THEN rule.weights END AS weights
FROM storage_bill_lines f
CROSS JOIN LATERAL (SELECT count(DISTINCT o.service_id) AS n,array_agg(DISTINCT o.service_id::text) AS ids
                    FROM storage_bucket_owners o WHERE o.bucket_id=f.bucket_id) own
LEFT JOIN LATERAL (SELECT r.weights FROM storage_allocation_rules r WHERE r.bucket_id=f.bucket_id AND r.effective_from<=f.date
                   ORDER BY r.effective_from DESC LIMIT 1) rule ON own.n>1;

CREATE VIEW storage_service_costs AS
SELECT f.organization_id,f.cloud_account_id,f.bucket_id,f.currency,f.date,split.service_id,split.cost
FROM storage_attributed_lines f
CROSS JOIN LATERAL (
 SELECT key::uuid AS service_id, CASE WHEN row_number() OVER (ORDER BY key)=count(*) OVER () THEN
 f.cost-COALESCE(sum(round(f.cost*value::numeric/10000,6)) OVER (ORDER BY key ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
 ELSE round(f.cost*value::numeric/10000,6) END AS cost
 FROM jsonb_each_text(f.weights)
) split WHERE f.allocation='allocated';
