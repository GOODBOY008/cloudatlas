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
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Service Templates
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateServiceTemplateRequest {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub service_type: Option<String>,
    pub tags: Option<Value>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateServiceTemplateRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub service_type: Option<String>,
    pub tags: Option<Value>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct AddTemplateItemRequest {
    pub ci_type_id: Uuid,
    pub role: Option<String>,
    pub is_required: Option<bool>,
    pub min_count: Option<i32>,
    pub max_count: Option<i32>,
    pub default_meta: Option<Value>,
    pub sort_order: Option<i32>,
}

pub async fn list_service_templates(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT t.id, t.name, t.display_name, t.description, t.service_type,
                  t.tags, t.is_active, t.created_at, t.updated_at,
                  COUNT(DISTINCT ti.id) AS item_count
           FROM service_templates t
           LEFT JOIN service_template_items ti ON ti.template_id = t.id
           WHERE t.organization_id = $1 AND t.deleted_at IS NULL
           GROUP BY t.id
           ORDER BY t.name, t.id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM service_templates WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<Option<String>, _>("display_name"),
                "description": r.get::<Option<String>, _>("description"),
                "service_type": r.get::<String, _>("service_type"),
                "tags": r.get::<Value, _>("tags"),
                "is_active": r.get::<bool, _>("is_active"),
                "item_count": r.get::<i64, _>("item_count"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

pub async fn create_service_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateServiceTemplateRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("Template name cannot be empty".into()));
    }

    let service_type = body.service_type.as_deref().unwrap_or("application");
    let valid_types = ["application", "platform", "infrastructure", "middleware"];
    if !valid_types.contains(&service_type) {
        return Err(AppError::Validation(format!(
            "Invalid service_type. Must be one of: {valid_types:?}"
        )));
    }

    let row = sqlx::query(
        r#"INSERT INTO service_templates
           (organization_id, name, display_name, description, service_type, tags, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name, display_name, description, service_type, tags,
                     is_active, created_at, updated_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(service_type)
    .bind(body.tags.clone().unwrap_or(json!({})))
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    // T4: model-layer audit.
    let tmpl_uuid: Uuid = row.get("id");
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "service_template",
        "create",
        &tmpl_uuid.to_string(),
        &body.name,
        None,
        Some(&json!({ "name": body.name, "service_type": service_type })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "organization_id": org_id,
                "name": row.get::<String, _>("name"),
                "display_name": row.get::<Option<String>, _>("display_name"),
                "description": row.get::<Option<String>, _>("description"),
                "service_type": row.get::<String, _>("service_type"),
                "tags": row.get::<Value, _>("tags"),
                "is_active": row.get::<bool, _>("is_active"),
                "item_count": 0_i64,
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            }
        })),
    ))
}

pub async fn get_service_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"SELECT id, name, display_name, description, service_type,
                  tags, is_active, created_at, updated_at
           FROM service_templates
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(tmpl_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Service template not found".into()))?;

    // Load items
    let item_rows = sqlx::query(
        r#"SELECT ti.id, ti.ci_type_id, ct.name AS ci_type_name, ct.display_name AS ci_type_display,
                  ti.role, ti.is_required, ti.min_count, ti.max_count,
                  ti.default_meta, ti.sort_order
           FROM service_template_items ti
           JOIN ci_types ct ON ct.id = ti.ci_type_id
           WHERE ti.template_id = $1
           ORDER BY ti.sort_order, ct.name"#,
    )
    .bind(tmpl_id)
    .fetch_all(&state.db)
    .await?;

    let items: Vec<Value> = item_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_type_id": r.get::<Uuid, _>("ci_type_id"),
                "ci_type_name": r.get::<String, _>("ci_type_name"),
                "ci_type_display": r.get::<String, _>("ci_type_display"),
                "role": r.get::<Option<String>, _>("role"),
                "is_required": r.get::<bool, _>("is_required"),
                "min_count": r.get::<i32, _>("min_count"),
                "max_count": r.get::<Option<i32>, _>("max_count"),
                "default_meta": r.get::<Value, _>("default_meta"),
                "sort_order": r.get::<i32, _>("sort_order"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "display_name": row.get::<Option<String>, _>("display_name"),
            "description": row.get::<Option<String>, _>("description"),
            "service_type": row.get::<String, _>("service_type"),
            "tags": row.get::<Value, _>("tags"),
            "is_active": row.get::<bool, _>("is_active"),
            "items": items,
            "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        }
    })))
}

pub async fn update_service_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateServiceTemplateRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"UPDATE service_templates
           SET display_name  = COALESCE($3, display_name),
               description   = COALESCE($4, description),
               service_type  = COALESCE($5, service_type),
               tags          = COALESCE($6, tags),
               is_active     = COALESCE($7, is_active)
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING id, name, display_name, description, service_type, tags, is_active, updated_at"#,
    )
    .bind(tmpl_id)
    .bind(org_id)
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.service_type)
    .bind(&body.tags)
    .bind(body.is_active)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Service template not found".into()))?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "service_template",
        "update",
        &tmpl_id.to_string(),
        &row.get::<String, _>("name"),
        Some(&json!({ "update": { "display_name": body.display_name, "service_type": body.service_type, "is_active": body.is_active } })),
        None,
    )
    .await;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "display_name": row.get::<Option<String>, _>("display_name"),
            "description": row.get::<Option<String>, _>("description"),
            "service_type": row.get::<String, _>("service_type"),
            "tags": row.get::<Value, _>("tags"),
            "is_active": row.get::<bool, _>("is_active"),
            "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        }
    })))
}

pub async fn delete_service_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE service_templates SET deleted_at = NOW()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(tmpl_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Service template not found".into()));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "service_template",
        "delete",
        &tmpl_id.to_string(),
        "",
        Some(&json!({ "template_id": tmpl_id })),
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn add_template_item(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<AddTemplateItemRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Verify template belongs to org
    sqlx::query(
        "SELECT id FROM service_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(tmpl_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Service template not found".into()))?;

    let row = sqlx::query(
        r#"INSERT INTO service_template_items
           (template_id, ci_type_id, role, is_required, min_count, max_count,
            default_meta, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (template_id, ci_type_id, role) DO UPDATE
               SET is_required  = EXCLUDED.is_required,
                   min_count    = EXCLUDED.min_count,
                   max_count    = EXCLUDED.max_count,
                   default_meta = EXCLUDED.default_meta,
                   sort_order   = EXCLUDED.sort_order
           RETURNING id, ci_type_id, role, is_required, min_count, max_count,
                     default_meta, sort_order"#,
    )
    .bind(tmpl_id)
    .bind(body.ci_type_id)
    .bind(&body.role)
    .bind(body.is_required.unwrap_or(true))
    .bind(body.min_count.unwrap_or(1))
    .bind(body.max_count)
    .bind(body.default_meta.clone().unwrap_or(json!({})))
    .bind(body.sort_order.unwrap_or(0))
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "template_id": tmpl_id,
                "ci_type_id": row.get::<Uuid, _>("ci_type_id"),
                "role": row.get::<Option<String>, _>("role"),
                "is_required": row.get::<bool, _>("is_required"),
                "min_count": row.get::<i32, _>("min_count"),
                "max_count": row.get::<Option<i32>, _>("max_count"),
                "default_meta": row.get::<Value, _>("default_meta"),
                "sort_order": row.get::<i32, _>("sort_order"),
            }
        })),
    ))
}

pub async fn remove_template_item(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id, item_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"DELETE FROM service_template_items
           WHERE id = $1 AND template_id = $2
             AND EXISTS (
               SELECT 1 FROM service_templates
               WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL
             )"#,
    )
    .bind(item_id)
    .bind(tmpl_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Template item not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

// ─────────────────────────────────────────────────────────────────────────────
// CI Apply Rules  (Host Apply equivalent)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateCiApplyRuleRequest {
    pub ci_type_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub conditions: Value,
    pub attributes: Value,
    pub priority: Option<i32>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateCiApplyRuleRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub conditions: Option<Value>,
    pub attributes: Option<Value>,
    pub priority: Option<i32>,
    pub is_active: Option<bool>,
}

pub async fn list_ci_apply_rules(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT r.id, r.ci_type_id, ct.name AS ci_type_name,
                  ct.display_name AS ci_type_display,
                  r.name, r.description, r.conditions, r.attributes,
                  r.priority, r.is_active, r.created_at, r.updated_at,
                  COUNT(DISTINCT res.ci_id) AS applied_count
           FROM ci_apply_rules r
           JOIN ci_types ct ON ct.id = r.ci_type_id
           LEFT JOIN ci_apply_rule_results res ON res.rule_id = r.id
           WHERE r.organization_id = $1 AND r.deleted_at IS NULL
           GROUP BY r.id, ct.name, ct.display_name
           ORDER BY r.ci_type_id, r.priority DESC, r.name, r.id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_apply_rules WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_type_id": r.get::<Uuid, _>("ci_type_id"),
                "ci_type_name": r.get::<String, _>("ci_type_name"),
                "ci_type_display": r.get::<String, _>("ci_type_display"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<Option<String>, _>("description"),
                "conditions": r.get::<Value, _>("conditions"),
                "attributes": r.get::<Value, _>("attributes"),
                "priority": r.get::<i32, _>("priority"),
                "is_active": r.get::<bool, _>("is_active"),
                "applied_count": r.get::<i64, _>("applied_count"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

pub async fn create_ci_apply_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateCiApplyRuleRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("Rule name cannot be empty".into()));
    }
    if !body.conditions.is_array() {
        return Err(AppError::Validation(
            "conditions must be a JSON array".into(),
        ));
    }
    if !body.attributes.is_object() {
        return Err(AppError::Validation(
            "attributes must be a JSON object".into(),
        ));
    }

    let row = sqlx::query(
        r#"INSERT INTO ci_apply_rules
           (organization_id, ci_type_id, name, description, conditions, attributes,
            priority, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, ci_type_id, name, description, conditions, attributes,
                     priority, is_active, created_at, updated_at"#,
    )
    .bind(org_id)
    .bind(body.ci_type_id)
    .bind(body.name.trim())
    .bind(&body.description)
    .bind(&body.conditions)
    .bind(&body.attributes)
    .bind(body.priority.unwrap_or(0))
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "organization_id": org_id,
                "ci_type_id": row.get::<Uuid, _>("ci_type_id"),
                "name": row.get::<String, _>("name"),
                "description": row.get::<Option<String>, _>("description"),
                "conditions": row.get::<Value, _>("conditions"),
                "attributes": row.get::<Value, _>("attributes"),
                "priority": row.get::<i32, _>("priority"),
                "is_active": row.get::<bool, _>("is_active"),
                "applied_count": 0_i64,
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            }
        })),
    ))
}

pub async fn update_ci_apply_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rule_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateCiApplyRuleRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"UPDATE ci_apply_rules
           SET name        = COALESCE($3, name),
               description = COALESCE($4, description),
               conditions  = COALESCE($5, conditions),
               attributes  = COALESCE($6, attributes),
               priority    = COALESCE($7, priority),
               is_active   = COALESCE($8, is_active)
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING id, ci_type_id, name, description, conditions, attributes,
                     priority, is_active, updated_at"#,
    )
    .bind(rule_id)
    .bind(org_id)
    .bind(&body.name)
    .bind(&body.description)
    .bind(&body.conditions)
    .bind(&body.attributes)
    .bind(body.priority)
    .bind(body.is_active)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI apply rule not found".into()))?;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "ci_type_id": row.get::<Uuid, _>("ci_type_id"),
            "name": row.get::<String, _>("name"),
            "description": row.get::<Option<String>, _>("description"),
            "conditions": row.get::<Value, _>("conditions"),
            "attributes": row.get::<Value, _>("attributes"),
            "priority": row.get::<i32, _>("priority"),
            "is_active": row.get::<bool, _>("is_active"),
            "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        }
    })))
}

pub async fn delete_ci_apply_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rule_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE ci_apply_rules SET deleted_at = NOW()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(rule_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("CI apply rule not found".into()));
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Execute a CI apply rule: find matching CIs and apply attribute values to their meta.
pub async fn execute_ci_apply_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rule_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Load the rule
    let rule_row = sqlx::query(
        r#"SELECT ci_type_id, attributes, is_active
           FROM ci_apply_rules
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(rule_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI apply rule not found".into()))?;

    if !rule_row.get::<bool, _>("is_active") {
        return Err(AppError::Validation("Rule is not active".into()));
    }

    let ci_type_id = rule_row.get::<Uuid, _>("ci_type_id");
    let attributes: Value = rule_row.get("attributes");

    // T1: the rule's attribute values must satisfy the type's attribute
    // definitions (type / enum / regex) before anything is applied.
    let attr_defs = super::validation::load_attr_defs(&state.db, ci_type_id).await?;
    if let Err(errors) = super::validation::validate_meta(&attr_defs, &attributes) {
        let msgs: Vec<Value> = errors.iter().map(|ve| ve.to_json()).collect();
        return Err(crate::error::AppError::Structured(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "ERR_VALIDATION".into(),
            "CI apply rule attributes fail type validation".into(),
            serde_json::json!({ "errors": msgs }),
        ));
    }

    // Load all active CIs of this type
    let ci_rows = sqlx::query(
        r#"SELECT id, meta FROM cis
           WHERE organization_id = $1 AND ci_type_id = $2 AND deleted_at IS NULL
             AND lifecycle_state NOT IN ('decommissioned', 'retired')"#,
    )
    .bind(org_id)
    .bind(ci_type_id)
    .fetch_all(&state.db)
    .await?;

    let mut applied = 0usize;
    let mut skipped: Vec<Value> = Vec::new();

    for ci_row in &ci_rows {
        let ci_id = ci_row.get::<Uuid, _>("id");
        let current_meta: Value = ci_row.get("meta");

        // T1: merged view (current meta overridden by rule attributes) must
        // still validate — e.g. a required attribute cannot be nulled out.
        let mut merged = current_meta.as_object().cloned().unwrap_or_default();
        if let Some(incoming) = attributes.as_object() {
            for (k, v) in incoming {
                merged.insert(k.clone(), v.clone());
            }
        }
        let merged_value = Value::Object(merged);
        if let Err(errors) =
            super::validation::validate_meta_update(&attr_defs, &current_meta, &merged_value)
        {
            let msgs: Vec<String> = errors.iter().map(|ve| ve.message.clone()).collect();
            skipped.push(json!({ "ci_id": ci_id, "reason": msgs.join("; ") }));
            continue;
        }

        // Merge attributes into meta using jsonb_strip_nulls + concat
        let result = sqlx::query(
            r#"UPDATE cis
               SET meta = meta || $3
               WHERE id = $1 AND organization_id = $2"#,
        )
        .bind(ci_id)
        .bind(org_id)
        .bind(&attributes)
        .execute(&state.db)
        .await;

        if result.is_ok() {
            // Record result
            let _ = sqlx::query(
                r#"INSERT INTO ci_apply_rule_results (rule_id, ci_id)
                   VALUES ($1, $2)
                   ON CONFLICT (rule_id, ci_id) DO UPDATE SET applied_at = NOW()"#,
            )
            .bind(rule_id)
            .bind(ci_id)
            .execute(&state.db)
            .await;

            applied += 1;
        }
    }

    Ok(Json(json!({
        "data": {
            "rule_id": rule_id,
            "ci_type_id": ci_type_id,
            "total_cis": ci_rows.len(),
            "applied": applied,
            "skipped": skipped,
        }
    })))
}

// ─────────────────────────────────────────────────────────────────────────────
// Field Templates
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateFieldTemplateRequest {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub attributes: Value, // array of attribute definitions
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpdateFieldTemplateRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub attributes: Option<Value>,
}

pub async fn list_field_templates(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, display_name, description, attributes, created_at, updated_at
           FROM field_templates
           WHERE organization_id = $1 AND deleted_at IS NULL
           ORDER BY name, id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM field_templates WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<Option<String>, _>("display_name"),
                "description": r.get::<Option<String>, _>("description"),
                "attributes": r.get::<Value, _>("attributes"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

pub async fn create_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateFieldTemplateRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Field template name cannot be empty".into(),
        ));
    }
    if !body.attributes.is_array() {
        return Err(AppError::Validation(
            "attributes must be a JSON array".into(),
        ));
    }

    let row = sqlx::query(
        r#"INSERT INTO field_templates
           (organization_id, name, display_name, description, attributes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, name, display_name, description, attributes, created_at, updated_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.attributes)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    // T4: model-layer audit.
    let ft_uuid: Uuid = row.get("id");
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "field_template",
        "create",
        &ft_uuid.to_string(),
        &body.name,
        None,
        Some(&json!({ "name": body.name, "attribute_count": body.attributes.as_array().map(|a| a.len()).unwrap_or(0) })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "organization_id": org_id,
                "name": row.get::<String, _>("name"),
                "display_name": row.get::<Option<String>, _>("display_name"),
                "description": row.get::<Option<String>, _>("description"),
                "attributes": row.get::<Value, _>("attributes"),
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            }
        })),
    ))
}

pub async fn update_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateFieldTemplateRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"UPDATE field_templates
           SET display_name = COALESCE($3, display_name),
               description  = COALESCE($4, description),
               attributes   = COALESCE($5, attributes)
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING id, name, display_name, description, attributes, updated_at"#,
    )
    .bind(tmpl_id)
    .bind(org_id)
    .bind(&body.display_name)
    .bind(&body.description)
    .bind(&body.attributes)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "field_template",
        "update",
        &tmpl_id.to_string(),
        &row.get::<String, _>("name"),
        Some(&json!({ "update": { "display_name": body.display_name, "description": body.description } })),
        None,
    )
    .await;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "display_name": row.get::<Option<String>, _>("display_name"),
            "description": row.get::<Option<String>, _>("description"),
            "attributes": row.get::<Value, _>("attributes"),
            "updated_at": row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
        }
    })))
}

pub async fn delete_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE field_templates SET deleted_at = NOW()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
    )
    .bind(tmpl_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Field template not found".into()));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        claims.user_id().ok(),
        "field_template",
        "delete",
        &tmpl_id.to_string(),
        "",
        Some(&json!({ "template_id": tmpl_id })),
        None,
    )
    .await;

    // Remove any CI type references
    sqlx::query("DELETE FROM ci_type_field_templates WHERE template_id = $1")
        .bind(tmpl_id)
        .execute(&state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unique Constraints (T2 — gap closure)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct CreateUniqueConstraintRequest {
    pub name: String,
    /// Attribute names forming the composite unique key, e.g. ["hostname"] or
    /// ["name", "region"]. Each must exist as an attribute of the CI type.
    pub attr_names: Vec<String>,
}

/// GET /api/v1/orgs/{org_id}/ci-types/{type_id}/unique-constraints
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/ci-types/{type_id}/unique-constraints",
    params(
        ("org_id"   = Uuid, Path, description = "Organization ID"),
        ("type_id"  = Uuid, Path, description = "CI type ID"),
    ),
    responses(
        (status = 200, description = "Unique constraints configured for the CI type"),
        (status = 404, description = "CI type not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn list_unique_constraints(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Type must be visible to this org (builtin or org-owned).
    sqlx::query(
        "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let rows = sqlx::query(
        r#"SELECT id, name, attr_names, created_at, updated_at
           FROM ci_unique_constraints
           WHERE organization_id = $1 AND ci_type_id = $2 AND deleted_at = 0
           ORDER BY name, id"#,
    )
    .bind(org_id)
    .bind(type_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_type_id": type_id,
                "name": r.get::<String, _>("name"),
                "attr_names": r.get::<Vec<String>, _>("attr_names"),
                "created_at": r.get::<i64, _>("created_at"),
                "updated_at": r.get::<i64, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

/// POST /api/v1/orgs/{org_id}/ci-types/{type_id}/unique-constraints
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/ci-types/{type_id}/unique-constraints",
    params(
        ("org_id"   = Uuid, Path, description = "Organization ID"),
        ("type_id"  = Uuid, Path, description = "CI type ID"),
    ),
    request_body = CreateUniqueConstraintRequest,
    responses(
        (status = 201, description = "Constraint created"),
        (status = 404, description = "CI type not found"),
        (status = 422, description = "attr_names invalid (empty or unknown attribute)"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn create_unique_constraint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateUniqueConstraintRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation(
            "Constraint name cannot be empty".into(),
        ));
    }
    if body.attr_names.is_empty() || body.attr_names.len() > 5 {
        return Err(AppError::Validation(
            "attr_names must contain between 1 and 5 attributes".into(),
        ));
    }

    // Type must be visible to this org.
    sqlx::query(
        "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    // Every referenced attribute must exist on the type and use the identifier
    // charset (keys are interpolated into meta->>'key' expressions by the
    // write-time check).
    let defs = super::validation::load_attr_defs(&state.db, type_id).await?;
    let known: std::collections::HashSet<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    for attr in &body.attr_names {
        if !known.contains(attr.as_str()) {
            return Err(AppError::Validation(format!(
                "attr_names references unknown attribute '{attr}' for this CI type"
            )));
        }
        if attr.is_empty() || !attr.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AppError::Validation(format!(
                "attr_names entries may only contain letters, digits and underscores (got '{attr}')"
            )));
        }
    }

    let id = Uuid::new_v4();
    let row = sqlx::query(
        r#"INSERT INTO ci_unique_constraints (id, organization_id, ci_type_id, name, attr_names)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, attr_names, created_at, updated_at"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(type_id)
    .bind(body.name.trim())
    .bind(&body.attr_names)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A constraint with this name already exists for this CI type".into())
        } else {
            AppError::Database(e)
        }
    })?;

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_type",
        "create_unique_constraint",
        &id.to_string(),
        &body.name,
        None,
        Some(&json!({ "ci_type_id": type_id, "name": body.name, "attr_names": body.attr_names })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "ci_type_id": type_id,
                "name": row.get::<String, _>("name"),
                "attr_names": row.get::<Vec<String>, _>("attr_names"),
                "created_at": row.get::<i64, _>("created_at"),
                "updated_at": row.get::<i64, _>("updated_at"),
            }
        })),
    ))
}

/// DELETE /api/v1/orgs/{org_id}/unique-constraints/{id}
#[utoipa::path(
    delete,
    path = "/api/v1/orgs/{org_id}/unique-constraints/{id}",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Constraint ID"),
    ),
    responses(
        (status = 204, description = "Constraint soft-deleted"),
        (status = 404, description = "Constraint not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn delete_unique_constraint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, constraint_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE ci_unique_constraints
           SET deleted_at = EXTRACT(EPOCH FROM NOW())::BIGINT, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
           WHERE id = $1 AND organization_id = $2 AND deleted_at = 0"#,
    )
    .bind(constraint_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Unique constraint not found".into()));
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_type",
        "delete_unique_constraint",
        &constraint_id.to_string(),
        "",
        Some(&json!({ "constraint_id": constraint_id })),
        None,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

// ─────────────────────────────────────────────────────────────────────────────
// Field Template Binding & Apply (T10 — gap closure)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct BindFieldTemplateRequest {
    /// CI types to (un)bind the template to.
    pub ci_type_ids: Vec<Uuid>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ApplyFieldTemplateRequest {
    pub ci_type_ids: Vec<Uuid>,
    /// When true, return the planned changes without writing.
    pub dry_run: Option<bool>,
}

/// POST /api/v1/orgs/{org_id}/field-templates/{id}/bind
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/field-templates/{id}/bind",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Field template ID"),
    ),
    request_body = BindFieldTemplateRequest,
    responses(
        (status = 200, description = "Types bound"),
        (status = 404, description = "Template not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn bind_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<BindFieldTemplateRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.ci_type_ids.is_empty() || body.ci_type_ids.len() > 50 {
        return Err(AppError::Validation(
            "ci_type_ids must contain between 1 and 50 types".into(),
        ));
    }

    let row = sqlx::query("SELECT name FROM field_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL")
        .bind(tmpl_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;
    let tmpl_name: String = row.try_get("name").unwrap_or_default();

    let mut bound: Vec<Uuid> = Vec::new();
    for type_id in &body.ci_type_ids {
        let visible = sqlx::query(
            "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
        )
        .bind(type_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?;
        if visible.is_none() {
            return Err(AppError::NotFound(format!("CI type {type_id} not found")));
        }

        sqlx::query(
            r#"INSERT INTO ci_type_field_templates (ci_type_id, template_id)
               VALUES ($1, $2)
               ON CONFLICT (ci_type_id, template_id) DO NOTHING"#,
        )
        .bind(type_id)
        .bind(tmpl_id)
        .execute(&state.db)
        .await?;
        bound.push(*type_id);
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "field_template",
        "bind",
        &tmpl_id.to_string(),
        &tmpl_name,
        None,
        Some(&json!({ "bound_ci_type_ids": bound })),
    )
    .await;

    Ok(Json(
        json!({ "data": { "template_id": tmpl_id, "bound_ci_type_ids": bound } }),
    ))
}

/// DELETE /api/v1/orgs/{org_id}/field-templates/{id}/unbind
#[utoipa::path(
    delete,
    path = "/api/v1/orgs/{org_id}/field-templates/{id}/unbind",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Field template ID"),
    ),
    request_body = BindFieldTemplateRequest,
    responses(
        (status = 200, description = "Types unbound"),
        (status = 404, description = "Template not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn unbind_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<BindFieldTemplateRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query("SELECT name FROM field_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL")
        .bind(tmpl_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;
    let tmpl_name: String = row.try_get("name").unwrap_or_default();

    for type_id in &body.ci_type_ids {
        sqlx::query(
            "DELETE FROM ci_type_field_templates WHERE template_id = $1 AND ci_type_id = $2",
        )
        .bind(tmpl_id)
        .bind(type_id)
        .execute(&state.db)
        .await?;
    }

    // T4: model-layer audit.
    super::handlers::write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "field_template",
        "unbind",
        &tmpl_id.to_string(),
        &tmpl_name,
        Some(&json!({ "unbound_ci_type_ids": body.ci_type_ids })),
        None,
    )
    .await;

    Ok(Json(
        json!({ "data": { "template_id": tmpl_id, "unbound_ci_type_ids": body.ci_type_ids } }),
    ))
}

/// GET /api/v1/orgs/{org_id}/field-templates/{id}/types
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/field-templates/{id}/types",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Field template ID"),
    ),
    responses(
        (status = 200, description = "CI types bound to the template"),
        (status = 404, description = "Template not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn field_template_bound_types(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    sqlx::query("SELECT id FROM field_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL")
        .bind(tmpl_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;

    let rows = sqlx::query(
        r#"SELECT ct.id, ct.name, ct.display_name, ct.is_builtin
           FROM ci_type_field_templates ctft
           JOIN ci_types ct ON ct.id = ctft.ci_type_id
           WHERE ctft.template_id = $1
           ORDER BY ct.name"#,
    )
    .bind(tmpl_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<String, _>("display_name"),
                "is_builtin": r.get::<bool, _>("is_builtin"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

/// Existing `ci_attributes` row projected for diffing.
struct AttrExisting {
    display_name: Option<String>,
    attribute_type: Option<String>,
    is_required: bool,
    is_unique: bool,
}

/// Compare one template attribute definition against one existing
/// `ci_attributes` row. Returns the diff entry (None when identical).
fn attr_conflicts(tmpl_attr: &Value, existing: &AttrExisting) -> Option<Value> {
    let mut diffs: Vec<String> = Vec::new();
    let t_type = tmpl_attr
        .get("attribute_type")
        .and_then(|v| v.as_str())
        .unwrap_or("string");
    let e_type = existing.attribute_type.as_deref().unwrap_or("string");
    if t_type != e_type {
        diffs.push(format!("attribute_type: {e_type:?} → {t_type:?}"));
    }
    let t_req = tmpl_attr
        .get("is_required")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if t_req != existing.is_required {
        diffs.push(format!("is_required: {} → {t_req}", existing.is_required));
    }
    let t_uniq = tmpl_attr
        .get("is_unique")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if t_uniq != existing.is_unique {
        diffs.push(format!("is_unique: {} → {t_uniq}", existing.is_unique));
    }
    if let Some(td) = tmpl_attr.get("display_name").and_then(|v| v.as_str()) {
        if existing.display_name.as_deref() != Some(td) {
            diffs.push(format!(
                "display_name: {:?} → {:?}",
                existing.display_name.as_deref().unwrap_or(""),
                td
            ));
        }
    }
    if diffs.is_empty() {
        None
    } else {
        Some(json!({ "attribute": tmpl_attr.get("name"), "changes": diffs }))
    }
}

/// GET /api/v1/orgs/{org_id}/field-templates/{id}/diff/{type_id}
///
/// Template attributes vs the type's current attributes:
/// `added` (template-only), `conflicts` (both, differing), `extra` (type-only).
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/field-templates/{id}/diff/{type_id}",
    params(
        ("org_id"  = Uuid, Path, description = "Organization ID"),
        ("id"      = Uuid, Path, description = "Field template ID"),
        ("type_id" = Uuid, Path, description = "CI type ID"),
    ),
    responses(
        (status = 200, description = "Diff between template and type attributes"),
        (status = 404, description = "Template or type not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn field_template_diff(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id, type_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let tmpl = sqlx::query(
        "SELECT attributes FROM field_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(tmpl_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;
    let attributes: Value = tmpl.try_get("attributes").unwrap_or_else(|_| json!([]));

    sqlx::query(
        "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let existing_rows = sqlx::query(
        r#"SELECT name, display_name, attribute_type::text AS attribute_type, is_required, is_unique
           FROM ci_attributes WHERE ci_type_id = $1"#,
    )
    .bind(type_id)
    .fetch_all(&state.db)
    .await?;

    let mut existing: std::collections::HashMap<String, AttrExisting> =
        std::collections::HashMap::new();
    for r in &existing_rows {
        let name: String = r.try_get("name").unwrap_or_default();
        existing.insert(
            name,
            AttrExisting {
                display_name: r.try_get("display_name").ok(),
                attribute_type: r.try_get("attribute_type").ok(),
                is_required: r.try_get("is_required").unwrap_or(false),
                is_unique: r.try_get("is_unique").unwrap_or(false),
            },
        );
    }

    let mut added: Vec<Value> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    let tmpl_names: std::collections::HashSet<String> = attributes
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if let Some(arr) = attributes.as_array() {
        for attr in arr {
            let name = attr
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string();
            match existing.get(&name) {
                None => added.push(attr.clone()),
                Some(ex) => {
                    if let Some(diff) = attr_conflicts(attr, ex) {
                        conflicts.push(diff);
                    }
                }
            }
        }
    }

    let extra: Vec<String> = existing
        .keys()
        .filter(|n| !tmpl_names.contains(*n))
        .cloned()
        .collect();

    Ok(Json(json!({
        "data": {
            "template_id": tmpl_id,
            "ci_type_id": type_id,
            "added": added,
            "conflicts": conflicts,
            "extra": extra,
        }
    })))
}

/// POST /api/v1/orgs/{org_id}/field-templates/{id}/apply
///
/// Syncs the template's attribute definitions onto the bound (or given) CI
/// types: missing attributes are created, conflicting definitions are
/// overwritten (template wins), type-only attributes are left untouched.
/// `dry_run=true` returns the plan without writing. Every applied change is
/// audited (T4).
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/field-templates/{id}/apply",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "Field template ID"),
    ),
    request_body = ApplyFieldTemplateRequest,
    responses(
        (status = 200, description = "Applied (or dry-run planned) changes per type"),
        (status = 404, description = "Template not found"),
        (status = 422, description = "Template attribute has invalid attribute_type"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn apply_field_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, tmpl_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ApplyFieldTemplateRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let tmpl = sqlx::query(
        "SELECT name, attributes FROM field_templates WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(tmpl_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Field template not found".into()))?;
    let tmpl_name: String = tmpl.try_get("name").unwrap_or_default();
    let attributes: Value = tmpl.try_get("attributes").unwrap_or_else(|_| json!([]));
    let attrs = attributes.as_array().cloned().unwrap_or_default();
    if attrs.is_empty() {
        return Err(AppError::Validation(
            "field template has no attributes to apply".into(),
        ));
    }

    // Validate every template attribute's type up front — a bad enum value
    // must fail the whole apply, not half-apply.
    for attr in &attrs {
        let ty = attr
            .get("attribute_type")
            .and_then(|v| v.as_str())
            .unwrap_or("string");
        let known = [
            "string",
            "integer",
            "float",
            "boolean",
            "datetime",
            "enum",
            "list",
            "json",
            "url",
            "ip_address",
            "cidr",
        ];
        if !known.contains(&ty) {
            return Err(AppError::Validation(format!(
                "template attribute '{}' has invalid attribute_type '{ty}'",
                attr.get("name").and_then(|v| v.as_str()).unwrap_or("?")
            )));
        }
    }

    let dry_run = body.dry_run.unwrap_or(false);
    let type_ids = if body.ci_type_ids.is_empty() {
        // Apply to every bound type when the list is empty.
        sqlx::query_scalar::<_, Uuid>(
            "SELECT ci_type_id FROM ci_type_field_templates WHERE template_id = $1",
        )
        .bind(tmpl_id)
        .fetch_all(&state.db)
        .await?
    } else {
        body.ci_type_ids.clone()
    };

    let mut per_type: Vec<Value> = Vec::new();

    for type_id in &type_ids {
        let visible = sqlx::query(
            "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
        )
        .bind(type_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?;
        if visible.is_none() {
            per_type.push(json!({ "ci_type_id": type_id, "error": "not found" }));
            continue;
        }

        let mut created_attrs: Vec<String> = Vec::new();
        let mut updated_attrs: Vec<String> = Vec::new();

        for attr in &attrs {
            let name = attr
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let display_name = attr
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or(name);
            let ty = attr
                .get("attribute_type")
                .and_then(|v| v.as_str())
                .unwrap_or("string");
            let is_required = attr
                .get("is_required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let is_unique = attr
                .get("is_unique")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let default_value = attr.get("default_value").and_then(|v| v.as_str());
            let enum_values = attr.get("enum_values");

            if dry_run {
                let exists = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM ci_attributes WHERE ci_type_id = $1 AND name = $2",
                )
                .bind(type_id)
                .bind(name)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0);
                if exists > 0 {
                    updated_attrs.push(name.to_string());
                } else {
                    created_attrs.push(name.to_string());
                }
                continue;
            }

            let res = sqlx::query(
                r#"INSERT INTO ci_attributes
                   (ci_type_id, organization_id, name, display_name, description,
                    attribute_type, is_required, is_unique, default_value, enum_values, is_builtin)
                   VALUES ($1, $2, $3, $4, NULL, $5::ci_attribute_type, $6, $7, $8, $9, false)
                   ON CONFLICT (ci_type_id, name) DO UPDATE SET
                       display_name = EXCLUDED.display_name,
                       attribute_type = EXCLUDED.attribute_type,
                       is_required   = EXCLUDED.is_required,
                       is_unique     = EXCLUDED.is_unique,
                       default_value = EXCLUDED.default_value,
                       enum_values   = EXCLUDED.enum_values
                   RETURNING (xmax = 0) AS inserted"#,
            )
            .bind(type_id)
            .bind(org_id)
            .bind(name)
            .bind(display_name)
            .bind(ty)
            .bind(is_required)
            .bind(is_unique)
            .bind(default_value)
            .bind(enum_values)
            .fetch_one(&state.db)
            .await;

            match res {
                Ok(row) => {
                    let inserted: bool = row.try_get("inserted").unwrap_or(false);
                    if inserted {
                        created_attrs.push(name.to_string());
                    } else {
                        updated_attrs.push(name.to_string());
                    }
                }
                Err(e) => {
                    per_type.push(json!({
                        "ci_type_id": type_id,
                        "error": format!("attribute '{name}': {e}"),
                    }));
                }
            }
        }

        if !dry_run && (!created_attrs.is_empty() || !updated_attrs.is_empty()) {
            // T4: model-layer audit.
            super::handlers::write_model_audit_log(
                &state.db,
                org_id,
                Some(user_id),
                "field_template",
                "apply",
                &tmpl_id.to_string(),
                &tmpl_name,
                None,
                Some(&json!({
                    "ci_type_id": type_id,
                    "created_attributes": created_attrs,
                    "updated_attributes": updated_attrs,
                })),
            )
            .await;
        }

        per_type.push(json!({
            "ci_type_id": type_id,
            "created_attributes": created_attrs,
            "updated_attributes": updated_attrs,
        }));
    }

    Ok(Json(json!({
        "data": {
            "template_id": tmpl_id,
            "dry_run": dry_run,
            "applied_types": per_type.len(),
            "per_type": per_type,
        }
    })))
}
