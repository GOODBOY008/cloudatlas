use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use super::dto::{CreateCostCenterRequest, UpdateCostCenterRequest};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let row = sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    if row.is_none() {
        return Err(AppError::Forbidden(
            "You are not a member of this organization".into(),
        ));
    }
    Ok(())
}

fn row_to_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id":              r.try_get::<Uuid, _>("id").ok(),
        "organization_id": r.try_get::<Uuid, _>("organization_id").ok(),
        "code":            r.try_get::<String, _>("code").unwrap_or_default(),
        "name":            r.try_get::<String, _>("name").unwrap_or_default(),
        "description":     r.try_get::<Option<String>, _>("description").unwrap_or(None),
        "parent_id":       r.try_get::<Option<Uuid>, _>("parent_id").unwrap_or(None),
        "owner_id":        r.try_get::<Option<Uuid>, _>("owner_id").unwrap_or(None),
        "created_at":      r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
        "updated_at":      r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
    })
}

// ─── list_cost_centers ────────────────────────────────────────────────────────

pub async fn list_cost_centers(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let rows = sqlx::query(
        "SELECT id, organization_id, code, name, description, parent_id, owner_id, created_at, updated_at
         FROM cost_centers
         WHERE organization_id = $1
         ORDER BY name",
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows.iter().map(row_to_json).collect();
    Ok(Json(
        json!({ "data": data, "meta": { "total": data.len() } }),
    ))
}

// ─── create_cost_center ───────────────────────────────────────────────────────

pub async fn create_cost_center(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateCostCenterRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.code.trim().is_empty() {
        return Err(AppError::Validation(
            "Cost center code cannot be empty".into(),
        ));
    }
    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Cost center name cannot be empty".into(),
        ));
    }

    let row = sqlx::query(
        r#"INSERT INTO cost_centers (id, organization_id, code, name, description, parent_id, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, organization_id, code, name, description, parent_id, owner_id, created_at, updated_at"#,
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(body.code.trim())
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.parent_id)
    .bind(body.owner_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A cost center with this code already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": row_to_json(&row) })),
    ))
}

// ─── get_cost_center ──────────────────────────────────────────────────────────

pub async fn get_cost_center(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let row = sqlx::query(
        "SELECT id, organization_id, code, name, description, parent_id, owner_id, created_at, updated_at
         FROM cost_centers WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cost center not found".into()))?;

    let org_id: Uuid = row
        .try_get("organization_id")
        .map_err(|_| AppError::NotFound("Cost center not found".into()))?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    Ok(Json(json!({ "data": row_to_json(&row) })))
}

// ─── update_cost_center ───────────────────────────────────────────────────────

pub async fn update_cost_center(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateCostCenterRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let existing = sqlx::query("SELECT organization_id FROM cost_centers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Cost center not found".into()))?;

    let org_id: Uuid = existing
        .try_get("organization_id")
        .map_err(|_| AppError::NotFound("Cost center not found".into()))?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let now = Utc::now();
    let row = sqlx::query(
        r#"UPDATE cost_centers
           SET code        = COALESCE($2, code),
               name        = COALESCE($3, name),
               description = COALESCE($4, description),
               parent_id   = COALESCE($5, parent_id),
               owner_id    = COALESCE($6, owner_id),
               updated_at  = $7
           WHERE id = $1
           RETURNING id, organization_id, code, name, description, parent_id, owner_id, created_at, updated_at"#,
    )
    .bind(id)
    .bind(body.code.as_deref())
    .bind(body.name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.parent_id)
    .bind(body.owner_id)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cost center not found".into()))?;

    Ok(Json(json!({ "data": row_to_json(&row) })))
}

// ─── delete_cost_center ───────────────────────────────────────────────────────

pub async fn delete_cost_center(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;

    let existing = sqlx::query("SELECT organization_id FROM cost_centers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Cost center not found".into()))?;

    let org_id: Uuid = existing
        .try_get("organization_id")
        .map_err(|_| AppError::NotFound("Cost center not found".into()))?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query("DELETE FROM cost_centers WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Cost center not found".into()));
    }

    Ok((
        StatusCode::OK,
        Json(json!({ "data": { "message": "Cost center deleted" } })),
    ))
}

// ─── cost_center_expenses ─────────────────────────────────────────────────────

pub async fn cost_center_expenses(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let existing = sqlx::query("SELECT organization_id FROM cost_centers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Cost center not found".into()))?;

    let org_id: Uuid = existing
        .try_get("organization_id")
        .map_err(|_| AppError::NotFound("Cost center not found".into()))?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Aggregate expenses from all business capabilities linked to this cost center,
    // via their associated CIs' cloud_resource_ids in expenses.
    let row = sqlx::query(
        r#"SELECT
               COALESCE(SUM(e.cost)::float8, 0) AS total_cost,
               COUNT(DISTINCT e.cloud_resource_id) AS resource_count
           FROM expenses e
           JOIN cis c ON c.cloud_resource_id = e.cloud_resource_id
               AND c.organization_id = e.organization_id
           JOIN service_cis sc ON sc.ci_id = c.id
           JOIN services svc ON svc.id = sc.service_id
           JOIN business_capabilities bc ON bc.name = svc.name
               AND bc.organization_id = e.organization_id
           WHERE bc.cost_center_id = $1
             AND e.date >= DATE_TRUNC('month', CURRENT_DATE)::date"#,
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    // Fall back gracefully if the join path yields no data
    let (total_cost, resource_count) = match row {
        Ok(Some(r)) => (
            r.try_get::<f64, _>("total_cost").unwrap_or(0.0),
            r.try_get::<i64, _>("resource_count").unwrap_or(0),
        ),
        _ => (0.0, 0),
    };

    Ok(Json(json!({
        "data": {
            "cost_center_id":    id,
            "total_cost":        total_cost,
            "resource_count":    resource_count,
            "period":            "current_month",
        }
    })))
}

// ─── Business Capabilities (T17 — gap closure) ───────────────────────────────

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub struct CreateBusinessCapabilityRequest {
    pub name: String,
    pub description: Option<String>,
    /// Owning cost center (validated against the org).
    pub cost_center_id: Option<Uuid>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
pub struct UpdateBusinessCapabilityRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub cost_center_id: Option<Uuid>,
}

/// GET /api/v1/orgs/{org_id}/business-capabilities
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/business-capabilities",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Business capabilities with their cost centers"),
    ),
    security(("bearer_auth" = [])),
    tag = "expenses",
)]
pub async fn list_business_capabilities(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let rows = sqlx::query(
        r#"SELECT bc.id, bc.name, bc.description, bc.cost_center_id, bc.created_at,
                  cc.code AS cost_center_code, cc.name AS cost_center_name
           FROM business_capabilities bc
           LEFT JOIN cost_centers cc ON cc.id = bc.cost_center_id
           WHERE bc.organization_id = $1
           ORDER BY bc.name"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<Uuid, _>("id").ok(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "description": r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "cost_center_id": r.try_get::<Option<Uuid>, _>("cost_center_id").unwrap_or(None),
                "cost_center_code": r.try_get::<Option<String>, _>("cost_center_code").unwrap_or(None),
                "cost_center_name": r.try_get::<Option<String>, _>("cost_center_name").unwrap_or(None),
                "created_at": r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

/// POST /api/v1/orgs/{org_id}/business-capabilities
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/business-capabilities",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = CreateBusinessCapabilityRequest,
    responses(
        (status = 201, description = "Capability created"),
        (status = 422, description = "Name empty or cost_center_id not in org"),
    ),
    security(("bearer_auth" = [])),
    tag = "expenses",
)]
pub async fn create_business_capability(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateBusinessCapabilityRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Capability name cannot be empty".into(),
        ));
    }
    if let Some(cc_id) = body.cost_center_id {
        let ok = sqlx::query("SELECT id FROM cost_centers WHERE id = $1 AND organization_id = $2")
            .bind(cc_id)
            .bind(org_id)
            .fetch_optional(&state.db)
            .await?;
        if ok.is_none() {
            return Err(AppError::Validation(
                "cost_center_id does not belong to this organization".into(),
            ));
        }
    }

    let row = sqlx::query(
        r#"INSERT INTO business_capabilities (organization_id, name, description, cost_center_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, created_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(body.cost_center_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A business capability with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "name": row.get::<String, _>("name"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

/// PUT /api/v1/business-capabilities/{id}
#[utoipa::path(
    put,
    path = "/api/v1/business-capabilities/{id}",
    params(("id" = Uuid, Path, description = "Capability ID")),
    request_body = UpdateBusinessCapabilityRequest,
    responses(
        (status = 200, description = "Capability updated"),
        (status = 404, description = "Capability not found"),
        (status = 422, description = "cost_center_id not in org"),
    ),
    security(("bearer_auth" = [])),
    tag = "expenses",
)]
pub async fn update_business_capability(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(capability_id): Path<Uuid>,
    Json(body): Json<UpdateBusinessCapabilityRequest>,
) -> AppResult<Json<Value>> {
    // Org derived from the existing row.
    let existing =
        sqlx::query("SELECT id, organization_id FROM business_capabilities WHERE id = $1")
            .bind(capability_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Business capability not found".into()))?;
    let org_id: Uuid = existing.try_get("organization_id")?;

    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if let Some(cc_id) = body.cost_center_id {
        let ok = sqlx::query("SELECT id FROM cost_centers WHERE id = $1 AND organization_id = $2")
            .bind(cc_id)
            .bind(org_id)
            .fetch_optional(&state.db)
            .await?;
        if ok.is_none() {
            return Err(AppError::Validation(
                "cost_center_id does not belong to this organization".into(),
            ));
        }
    }

    let row = sqlx::query(
        r#"UPDATE business_capabilities
           SET name = COALESCE($2, name),
               description = COALESCE($3, description),
               cost_center_id = COALESCE($4, cost_center_id)
           WHERE id = $1
           RETURNING id, name, description, cost_center_id"#,
    )
    .bind(capability_id)
    .bind(body.name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.cost_center_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Business capability not found".into()))?;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "description": row.get::<Option<String>, _>("description"),
            "cost_center_id": row.get::<Option<Uuid>, _>("cost_center_id"),
        }
    })))
}

/// DELETE /api/v1/business-capabilities/{id}
#[utoipa::path(
    delete,
    path = "/api/v1/business-capabilities/{id}",
    params(("id" = Uuid, Path, description = "Capability ID")),
    responses(
        (status = 204, description = "Capability deleted"),
        (status = 404, description = "Capability not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "expenses",
)]
pub async fn delete_business_capability(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(capability_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let existing =
        sqlx::query("SELECT id, organization_id FROM business_capabilities WHERE id = $1")
            .bind(capability_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Business capability not found".into()))?;
    let org_id: Uuid = existing.try_get("organization_id")?;

    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    sqlx::query("DELETE FROM business_capabilities WHERE id = $1")
        .bind(capability_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
