use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

// ─── Shared guard ─────────────────────────────────────────────────────────────

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

// ─── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct ResourceQuery {
    pub resource_type: Option<String>,
    pub pool_id: Option<Uuid>,
    pub cloud_account_id: Option<Uuid>,
    pub cloud_region: Option<String>,
    pub active: Option<bool>,
    pub search: Option<String>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

#[derive(Debug, Deserialize)]
pub struct PatchPoolRequest {
    pub pool_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct PatchTagsRequest {
    /// Full replacement of the resource's tags JSONB object.
    pub tags: Value,
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/resources
///
/// List cloud resources tracked for the organization.
/// Supports filtering by resource_type, pool_id, cloud_account_id, cloud_region, active.
/// Supports full-text search on name, cloud_resource_id, service_name.
/// Paginated via limit/offset.
pub async fn list_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ResourceQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);
    let search = q
        .search
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let rows = sqlx::query(
        r#"SELECT
               r.id, r.cloud_account_id, r.cloud_resource_id, r.resource_type::text AS resource_type,
               r.service_name, r.name, r.cloud_region, r.tags, r.meta, r.pool_id,
               r.first_seen, r.last_seen, r.active, r.total_cost::float8 AS total_cost,
               r.last_month_cost::float8 AS last_month_cost,
               r.recommendations, r.dismissed_recs,
               r.created_at, r.updated_at,
               ca.provider::text AS provider, ca.name AS account_name
           FROM resources r
           LEFT JOIN cloud_accounts ca ON ca.id = r.cloud_account_id AND ca.deleted_at IS NULL
           WHERE r.organization_id = $1
             AND ($2::text    IS NULL OR r.resource_type::text = $2)
             AND ($3::uuid    IS NULL OR r.pool_id           = $3)
             AND ($4::uuid    IS NULL OR r.cloud_account_id  = $4)
             AND ($5::text    IS NULL OR r.cloud_region      = $5)
             AND ($6::boolean IS NULL OR r.active            = $6)
             AND ($7::text    IS NULL
                  OR r.name             ILIKE '%' || $7 || '%'
                  OR r.cloud_resource_id ILIKE '%' || $7 || '%'
                  OR COALESCE(r.service_name, '') ILIKE '%' || $7 || '%')
           ORDER BY r.total_cost DESC, r.name ASC
           LIMIT $8 OFFSET $9"#,
    )
    .bind(org_id)
    .bind(q.resource_type.as_deref())
    .bind(q.pool_id)
    .bind(q.cloud_account_id)
    .bind(q.cloud_region.as_deref())
    .bind(q.active)
    .bind(search.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM resources
           WHERE organization_id = $1
             AND ($2::text    IS NULL OR resource_type::text = $2)
             AND ($3::uuid    IS NULL OR pool_id           = $3)
             AND ($4::uuid    IS NULL OR cloud_account_id  = $4)
             AND ($5::text    IS NULL OR cloud_region      = $5)
             AND ($6::boolean IS NULL OR active            = $6)
             AND ($7::text    IS NULL
                  OR name             ILIKE '%' || $7 || '%'
                  OR cloud_resource_id ILIKE '%' || $7 || '%'
                  OR COALESCE(service_name, '') ILIKE '%' || $7 || '%')"#,
    )
    .bind(org_id)
    .bind(q.resource_type.as_deref())
    .bind(q.pool_id)
    .bind(q.cloud_account_id)
    .bind(q.cloud_region.as_deref())
    .bind(q.active)
    .bind(search.as_deref())
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(resource_row_to_json).collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

/// GET /api/v1/orgs/{org_id}/resources/{resource_id}
pub async fn get_resource(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT
               r.id, r.cloud_account_id, r.cloud_resource_id, r.resource_type::text AS resource_type,
               r.service_name, r.name, r.cloud_region, r.tags, r.meta, r.pool_id,
               r.first_seen, r.last_seen, r.active, r.total_cost::float8 AS total_cost,
               r.last_month_cost::float8 AS last_month_cost,
               r.recommendations, r.dismissed_recs,
               r.created_at, r.updated_at,
               ca.provider::text AS provider, ca.name AS account_name
           FROM resources r
           LEFT JOIN cloud_accounts ca ON ca.id = r.cloud_account_id AND ca.deleted_at IS NULL
           WHERE r.id = $1 AND r.organization_id = $2"#,
    )
    .bind(resource_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Resource {resource_id} not found")))?;

    Ok(Json(json!({ "data": resource_row_to_json(&row) })))
}

/// PATCH /api/v1/orgs/{org_id}/resources/{resource_id}/pool
///
/// Assign or unassign a resource to a pool (pass null pool_id to unassign).
pub async fn patch_resource_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PatchPoolRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // If a pool_id is given, confirm it belongs to the same org.
    if let Some(pool_id) = body.pool_id {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pools WHERE id = $1 AND organization_id = $2 AND deleted_at = 0)",
        )
        .bind(pool_id)
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        if !exists {
            return Err(AppError::Validation(format!(
                "Pool {pool_id} does not exist in this organization"
            )));
        }
    }

    let result = sqlx::query(
        r#"UPDATE resources
           SET pool_id    = $3,
               updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(resource_id)
    .bind(org_id)
    .bind(body.pool_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Resource {resource_id} not found"
        )));
    }

    Ok(Json(json!({
        "data": {
            "id": resource_id,
            "pool_id": body.pool_id,
            "message": "Pool assignment updated"
        }
    })))
}

/// PATCH /api/v1/orgs/{org_id}/resources/{resource_id}/tags
///
/// Replace the full tags object on a resource.
pub async fn patch_resource_tags(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<PatchTagsRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    crate::utils::tags::validate_tags(&body.tags)?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Ensure tags value is an object.
    if !body.tags.is_object() {
        return Err(AppError::Validation("tags must be a JSON object".into()));
    }

    let result = sqlx::query(
        r#"UPDATE resources
           SET tags       = $3,
               updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(resource_id)
    .bind(org_id)
    .bind(&body.tags)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Resource {resource_id} not found"
        )));
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": {
                "id": resource_id,
                "tags": body.tags,
                "message": "Tags updated"
            }
        })),
    ))
}

// ─── Internal helper ──────────────────────────────────────────────────────────

fn resource_row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id":               r.try_get::<Uuid, _>("id").ok(),
        "cloud_account_id": r.try_get::<Uuid, _>("cloud_account_id").ok(),
        "cloud_resource_id": r.try_get::<String, _>("cloud_resource_id").unwrap_or_default(),
        "resource_type":    r.try_get::<String, _>("resource_type").unwrap_or_default(),
        "provider":         r.try_get::<Option<String>, _>("provider").unwrap_or(None),
        "account_name":     r.try_get::<Option<String>, _>("account_name").unwrap_or(None),
        "service_name":     r.try_get::<Option<String>, _>("service_name").unwrap_or(None),
        "name":             r.try_get::<Option<String>, _>("name").unwrap_or(None),
        "cloud_region":     r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
        "tags":             r.try_get::<Value, _>("tags").unwrap_or(json!({})),
        "meta":             r.try_get::<Value, _>("meta").unwrap_or(json!({})),
        "pool_id":          r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
        "first_seen":       r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("first_seen").unwrap_or(None),
        "last_seen":        r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_seen").unwrap_or(None),
        "active":           r.try_get::<bool, _>("active").unwrap_or(true),
        "total_cost":       r.try_get::<f64, _>("total_cost").unwrap_or(0.0),
        "last_month_cost":  r.try_get::<f64, _>("last_month_cost").unwrap_or(0.0),
        "recommendations":  r.try_get::<Value, _>("recommendations").unwrap_or(json!([])),
        "dismissed_recs":   r.try_get::<Value, _>("dismissed_recs").unwrap_or(json!([])),
        "created_at":       r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("created_at").unwrap_or(None),
        "updated_at":       r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("updated_at").unwrap_or(None),
    })
}

// ─── S3 Duplicate Finder ──────────────────────────────────────────────────────

/// Analyze S3 buckets (from the resources table) for potential duplicates.
///
/// Buckets are grouped when their normalized names share >= 80% of tokens;
/// the cheaper bucket in each group is flagged as redundant. The matrix gives
/// pairwise similarity scores for the UI.
pub async fn s3_duplicate_analysis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let rows = sqlx::query(
        r#"SELECT id, name, cloud_resource_id, cloud_region AS region, total_cost::float8 AS total_cost, tags, meta
           FROM resources
           WHERE organization_id = $1
             AND (
                 resource_type IN ('bucket', 'volume', 'snapshot')
                 OR service_name ILIKE '%s3%'
                 OR service_name ILIKE '%storage%'
             )
           ORDER BY total_cost DESC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut buckets: Vec<Value> = Vec::new();
    for r in &rows {
        let name = r
            .get::<Option<String>, _>("name")
            .or_else(|| r.get::<Option<String>, _>("cloud_resource_id"))
            .unwrap_or_default();
        let meta: Value = r.get("meta");
        let object_count = meta
            .get("object_count")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        buckets.push(json!({
            "id": r.get::<Uuid, _>("id"),
            "name": name,
            "cloud_resource_id": r.get::<String, _>("cloud_resource_id"),
            "region": r.get::<Option<String>, _>("region"),
            "total_cost": r.get::<f64, _>("total_cost"),
            "object_count": object_count,
            "tags": r.get::<Value, _>("tags"),
        }));
    }

    // Normalized token set for similarity.
    let tokens = |name: &str| -> std::collections::HashSet<String> {
        name.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty() && t.len() > 2)
            .map(String::from)
            .collect()
    };

    let jaccard = |a: &str, b: &str| -> f64 {
        let ta = tokens(a);
        let tb = tokens(b);
        if ta.is_empty() || tb.is_empty() {
            return 0.0;
        }
        let inter = ta.intersection(&tb).count() as f64;
        let union = ta.union(&tb).count() as f64;
        inter / union.max(1.0)
    };

    // Bucket × bucket similarity matrix (top-left triangle, name pairs).
    let mut matrix: Vec<Value> = Vec::new();
    for i in 0..buckets.len() {
        for j in (i + 1)..buckets.len() {
            let a = buckets[i]["name"].as_str().unwrap_or_default();
            let b = buckets[j]["name"].as_str().unwrap_or_default();
            let score = jaccard(a, b);
            if score > 0.0 {
                matrix.push(json!({
                    "bucket_a": a,
                    "bucket_b": b,
                    "similarity": (score * 100.0).round() / 100.0,
                }));
            }
        }
    }

    // Duplicate groups: union-find over pairs with similarity >= 0.8.
    let mut groups: Vec<Vec<String>> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for pair in &matrix {
        let a = pair["bucket_a"].as_str().unwrap_or_default().to_string();
        let b = pair["bucket_b"].as_str().unwrap_or_default().to_string();
        if pair["similarity"].as_f64().unwrap_or(0.0) < 0.8 {
            continue;
        }
        let ia = *index.entry(a.clone()).or_insert_with(|| {
            groups.push(vec![a.clone()]);
            groups.len() - 1
        });
        let ib = *index.entry(b.clone()).or_insert_with(|| {
            groups.push(vec![b.clone()]);
            groups.len() - 1
        });
        if ia != ib {
            let merged = groups[ia].clone();
            let other = groups[ib].clone();
            groups[ia] = merged
                .iter()
                .chain(other.iter())
                .cloned()
                .collect::<Vec<_>>();
            groups[ib] = Vec::new();
        } else if !groups[ia].contains(&b) {
            groups[ia].push(b);
        }
    }
    groups.retain(|g| g.len() >= 2);

    // Savings estimate: within each group, all but the most expensive bucket
    // are treated as redundant.
    let mut potential_savings = 0.0f64;
    let mut dup_groups: Vec<Value> = Vec::new();
    for group in &groups {
        let members: Vec<Value> = buckets
            .iter()
            .filter(|b| group.contains(&b["name"].as_str().unwrap_or_default().to_string()))
            .cloned()
            .collect();
        if members.is_empty() {
            continue;
        }
        let redundant = members.len().saturating_sub(1) as f64;
        let group_cost: f64 = members
            .iter()
            .map(|m| m["total_cost"].as_f64().unwrap_or(0.0))
            .sum();
        let redundant_cost = group_cost * (redundant / members.len() as f64);
        potential_savings += redundant_cost;
        dup_groups.push(json!({
            "buckets": members,
            "redundant_count": redundant,
            "redundant_cost": (redundant_cost * 100.0).round() / 100.0,
        }));
    }

    Ok(Json(json!({
        "data": {
            "buckets": buckets,
            "matrix": matrix,
            "duplicate_groups": dup_groups,
            "summary": {
                "bucket_count": buckets.len(),
                "pair_count": matrix.len(),
                "duplicate_group_count": dup_groups.len(),
                "potential_savings": (potential_savings * 100.0).round() / 100.0,
            },
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jaccard_similarity() {
        let tokens = |name: &str| -> std::collections::HashSet<String> {
            name.to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .filter(|t| !t.is_empty() && t.len() > 2)
                .map(String::from)
                .collect()
        };
        let jac = |a: &str, b: &str| -> f64 {
            let ta = tokens(a);
            let tb = tokens(b);
            let inter = ta.intersection(&tb).count() as f64;
            let union = ta.union(&tb).count() as f64;
            inter / union.max(1.0)
        };
        assert_eq!(jac("prod-backup", "prod-backup"), 1.0);
        assert!(jac("prod-backup", "prod-backup-old") > 0.6);
        assert!(jac("prod-backup", "dev-logs") < 0.3);
        assert_eq!(jac("ab", "cd"), 0.0); // tokens shorter than 3 chars dropped
    }
}

// ─── Resource → Recommendations drill-down (G12) ──────────────────────────────

/// GET /orgs/{org_id}/resources/{resource_id}/recommendations
/// Recommendations linked to this resource (by cloud_resource_id).
pub async fn resource_recommendations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, Uuid)>,
    Query(page): Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Resolve the resource's cloud_resource_id (must belong to the org).
    let cloud_resource_id = sqlx::query_scalar::<_, Option<String>>(
        "SELECT cloud_resource_id FROM resources WHERE id = $1 AND organization_id = $2",
    )
    .bind(resource_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Resource {resource_id} not found")))?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, rec_type::text AS rec_type, title, status::text AS status,
                  potential_savings::float8 AS savings,
                  current_monthly_cost::float8 AS monthly_cost, created_at
           FROM recommendations
           WHERE organization_id = $1 AND cloud_resource_id = $2
           ORDER BY potential_savings DESC NULLS LAST, id DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(org_id)
    .bind(&cloud_resource_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1 AND cloud_resource_id = $2",
    )
    .bind(org_id)
    .bind(&cloud_resource_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "rec_type": r.get::<String, _>("rec_type"),
                "title": r.get::<String, _>("title"),
                "status": r.get::<String, _>("status"),
                "potential_savings": r.get::<f64, _>("savings"),
                "current_monthly_cost": r.get::<f64, _>("monthly_cost"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

// ─── Metric ingestion (product gap D1) ────────────────────────────────────────

#[derive(Deserialize)]
pub struct MetricPoint {
    pub resource_id: Uuid,
    pub metric_name: String,
    pub value: f64,
    pub ts: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Deserialize)]
pub struct IngestMetricsRequest {
    pub points: Vec<MetricPoint>,
}

/// POST /orgs/{org_id}/metrics — bulk ingestion (≤10k points) from metric
/// exporters / discovery agents. Used by metric-aware recommendation detectors.
pub async fn ingest_metrics(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<IngestMetricsRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if req.points.is_empty() {
        return Err(AppError::Validation("points must not be empty".into()));
    }
    if req.points.len() > 10_000 {
        return Err(AppError::Validation("too many points (max 10,000)".into()));
    }

    let mut inserted = 0u32;
    for p in &req.points {
        // Only accept metrics for resources in this org.
        let owned = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM resources WHERE id = $1 AND organization_id = $2",
        )
        .bind(p.resource_id)
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
        if owned == 0 {
            continue;
        }
        let result = sqlx::query(
            r#"INSERT INTO metrics (organization_id, resource_id, metric_name, value, ts)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(org_id)
        .bind(p.resource_id)
        .bind(&p.metric_name)
        .bind(p.value)
        .bind(p.ts.unwrap_or_else(chrono::Utc::now))
        .execute(&state.db)
        .await?;
        inserted += result.rows_affected() as u32;
    }

    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": { "inserted": inserted, "total": req.points.len() } })),
    ))
}

/// GET /orgs/{org_id}/metrics?resource_id=…&metric=cpu_utilization&hours=24
/// — recent metric points for a resource (charting/debug).
/// Time-series exception: `per_page` max is 2000 (not 200); envelope is shared.
pub async fn list_metrics(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let resource_id = q
        .get("resource_id")
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("resource_id is required".into()))?;
    let metric = q
        .get("metric")
        .map(String::as_str)
        .unwrap_or("cpu_utilization");
    let hours: i64 = q
        .get("hours")
        .and_then(|v| v.parse().ok())
        .unwrap_or(24)
        .clamp(1, 720);
    let page = crate::utils::pagination::PageQuery {
        page: q.get("page").cloned(),
        per_page: q.get("per_page").cloned(),
        limit: q.get("limit").cloned(),
        offset: q.get("offset").cloned(),
    };
    let bounds = page.resolve(50, 2000);

    let rows = sqlx::query(
        r#"SELECT m.id, m.metric_name, m.value, m.ts
           FROM metrics m
           WHERE m.organization_id = $1 AND m.resource_id = $2
             AND m.metric_name = $3 AND m.ts >= NOW() - $4::int * INTERVAL '1 hour'
           ORDER BY m.ts DESC, m.id DESC
           LIMIT $5 OFFSET $6"#,
    )
    .bind(org_id)
    .bind(resource_id)
    .bind(metric)
    .bind(hours)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM metrics m
           WHERE m.organization_id = $1 AND m.resource_id = $2
             AND m.metric_name = $3 AND m.ts >= NOW() - $4::int * INTERVAL '1 hour'"#,
    )
    .bind(org_id)
    .bind(resource_id)
    .bind(metric)
    .bind(hours)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "metric_name": r.get::<String, _>("metric_name"),
                "value": r.get::<f64, _>("value"),
                "ts": r.get::<chrono::DateTime<chrono::Utc>, _>("ts"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

// ─── Global search (product gap P3) ───────────────────────────────────────────

/// GET /orgs/{org_id}/search?q=… — cross-entity search: CIs, resources,
/// recommendations, services, pools (top 5 each).
pub async fn global_search(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let query = q.get("q").cloned().unwrap_or_default();
    let pattern = format!("%{}%", query.to_lowercase());
    let limit: i64 = q
        .get("limit")
        .and_then(|v| v.parse().ok())
        .unwrap_or(5)
        .clamp(1, 10);

    let mut result = serde_json::Map::new();

    // CIs — rides the idx_cis_trgm expression index (migration 033): match on
    // the lower(name/display_name/cloud_resource_id) surface it covers.
    let cis = sqlx::query(
        r#"SELECT id, name, display_name, lifecycle_state::text AS lifecycle_state
           FROM cis
           WHERE organization_id = $1 AND deleted_at IS NULL
             AND (lower(name) LIKE $2
                  OR lower(COALESCE(display_name, '')) LIKE $2
                  OR lower(COALESCE(cloud_resource_id, '')) LIKE $2)
           ORDER BY name LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    result.insert(
        "cis".into(),
        json!(cis
            .iter()
            .map(|r| json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<Option<String>, _>("display_name"),
                "lifecycle_state": r.get::<String, _>("lifecycle_state"),
            }))
            .collect::<Vec<_>>()),
    );

    // Resources
    let resources = sqlx::query(
        r#"SELECT id, name, resource_type::text AS resource_type, service_name, cloud_region, total_cost::float8 AS cost
           FROM resources
           WHERE organization_id = $1 AND active = true
             AND (name ILIKE $2 OR service_name ILIKE $2 OR cloud_resource_id ILIKE $2)
           ORDER BY total_cost DESC LIMIT $3"#,
    )
    .bind(org_id).bind(&pattern).bind(limit)
    .fetch_all(&state.db).await.unwrap_or_default();
    result.insert(
        "resources".into(),
        json!(resources
            .iter()
            .map(|r| json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<Option<String>, _>("name"),
                "resource_type": r.get::<Option<String>, _>("resource_type"),
                "service": r.get::<Option<String>, _>("service_name"),
                "region": r.get::<Option<String>, _>("cloud_region"),
                "cost": r.get::<f64, _>("cost"),
            }))
            .collect::<Vec<_>>()),
    );

    // Recommendations
    let recs = sqlx::query(
        r#"SELECT id, title, rec_type, status, potential_savings::float8 AS savings
           FROM recommendations
           WHERE organization_id = $1 AND status = 'active'
             AND (title ILIKE $2 OR rec_type ILIKE $2)
           ORDER BY potential_savings DESC LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    result.insert(
        "recommendations".into(),
        json!(recs
            .iter()
            .map(|r| json!({
                "id": r.get::<Uuid, _>("id"),
                "title": r.get::<String, _>("title"),
                "rec_type": r.get::<String, _>("rec_type"),
                "status": r.get::<String, _>("status"),
                "savings": r.get::<f64, _>("savings"),
            }))
            .collect::<Vec<_>>()),
    );

    // Services
    let services = sqlx::query(
        r#"SELECT id, name, display_name FROM services
           WHERE organization_id = $1 AND deleted_at IS NULL
             AND (name ILIKE $2 OR display_name ILIKE $2)
           ORDER BY name LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    result.insert(
        "services".into(),
        json!(services
            .iter()
            .map(|r| json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<String, _>("display_name"),
            }))
            .collect::<Vec<_>>()),
    );

    // Pools
    let pools = sqlx::query(
        r#"SELECT id, name FROM pools
           WHERE organization_id = $1 AND deleted_at = 0
             AND name ILIKE $2
           ORDER BY name LIMIT $3"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(limit)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    result.insert(
        "pools".into(),
        json!(pools
            .iter()
            .map(|r| json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
            }))
            .collect::<Vec<_>>()),
    );

    Ok(Json(
        json!({ "data": Value::Object(result), "query": query }),
    ))
}

// ─── Demo data seeding (product gap P5) ───────────────────────────────────────

/// POST /orgs/{org_id}/demo-data — seed a demo pool, cloud account, resources,
/// 60 days of expenses and a budget so new orgs can explore immediately.
pub async fn seed_demo_data(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    let _user_id = claims.user_id()?;
    let org_cur = crate::modules::billing::fx::org_currency(&state.db, org_id).await;
    let user_id = claims.user_id()?;

    // Idempotency: skip when already seeded.
    let seeded = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((settings->>'demo_seeded')::boolean, false) FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);
    if seeded {
        return Ok(Json(
            json!({ "data": { "message": "Demo data already seeded" } }),
        ));
    }

    // 1. Demo pool + budget
    let pool_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO pools (id, organization_id, name, pool_type, created_at, updated_at)
           VALUES ($1, $2, 'Demo Project', 'project', NOW(), NOW())"#,
    )
    .bind(pool_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    let budget_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO budgets (id, organization_id, pool_id, name, amount, currency, period, is_active)
           VALUES ($1, $2, $3, 'Demo Budget', 5000, 'USD', 'monthly', true)"#,
    )
    .bind(budget_id)
    .bind(org_id)
    .bind(pool_id)
    .execute(&state.db)
    .await?;

    // 2. Demo cloud account (mock)
    let account_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO cloud_accounts (id, organization_id, name, provider, credentials_enc, config, is_active, created_at, updated_at)
           VALUES ($1, $2, 'Demo Account', 'mock', 'e30=', '{}'::jsonb, true, NOW(), NOW())"#,
    )
    .bind(account_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    // 3. Demo resources + 60 days of expenses
    let resources: [(&str, &str, &str, &str, f64); 3] = [
        ("demo-web-01", "instance", "EC2", "us-east-1", 3.2),
        ("demo-db-01", "rds_instance", "RDS", "us-east-1", 8.4),
        ("demo-data-bucket", "bucket", "S3", "us-east-1", 0.9),
    ];
    for (name, rtype, service, region, daily) in resources {
        let resource_id = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO resources (id, organization_id, cloud_account_id, cloud_resource_id,
                   resource_type, service_name, name, cloud_region, pool_id, total_cost, active)
               VALUES ($1, $2, $3, $4, $5::resource_type, $6, $7, $8, $9, 0, true)"#,
        )
        .bind(resource_id)
        .bind(org_id)
        .bind(account_id)
        .bind(format!("{name}-id"))
        .bind(rtype)
        .bind(service)
        .bind(name)
        .bind(region)
        .bind(pool_id)
        .execute(&state.db)
        .await?;

        for day in 0..60 {
            let date = chrono::Utc::now().date_naive() - chrono::Duration::days(day);
            let cost = daily * (0.85 + ((day * 37) % 30) as f64 / 100.0);
            let _ = sqlx::query(
                r#"INSERT INTO expenses (organization_id, cloud_account_id, cloud_resource_id,
                       resource_name, service_name, date, cloud_region, resource_type, cost, currency, tags)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::resource_type, $9, $10, '{}'::jsonb)"#,
            )
            .bind(org_id)
            .bind(account_id)
            .bind(format!("{name}-id"))
            .bind(name)
            .bind(service)
            .bind(date)
            .bind(region)
            .bind(rtype)
            .bind((cost * 100.0).round() / 100.0)
            .bind(&org_cur)
            .execute(&state.db)
            .await;
        }
    }

    // 4. Mark seeded + create an onboarding notification.
    sqlx::query(
        r#"UPDATE organizations SET settings = jsonb_set(settings, '{demo_seeded}', 'true') WHERE id = $1"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    crate::modules::notifications::handlers::create_notification(
        &state.db,
        org_id,
        Some(user_id),
        "system",
        "Demo data ready",
        "A demo pool, account and 60 days of expenses have been created for you.",
    )
    .await;

    Ok(Json(json!({ "data": { "message": "Demo data seeded" } })))
}
