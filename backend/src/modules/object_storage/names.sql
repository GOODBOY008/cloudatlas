WITH named AS (SELECT id,name,region,account_name, ARRAY(SELECT DISTINCT t FROM regexp_split_to_table(lower(name),'[^[:alnum:]]+') t WHERE length(t)>2) AS tokens
 FROM storage_bucket_assets WHERE organization_id=$1), pairs AS (
 SELECT n.id,n.name,n.region,n.account_name,
 (SELECT count(*) FROM (SELECT unnest(n.tokens) INTERSECT SELECT unnest(b.tokens)) hits)::numeric /
 NULLIF((SELECT count(*) FROM (SELECT unnest(n.tokens) UNION SELECT unnest(b.tokens)) words),0) AS similarity
 FROM named b JOIN named n ON n.id<>b.id AND n.tokens && b.tokens WHERE b.id=$2
) SELECT COALESCE(jsonb_agg(to_jsonb(p) || jsonb_build_object('services',
   COALESCE((SELECT jsonb_agg(DISTINCT o.service_name ORDER BY o.service_name)
             FROM storage_bucket_owners o WHERE o.bucket_id=p.id),'[]'))
   ORDER BY similarity DESC,name,id),'[]') FROM (
 SELECT * FROM pairs WHERE similarity>=0.5 ORDER BY similarity DESC,name,id LIMIT 20) p
