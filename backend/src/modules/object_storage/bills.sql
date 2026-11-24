WITH items AS (
 SELECT f.expense_id,f.raw_id,f.imported_at,f.account_name,f.cloud_resource_id,f.bucket_id,f.date,f.cost,f.currency,
 f.original_cost,f.original_currency,f.category,f.service,f.item,f.seq,
 f.allocation,f.weights
 FROM storage_attributed_lines f
 WHERE f.organization_id=$1 AND f.date BETWEEN $2 AND $3 AND f.currency=$4 AND ($5::uuid IS NULL OR f.cloud_account_id=$5) AND ($6::uuid IS NULL OR f.bucket_id=$6)
), filtered AS (SELECT * FROM items WHERE $7::text='' OR allocation=$7),
 page AS (SELECT * FROM filtered ORDER BY date DESC,expense_id,seq LIMIT $8 OFFSET $9)
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY date DESC,expense_id,seq) FROM page p),'[]'),
'total',(SELECT count(*) FROM filtered))
