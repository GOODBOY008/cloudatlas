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

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

// ─── DTOs ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateClassificationRequest {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
}

#[derive(Deserialize)]
pub struct UpdateClassificationRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
}

// ─── list_ci_classifications ───────────────────────────────────────────────

pub async fn list_ci_classifications(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let rows = sqlx::query(
        r#"SELECT id, organization_id, name, display_name, description, icon,
                  sort_order, is_builtin, created_at, updated_at,
                  (SELECT COUNT(*) FROM ci_types t WHERE t.classification_id = c.id) AS ci_type_count
           FROM ci_classifications c
           WHERE (organization_id = $1 OR organization_id IS NULL)
           ORDER BY sort_order ASC, name ASC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "organization_id": r.get::<Option<Uuid>, _>("organization_id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<String, _>("display_name"),
                "description": r.get::<Option<String>, _>("description"),
                "icon": r.get::<Option<String>, _>("icon"),
                "sort_order": r.get::<i32, _>("sort_order"),
                "is_builtin": r.get::<bool, _>("is_builtin"),
                "ci_type_count": r.get::<i64, _>("ci_type_count"),
                "created_at": r.get::<chrono::DateTime<Utc>, _>("created_at"),
                "updated_at": r.get::<chrono::DateTime<Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

// ─── create_ci_classification ──────────────────────────────────────────────

pub async fn create_ci_classification(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateClassificationRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Classification name cannot be empty".into(),
        ));
    }

    let row = sqlx::query(
        r#"INSERT INTO ci_classifications
           (organization_id, name, display_name, description, icon, sort_order, is_builtin)
           VALUES ($1, $2, $3, $4, $5, $6, false)
           RETURNING id, name, display_name, description, icon, sort_order, is_builtin, created_at, updated_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.icon)
    .bind(body.sort_order.unwrap_or(0))
    .fetch_one(&state.db)
    .await?;

    let id: Uuid = row.get("id");
    let name: String = row.get("name");

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_classification",
        "create",
        &id.to_string(),
        &name,
        None,
        Some(&json!({ "name": name, "display_name": body.display_name })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "organization_id": org_id,
                "name": name,
                "display_name": row.get::<String, _>("display_name"),
                "description": row.get::<Option<String>, _>("description"),
                "icon": row.get::<Option<String>, _>("icon"),
                "sort_order": row.get::<i32, _>("sort_order"),
                "is_builtin": false,
                "ci_type_count": 0_i64,
                "created_at": row.get::<chrono::DateTime<Utc>, _>("created_at"),
                "updated_at": row.get::<chrono::DateTime<Utc>, _>("updated_at"),
            }
        })),
    ))
}

// ─── update_ci_classification ──────────────────────────────────────────────

pub async fn update_ci_classification(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, class_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateClassificationRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Verify ownership: not allowed to update builtin classifications
    let existing = sqlx::query(
        "SELECT is_builtin FROM ci_classifications WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    )
    .bind(class_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Classification not found".into()))?;

    if existing.get::<bool, _>("is_builtin") {
        return Err(AppError::Validation(
            "Built-in classifications cannot be modified".into(),
        ));
    }

    let row = sqlx::query(
        r#"UPDATE ci_classifications
           SET display_name = COALESCE($3, display_name),
               description  = COALESCE($4, description),
               icon         = COALESCE($5, icon),
               sort_order   = COALESCE($6, sort_order)
           WHERE id = $1 AND organization_id = $2
           RETURNING id, name, display_name, description, icon, sort_order, is_builtin, created_at, updated_at"#,
    )
    .bind(class_id)
    .bind(org_id)
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.icon)
    .bind(body.sort_order)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Classification not found".into()))?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_classification",
        "update",
        &class_id.to_string(),
        &row.get::<String, _>("name"),
        Some(&json!({ "update": { "display_name": body.display_name, "description": body.description, "icon": body.icon, "sort_order": body.sort_order } })),
        None,
    )
    .await;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "organization_id": org_id,
            "name": row.get::<String, _>("name"),
            "display_name": row.get::<String, _>("display_name"),
            "description": row.get::<Option<String>, _>("description"),
            "icon": row.get::<Option<String>, _>("icon"),
            "sort_order": row.get::<i32, _>("sort_order"),
            "is_builtin": row.get::<bool, _>("is_builtin"),
            "updated_at": row.get::<chrono::DateTime<Utc>, _>("updated_at"),
        }
    })))
}

// ─── delete_ci_classification ──────────────────────────────────────────────

pub async fn delete_ci_classification(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, class_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let existing = sqlx::query(
        "SELECT is_builtin, name FROM ci_classifications WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    )
    .bind(class_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Classification not found".into()))?;

    if existing.get::<bool, _>("is_builtin") {
        return Err(AppError::Validation(
            "Built-in classifications cannot be deleted".into(),
        ));
    }
    let class_name: String = existing.get("name");

    // T4: model-layer audit (before the row is removed).
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_classification",
        "delete",
        &class_id.to_string(),
        &class_name,
        Some(&json!({ "name": class_name })),
        None,
    )
    .await;

    // Unlink CI types rather than blocking the delete
    sqlx::query("UPDATE ci_types SET classification_id = NULL WHERE classification_id = $1")
        .bind(class_id)
        .execute(&state.db)
        .await?;

    sqlx::query("DELETE FROM ci_classifications WHERE id = $1 AND organization_id = $2")
        .bind(class_id)
        .bind(org_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
