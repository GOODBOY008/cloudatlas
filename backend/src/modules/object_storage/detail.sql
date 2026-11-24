WITH ledger AS (
 SELECT * FROM storage_bill_lines WHERE organization_id=$1 AND bucket_id=$2 AND currency=$5 AND date BETWEEN $3 AND $4
)
SELECT to_jsonb(b) || jsonb_build_object(
 'usage',to_jsonb(u)-'bucket_id'-'organization_id',
 'environment',COALESCE(env.environment,org.name),
 'owners',COALESCE((SELECT jsonb_agg(to_jsonb(o)-'organization_id'-'bucket_id' ORDER BY service_name,deployment_id) FROM storage_bucket_owners o WHERE o.bucket_id=b.id),'[]'),
 'cost',(SELECT sum(cost) FROM ledger),
 'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object('effective_from',effective_from,'weights',weights) ORDER BY effective_from DESC)
 FROM storage_allocation_rules r WHERE r.bucket_id=b.id),'[]'),
 'service_costs',COALESCE((SELECT jsonb_agg(to_jsonb(part) ORDER BY service_name) FROM (
 SELECT s.service_id,(SELECT min(service_name) FROM storage_bucket_owners o WHERE o.bucket_id=b.id AND o.service_id=s.service_id) service_name,sum(s.cost) cost
 FROM storage_service_costs s WHERE s.bucket_id=b.id AND s.organization_id=$1 AND s.currency=$5 AND s.date BETWEEN $3 AND $4 GROUP BY s.service_id) part),'[]'),
 'trend',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY date) FROM (SELECT date,sum(cost) AS cost FROM ledger GROUP BY date) d),'[]'),
 'breakdown',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY category) FROM (SELECT category,sum(cost) AS cost FROM ledger GROUP BY category) d),'[]'),
 'imports',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY created_at DESC,id) FROM (
 SELECT id,prefix,captured_at,created_at,status,source,object_count,size_bytes,error,rate_class,rate_currency,rate_gib_month,rate_source
 FROM storage_inventory_imports i WHERE i.bucket_id=b.id ORDER BY created_at DESC,id LIMIT 20) d),'[]'))
FROM storage_bucket_assets b JOIN organizations org ON org.id=b.organization_id
LEFT JOIN workspace_environments env ON env.organization_id=b.organization_id
JOIN storage_bucket_usage u ON u.bucket_id=b.id WHERE b.organization_id=$1 AND b.id=$2
