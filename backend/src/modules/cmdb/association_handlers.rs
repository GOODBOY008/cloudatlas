use axum::{
    extract::{Extension, Path, State},
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

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
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

// ─── DTOs ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateAssociationKindRequest {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub is_directional: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateAssociationKindRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub is_directional: Option<bool>,
}

#[derive(Deserialize)]
pub struct CreateObjectAssociationRequest {
    pub src_ci_type_id: Uuid,
    pub association_kind_id: Uuid,
    pub dst_ci_type_id: Uuid,
    pub cardinality: Option<String>,
    pub description: Option<String>,
}

// ─── Association Kinds ─────────────────────────────────────────────────────
// (GET list_association_kinds / list_object_associations were unrouted dead
//  code — the live GET routes use cmdb::handlers::list_ci_association_kinds /
//  list_ci_object_associations; deleted per pagination spec 4.3-E.)

pub async fn create_association_kind(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateAssociationKindRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Association kind name cannot be empty".into(),
        ));
    }

    let row = sqlx::query(
        r#"INSERT INTO ci_association_kinds
           (organization_id, name, display_name, description, is_directional, is_builtin)
           VALUES ($1, $2, $3, $4, $5, false)
           RETURNING id, name, display_name, description, is_directional, is_builtin, created_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(body.is_directional.unwrap_or(true))
    .fetch_one(&state.db)
    .await?;

    let kind_id: Uuid = row.get("id");
    let kind_name: String = row.get("name");

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_association_kind",
        "create",
        &kind_id.to_string(),
        &kind_name,
        None,
        Some(&json!({ "name": kind_name, "display_name": body.display_name })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": kind_id,
                "organization_id": org_id,
                "name": kind_name,
                "display_name": row.get::<String, _>("display_name"),
                "description": row.get::<Option<String>, _>("description"),
                "is_directional": row.get::<bool, _>("is_directional"),
                "is_builtin": false,
                "usage_count": 0_i64,
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

pub async fn update_association_kind(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, kind_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateAssociationKindRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let existing = sqlx::query(
        "SELECT is_builtin, name FROM ci_association_kinds WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    )
    .bind(kind_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Association kind not found".into()))?;

    if existing.get::<bool, _>("is_builtin") {
        return Err(AppError::Validation(
            "Built-in association kinds cannot be modified".into(),
        ));
    }

    let row = sqlx::query(
        r#"UPDATE ci_association_kinds
           SET display_name   = COALESCE($3, display_name),
               description    = COALESCE($4, description),
               is_directional = COALESCE($5, is_directional)
           WHERE id = $1 AND organization_id = $2
           RETURNING id, name, display_name, description, is_directional, is_builtin, created_at"#,
    )
    .bind(kind_id)
    .bind(org_id)
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(body.is_directional)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Association kind not found".into()))?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_association_kind",
        "update",
        &kind_id.to_string(),
        &row.get::<String, _>("name"),
        Some(&json!({ "update": { "display_name": body.display_name, "description": body.description, "is_directional": body.is_directional } })),
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
            "is_directional": row.get::<bool, _>("is_directional"),
            "is_builtin": row.get::<bool, _>("is_builtin"),
        }
    })))
}

pub async fn delete_association_kind(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, kind_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let existing = sqlx::query(
        "SELECT is_builtin FROM ci_association_kinds WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    )
    .bind(kind_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Association kind not found".into()))?;

    if existing.get::<bool, _>("is_builtin") {
        return Err(AppError::Validation(
            "Built-in association kinds cannot be deleted".into(),
        ));
    }

    // Check if still used
    let usage: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_object_associations WHERE association_kind_id = $1",
    )
    .bind(kind_id)
    .fetch_one(&state.db)
    .await?;

    if usage > 0 {
        return Err(AppError::Validation(format!(
            "Association kind is referenced by {usage} object association(s). Remove those first."
        )));
    }

    // T4: model-layer audit (before removal).
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_association_kind",
        "delete",
        &kind_id.to_string(),
        &existing.get::<String, _>("name"),
        Some(&json!({ "name": existing.get::<String, _>("name") })),
        None,
    )
    .await;

    sqlx::query(
        "DELETE FROM ci_association_kinds WHERE id = $1 AND organization_id = $2",
    )
    .bind(kind_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ─── Object Associations (CI Type ↔ CI Type via kind) ─────────────────────

pub async fn create_object_association(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateObjectAssociationRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let cardinality = body.cardinality.as_deref().unwrap_or("many_to_many");
    let valid_cardinalities = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"];
    if !valid_cardinalities.contains(&cardinality) {
        return Err(AppError::Validation(format!(
            "Invalid cardinality '{cardinality}'. Must be one of: {valid_cardinalities:?}"
        )));
    }

    let row = sqlx::query(
        r#"INSERT INTO ci_object_associations
           (organization_id, src_ci_type_id, association_kind_id, dst_ci_type_id, cardinality, description)
           VALUES ($1, $2, $3, $4, $5::association_cardinality, $6)
           RETURNING id, src_ci_type_id, association_kind_id, dst_ci_type_id,
                     cardinality::text AS cardinality, description, created_at"#,
    )
    .bind(org_id)
    .bind(body.src_ci_type_id)
    .bind(body.association_kind_id)
    .bind(body.dst_ci_type_id)
    .bind(cardinality)
    .bind(&body.description)
    .fetch_one(&state.db)
    .await?;

    let obj_assoc_id: Uuid = row.get("id");

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_object_association",
        "create",
        &obj_assoc_id.to_string(),
        &format!("{} → {}", body.src_ci_type_id, body.dst_ci_type_id),
        None,
        Some(&json!({ "src_ci_type_id": body.src_ci_type_id, "dst_ci_type_id": body.dst_ci_type_id, "association_kind_id": body.association_kind_id, "cardinality": cardinality })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": obj_assoc_id,
                "organization_id": org_id,
                "src_ci_type_id": row.get::<Uuid, _>("src_ci_type_id"),
                "association_kind_id": row.get::<Uuid, _>("association_kind_id"),
                "dst_ci_type_id": row.get::<Uuid, _>("dst_ci_type_id"),
                "cardinality": row.get::<String, _>("cardinality"),
                "description": row.get::<Option<String>, _>("description"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

pub async fn delete_object_association(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, assoc_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let usage: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_instance_associations WHERE object_association_id = $1",
    )
    .bind(assoc_id)
    .fetch_one(&state.db)
    .await?;

    if usage > 0 {
        return Err(AppError::Validation(format!(
            "Object association is referenced by {usage} CI instance association(s). Remove those first."
        )));
    }

    let result = sqlx::query(
        "DELETE FROM ci_object_associations WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    )
    .bind(assoc_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Object association not found".into()));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "ci_object_association",
        "delete",
        &assoc_id.to_string(),
        "",
        Some(&json!({ "object_association_id": assoc_id })),
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}
