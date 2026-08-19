use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

#[derive(Deserialize, Default)]
pub struct WorkloadListParams {
    pub cluster_id: Option<Uuid>,
    pub namespace: Option<String>,
    pub min_savings: Option<f64>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

#[derive(Deserialize)]
pub struct UpsertClusterRequest {
    pub name: String,
    pub region: Option<String>,
    pub provider: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    pub node_count: Option<i32>,
    pub total_vcpu: Option<f64>,
    pub total_memory_gb: Option<f64>,
    pub monthly_cost: Option<f64>,
}

#[derive(Deserialize)]
pub struct UpsertWorkloadRequest {
    pub cluster_id: Uuid,
    pub namespace: String,
    pub workload_name: String,
    pub workload_type: Option<String>,
    pub container_name: Option<String>,
    pub cpu_request_m: Option<i32>,
    pub mem_request_mi: Option<i32>,
    pub cpu_limit_m: Option<i32>,
    pub mem_limit_mi: Option<i32>,
    pub cpu_p95_m: Option<f64>,
    pub mem_p95_mi: Option<f64>,
    pub cpu_rec_m: Option<i32>,
    pub mem_rec_mi: Option<i32>,
    pub monthly_cost: Option<f64>,
    pub potential_savings: Option<f64>,
    pub observation_days: Option<i32>,
}

// ─── Clusters ─────────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/k8s/clusters
pub async fn list_clusters(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT c.id, c.name, c.region, c.provider, c.node_count,
                  c.total_vcpu::float8, c.total_memory_gb::float8, c.monthly_cost::float8, c.last_synced_at,
                  COUNT(w.id)                       AS workload_count,
                  COALESCE(SUM(w.potential_savings), 0)::float8 AS total_savings
           FROM k8s_clusters c
           LEFT JOIN k8s_workload_metrics w ON w.cluster_id = c.id
           WHERE c.organization_id = $1
           GROUP BY c.id
           ORDER BY total_savings DESC NULLS LAST, c.id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM k8s_clusters WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "id":             r.try_get::<Uuid, _>("id").ok(),
        "name":           r.try_get::<String, _>("name").unwrap_or_default(),
        "region":         r.try_get::<Option<String>, _>("region").unwrap_or(None),
        "provider":       r.try_get::<Option<String>, _>("provider").unwrap_or(None),
        "node_count":     r.try_get::<Option<i32>, _>("node_count").unwrap_or(None),
        "total_vcpu":     r.try_get::<Option<f64>, _>("total_vcpu").unwrap_or(None),
        "total_memory_gb":r.try_get::<Option<f64>, _>("total_memory_gb").unwrap_or(None),
        "monthly_cost":   r.try_get::<Option<f64>, _>("monthly_cost").unwrap_or(None),
        "workload_count": r.try_get::<i64, _>("workload_count").unwrap_or(0),
        "total_savings":  r.try_get::<f64, _>("total_savings").unwrap_or(0.0),
        "last_synced_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_synced_at").unwrap_or(None),
    })).collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// POST /api/v1/orgs/{org_id}/k8s/clusters
pub async fn upsert_cluster(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<UpsertClusterRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let row = sqlx::query(
        r#"INSERT INTO k8s_clusters
               (organization_id, cloud_account_id, name, region, provider,
                node_count, total_vcpu, total_memory_gb, monthly_cost, last_synced_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
           ON CONFLICT (organization_id, name)
           DO UPDATE SET
               region           = EXCLUDED.region,
               provider         = EXCLUDED.provider,
               node_count       = EXCLUDED.node_count,
               total_vcpu       = EXCLUDED.total_vcpu,
               total_memory_gb  = EXCLUDED.total_memory_gb,
               monthly_cost     = EXCLUDED.monthly_cost,
               last_synced_at   = NOW(),
               updated_at       = NOW()
           RETURNING id, name, created_at"#,
    )
    .bind(org_id)
    .bind(body.cloud_account_id)
    .bind(body.name.trim())
    .bind(body.region.as_deref())
    .bind(body.provider.as_deref())
    .bind(body.node_count)
    .bind(body.total_vcpu)
    .bind(body.total_memory_gb)
    .bind(body.monthly_cost)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": {
                "id":   row.try_get::<Uuid, _>("id").ok(),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
            }
        })),
    ))
}

// ─── Workloads ────────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/k8s/workloads
pub async fn list_workloads(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(params): Query<WorkloadListParams>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = params.page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT w.id, w.cluster_id, c.name AS cluster_name, w.namespace, w.workload_name,
                  w.workload_type, w.container_name,
                  w.cpu_request_m, w.mem_request_mi, w.cpu_limit_m, w.mem_limit_mi,
                  w.cpu_p95_m::float8, w.mem_p95_mi::float8, w.cpu_rec_m, w.mem_rec_mi,
                  w.monthly_cost::float8, w.potential_savings::float8, w.observation_days, w.evaluated_at
           FROM k8s_workload_metrics w
           JOIN k8s_clusters c ON c.id = w.cluster_id
           WHERE w.organization_id = $1
             AND ($2::uuid IS NULL OR w.cluster_id = $2)
             AND ($3::text IS NULL OR w.namespace = $3)
             AND ($4::float8 IS NULL OR w.potential_savings >= $4)
           ORDER BY w.potential_savings DESC NULLS LAST, w.id DESC
           LIMIT $5 OFFSET $6"#,
    )
    .bind(org_id)
    .bind(params.cluster_id)
    .bind(params.namespace.as_deref())
    .bind(params.min_savings)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM k8s_workload_metrics w
           WHERE w.organization_id = $1
             AND ($2::uuid IS NULL OR w.cluster_id = $2)
             AND ($3::text IS NULL OR w.namespace = $3)
             AND ($4::float8 IS NULL OR w.potential_savings >= $4)"#,
    )
    .bind(org_id)
    .bind(params.cluster_id)
    .bind(params.namespace.as_deref())
    .bind(params.min_savings)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "id":               r.try_get::<Uuid, _>("id").ok(),
        "cluster_id":       r.try_get::<Uuid, _>("cluster_id").ok(),
        "cluster_name":     r.try_get::<String, _>("cluster_name").unwrap_or_default(),
        "namespace":        r.try_get::<String, _>("namespace").unwrap_or_default(),
        "workload_name":    r.try_get::<String, _>("workload_name").unwrap_or_default(),
        "workload_type":    r.try_get::<String, _>("workload_type").unwrap_or_default(),
        "container_name":   r.try_get::<Option<String>, _>("container_name").unwrap_or(None),
        "cpu_request_m":    r.try_get::<Option<i32>, _>("cpu_request_m").unwrap_or(None),
        "mem_request_mi":   r.try_get::<Option<i32>, _>("mem_request_mi").unwrap_or(None),
        "cpu_limit_m":      r.try_get::<Option<i32>, _>("cpu_limit_m").unwrap_or(None),
        "mem_limit_mi":     r.try_get::<Option<i32>, _>("mem_limit_mi").unwrap_or(None),
        "cpu_p95_m":        r.try_get::<Option<f64>, _>("cpu_p95_m").unwrap_or(None),
        "mem_p95_mi":       r.try_get::<Option<f64>, _>("mem_p95_mi").unwrap_or(None),
        "cpu_rec_m":        r.try_get::<Option<i32>, _>("cpu_rec_m").unwrap_or(None),
        "mem_rec_mi":       r.try_get::<Option<i32>, _>("mem_rec_mi").unwrap_or(None),
        "monthly_cost":     r.try_get::<Option<f64>, _>("monthly_cost").unwrap_or(None),
        "potential_savings":r.try_get::<Option<f64>, _>("potential_savings").unwrap_or(None),
        "observation_days": r.try_get::<i32, _>("observation_days").unwrap_or(14),
        "evaluated_at":     r.try_get::<chrono::DateTime<Utc>, _>("evaluated_at").ok(),
    })).collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// POST /api/v1/orgs/{org_id}/k8s/workloads
pub async fn upsert_workload(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<UpsertWorkloadRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.workload_name.trim().is_empty() || body.namespace.trim().is_empty() {
        return Err(AppError::Validation(
            "workload_name and namespace are required".into(),
        ));
    }

    let wt = body.workload_type.as_deref().unwrap_or("Deployment");

    let row = sqlx::query(
        r#"INSERT INTO k8s_workload_metrics
               (organization_id, cluster_id, namespace, workload_name, workload_type, container_name,
                cpu_request_m, mem_request_mi, cpu_limit_m, mem_limit_mi,
                cpu_p95_m, mem_p95_mi, cpu_rec_m, mem_rec_mi,
                monthly_cost, potential_savings, observation_days, evaluated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
           ON CONFLICT (organization_id, cluster_id, namespace, workload_name, (COALESCE(container_name, '')))
           DO UPDATE SET
               cpu_request_m    = EXCLUDED.cpu_request_m,
               mem_request_mi   = EXCLUDED.mem_request_mi,
               cpu_p95_m        = EXCLUDED.cpu_p95_m,
               mem_p95_mi       = EXCLUDED.mem_p95_mi,
               cpu_rec_m        = EXCLUDED.cpu_rec_m,
               mem_rec_mi       = EXCLUDED.mem_rec_mi,
               monthly_cost     = EXCLUDED.monthly_cost,
               potential_savings = EXCLUDED.potential_savings,
               observation_days = EXCLUDED.observation_days,
               evaluated_at     = NOW()
           RETURNING id"#,
    )
    .bind(org_id).bind(body.cluster_id)
    .bind(body.namespace.trim()).bind(body.workload_name.trim()).bind(wt)
    .bind(body.container_name.as_deref())
    .bind(body.cpu_request_m).bind(body.mem_request_mi)
    .bind(body.cpu_limit_m).bind(body.mem_limit_mi)
    .bind(body.cpu_p95_m).bind(body.mem_p95_mi)
    .bind(body.cpu_rec_m).bind(body.mem_rec_mi)
    .bind(body.monthly_cost).bind(body.potential_savings)
    .bind(body.observation_days.unwrap_or(14))
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": { "id": row.try_get::<Uuid, _>("id").ok() }
        })),
    ))
}

/// GET /api/v1/orgs/{org_id}/k8s/summary
pub async fn rightsizing_summary(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let totals = sqlx::query(
        r#"SELECT COUNT(DISTINCT cluster_id)                         AS cluster_count,
                  COUNT(DISTINCT (cluster_id, namespace))            AS namespace_count,
                  COUNT(*)                                           AS workload_count,
                  COALESCE(SUM(potential_savings), 0)::float8        AS total_savings,
                  COALESCE(SUM(monthly_cost), 0)::float8             AS total_cost
           FROM k8s_workload_metrics
           WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    let by_namespace = sqlx::query(
        r#"SELECT namespace, cluster_id,
                  COUNT(*) AS workload_count,
                  COALESCE(SUM(potential_savings), 0)::float8 AS namespace_savings
           FROM k8s_workload_metrics
           WHERE organization_id = $1
           GROUP BY namespace, cluster_id
           ORDER BY namespace_savings DESC
           LIMIT 10"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let ns_data: Vec<Value> = by_namespace
        .iter()
        .map(|r| {
            json!({
                "namespace":       r.try_get::<String, _>("namespace").unwrap_or_default(),
                "cluster_id":      r.try_get::<Uuid, _>("cluster_id").ok(),
                "workload_count":  r.try_get::<i64, _>("workload_count").unwrap_or(0),
                "potential_savings": r.try_get::<f64, _>("namespace_savings").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({
        "cluster_count":   totals.try_get::<i64, _>("cluster_count").unwrap_or(0),
        "namespace_count": totals.try_get::<i64, _>("namespace_count").unwrap_or(0),
        "workload_count":  totals.try_get::<i64, _>("workload_count").unwrap_or(0),
        "total_savings":   totals.try_get::<f64, _>("total_savings").unwrap_or(0.0),
        "total_cost":      totals.try_get::<f64, _>("total_cost").unwrap_or(0.0),
        "top_namespaces":  ns_data,
    })))
}
