use axum::{
    extract::{Extension, Path, State},
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

async fn ensure_org_member(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
    sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateServiceRequest {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub service_type: Option<String>,
    pub owner_id: Option<Uuid>,
    pub pool_id: Option<Uuid>,
    pub tags: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct AddServiceCiRequest {
    pub ci_id: Uuid,
    pub role: Option<String>,
}

pub async fn list_services(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, display_name, description, service_type, owner_id, pool_id, tags, created_at, updated_at
           FROM services WHERE organization_id = $1 AND deleted_at IS NULL
           ORDER BY name ASC, id ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM services WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":           r.try_get::<Uuid, _>("id").ok(),
                "name":         r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name": r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "description":  r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "service_type": r.try_get::<String, _>("service_type").unwrap_or_else(|_| "application".into()),
                "owner_id":     r.try_get::<Option<Uuid>, _>("owner_id").unwrap_or(None),
                "pool_id":      r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
                "tags":         r.try_get::<Value, _>("tags").unwrap_or(json!({})),
                "created_at":   r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "updated_at":   r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_service(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateServiceRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let id = Uuid::new_v4();
    let service_type = body.service_type.unwrap_or_else(|| "application".into());
    let tags = body.tags.unwrap_or(json!({}));

    sqlx::query(
        r#"INSERT INTO services (id, organization_id, name, display_name, description, service_type, owner_id, pool_id, tags, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.display_name.as_deref())
    .bind(body.description.as_deref())
    .bind(&service_type)
    .bind(body.owner_id)
    .bind(body.pool_id)
    .bind(&tags)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service",
        "create",
        &id.to_string(),
        &body.name,
        None,
        Some(&json!({ "name": body.name, "service_type": service_type })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "service_type": service_type,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn get_service(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT id, name, display_name, description, service_type, owner_id, pool_id, tags, created_at, updated_at
           FROM services WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Service {service_id} not found")))?;

    Ok(Json(json!({
        "data": {
            "id":           row.try_get::<Uuid, _>("id").ok(),
            "name":         row.try_get::<String, _>("name").unwrap_or_default(),
            "display_name": row.try_get::<Option<String>, _>("display_name").unwrap_or(None),
            "description":  row.try_get::<Option<String>, _>("description").unwrap_or(None),
            "service_type": row.try_get::<String, _>("service_type").unwrap_or_default(),
            "owner_id":     row.try_get::<Option<Uuid>, _>("owner_id").unwrap_or(None),
            "pool_id":      row.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
            "tags":         row.try_get::<Value, _>("tags").unwrap_or(json!({})),
            "created_at":   row.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            "updated_at":   row.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
        }
    })))
}

pub async fn update_service(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateServiceRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE services SET
               name         = $3,
               display_name = COALESCE($4, display_name),
               description  = COALESCE($5, description),
               service_type = COALESCE($6, service_type),
               owner_id     = COALESCE($7, owner_id),
               pool_id      = COALESCE($8, pool_id),
               tags         = COALESCE($9, tags),
               updated_at   = NOW()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(service_id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.display_name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.service_type.as_deref())
    .bind(body.owner_id)
    .bind(body.pool_id)
    .bind(body.tags)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Service {service_id} not found")));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service",
        "update",
        &service_id.to_string(),
        &body.name,
        Some(&json!({ "update": { "display_name": body.display_name, "service_type": body.service_type, "owner_id": body.owner_id, "pool_id": body.pool_id } })),
        None,
    )
    .await;

    Ok(Json(json!({ "data": { "id": service_id, "message": "Updated" } })))
}

pub async fn delete_service(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "UPDATE services SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(service_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Service {service_id} not found")));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service",
        "delete",
        &service_id.to_string(),
        "",
        Some(&json!({ "service_id": service_id })),
        None,
    )
    .await;

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

pub async fn list_service_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let service = sqlx::query(
        "SELECT id FROM services WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    if service.is_none() {
        return Err(AppError::NotFound(format!("Service {service_id} not found")));
    }

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT sc.id, sc.ci_id, sc.role, c.name AS ci_name, sc.created_at
           FROM service_cis sc
           JOIN cis c ON c.id = sc.ci_id
           WHERE sc.service_id = $1
           ORDER BY sc.created_at ASC, sc.id ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(service_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_cis WHERE service_id = $1")
        .bind(service_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":         r.try_get::<Uuid, _>("id").ok(),
                "ci_id":      r.try_get::<Uuid, _>("ci_id").ok(),
                "ci_name":    r.try_get::<String, _>("ci_name").unwrap_or_default(),
                "role":       r.try_get::<Option<String>, _>("role").unwrap_or(None),
                "created_at": r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn add_service_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<AddServiceCiRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let service = sqlx::query(
        "SELECT id FROM services WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    if service.is_none() {
        return Err(AppError::NotFound(format!("Service {service_id} not found")));
    }

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO service_cis (id, service_id, ci_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(service_id)
    .bind(body.ci_id)
    .bind(body.role.as_deref())
    .execute(&state.db)
    .await?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service",
        "add_ci",
        &service_id.to_string(),
        "",
        None,
        Some(&json!({ "ci_id": body.ci_id, "role": body.role })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "service_id": service_id,
                "ci_id": body.ci_id,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn remove_service_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id, ci_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"DELETE FROM service_cis
           WHERE ci_id = $1 AND service_id = $2
           AND EXISTS (SELECT 1 FROM services WHERE id = $2 AND organization_id = $3)"#,
    )
    .bind(ci_id)
    .bind(service_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("CI not found in service".into()));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service",
        "remove_ci",
        &service_id.to_string(),
        "",
        Some(&json!({ "ci_id": ci_id })),
        None,
    )
    .await;

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

// ─── Service Cost Rollup ─────────────────────────────────────────────────────

/// Returns aggregated expense cost for all CIs belonging to a service (last 30 days).
pub async fn get_service_costs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, service_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Verify service exists and belongs to this org
    let service = sqlx::query(
        "SELECT id, name FROM services WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Service {service_id} not found")))?;

    let service_name: String = service.try_get("name").unwrap_or_default();

    // Sum all expenses from the last 30 days for CIs linked to this service.
    // Join: service_cis → cis → expenses (matching cloud_resource_id)
    let rows = sqlx::query(
        r#"SELECT
               c.id AS ci_id,
               c.name AS ci_name,
               c.cloud_resource_id,
               COALESCE(SUM(e.cost), 0)::float8 AS total_cost,
               COUNT(e.id) AS expense_rows
           FROM service_cis sc
           JOIN cis c ON c.id = sc.ci_id AND c.deleted_at IS NULL
           LEFT JOIN expenses e
               ON e.cloud_resource_id = c.cloud_resource_id
               AND e.date >= (CURRENT_DATE - INTERVAL '30 days')
           WHERE sc.service_id = $1
             AND c.organization_id = $2
           GROUP BY c.id, c.name, c.cloud_resource_id
           ORDER BY total_cost DESC"#,
    )
    .bind(service_id)
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut grand_total: f64 = 0.0;
    let ci_costs: Vec<Value> = rows
        .iter()
        .map(|r| {
            let cost: f64 = r.try_get("total_cost").unwrap_or(0.0);
            grand_total += cost;
            json!({
                "ci_id":            r.try_get::<Uuid, _>("ci_id").ok(),
                "ci_name":          r.try_get::<String, _>("ci_name").unwrap_or_default(),
                "cloud_resource_id":r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
                "total_cost":       cost,
                "expense_rows":     r.try_get::<i64, _>("expense_rows").unwrap_or(0),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": {
            "service_id":       service_id,
            "service_name":     service_name,
            "period_days":      30,
            "total_cost":       grand_total,
            "currency":         "USD",
            "ci_count":         ci_costs.len(),
            "ci_costs":         ci_costs,
        }
    })))
}
