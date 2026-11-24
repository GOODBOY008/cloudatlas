WITH objects AS MATERIALIZED (
 SELECT o.*,NULLIF(regexp_replace(o.object_key,'^.*/',''),'') AS basename
 FROM storage_current_objects o WHERE organization_id=$1
), evidence AS (
 SELECT o.*,sig.kind,sig.val,encode(sha256(convert_to(jsonb_build_array(sig.kind,sig.val,o.bytes)::text,'UTF8')),'hex') AS gid,
 CASE WHEN rate_class=storage_class AND rate_currency=$3 THEN rate_gib_month*bytes/1073741824::numeric END AS monthly
 FROM objects o CROSS JOIN LATERAL (VALUES ('verified',o.sha256),('etag',o.etag),('name',o.basename),('size',o.bytes::text)) sig(kind,val)
 WHERE sig.val IS NOT NULL AND (o.bytes IS NOT NULL OR sig.kind IN ('name','etag'))
), groups AS (
 SELECT gid,kind,val,bytes,count(*) AS copies,
 CASE WHEN kind='verified' THEN bytes::numeric*(count(*)-1) END AS potential_bytes,
 CASE WHEN kind='verified' AND count(monthly)=count(*) THEN sum(monthly)-max(monthly) END AS potential_monthly
 FROM evidence GROUP BY gid,kind,val,bytes HAVING count(*)>1 AND bool_or(bucket_id=$2)
 AND (kind='verified' OR (count(sha256)<count(*) AND count(DISTINCT sha256)<=1))
 -- A size-only group adds a clue when the filenames or ETags did not already group all copies.
 AND (kind<>'size' OR (count(DISTINCT basename)>1 AND (count(etag)<count(*) OR count(DISTINCT etag)>1)))
), page AS (
 SELECT * FROM groups WHERE $4::text='' OR gid=$4
 ORDER BY (kind='verified') DESC,(kind='size'),potential_bytes DESC NULLS LAST,copies DESC,gid LIMIT $5 OFFSET $6
)
SELECT jsonb_build_object('total',(SELECT count(*) FROM groups WHERE $4='' OR gid=$4),
 'groups',COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('members',COALESCE((
   SELECT jsonb_agg(to_jsonb(m) ORDER BY (m.bucket_id=$2) DESC,m.bucket_id,m.object_key) FROM (
    SELECT o.bucket_id,o.bucket_name,o.object_key,o.version_id,o.storage_class,o.captured_at,o.prefix,o.import_id,o.rate_source,o.rate_gib_month,o.rate_class,o.rate_currency,
      COALESCE((SELECT jsonb_agg(DISTINCT x.service_name) FROM storage_bucket_owners x WHERE x.bucket_id=o.bucket_id),'[]') AS services
    FROM evidence o WHERE o.gid=p.gid ORDER BY (o.bucket_id=$2) DESC,o.bucket_id,o.object_key LIMIT $7 OFFSET $8
   ) m),'[]')) ORDER BY (p.kind='verified') DESC,(p.kind='size'),p.potential_bytes DESC NULLS LAST,p.copies DESC,p.gid) FROM page p),'[]'))
