WITH selected AS (
 SELECT b.*,COALESCE(own.owners,'[]') AS owners,own.services
 FROM storage_bucket_assets b
 CROSS JOIN LATERAL (SELECT jsonb_agg(to_jsonb(o)-'bucket_id'-'organization_id' ORDER BY o.service_name,o.deployment_id) AS owners,
                            count(DISTINCT service_id) AS services FROM storage_bucket_owners o WHERE o.bucket_id=b.id) own
 WHERE b.organization_id=$1 AND ($5::uuid IS NULL OR b.cloud_account_id=$5)
), ledger AS (
 SELECT f.bucket_id, f.cloud_account_id, sum(f.cost) AS cost
 FROM storage_bill_lines f WHERE f.organization_id=$1 AND f.currency=$4 AND f.date BETWEEN $2 AND $3
 AND ($5 IS NULL OR f.cloud_account_id=$5) GROUP BY f.bucket_id,f.cloud_account_id
), bucket_rows AS (
 SELECT s.id,s.ci_id,s.cloud_account_id,s.account_name,s.provider,s.region,s.name,s.cloud_resource_id,s.tags,s.last_seen,
        s.owners,s.services,l.cost FROM selected s LEFT JOIN ledger l ON l.bucket_id=s.id
), filtered AS (
 SELECT b.* FROM bucket_rows b WHERE ($6::text='' OR strpos(lower(concat_ws(' ',b.name,b.cloud_resource_id,b.region,b.account_name)),lower($6))>0
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.owners) x WHERE strpos(lower(concat_ws(' ',x->>'service_name',x->>'team_name',x->>'system_name')),lower($6))>0))
 AND CASE $7::text WHEN 'unclaimed' THEN b.services=0 WHEN 'shared' THEN b.services>1 WHEN 'owned' THEN b.services=1 ELSE true END
 AND ($8::boolean=false OR b.cost IS NOT NULL)
 AND ($11::uuid IS NULL OR EXISTS(SELECT 1 FROM storage_bucket_owners o WHERE o.bucket_id=b.id AND (o.service_id=$11 OR o.deployment_id=$11)))
), entries AS (
 SELECT * FROM filtered ORDER BY cost DESC NULLS LAST,name,id LIMIT $9 OFFSET $10
), allocation AS (
 SELECT f.cloud_account_id,f.allocation AS kind,sum(f.cost) AS cost FROM storage_attributed_lines f
 WHERE f.organization_id=$1 AND f.currency=$4 AND f.date BETWEEN $2 AND $3 AND ($5 IS NULL OR f.cloud_account_id=$5)
 GROUP BY f.cloud_account_id,f.allocation
)
SELECT jsonb_build_object('buckets',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY cost DESC NULLS LAST,name,id) FROM entries e),'[]'),
 'filtered_count',(SELECT count(*) FROM filtered),
 'bucket_count',(SELECT count(*) FROM selected),'unclaimed_count',(SELECT count(*) FROM selected WHERE services=0),
 'billed_count',(SELECT count(*) FROM ledger WHERE bucket_id IS NOT NULL),
 'period_cost',(SELECT sum(cost) FROM allocation),
 'allocated_cost',(SELECT CASE WHEN count(*)>0 THEN COALESCE(sum(cost) FILTER(WHERE kind='allocated'),0) END FROM allocation),
 'unallocated_cost',(SELECT CASE WHEN count(*)>0 THEN COALESCE(sum(cost) FILTER(WHERE kind<>'allocated'),0) END FROM allocation),
 'excluded_currency_rows',(SELECT count(*) FROM storage_bill_lines f WHERE f.organization_id=$1 AND f.date BETWEEN $2 AND $3 AND f.currency<>$4 AND ($5 IS NULL OR f.cloud_account_id=$5)),
 'accounts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) ORDER BY a.name) FROM cloud_accounts a WHERE a.organization_id=$1 AND
 (a.deleted_at IS NULL OR EXISTS(SELECT 1 FROM storage_bill_lines f WHERE f.organization_id=$1 AND f.cloud_account_id=a.id AND f.date BETWEEN $2 AND $3))),'[]'),
 'allocation',COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.account_name,item.kind) FROM
 (SELECT a.cloud_account_id,ca.name AS account_name,a.kind,sum(a.cost) AS cost FROM allocation a JOIN cloud_accounts ca ON ca.id=a.cloud_account_id GROUP BY a.cloud_account_id,ca.name,a.kind) item),'[]'))
