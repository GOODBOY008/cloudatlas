use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use super::{
    dto::{
        AuditLogResponse, AssociationResponse, CiQuery, CiResponse, CiTypeResponse,
        CreateAssociationRequest, CreateCiRequest, CreateCiTypeRequest, ImpactQuery, TopologyQuery,
        UpdateCiRequest, UpdateCiTypeRequest,
    },
    models::{AssociationRow, Ci, CiAuditLog, CiType},
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const CI_TYPE_SELECT: &str = r#"
    SELECT
        id, organization_id, classification_id, name, display_name,
        description, icon,
        cloud_provider::text AS cloud_provider,
        is_builtin, is_abstract, parent_type_id, sort_order,
        created_at, updated_at
    FROM ci_types
"#;

const CI_SELECT: &str = r#"
    SELECT
        id, organization_id, ci_type_id,
        cloud_account_id, cloud_resource_id,
        cloud_provider::text AS cloud_provider,
        cloud_region, name, display_name, meta, tags,
        lifecycle_state::text AS lifecycle_state,
        parent_ci_id, pool_id, discovered_at,
        created_at, updated_at
    FROM cis
"#;

async fn ensure_org_member(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
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

async fn write_audit_log(
    db: &sqlx::PgPool,
    ci_id: Uuid,
    org_id: Uuid,
    user_id: Option<Uuid>,
    operation: &str,
    field_changes: Option<&Value>,
    source: &str,
) {
    let _ = sqlx::query(
        r#"
        INSERT INTO ci_audit_logs (id, ci_id, organization_id, user_id, operation, field_changes, source, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(ci_id)
    .bind(org_id)
    .bind(user_id)
    .bind(operation)
    .bind(field_changes)
    .bind(source)
    .bind(Utc::now())
    .execute(db)
    .await;
}

/// Audit a model-layer write (T4): ci_type / ci_attribute / ci_classification /
/// ci_association_kind / ci_object_association / service / service_template /
/// field_template mutations land in the same `ci_audit_logs` trail with
/// `resource_type` set and `ci_id` NULL.
pub(crate) async fn write_model_audit_log(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Option<Uuid>,
    resource_type: &str,
    action: &str,
    resource_id: &str,
    resource_name: &str,
    pre_data: Option<&Value>,
    cur_data: Option<&Value>,
) {
    let _ = sqlx::query(
        r#"
        INSERT INTO ci_audit_logs
            (id, ci_id, organization_id, user_id, operation, field_changes, source,
             resource_type, resource_id, resource_name, created_at)
        VALUES ($1, NULL, $2, $3, $4, $5, 'user', $6, $7, $8, $9)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(user_id)
    .bind(action)
    .bind(json!({ "pre_data": pre_data, "cur_data": cur_data }))
    .bind(resource_type)
    .bind(resource_id)
    .bind(resource_name)
    .bind(Utc::now())
    .execute(db)
    .await;
}

/// Build a JSON diff object `{"field": {"old": ..., "new": ...}, ...}` for audit logs.
fn compute_field_changes(old: &Ci, req: &UpdateCiRequest) -> Value {
    let mut changes = serde_json::Map::new();

    if let Some(ref new_name) = req.name {
        if *new_name != old.name {
            changes.insert(
                "name".into(),
                json!({ "old": old.name, "new": new_name }),
            );
        }
    }
    if let Some(ref new_dn) = req.display_name {
        if old.display_name.as_deref() != Some(new_dn.as_str()) {
            changes.insert(
                "display_name".into(),
                json!({ "old": old.display_name, "new": new_dn }),
            );
        }
    }
    if let Some(ref new_state) = req.lifecycle_state {
        if old.lifecycle_state != *new_state {
            changes.insert(
                "lifecycle_state".into(),
                json!({ "old": old.lifecycle_state, "new": new_state }),
            );
        }
    }
    if let Some(ref new_pool) = req.pool_id {
        if old.pool_id.as_ref() != Some(new_pool) {
            changes.insert(
                "pool_id".into(),
                json!({ "old": old.pool_id, "new": new_pool }),
            );
        }
    }

    Value::Object(changes)
}

// ─── list_ci_types ────────────────────────────────────────────────────────────

pub async fn list_ci_types(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Return builtin CI types (org IS NULL) + org-specific ones.
    let types = sqlx::query_as::<_, CiType>(&format!(
        "{CI_TYPE_SELECT} WHERE (organization_id = $1 OR organization_id IS NULL) AND deleted_at IS NULL ORDER BY sort_order ASC, name ASC"
    ))
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<CiTypeResponse> = types.into_iter().map(Into::into).collect();
    let total = data.len();
    Ok(Json(json!({ "data": data, "meta": { "total": total } })))
}

// ─── create_ci_type ───────────────────────────────────────────────────────────

pub async fn create_ci_type(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateCiTypeRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("CI type name cannot be empty".into()));
    }

    let now = Utc::now();
    let type_id = Uuid::new_v4();

    let ci_type = sqlx::query_as::<_, CiType>(&format!(
        r#"
        INSERT INTO ci_types
            (id, organization_id, classification_id, name, display_name, description,
             icon, cloud_provider, is_builtin, is_abstract, parent_type_id, sort_order,
             created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7,
                CASE WHEN $8::text IS NULL THEN NULL ELSE $8::cloud_provider END,
                false, false, $9, $10, $11, $11)
        RETURNING {cols}
        "#,
        cols = "id, organization_id, classification_id, name, display_name, description, icon,
                cloud_provider::text AS cloud_provider, is_builtin, is_abstract,
                parent_type_id, sort_order, created_at, updated_at"
    ))
    .bind(type_id)
    .bind(org_id)
    .bind(body.classification_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(body.description.as_deref())
    .bind(body.icon.as_deref())
    .bind(body.cloud_provider.as_deref())
    .bind(body.parent_type_id)
    .bind(body.sort_order.unwrap_or(100))
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A CI type with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    let resp: CiTypeResponse = ci_type.into();

    // T4: model-layer audit.
    write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_type",
        "create",
        &type_id.to_string(),
        &body.name,
        None,
        Some(&serde_json::to_value(&resp).unwrap_or(Value::Null)),
    )
    .await;

    Ok((StatusCode::CREATED, Json(json!({ "data": resp }))))
}

// ─── get_ci_type ──────────────────────────────────────────────────────────────

pub async fn get_ci_type(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let ci_type = sqlx::query_as::<_, CiType>(&format!(
        "{CI_TYPE_SELECT} WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL"
    ))
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let resp: CiTypeResponse = ci_type.into();
    Ok(Json(json!({ "data": resp })))
}

// ─── update_ci_type ───────────────────────────────────────────────────────────

pub async fn update_ci_type(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateCiTypeRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Guard: cannot update builtin CI types.
    let existing = sqlx::query_as::<_, CiType>(&format!(
        "{CI_TYPE_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found or is a builtin".into()))?;

    if existing.is_builtin {
        return Err(AppError::Forbidden("Cannot modify a builtin CI type".into()));
    }

    let now = Utc::now();

    let ci_type = sqlx::query_as::<_, CiType>(&format!(
        r#"
        UPDATE ci_types
        SET
            display_name = COALESCE($3, display_name),
            description  = COALESCE($4, description),
            icon         = COALESCE($5, icon),
            sort_order   = COALESCE($6, sort_order),
            updated_at   = $7
        WHERE id = $1 AND organization_id = $2
        RETURNING {cols}
        "#,
        cols = "id, organization_id, classification_id, name, display_name, description, icon,
                cloud_provider::text AS cloud_provider, is_builtin, is_abstract,
                parent_type_id, sort_order, created_at, updated_at"
    ))
    .bind(type_id)
    .bind(org_id)
    .bind(body.display_name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.icon.as_deref())
    .bind(body.sort_order)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let resp: CiTypeResponse = ci_type.into();

    // T4: model-layer audit (pre snapshot from `existing`).
    write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_type",
        "update",
        &type_id.to_string(),
        &resp.name,
        Some(&serde_json::to_value(CiTypeResponse::from(existing)).unwrap_or(Value::Null)),
        Some(&serde_json::to_value(&resp).unwrap_or(Value::Null)),
    )
    .await;

    Ok(Json(json!({ "data": resp })))
}

// ─── list_cis ─────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cis",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Paginated list of configuration items"),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb"
)]
pub async fn list_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<CiQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let mut conditions = vec!["c.organization_id = $1".to_string(), "c.deleted_at IS NULL".to_string()];
    let mut bind_idx = 2usize;

    if q.ci_type_id.is_some() {
        conditions.push(format!("c.ci_type_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.lifecycle_state.is_some() {
        conditions.push(format!("c.lifecycle_state::text = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.cloud_account_id.is_some() {
        conditions.push(format!("c.cloud_account_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.cloud_provider.is_some() {
        conditions.push(format!("c.cloud_provider::text = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.search.is_some() {
        conditions.push(format!("(c.name ILIKE ${bind_idx} OR c.cloud_resource_id ILIKE ${bind_idx})"));
        bind_idx += 1;
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        r#"
        SELECT
            c.id, c.organization_id, c.ci_type_id,
            c.cloud_account_id, c.cloud_resource_id,
            c.cloud_provider::text AS cloud_provider,
            c.cloud_region, c.name, c.display_name, c.meta, c.tags,
            c.lifecycle_state::text AS lifecycle_state,
            c.parent_ci_id, c.pool_id, c.discovered_at,
            c.created_at, c.updated_at
        FROM cis c
        WHERE {where_clause}
        ORDER BY c.created_at DESC
        LIMIT ${bind_idx} OFFSET ${}
        "#,
        bind_idx + 1
    );

    let mut query = sqlx::query_as::<_, Ci>(&sql).bind(org_id);

    if let Some(v) = q.ci_type_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.lifecycle_state {
        query = query.bind(v);
    }
    if let Some(v) = q.cloud_account_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.cloud_provider {
        query = query.bind(v);
    }
    if let Some(ref v) = q.search {
        query = query.bind(format!("%{v}%"));
    }

    let cis = query.bind(limit).bind(offset).fetch_all(&state.db).await?;

    // COUNT under the identical WHERE so meta.total matches the filtered set.
    let count_sql = format!("SELECT COUNT(*) FROM cis c WHERE {where_clause}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(org_id);
    if let Some(v) = q.ci_type_id {
        count_query = count_query.bind(v);
    }
    if let Some(ref v) = q.lifecycle_state {
        count_query = count_query.bind(v);
    }
    if let Some(v) = q.cloud_account_id {
        count_query = count_query.bind(v);
    }
    if let Some(ref v) = q.cloud_provider {
        count_query = count_query.bind(v);
    }
    if let Some(ref v) = q.search {
        count_query = count_query.bind(format!("%{v}%"));
    }
    let total: i64 = count_query.fetch_one(&state.db).await.unwrap_or(0);

    // Fetch CI type names in one query.
    let type_ids: Vec<Uuid> = cis.iter().map(|c| c.ci_type_id).collect();
    let type_names = fetch_ci_type_names(&state.db, &type_ids).await?;

    let data: Vec<CiResponse> = cis
        .into_iter()
        .map(|c| {
            let ci_type_name = type_names
                .get(&c.ci_type_id)
                .cloned()
                .unwrap_or_else(|| "Unknown".into());
            ci_to_response(c, ci_type_name)
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── create_ci ────────────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cis",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = CreateCiRequest,
    responses(
        (status = 201, description = "CI created", body = CiResponse),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb"
)]
pub async fn create_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateCiRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("CI name cannot be empty".into()));
    }

    let now = Utc::now();
    let ci_id = Uuid::new_v4();
    let meta = body.meta.clone().unwrap_or(Value::Object(Default::default()));
    let tags = body.tags.clone().unwrap_or(Value::Object(Default::default()));

    // T1: enforce ci_attributes definitions (type / required / enum / regex).
    let attr_defs = super::validation::load_attr_defs(&state.db, body.ci_type_id).await?;
    if let Err(errors) = super::validation::validate_meta(&attr_defs, &meta) {
        return Err(super::validation::validation_error(errors));
    }

    // T2: composite + single-field unique constraints.
    super::validation::check_unique_constraints(&state.db, org_id, body.ci_type_id, &meta, None)
        .await?;

    let ci = sqlx::query_as::<_, Ci>(&format!(
        r#"
        INSERT INTO cis
            (id, organization_id, ci_type_id, cloud_resource_id,
             cloud_provider, cloud_region, name, display_name,
             meta, tags, lifecycle_state, created_at, updated_at)
        VALUES
            ($1, $2, $3, $4,
             CASE WHEN $5::text IS NULL THEN NULL ELSE $5::cloud_provider END,
             $6, $7, $8,
             $9, $10, 'active', $11, $11)
        RETURNING {cols}
        "#,
        cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                meta, tags, lifecycle_state::text AS lifecycle_state,
                parent_ci_id, pool_id, discovered_at, created_at, updated_at"
    ))
    .bind(ci_id)
    .bind(org_id)
    .bind(body.ci_type_id)
    .bind(body.cloud_resource_id.as_deref())
    .bind(body.cloud_provider.as_deref())
    .bind(body.cloud_region.as_deref())
    .bind(body.name.trim())
    .bind(body.display_name.as_deref())
    .bind(&meta)
    .bind(&tags)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A CI with this cloud_resource_id already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    write_audit_log(&state.db, ci_id, org_id, Some(user_id), "create", None, "user").await;

    super::events::emit_ci_event(&state.db, org_id, super::events::EVENT_CI_CREATED, &ci, json!({})).await;

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok((StatusCode::CREATED, Json(json!({ "data": resp }))))
}

// ─── get_ci ───────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cis/{id}",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "CI ID"),
    ),
    responses(
        (status = 200, description = "CI details", body = CiResponse),
        (status = 404, description = "Not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb"
)]
pub async fn get_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let ci = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok(Json(json!({ "data": resp })))
}

// ─── update_ci ────────────────────────────────────────────────────────────────

pub async fn update_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateCiRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Fetch current state for audit diff.
    let old = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    // T3: the legacy PUT path enforces the same transition matrix as the
    // dedicated PATCH endpoint.
    if let Some(ref new_state) = body.lifecycle_state {
        if *new_state != old.lifecycle_state {
            super::validation::validate_transition(&old.lifecycle_state, new_state)?;
        }
    }

    // T11: parent_ci_id change — org check + cycle detection.
    if let Some(new_parent) = body.parent_ci_id {
        if new_parent == ci_id {
            return Err(AppError::Validation("A CI cannot be its own parent".into()));
        }
        let parent_ok = sqlx::query(
            "SELECT id FROM cis WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
        )
        .bind(new_parent)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?;
        if parent_ok.is_none() {
            return Err(AppError::NotFound("Parent CI not found".into()));
        }
        // Walking up from the new parent must never reach this CI.
        let cycle = sqlx::query(
            r#"WITH RECURSIVE up AS (
                SELECT id, parent_ci_id FROM cis WHERE id = $1 AND deleted_at IS NULL
                UNION ALL
                SELECT c.id, c.parent_ci_id FROM cis c JOIN up ON c.id = up.parent_ci_id
                WHERE c.deleted_at IS NULL
            )
            SELECT 1 FROM up WHERE id = $2 LIMIT 1"#,
        )
        .bind(new_parent)
        .bind(ci_id)
        .fetch_optional(&state.db)
        .await?;
        if cycle.is_some() {
            return Err(AppError::Validation(
                "Cannot set parent: it would create a cycle in the CI tree".into(),
            ));
        }
    }

    // T1: attribute validation on full meta replacement.
    if let Some(ref new_meta) = body.meta {
        let attr_defs = super::validation::load_attr_defs(&state.db, old.ci_type_id).await?;
        if let Err(errors) =
            super::validation::validate_meta_update(&attr_defs, &old.meta, new_meta)
        {
            return Err(super::validation::validation_error(errors));
        }
        // T2: unique constraints (excluding this CI).
        super::validation::check_unique_constraints(
            &state.db,
            org_id,
            old.ci_type_id,
            new_meta,
            Some(ci_id),
        )
        .await?;
    }

    let field_changes = compute_field_changes(&old, &body);
    let now = Utc::now();

    let ci = sqlx::query_as::<_, Ci>(&format!(
        r#"
        UPDATE cis
        SET
            name            = COALESCE($3, name),
            display_name    = COALESCE($4, display_name),
            meta            = COALESCE($5, meta),
            tags            = COALESCE($6, tags),
            lifecycle_state = COALESCE($7::ci_lifecycle_state, lifecycle_state),
            pool_id         = COALESCE($8, pool_id),
            parent_ci_id    = CASE
                WHEN $10 THEN NULL
                ELSE COALESCE($9, parent_ci_id)
            END,
            updated_at      = $11
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING {cols}
        "#,
        cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                meta, tags, lifecycle_state::text AS lifecycle_state,
                parent_ci_id, pool_id, discovered_at, created_at, updated_at"
    ))
    .bind(ci_id)
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.display_name.as_deref())
    .bind(body.meta.as_ref())
    .bind(body.tags.as_ref())
    .bind(body.lifecycle_state.as_deref())
    .bind(body.pool_id)
    .bind(body.parent_ci_id)
    .bind(body.remove_parent.unwrap_or(false))
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    write_audit_log(
        &state.db,
        ci_id,
        org_id,
        Some(user_id),
        "update",
        Some(&field_changes),
        "user",
    )
    .await;

    // Record lifecycle transition in dedicated table if state changed.
    let mut lifecycle_changed = false;
    if let Some(ref new_state) = body.lifecycle_state {
        if *new_state != old.lifecycle_state {
            lifecycle_changed = true;
            let _ = sqlx::query(
                r#"INSERT INTO ci_lifecycle_transitions
                   (id, ci_id, organization_id, from_state, to_state, triggered_by, source, created_at)
                   VALUES ($1, $2, $3, $4::ci_lifecycle_state, $5::ci_lifecycle_state, $6, 'user', NOW())"#,
            )
            .bind(Uuid::new_v4())
            .bind(ci_id)
            .bind(org_id)
            .bind(&old.lifecycle_state)
            .bind(new_state.as_str())
            .bind(user_id)
            .execute(&state.db)
            .await;
        }
    }

    // Fire-and-forget drift detection against any active baseline
    let _ = check_ci_drift(&state.db, ci_id, org_id);

    // Change events: lifecycle transitions get a dedicated event type.
    if lifecycle_changed {
        super::events::emit_ci_event(
            &state.db,
            org_id,
            super::events::EVENT_CI_LIFECYCLE_CHANGED,
            &ci,
            json!({ "from_state": old.lifecycle_state, "to_state": ci.lifecycle_state }),
        )
        .await;
    } else {
        super::events::emit_ci_event(
            &state.db,
            org_id,
            super::events::EVENT_CI_UPDATED,
            &ci,
            json!({ "field_changes": field_changes }),
        )
        .await;
    }

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok(Json(json!({ "data": resp })))
}

// ─── transition_ci_lifecycle (T3) ────────────────────────────────────────────

#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct LifecycleTransitionRequest {
    /// Target lifecycle state — must be a legal successor of the current one.
    pub to_state: String,
    /// Optional human-readable reason recorded on the transition log.
    pub reason: Option<String>,
}

/// PATCH /api/v1/orgs/:org_id/cis/:ci_id/lifecycle
///
/// Dedicated lifecycle transition endpoint. Enforces the global transition
/// matrix (422 `ERR_INVALID_TRANSITION` with the legal successor list),
/// records the transition (with reason), writes an audit entry, re-runs drift
/// detection, and fires the `ci.lifecycle_changed` event.
#[utoipa::path(
    patch,
    path = "/api/v1/orgs/{org_id}/cis/{ci_id}/lifecycle",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("ci_id"  = Uuid, Path, description = "CI ID"),
    ),
    request_body = LifecycleTransitionRequest,
    responses(
        (status = 200, description = "Transition applied", body = CiResponse),
        (status = 422, description = "ERR_INVALID_TRANSITION — the move is not in the transition matrix"),
        (status = 404, description = "CI not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn transition_ci_lifecycle(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<LifecycleTransitionRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let old = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    super::validation::validate_transition(&old.lifecycle_state, &body.to_state)?;

    let now = Utc::now();
    let ci = sqlx::query_as::<_, Ci>(&format!(
        r#"
        UPDATE cis
        SET lifecycle_state = $3::ci_lifecycle_state, updated_at = $4
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING {cols}
        "#,
        cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                meta, tags, lifecycle_state::text AS lifecycle_state,
                parent_ci_id, pool_id, discovered_at, created_at, updated_at"
    ))
    .bind(ci_id)
    .bind(org_id)
    .bind(&body.to_state)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    // Transition log (with reason).
    if body.to_state != old.lifecycle_state {
        let _ = sqlx::query(
            r#"INSERT INTO ci_lifecycle_transitions
               (id, ci_id, organization_id, from_state, to_state, reason, triggered_by, source, created_at)
               VALUES ($1, $2, $3, $4::ci_lifecycle_state, $5::ci_lifecycle_state, $6, $7, 'user', NOW())"#,
        )
        .bind(Uuid::new_v4())
        .bind(ci_id)
        .bind(org_id)
        .bind(&old.lifecycle_state)
        .bind(&body.to_state)
        .bind(body.reason.as_deref())
        .bind(user_id)
        .execute(&state.db)
        .await;
    }

    write_audit_log(
        &state.db,
        ci_id,
        org_id,
        Some(user_id),
        "lifecycle_transition",
        Some(&json!({
            "lifecycle_state": { "old": old.lifecycle_state, "new": body.to_state },
            "reason": body.reason,
        })),
        "user",
    )
    .await;

    // Drift detection may care about lifecycle-carrying meta.
    let _ = check_ci_drift(&state.db, ci_id, org_id);

    // Fire the ci.lifecycle_changed event (webhook + event stream, T6).
    super::events::emit_ci_event(
        &state.db,
        org_id,
        "ci.lifecycle_changed",
        &ci,
        json!({ "from_state": old.lifecycle_state, "to_state": body.to_state, "reason": body.reason }),
    )
    .await;

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok(Json(json!({ "data": resp })))
}

// ─── patch_ci_tags ────────────────────────────────────────────────────────────

/// Pure validation for the PATCH tags body. Returns `Ok(())` if `tags` is a
/// flat JSON object of string values, or an `AppError::Validation` with a
/// human-readable message otherwise. Kept separate from the handler so it can
/// be unit-tested without a DB.
pub fn validate_patch_tags(tags: &Value) -> AppResult<()> {
    if !tags.is_object() {
        return Err(AppError::Validation("tags must be a JSON object".into()));
    }
    if let Some(obj) = tags.as_object() {
        for (k, v) in obj {
            if !v.is_string() {
                return Err(AppError::Validation(format!(
                    "tag '{k}' value must be a string"
                )));
            }
        }
    }
    Ok(())
}

/// PATCH /api/v1/orgs/:org_id/cis/:ci_id/tags
///
/// Replace the full tags object on a configuration item. The body must be
/// `{"tags": { "key": "value", ... }}` where every value is a string. Mirrors
/// the `/resources/:id/tags` pattern.
#[utoipa::path(
    patch,
    path = "/api/v1/orgs/{org_id}/cis/{ci_id}/tags",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("ci_id"  = Uuid, Path, description = "CI ID"),
    ),
    request_body = PatchCiTagsRequest,
    responses(
        (status = 200, description = "Tags updated", body = CiResponse),
        (status = 400, description = "tags must be a JSON object of string values"),
        (status = 404, description = "CI not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn patch_ci_tags(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<super::dto::PatchCiTagsRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;
    crate::utils::tags::validate_tags(&body.tags)?;

    validate_patch_tags(&body.tags)?;

    // Fetch pre-state for audit diff.
    let old = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    let field_changes = json!({ "tags": { "old": old.tags, "new": body.tags } });
    let now = Utc::now();

    let ci = sqlx::query_as::<_, Ci>(&format!(
        r#"
        UPDATE cis
        SET tags = $3, updated_at = $4
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING {cols}
        "#,
        cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                meta, tags, lifecycle_state::text AS lifecycle_state,
                parent_ci_id, pool_id, discovered_at, created_at, updated_at"
    ))
    .bind(ci_id)
    .bind(org_id)
    .bind(&body.tags)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    write_audit_log(
        &state.db,
        ci_id,
        org_id,
        Some(user_id),
        "update",
        Some(&field_changes),
        "user",
    )
    .await;

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok(Json(json!({ "data": resp })))
}

// ─── delete_ci ────────────────────────────────────────────────────────────────

pub async fn delete_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Snapshot for the delete event before the row goes away.
    let old = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    let result = sqlx::query(
        "UPDATE cis SET deleted_at = $1 WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL",
    )
    .bind(Utc::now())
    .bind(ci_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("CI not found".into()));
    }

    write_audit_log(&state.db, ci_id, org_id, Some(user_id), "delete", None, "user").await;

    super::events::emit_ci_deleted(&state.db, org_id, &old).await;

    Ok((StatusCode::OK, Json(json!({ "data": { "message": "CI deleted" } }))))
}

// ─── list_associations ────────────────────────────────────────────────────────

pub async fn list_associations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query_as::<_, AssociationRow>(
        r#"
        SELECT
            cia.id,
            cia.src_ci_id,
            src.name AS src_ci_name,
            ciak.display_name AS association_kind_name,
            cia.dst_ci_id,
            dst.name AS dst_ci_name,
            cia.meta,
            cia.created_at
        FROM ci_instance_associations cia
        JOIN cis src ON src.id = cia.src_ci_id
        JOIN cis dst ON dst.id = cia.dst_ci_id
        JOIN ci_object_associations coa ON coa.id = cia.object_association_id
        JOIN ci_association_kinds ciak ON ciak.id = coa.association_kind_id
        WHERE cia.organization_id = $1
          AND (cia.src_ci_id = $2 OR cia.dst_ci_id = $2)
        ORDER BY cia.created_at DESC, cia.id DESC
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(org_id)
    .bind(ci_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM ci_instance_associations cia
           WHERE cia.organization_id = $1
             AND (cia.src_ci_id = $2 OR cia.dst_ci_id = $2)"#,
    )
    .bind(org_id)
    .bind(ci_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<AssociationResponse> = rows
        .into_iter()
        .map(|r| AssociationResponse {
            id: r.id,
            src_ci_id: r.src_ci_id,
            src_ci_name: r.src_ci_name,
            association_kind_name: r.association_kind_name,
            dst_ci_id: r.dst_ci_id,
            dst_ci_name: r.dst_ci_name,
            meta: r.meta,
            created_at: r.created_at,
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── create_association ───────────────────────────────────────────────────────

pub async fn create_association(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, src_ci_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateAssociationRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let assoc_id = Uuid::new_v4();
    let meta = body.meta.unwrap_or(Value::Object(Default::default()));

    sqlx::query(
        r#"
        INSERT INTO ci_instance_associations
            (id, organization_id, src_ci_id, object_association_id, dst_ci_id, meta, created_by, source, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8)
        "#,
    )
    .bind(assoc_id)
    .bind(org_id)
    .bind(src_ci_id)
    .bind(body.object_association_id)
    .bind(body.dst_ci_id)
    .bind(&meta)
    .bind(user_id)
    .bind(Utc::now())
    .execute(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("This association already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    // Association change event (best-effort: needs the live src CI row).
    if let Ok(Some(src_ci)) = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(src_ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await
    {
        super::events::emit_ci_event(
            &state.db,
            org_id,
            super::events::EVENT_CI_ASSOCIATION_CHANGED,
            &src_ci,
            json!({ "action": "created", "assoc_id": assoc_id, "dst_ci_id": body.dst_ci_id }),
        )
        .await;
    }

    Ok((
        StatusCode::CREATED,
        Json(json!({ "data": { "id": assoc_id, "message": "Association created" } })),
    ))
}

// ─── delete_association ───────────────────────────────────────────────────────

/// DELETE /api/v1/orgs/:org_id/cis/:ci_id/associations/:assoc_id
///
/// Permanently removes a CI instance association. The association must belong
/// to the organization and involve `ci_id` as either source or destination.
pub async fn delete_association(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id, assoc_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"DELETE FROM ci_instance_associations
           WHERE id = $1
             AND organization_id = $2
             AND (src_ci_id = $3 OR dst_ci_id = $3)"#,
    )
    .bind(assoc_id)
    .bind(org_id)
    .bind(ci_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Association {assoc_id} not found")));
    }

    // Association change event (best-effort).
    if let Ok(Some(src_ci)) = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await
    {
        super::events::emit_ci_event(
            &state.db,
            org_id,
            super::events::EVENT_CI_ASSOCIATION_CHANGED,
            &src_ci,
            json!({ "action": "deleted", "assoc_id": assoc_id }),
        )
        .await;
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

// ─── delete_ci_type ───────────────────────────────────────────────────────────

/// DELETE /api/v1/orgs/:org_id/ci-types/:type_id
///
/// Soft-deletes a custom CI type (deleted_at = now). Rejected if:
/// - The type is a builtin (is_builtin = true), or
/// - There are active (non-deleted) CIs of this type in the organization.
pub async fn delete_ci_type(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Fetch the type and confirm it belongs to this org (not builtin).
    let row = sqlx::query(
        "SELECT is_builtin, name FROM ci_types WHERE id = $1 AND organization_id = $2",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found or is a builtin".into()))?;

    let is_builtin: bool = row.try_get("is_builtin").unwrap_or(true);
    if is_builtin {
        return Err(AppError::Forbidden("Cannot delete a builtin CI type".into()));
    }
    let type_name: String = row.try_get("name").unwrap_or_default();

    // Guard: reject if active CIs exist for this type.
    let active_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cis WHERE ci_type_id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    if active_count > 0 {
        return Err(AppError::Validation(format!(
            "Cannot delete CI type: {active_count} active CI(s) still reference it. Delete them first."
        )));
    }

    sqlx::query(
        "UPDATE ci_types SET deleted_at = $1 WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL",
    )
    .bind(Utc::now())
    .bind(type_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    tracing::info!(
        org_id = %org_id,
        type_id = %type_id,
        deleted_by = %user_id,
        "CI type soft-deleted"
    );

    // T4: model-layer audit.
    write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_type",
        "delete",
        &type_id.to_string(),
        &type_name,
        Some(&json!({ "name": type_name })),
        None,
    )
    .await;

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

// ─── ci_history ───────────────────────────────────────────────────────────────

pub async fn ci_history(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let logs = sqlx::query_as::<_, CiAuditLog>(
        r#"
        SELECT id, ci_id, organization_id, user_id, operation, field_changes, source, created_at
        FROM ci_audit_logs
        WHERE ci_id = $1 AND organization_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4
        "#,
    )
    .bind(ci_id)
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_audit_logs WHERE ci_id = $1 AND organization_id = $2",
    )
    .bind(ci_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<AuditLogResponse> = logs.into_iter().map(Into::into).collect();
    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

// ─── Private helpers ──────────────────────────────────────────────────────────

fn ci_to_response(ci: Ci, ci_type_name: String) -> CiResponse {
    CiResponse {
        id: ci.id,
        organization_id: ci.organization_id,
        ci_type_id: ci.ci_type_id,
        ci_type_name,
        cloud_account_id: ci.cloud_account_id,
        cloud_resource_id: ci.cloud_resource_id,
        cloud_provider: ci.cloud_provider,
        cloud_region: ci.cloud_region,
        name: ci.name,
        display_name: ci.display_name,
        meta: ci.meta,
        tags: ci.tags,
        lifecycle_state: ci.lifecycle_state,
        parent_ci_id: ci.parent_ci_id,
        pool_id: ci.pool_id,
        discovered_at: ci.discovered_at,
        created_at: ci.created_at,
        updated_at: ci.updated_at,
    }
}

async fn fetch_ci_type_name(db: &sqlx::PgPool, type_id: Uuid) -> AppResult<String> {
    let row = sqlx::query("SELECT display_name FROM ci_types WHERE id = $1")
        .bind(type_id)
        .fetch_optional(db)
        .await?;

    Ok(row
        .and_then(|r| r.try_get::<String, _>("display_name").ok())
        .unwrap_or_else(|| "Unknown".into()))
}

async fn fetch_ci_type_names(
    db: &sqlx::PgPool,
    type_ids: &[Uuid],
) -> AppResult<std::collections::HashMap<Uuid, String>> {
    if type_ids.is_empty() {
        return Ok(Default::default());
    }

    let rows = sqlx::query("SELECT id, display_name FROM ci_types WHERE id = ANY($1)")
        .bind(type_ids)
        .fetch_all(db)
        .await?;

    Ok(rows
        .iter()
        .filter_map(|r| {
            let id: Uuid = r.try_get("id").ok()?;
            let name: String = r.try_get("display_name").ok()?;
            Some((id, name))
        })
        .collect())
}

// ─── CI Topology ─────────────────────────────────────────────────────────────

/// Builds a nested tree of a CI's descendants via `parent_ci_id` using a recursive CTE.
pub async fn ci_topology(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<TopologyQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let max_depth = q.max_depth.unwrap_or(10).clamp(1, 20);

    let rows = sqlx::query(
        r#"
        WITH RECURSIVE topo AS (
            SELECT
                id, name, display_name, ci_type_id, parent_ci_id,
                lifecycle_state::text AS lifecycle_state, cloud_region, 0 AS depth
            FROM cis
            WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
            UNION ALL
            SELECT
                c.id, c.name, c.display_name, c.ci_type_id, c.parent_ci_id,
                c.lifecycle_state::text, c.cloud_region, t.depth + 1
            FROM cis c
            JOIN topo t ON c.parent_ci_id = t.id
            WHERE c.deleted_at IS NULL AND t.depth < $3
        )
        SELECT t.id, t.name, t.display_name, t.ci_type_id, t.parent_ci_id,
               t.lifecycle_state, t.cloud_region, t.depth,
               ct.display_name AS ci_type_name
        FROM topo t
        LEFT JOIN ci_types ct ON ct.id = t.ci_type_id
        ORDER BY t.depth, t.name
        "#,
    )
    .bind(ci_id)
    .bind(org_id)
    .bind(max_depth)
    .fetch_all(&state.db)
    .await?;

    if rows.is_empty() {
        return Err(AppError::NotFound(format!("CI {ci_id} not found")));
    }

    let total_nodes = rows.len();

    // Build a node map and children adjacency map
    let mut node_map: HashMap<Uuid, Value> = HashMap::new();
    let mut children_map: HashMap<Uuid, Vec<Uuid>> = HashMap::new();

    for row in &rows {
        let id: Uuid = row.try_get("id").unwrap_or_default();
        let parent_id: Option<Uuid> = row.try_get("parent_ci_id").unwrap_or(None);

        node_map.insert(
            id,
            json!({
                "id":              id,
                "name":            row.try_get::<String, _>("name").unwrap_or_default(),
                "display_name":    row.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "ci_type_id":      row.try_get::<Option<Uuid>, _>("ci_type_id").unwrap_or(None),
                "ci_type_name":    row.try_get::<Option<String>, _>("ci_type_name").unwrap_or(None),
                "lifecycle_state": row.try_get::<String, _>("lifecycle_state").unwrap_or_default(),
                "cloud_region":    row.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "depth":           row.try_get::<i32, _>("depth").unwrap_or(0),
            }),
        );

        // Only add to children_map if this node has a parent (so parent gets it as child)
        if let Some(pid) = parent_id {
            children_map.entry(pid).or_default().push(id);
        }
    }

    // Recursively build the tree starting from the root CI
    let tree = build_topo_node(ci_id, &node_map, &children_map);

    Ok(Json(json!({
        "data": {
            "root": tree,
            "total_nodes": total_nodes,
        }
    })))
}

/// Recursively constructs a JSON tree node with nested children.
fn build_topo_node(
    id: Uuid,
    nodes: &HashMap<Uuid, Value>,
    children: &HashMap<Uuid, Vec<Uuid>>,
) -> Value {
    let base = match nodes.get(&id) {
        Some(n) => n.clone(),
        None => return json!(null),
    };

    let child_values: Vec<Value> = children
        .get(&id)
        .map(|kids| {
            kids.iter()
                .map(|kid| build_topo_node(*kid, nodes, children))
                .collect()
        })
        .unwrap_or_default();

    let mut result = base.as_object().cloned().unwrap_or_default();
    result.insert("children".to_string(), json!(child_values));
    Value::Object(result)
}

// ─── CI Impact ────────────────────────────────────────────────────────────────

pub async fn ci_impact(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Query(params): Query<ImpactQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Verify CI exists in this org.
    sqlx::query("SELECT id FROM cis WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL")
        .bind(ci_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("CI {ci_id} not found")))?;

    let max_depth = params.max_depth.unwrap_or(3).clamp(1, 10);
    let direction = params.direction.as_deref().unwrap_or("both");

    // BFS recursive CTE: traverse association graph up to max_depth hops.
    // "outgoing" follows src→dst edges; "incoming" follows dst→src; "both" merges both.
    // Note: PostgreSQL requires the recursive CTE to be referenced exactly once
    // in the recursive term, so the direction is carried on the bfs row itself.
    let rows = sqlx::query(
        r#"
        WITH RECURSIVE bfs AS (
            -- Seed: direct neighbours
            SELECT
                CASE WHEN dirs.direction = 'out' THEN cia.dst_ci_id ELSE cia.src_ci_id END AS ci_id,
                cia.object_association_id,
                1 AS depth,
                dirs.direction
            FROM ci_instance_associations cia
            CROSS JOIN (
                SELECT 'out'::text AS direction
                WHERE $3 IN ('outgoing','both')
                UNION ALL
                SELECT 'in'::text AS direction
                WHERE $3 IN ('incoming','both')
            ) dirs
            WHERE ((dirs.direction = 'out' AND cia.src_ci_id = $1)
                OR (dirs.direction = 'in'  AND cia.dst_ci_id = $1))
              AND cia.organization_id = $2

            UNION

            -- BFS expansion up to max_depth
            SELECT
                CASE WHEN bfs.direction = 'out' THEN cia.dst_ci_id ELSE cia.src_ci_id END,
                cia.object_association_id,
                bfs.depth + 1,
                bfs.direction
            FROM ci_instance_associations cia
            JOIN bfs ON (
                (bfs.direction = 'out' AND cia.src_ci_id = bfs.ci_id)
             OR (bfs.direction = 'in'  AND cia.dst_ci_id = bfs.ci_id)
            )
            WHERE cia.organization_id = $2
              AND bfs.depth < $4
        )
        SELECT DISTINCT ON (bfs.ci_id)
               bfs.ci_id,
               bfs.depth,
               bfs.direction,
               c.name,
               c.display_name,
               c.lifecycle_state::text AS lifecycle_state,
               ct.display_name          AS ci_type_name,
               cak.name                 AS association_kind
        FROM bfs
        JOIN cis c ON c.id = bfs.ci_id AND c.deleted_at IS NULL
        LEFT JOIN ci_types ct ON ct.id = c.ci_type_id
        LEFT JOIN ci_object_associations coa ON coa.id = bfs.object_association_id
        LEFT JOIN ci_association_kinds cak ON cak.id = coa.association_kind_id
        WHERE bfs.ci_id <> $1
        ORDER BY bfs.ci_id, bfs.depth
        "#,
    )
    .bind(ci_id)
    .bind(org_id)
    .bind(direction)
    .bind(max_depth)
    .fetch_all(&state.db)
    .await?;

    let impacted_cis: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":               r.try_get::<Uuid, _>("ci_id").ok(),
                "name":             r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name":     r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "lifecycle_state":  r.try_get::<String, _>("lifecycle_state").unwrap_or_default(),
                "ci_type_name":     r.try_get::<Option<String>, _>("ci_type_name").unwrap_or(None),
                "association_kind": r.try_get::<Option<String>, _>("association_kind").unwrap_or(None),
                "direction":        r.try_get::<String, _>("direction").unwrap_or_default(),
                "depth":            r.try_get::<i32, _>("depth").unwrap_or(1),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": {
            "ci_id":        ci_id,
            "max_depth":    max_depth,
            "direction":    direction,
            "impacted_cis": impacted_cis,
            "total":        impacted_cis.len(),
        }
    })))
}

// ─── Dynamic Groups ───────────────────────────────────────────────────────────

pub async fn list_dynamic_groups(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, ci_type_id, conditions, created_at, updated_at
           FROM ci_dynamic_groups WHERE organization_id = $1
           ORDER BY name ASC, id ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_dynamic_groups WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":          r.try_get::<Uuid, _>("id").ok(),
                "name":        r.try_get::<String, _>("name").unwrap_or_default(),
                "description": r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "ci_type_id":  r.try_get::<Option<Uuid>, _>("ci_type_id").unwrap_or(None),
                "conditions":  r.try_get::<serde_json::Value, _>("conditions").unwrap_or(serde_json::json!([])),
                "created_at":  r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at":  r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_dynamic_group(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let name = body["name"]
        .as_str()
        .ok_or_else(|| AppError::Validation("name is required".into()))?
        .to_string();

    let id = Uuid::new_v4();
    let conditions = body.get("conditions").cloned().unwrap_or(serde_json::json!([]));
    let ci_type_id: Option<Uuid> = body["ci_type_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok());

    sqlx::query(
        r#"INSERT INTO ci_dynamic_groups (id, organization_id, name, description, ci_type_id, conditions, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&name)
    .bind(body["description"].as_str())
    .bind(ci_type_id)
    .bind(&conditions)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(serde_json::json!({ "data": { "id": id, "name": name } })),
    ))
}

pub async fn update_dynamic_group(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, group_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE ci_dynamic_groups SET
               name        = COALESCE($3, name),
               description = COALESCE($4, description),
               conditions  = COALESCE($5, conditions),
               updated_at  = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(group_id)
    .bind(org_id)
    .bind(body["name"].as_str())
    .bind(body["description"].as_str())
    .bind(body.get("conditions"))
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Dynamic group {group_id} not found")));
    }

    Ok(Json(serde_json::json!({ "data": { "id": group_id, "message": "Updated" } })))
}

pub async fn delete_dynamic_group(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, group_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM ci_dynamic_groups WHERE id = $1 AND organization_id = $2",
    )
    .bind(group_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Dynamic group {group_id} not found")));
    }

    Ok((axum::http::StatusCode::NO_CONTENT, Json(serde_json::json!({}))))
}

/// Execute a dynamic group with SQL pushdown (T16): conditions compile to a
/// whitelisted, bound WHERE; the 500-row memory cap is gone; the response
/// follows the unified {data, meta} pagination envelope.
pub async fn execute_dynamic_group(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, group_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let group = sqlx::query(
        "SELECT id, ci_type_id, conditions FROM ci_dynamic_groups WHERE id = $1 AND organization_id = $2",
    )
    .bind(group_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Dynamic group {group_id} not found")))?;

    let ci_type_id: Option<Uuid> = group.try_get("ci_type_id").unwrap_or(None);
    let conditions_raw: Value = group
        .try_get::<Value, _>("conditions")
        .unwrap_or_else(|_| json!([]));
    let conditions: Vec<Value> = conditions_raw.as_array().cloned().unwrap_or_default();

    let bounds = page.resolve(50, 200);
    let (cis, total) =
        run_dynamic_group_sql(&state.db, org_id, &conditions, ci_type_id, bounds.limit, bounds.offset).await?;

    Ok((
        axum::http::StatusCode::OK,
        Json(json!({
            "data": cis,
            "meta": crate::utils::pagination::page_meta_json(total, &bounds)
        })),
    ))
}

/// Evaluate all conditions with AND (default) or OR logic.
/// Condition JSON shape: `{ "field": "name", "operator": "$eq", "value": "web-01", "logic": "AND" }`
fn evaluate_conditions(ci: &Value, conditions: &[Value]) -> bool {
    if conditions.is_empty() {
        return true;
    }

    // Check if any condition specifies "OR" logic — if mixed, majority wins; simple: first non-null
    let use_or = conditions
        .iter()
        .any(|c| c.get("logic").and_then(|v| v.as_str()) == Some("OR"));

    if use_or {
        conditions.iter().any(|c| evaluate_condition(ci, c))
    } else {
        conditions.iter().all(|c| evaluate_condition(ci, c))
    }
}

/// Evaluate a single condition against a CI value.
fn evaluate_condition(ci: &Value, condition: &Value) -> bool {
    let field = match condition.get("field").and_then(|v| v.as_str()) {
        Some(f) => f,
        None => return true,
    };
    let operator = condition
        .get("operator")
        .and_then(|v| v.as_str())
        .unwrap_or("$eq");
    let cond_val = condition.get("value");

    // Resolve field value from CI — support `meta.key` JSONB path
    let ci_field_val: Option<Value> = if let Some(meta_key) = field.strip_prefix("meta.") {
        ci.get("meta").and_then(|m| m.get(meta_key)).cloned()
    } else if let Some(tags_key) = field.strip_prefix("tags.") {
        ci.get("tags").and_then(|t| t.get(tags_key)).cloned()
    } else {
        ci.get(field).cloned()
    };

    match operator {
        "$eq" => {
            let cv = match cond_val {
                Some(v) => v,
                None => return ci_field_val.is_none(),
            };
            match &ci_field_val {
                Some(Value::String(s)) => cv.as_str().map(|c| c.to_lowercase() == s.to_lowercase()).unwrap_or(false),
                Some(other) => other == cv,
                None => false,
            }
        }
        "$ne" => {
            let cv = match cond_val {
                Some(v) => v,
                None => return ci_field_val.is_some(),
            };
            match &ci_field_val {
                Some(Value::String(s)) => cv.as_str().map(|c| c.to_lowercase() != s.to_lowercase()).unwrap_or(true),
                Some(other) => other != cv,
                None => true,
            }
        }
        "$in" => {
            let arr = match cond_val.and_then(|v| v.as_array()) {
                Some(a) => a,
                None => return false,
            };
            match &ci_field_val {
                Some(v) => arr.iter().any(|a| a == v),
                None => false,
            }
        }
        "$nin" => {
            let arr = match cond_val.and_then(|v| v.as_array()) {
                Some(a) => a,
                None => return true,
            };
            match &ci_field_val {
                Some(v) => !arr.iter().any(|a| a == v),
                None => true,
            }
        }
        "$contains" => {
            let pattern = match cond_val.and_then(|v| v.as_str()) {
                Some(p) => p.to_lowercase(),
                None => return false,
            };
            match &ci_field_val {
                Some(Value::String(s)) => s.to_lowercase().contains(&pattern),
                _ => false,
            }
        }
        "$startswith" => {
            let pattern = match cond_val.and_then(|v| v.as_str()) {
                Some(p) => p.to_lowercase(),
                None => return false,
            };
            match &ci_field_val {
                Some(Value::String(s)) => s.to_lowercase().starts_with(&pattern),
                _ => false,
            }
        }
        "$gte" => compare_numeric(&ci_field_val, cond_val, |a, b| a >= b),
        "$lte" => compare_numeric(&ci_field_val, cond_val, |a, b| a <= b),
        "$gt"  => compare_numeric(&ci_field_val, cond_val, |a, b| a > b),
        "$lt"  => compare_numeric(&ci_field_val, cond_val, |a, b| a < b),
        _ => true,
    }
}

fn compare_numeric<F: Fn(f64, f64) -> bool>(
    ci_val: &Option<Value>,
    cond_val: Option<&Value>,
    f: F,
) -> bool {
    let a = match ci_val {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    let b = cond_val.and_then(|v| v.as_f64());
    match (a, b) {
        (Some(a), Some(b)) => f(a, b),
        _ => false,
    }
}

// ─── Drift Detection ─────────────────────────────────────────────────────────

/// Fire-and-forget wrapper: spawns drift detection in the background so callers don't block.
pub fn check_ci_drift(db: &sqlx::PgPool, ci_id: Uuid, org_id: Uuid) -> tokio::task::JoinHandle<()> {
    let db = db.clone();
    tokio::spawn(async move {
        if let Err(e) = do_check_ci_drift(&db, ci_id, org_id).await {
            tracing::warn!("Drift check failed for CI {ci_id}: {e}");
        }
    })
}

/// Compare the CI's current `meta` JSONB against the active baseline's `desired_state`.
/// Inserts a `ci_drift` row for every field that diverges (if not already open).
async fn do_check_ci_drift(db: &sqlx::PgPool, ci_id: Uuid, org_id: Uuid) -> AppResult<()> {
    // Fetch the active baseline for this CI (there should be at most one active baseline)
    let baseline_row = sqlx::query(
        r#"SELECT id, desired_state
           FROM ci_baselines
           WHERE ci_id = $1 AND organization_id = $2 AND is_active = true
           LIMIT 1"#,
    )
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(db)
    .await?;

    let baseline_row = match baseline_row {
        Some(r) => r,
        None => return Ok(()), // No active baseline — nothing to compare
    };

    let baseline_id: Uuid = baseline_row.try_get("id")?;
    let desired_state: Value = baseline_row
        .try_get::<Value, _>("desired_state")
        .unwrap_or_else(|_| json!({}));

    // Fetch the current CI meta
    let ci_row = sqlx::query("SELECT meta FROM cis WHERE id = $1 AND deleted_at IS NULL")
        .bind(ci_id)
        .fetch_optional(db)
        .await?;

    let ci_row = match ci_row {
        Some(r) => r,
        None => return Ok(()),
    };

    let current_meta: Value = ci_row
        .try_get::<Value, _>("meta")
        .unwrap_or_else(|_| json!({}));

    let desired_obj = match desired_state.as_object() {
        Some(m) => m,
        None => return Ok(()),
    };

    // For each field defined in desired_state, compare against current meta
    for (field, expected) in desired_obj {
        let actual = current_meta.get(field);
        let actual_val = actual.cloned().unwrap_or(Value::Null);

        // If values match, skip
        if &actual_val == expected {
            continue;
        }

        let expected_str = serde_json::to_string(expected).unwrap_or_default();
        let actual_str = serde_json::to_string(&actual_val).unwrap_or_default();

        // Insert drift record — skip if an open drift already exists for this field
        sqlx::query(
            r#"INSERT INTO ci_drift (baseline_id, ci_id, organization_id, field_name,
                                     expected_value, actual_value, status, detected_at)
               SELECT $1, $2, $3, $4, $5, $6, 'open'::drift_status, NOW()
               WHERE NOT EXISTS (
                   SELECT 1 FROM ci_drift
                   WHERE baseline_id = $1 AND ci_id = $2 AND field_name = $4
                     AND status = 'open'::drift_status
               )"#,
        )
        .bind(baseline_id)
        .bind(ci_id)
        .bind(org_id)
        .bind(field)
        .bind(&expected_str)
        .bind(&actual_str)
        .execute(db)
        .await?;
    }

    Ok(())
}

// ─── CI Attributes ────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/:org_id/ci-types/:type_id/attributes
/// List all attribute definitions for a CI type (builtin + org-specific).
pub async fn list_ci_attributes(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    sqlx::query(
        "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let rows = sqlx::query(
        r#"SELECT id, ci_type_id, name, display_name, description,
                  attribute_type::text AS attribute_type, is_required, is_unique,
                  default_value, enum_values, validation_rule, sort_order, is_builtin, created_at
           FROM ci_attributes
           WHERE ci_type_id = $1
           ORDER BY sort_order ASC, name ASC"#,
    )
    .bind(type_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":             r.try_get::<Uuid, _>("id").ok(),
                "ci_type_id":     r.try_get::<Uuid, _>("ci_type_id").ok(),
                "name":           r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name":   r.try_get::<String, _>("display_name").unwrap_or_default(),
                "description":    r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "attribute_type": r.try_get::<String, _>("attribute_type").unwrap_or_default(),
                "is_required":    r.try_get::<bool, _>("is_required").unwrap_or(false),
                "is_unique":      r.try_get::<bool, _>("is_unique").unwrap_or(false),
                "default_value":  r.try_get::<Option<String>, _>("default_value").unwrap_or(None),
                "enum_values":    r.try_get::<Option<Value>, _>("enum_values").unwrap_or(None),
                "sort_order":     r.try_get::<i32, _>("sort_order").unwrap_or(0),
                "is_builtin":     r.try_get::<bool, _>("is_builtin").unwrap_or(false),
                "created_at":     r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

#[derive(serde::Deserialize)]
pub struct CreateCiAttributeRequest {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub attribute_type: String,
    pub is_required: Option<bool>,
    pub is_unique: Option<bool>,
    pub default_value: Option<String>,
    pub enum_values: Option<Value>,
    pub sort_order: Option<i32>,
}

/// POST /api/v1/orgs/:org_id/ci-types/:type_id/attributes
/// Add a new attribute definition to a custom (non-builtin) CI type.
pub async fn create_ci_attribute(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateCiAttributeRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("Attribute name cannot be empty".into()));
    }

    let type_row = sqlx::query(
        "SELECT is_builtin FROM ci_types WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found or is a builtin".into()))?;

    let is_builtin: bool = type_row.try_get("is_builtin").unwrap_or(false);
    if is_builtin {
        return Err(AppError::Forbidden("Cannot add attributes to a builtin CI type".into()));
    }

    let attr_id = Uuid::new_v4();
    let row = sqlx::query(
        r#"INSERT INTO ci_attributes
           (id, ci_type_id, organization_id, name, display_name, description,
            attribute_type, is_required, is_unique, default_value, enum_values, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7::ci_attribute_type, $8, $9, $10, $11, $12)
           RETURNING id, name, display_name, attribute_type::text AS attribute_type, is_required, created_at"#,
    )
    .bind(attr_id)
    .bind(type_id)
    .bind(org_id)
    .bind(body.name.trim())
    .bind(&body.display_name)
    .bind(body.description.as_deref())
    .bind(&body.attribute_type)
    .bind(body.is_required.unwrap_or(false))
    .bind(body.is_unique.unwrap_or(false))
    .bind(body.default_value.as_deref())
    .bind(body.enum_values.as_ref())
    .bind(body.sort_order.unwrap_or(100))
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("unique") || msg.contains("duplicate") {
            AppError::Conflict("An attribute with this name already exists on this CI type".into())
        } else if msg.contains("invalid input value for enum") {
            AppError::Validation(format!("Invalid attribute_type: '{}'", body.attribute_type))
        } else {
            AppError::Database(e)
        }
    })?;

    tracing::info!(org_id = %org_id, type_id = %type_id, attr_id = %attr_id, "CI attribute created");

    // T4: model-layer audit.
    write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_attribute",
        "create",
        &attr_id.to_string(),
        &body.name,
        None,
        Some(&json!({
            "ci_type_id": type_id,
            "name": body.name,
            "attribute_type": body.attribute_type,
            "is_required": body.is_required.unwrap_or(false),
            "is_unique": body.is_unique.unwrap_or(false),
        })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id":             row.try_get::<Uuid, _>("id").ok(),
                "name":           row.try_get::<String, _>("name").unwrap_or_default(),
                "display_name":   row.try_get::<String, _>("display_name").unwrap_or_default(),
                "attribute_type": row.try_get::<String, _>("attribute_type").unwrap_or_default(),
                "is_required":    row.try_get::<bool, _>("is_required").unwrap_or(false),
                "created_at":     row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            }
        })),
    ))
}

/// DELETE /api/v1/orgs/:org_id/ci-types/:type_id/attributes/:attr_id
/// Remove a custom (non-builtin) attribute from a CI type.
pub async fn delete_ci_attribute(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id, attr_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        "SELECT is_builtin FROM ci_attributes WHERE id = $1 AND ci_type_id = $2",
    )
    .bind(attr_id)
    .bind(type_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Attribute not found".into()))?;

    if row.try_get::<bool, _>("is_builtin").unwrap_or(false) {
        return Err(AppError::Forbidden("Cannot delete a builtin attribute".into()));
    }

    sqlx::query("DELETE FROM ci_attributes WHERE id = $1 AND ci_type_id = $2")
        .bind(attr_id)
        .bind(type_id)
        .execute(&state.db)
        .await?;

    tracing::info!(org_id = %org_id, attr_id = %attr_id, deleted_by = %user_id, "CI attribute deleted");

    // T4: model-layer audit.
    write_model_audit_log(
        &state.db,
        org_id,
        Some(user_id),
        "ci_attribute",
        "delete",
        &attr_id.to_string(),
        "",
        Some(&json!({ "ci_type_id": type_id, "attr_id": attr_id })),
        None,
    )
    .await;

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

// ─── CI Association Kinds ─────────────────────────────────────────────────────

/// GET /api/v1/orgs/:org_id/ci-association-kinds
/// List all association kinds available to this org (builtin + org-specific).
pub async fn list_ci_association_kinds(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let rows = sqlx::query(
        r#"SELECT id, organization_id, name, display_name, description,
                  is_directional, is_builtin, created_at
           FROM ci_association_kinds
           WHERE organization_id = $1 OR organization_id IS NULL
           ORDER BY is_builtin DESC, name ASC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":             r.try_get::<Uuid, _>("id").ok(),
                "name":           r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name":   r.try_get::<String, _>("display_name").unwrap_or_default(),
                "description":    r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "is_directional": r.try_get::<bool, _>("is_directional").unwrap_or(true),
                "is_builtin":     r.try_get::<bool, _>("is_builtin").unwrap_or(false),
                "created_at":     r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

// ─── CI Object Associations (schema-level) ────────────────────────────────────

/// GET /api/v1/orgs/:org_id/ci-object-associations
/// List schema-level relationship definitions (src_type ↔ kind ↔ dst_type).
/// Used by the UI to populate the association creation form.
pub async fn list_ci_object_associations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let rows = sqlx::query(
        r#"SELECT coa.id, coa.organization_id,
                  coa.src_ci_type_id, src_t.display_name AS src_type_name,
                  coa.association_kind_id, cak.display_name AS kind_name, cak.name AS kind_key,
                  coa.dst_ci_type_id, dst_t.display_name AS dst_type_name,
                  coa.cardinality::text AS cardinality, coa.description, coa.created_at
           FROM ci_object_associations coa
           JOIN ci_types src_t ON src_t.id = coa.src_ci_type_id
           JOIN ci_types dst_t ON dst_t.id = coa.dst_ci_type_id
           JOIN ci_association_kinds cak ON cak.id = coa.association_kind_id
           WHERE coa.organization_id = $1 OR coa.organization_id IS NULL
           ORDER BY src_t.display_name, cak.name, dst_t.display_name"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":                   r.try_get::<Uuid, _>("id").ok(),
                "src_ci_type_id":       r.try_get::<Uuid, _>("src_ci_type_id").ok(),
                "src_type_name":        r.try_get::<String, _>("src_type_name").unwrap_or_default(),
                "association_kind_id":  r.try_get::<Uuid, _>("association_kind_id").ok(),
                "kind_name":            r.try_get::<String, _>("kind_name").unwrap_or_default(),
                "kind_key":             r.try_get::<String, _>("kind_key").unwrap_or_default(),
                "dst_ci_type_id":       r.try_get::<Uuid, _>("dst_ci_type_id").ok(),
                "dst_type_name":        r.try_get::<String, _>("dst_type_name").unwrap_or_default(),
                "cardinality":          r.try_get::<String, _>("cardinality").unwrap_or_default(),
                "description":          r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "created_at":           r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "total": data.len() })))
}

/// Audit helper used by the CSV import path (T7) — one create entry per row.
pub(crate) async fn audit_import_row(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Option<Uuid>,
    ci_id: Uuid,
    ci_name: &str,
) {
    let _ = sqlx::query(
        r#"INSERT INTO ci_audit_logs (id, ci_id, organization_id, user_id, operation, field_changes, source, created_at)
           VALUES ($1, $2, $3, $4, 'create', $5, 'bulk_import', NOW())"#,
    )
    .bind(Uuid::new_v4())
    .bind(ci_id)
    .bind(org_id)
    .bind(user_id)
    .bind(json!({ "name": ci_name, "via": "csv_import" }))
    .execute(db)
    .await;
}

// ─── CI Full-text Search (T8) ────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
pub struct CiSearchQuery {
    /// Free-text query — trigram-matched against name / display_name /
    /// cloud_resource_id, with meta/tags ::text ILIKE as a fallback.
    pub q: String,
    /// Optional type scope.
    pub ci_type_id: Option<Uuid>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

/// GET /api/v1/orgs/:org_id/cis/search?q=
///
/// Ranked full-text search: `%q%` ILIKE over the trigram-indexed name surface
/// (similarity-ranked) UNION meta/tags JSONB text fallback, returning the
/// unified `{data, meta}` pagination envelope.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cis/search",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("q" = String, Query, description = "Search text"),
        ("ci_type_id" = Uuid, Query, description = "Optional CI type scope"),
    ),
    responses(
        (status = 200, description = "Ranked, paginated search results"),
        (status = 422, description = "q is required"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn search_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<CiSearchQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let term = q.q.trim().to_string();
    if term.is_empty() {
        return Err(AppError::Validation("q is required".into()));
    }

    let bounds = q.page.resolve(50, 200);
    let pattern = format!("%{}%", term.to_lowercase());

    // Trigram-indexed surface (name/display_name/cloud_resource_id) ranked by
    // similarity, UNION the JSONB fallback (meta/tags as text). DISTINCT ON
    // keeps one row per CI with the best (lowest) rank.
    let rows = sqlx::query(
        r#"
        WITH ranked AS (
            SELECT
                c.id, c.name, c.display_name, c.cloud_resource_id,
                c.lifecycle_state::text AS lifecycle_state, c.cloud_region,
                c.cloud_provider::text AS cloud_provider, c.ci_type_id,
                ROW_NUMBER() OVER (
                    PARTITION BY c.id
                    ORDER BY
                        CASE
                            WHEN lower(c.name) LIKE $2 THEN 0
                            WHEN lower(COALESCE(c.display_name, '')) LIKE $2 THEN 1
                            ELSE 2
                        END,
                        similarity(
                            lower(c.name || ' ' || COALESCE(c.display_name, '') || ' ' || COALESCE(c.cloud_resource_id, '')),
                            $3
                        ) DESC
                ) AS rank
            FROM cis c
            WHERE c.organization_id = $1
              AND c.deleted_at IS NULL
              AND ($4::uuid IS NULL OR c.ci_type_id = $4)
              AND (
                    lower(c.name) LIKE $2
                 OR lower(COALESCE(c.display_name, '')) LIKE $2
                 OR lower(COALESCE(c.cloud_resource_id, '')) LIKE $2
                 OR c.meta::text ILIKE $5
                 OR c.tags::text ILIKE $5
              )
        )
        SELECT r.id, r.name, r.display_name, r.cloud_resource_id,
               r.lifecycle_state, r.cloud_region, r.cloud_provider, r.ci_type_id, r.rank,
               ct.display_name AS ci_type_name
        FROM ranked r
        LEFT JOIN ci_types ct ON ct.id = r.ci_type_id
        WHERE r.rank = 1
        ORDER BY r.rank, r.name
        LIMIT $6 OFFSET $7
        "#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(&term.to_lowercase())
    .bind(q.ci_type_id)
    .bind(format!("%{term}%"))
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT c.id)
           FROM cis c
           WHERE c.organization_id = $1
             AND c.deleted_at IS NULL
             AND ($4::uuid IS NULL OR c.ci_type_id = $4)
             AND (
                  lower(c.name) LIKE $2
               OR lower(COALESCE(c.display_name, '')) LIKE $2
               OR lower(COALESCE(c.cloud_resource_id, '')) LIKE $2
               OR c.meta::text ILIKE $3
               OR c.tags::text ILIKE $3
             )"#,
    )
    .bind(org_id)
    .bind(&pattern)
    .bind(format!("%{term}%"))
    .bind(q.ci_type_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<Uuid, _>("id").ok(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name": r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "cloud_resource_id": r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
                "lifecycle_state": r.try_get::<String, _>("lifecycle_state").unwrap_or_default(),
                "cloud_region": r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "cloud_provider": r.try_get::<Option<String>, _>("cloud_provider").unwrap_or(None),
                "ci_type_id": r.try_get::<Uuid, _>("ci_type_id").ok(),
                "ci_type_name": r.try_get::<Option<String>, _>("ci_type_name").unwrap_or(None),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

// ─── CI Batch Operations (T9) ────────────────────────────────────────────────

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct BatchUpdateCiRequest {
    /// CI ids to patch (max 200 per request).
    pub ids: Vec<Uuid>,
    /// Fields to apply to every CI. `meta_patch` merges (shallow) into meta;
    /// `tags` replaces wholesale.
    pub name: Option<String>,
    pub tags: Option<Value>,
    pub pool_id: Option<Uuid>,
    pub lifecycle_state: Option<String>,
    pub meta_patch: Option<Value>,
}

/// POST /api/v1/orgs/:org_id/cis/batch-update
///
/// Applies the same patch to a list of CIs with per-id results. Every row runs
/// the full T1 attribute / T3 lifecycle / T2 unique validation chain; a row
/// that fails validation is reported and skipped, the rest proceed.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cis/batch-update",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = BatchUpdateCiRequest,
    responses(
        (status = 200, description = "Per-id success/failure results"),
        (status = 422, description = "ids empty or over 200"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn batch_update_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<BatchUpdateCiRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.ids.is_empty() || body.ids.len() > 200 {
        return Err(AppError::Validation(
            "ids must contain between 1 and 200 CI ids".into(),
        ));
    }
    if let Some(ref tags) = body.tags {
        validate_patch_tags(tags)?;
    }
    if let Some(ref meta_patch) = body.meta_patch {
        if !meta_patch.is_object() {
            return Err(AppError::Validation("meta_patch must be a JSON object".into()));
        }
    }

    let mut updated = 0usize;
    let mut failed = 0usize;
    let mut results: Vec<Value> = Vec::new();

    for ci_id in &body.ids {
        let old = match sqlx::query_as::<_, Ci>(&format!(
            "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
        ))
        .bind(ci_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await
        {
            Ok(Some(c)) => c,
            Ok(None) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": "not found" }));
                continue;
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
                continue;
            }
        };

        // T3 lifecycle matrix.
        if let Some(ref new_state) = body.lifecycle_state {
            if *new_state != old.lifecycle_state {
                if let Err(e) = super::validation::validate_transition(&old.lifecycle_state, new_state) {
                    failed += 1;
                    results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
                    continue;
                }
            }
        }

        // T1 validation on merged meta (meta_patch merges over current meta).
        let effective_meta: Value = match &body.meta_patch {
            Some(patch) => {
                let mut merged = old.meta.as_object().cloned().unwrap_or_default();
                for (k, v) in patch.as_object().unwrap_or(&Default::default()) {
                    merged.insert(k.clone(), v.clone());
                }
                Value::Object(merged)
            }
            None => old.meta.clone(),
        };
        if body.meta_patch.is_some() {
            let attr_defs = super::validation::load_attr_defs(&state.db, old.ci_type_id).await?;
            if let Err(errors) = super::validation::validate_meta_update(
                &attr_defs,
                &old.meta,
                &effective_meta,
            ) {
                failed += 1;
                let msgs: Vec<Value> = errors.iter().map(|ve| ve.to_json()).collect();
                results.push(json!({ "id": ci_id, "status": "error", "errors": msgs }));
                continue;
            }
            // T2 unique constraints (excluding this CI).
            if let Err(e) = super::validation::check_unique_constraints(
                &state.db,
                org_id,
                old.ci_type_id,
                &effective_meta,
                Some(*ci_id),
            )
            .await
            {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
                continue;
            }
        }

        let field_changes = json!({
            "batch_update": {
                "name": body.name,
                "tags": body.tags,
                "pool_id": body.pool_id,
                "lifecycle_state": body.lifecycle_state,
                "meta_patch": body.meta_patch,
            }
        });

        let ci = match sqlx::query_as::<_, Ci>(&format!(
            r#"
            UPDATE cis
            SET name            = COALESCE($3, name),
                tags            = COALESCE($4, tags),
                meta            = COALESCE($5, meta),
                lifecycle_state = COALESCE($6::ci_lifecycle_state, lifecycle_state),
                pool_id         = COALESCE($7, pool_id),
                updated_at      = $8
            WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
            RETURNING {cols}
            "#,
            cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                    cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                    meta, tags, lifecycle_state::text AS lifecycle_state,
                    parent_ci_id, pool_id, discovered_at, created_at, updated_at"
        ))
        .bind(ci_id)
        .bind(org_id)
        .bind(body.name.as_deref())
        .bind(body.tags.as_ref())
        .bind(if body.meta_patch.is_some() { Some(&effective_meta) } else { None })
        .bind(body.lifecycle_state.as_deref())
        .bind(body.pool_id)
        .bind(Utc::now())
        .fetch_optional(&state.db)
        .await
        {
            Ok(Some(c)) => c,
            Ok(None) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": "not found" }));
                continue;
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
                continue;
            }
        };

        write_audit_log(
            &state.db,
            *ci_id,
            org_id,
            Some(user_id),
            "update",
            Some(&field_changes),
            "batch",
        )
        .await;

        super::events::emit_ci_event(
            &state.db,
            org_id,
            super::events::EVENT_CI_UPDATED,
            &ci,
            json!({ "via": "batch_update" }),
        )
        .await;

        updated += 1;
        results.push(json!({ "id": ci_id, "status": "updated" }));
    }

    Ok(Json(json!({
        "data": {
            "total": body.ids.len(),
            "updated": updated,
            "failed": failed,
            "results": results,
        }
    })))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct BatchDeleteCiRequest {
    pub ids: Vec<Uuid>,
}

/// POST /api/v1/orgs/:org_id/cis/batch-delete
///
/// Soft-deletes a list of CIs with per-id results (audit + delete event each).
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cis/batch-delete",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = BatchDeleteCiRequest,
    responses(
        (status = 200, description = "Per-id success/failure results"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn batch_delete_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<BatchDeleteCiRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.ids.is_empty() || body.ids.len() > 200 {
        return Err(AppError::Validation(
            "ids must contain between 1 and 200 CI ids".into(),
        ));
    }

    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut results: Vec<Value> = Vec::new();

    for ci_id in &body.ids {
        let old = sqlx::query_as::<_, Ci>(&format!(
            "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
        ))
        .bind(ci_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await;

        let old = match old {
            Ok(Some(c)) => c,
            Ok(None) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": "not found" }));
                continue;
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
                continue;
            }
        };

        let res = sqlx::query(
            "UPDATE cis SET deleted_at = $3 WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
        )
        .bind(ci_id)
        .bind(org_id)
        .bind(Utc::now())
        .execute(&state.db)
        .await;

        match res {
            Ok(r) if r.rows_affected() > 0 => {
                write_audit_log(&state.db, *ci_id, org_id, Some(user_id), "delete", None, "batch").await;
                super::events::emit_ci_deleted(&state.db, org_id, &old).await;
                deleted += 1;
                results.push(json!({ "id": ci_id, "status": "deleted" }));
            }
            Ok(_) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": "not found" }));
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "id": ci_id, "status": "error", "error": e.to_string() }));
            }
        }
    }

    Ok(Json(json!({
        "data": {
            "total": body.ids.len(),
            "deleted": deleted,
            "failed": failed,
            "results": results,
        }
    })))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CloneCiRequest {
    pub new_name: String,
}

/// POST /api/v1/orgs/:org_id/cis/:id/clone
///
/// Clones a CI: copies ci_type_id / cloud_provider / cloud_region / meta /
/// tags under a new name. Associations and cloud_resource_id are NOT copied
/// (the clone is a logical copy, not a cloud identity). Runs the same T1/T2
/// validation as create.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cis/{id}/clone",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "CI ID to clone"),
    ),
    request_body = CloneCiRequest,
    responses(
        (status = 201, description = "Cloned CI"),
        (status = 404, description = "Source CI not found"),
        (status = 409, description = "Clone would violate a unique constraint"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn clone_ci(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, ci_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CloneCiRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.new_name.trim().is_empty() {
        return Err(AppError::Validation("new_name cannot be empty".into()));
    }

    let src = sqlx::query_as::<_, Ci>(&format!(
        "{CI_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    ))
    .bind(ci_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    // T2: the copied meta must not violate unique constraints.
    super::validation::check_unique_constraints(&state.db, org_id, src.ci_type_id, &src.meta, None)
        .await?;

    let now = Utc::now();
    let new_id = Uuid::new_v4();
    let ci = sqlx::query_as::<_, Ci>(&format!(
        r#"
        INSERT INTO cis
            (id, organization_id, ci_type_id, cloud_resource_id,
             cloud_provider, cloud_region, name, display_name,
             meta, tags, lifecycle_state, created_at, updated_at)
        VALUES
            ($1, $2, $3, NULL,
             CASE WHEN $4::text IS NULL THEN NULL ELSE $4::cloud_provider END,
             $5, $6, $7,
             $8, $9, 'provisioning', $10, $10)
        RETURNING {cols}
        "#,
        cols = "id, organization_id, ci_type_id, cloud_account_id, cloud_resource_id,
                cloud_provider::text AS cloud_provider, cloud_region, name, display_name,
                meta, tags, lifecycle_state::text AS lifecycle_state,
                parent_ci_id, pool_id, discovered_at, created_at, updated_at"
    ))
    .bind(new_id)
    .bind(org_id)
    .bind(src.ci_type_id)
    .bind(src.cloud_provider.as_deref())
    .bind(src.cloud_region.as_deref())
    .bind(body.new_name.trim())
    .bind(body.new_name.trim())
    .bind(&src.meta)
    .bind(&src.tags)
    .bind(now)
    .fetch_one(&state.db)
    .await?;

    write_audit_log(
        &state.db,
        new_id,
        org_id,
        Some(user_id),
        "create",
        Some(&json!({ "cloned_from": ci_id.to_string() })),
        "user",
    )
    .await;

    super::events::emit_ci_event(
        &state.db,
        org_id,
        super::events::EVENT_CI_CREATED,
        &ci,
        json!({ "cloned_from": ci_id }),
    )
    .await;

    let ci_type_name = fetch_ci_type_name(&state.db, ci.ci_type_id).await?;
    let resp = ci_to_response(ci, ci_type_name);
    Ok((StatusCode::CREATED, Json(json!({ "data": resp }))))
}

// ─── CI Forest (T11 — per-type root + subtree view) ──────────────────────────

#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
pub struct CiForestQuery {
    /// Restrict the forest to one CI type (blank = all types).
    pub ci_type_id: Option<Uuid>,
    /// Maximum subtree depth (default 10, max 20).
    pub max_depth: Option<i32>,
}

/// GET /api/v1/orgs/:org_id/ci-forest
///
/// Returns the CI parent-child forest for the org (optionally scoped to one
/// type): roots are CIs without a parent; every node carries its children.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/ci-forest",
    params(
        ("org_id"    = Uuid, Path, description = "Organization ID"),
        ("ci_type_id" = Uuid, Query, description = "Optional CI type scope"),
        ("max_depth" = i32, Query, description = "Maximum subtree depth (default 10)"),
    ),
    responses(
        (status = 200, description = "Nested forest of CI nodes"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn ci_forest(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<CiForestQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let max_depth = q.max_depth.unwrap_or(10).clamp(1, 20);

    let rows = sqlx::query(
        r#"
        WITH RECURSIVE forest AS (
            -- Roots of the requested scope.
            SELECT c.id, c.parent_ci_id, 0 AS depth
            FROM cis c
            WHERE c.organization_id = $1
              AND c.deleted_at IS NULL
              AND c.parent_ci_id IS NULL
              AND ($2::uuid IS NULL OR c.ci_type_id = $2)
            UNION ALL
            SELECT c.id, c.parent_ci_id, f.depth + 1
            FROM cis c
            JOIN forest f ON c.parent_ci_id = f.id
            WHERE c.deleted_at IS NULL
              AND c.organization_id = $1
              AND ($2::uuid IS NULL OR c.ci_type_id = $2)
              AND f.depth < $3
        )
        SELECT f.id, f.depth,
               c.name, c.display_name, c.ci_type_id, c.parent_ci_id,
               c.lifecycle_state::text AS lifecycle_state, c.cloud_region,
               ct.display_name AS ci_type_name
        FROM forest f
        JOIN cis c ON c.id = f.id
        LEFT JOIN ci_types ct ON ct.id = c.ci_type_id
        ORDER BY f.depth, c.name
        "#,
    )
    .bind(org_id)
    .bind(q.ci_type_id)
    .bind(max_depth)
    .fetch_all(&state.db)
    .await?;

    let mut node_map: HashMap<Uuid, Value> = HashMap::new();
    let mut children_map: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    let mut roots: Vec<Uuid> = Vec::new();

    for row in &rows {
        let id: Uuid = row
            .try_get("id")
            .unwrap_or_default();
        let parent_id: Option<Uuid> = row.try_get("parent_ci_id").unwrap_or(None);
        let depth: i32 = row.try_get("depth").unwrap_or(0);

        node_map.insert(
            id,
            json!({
                "id": id,
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "display_name": row.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "ci_type_id": row.try_get::<Option<Uuid>, _>("ci_type_id").unwrap_or(None),
                "ci_type_name": row.try_get::<Option<String>, _>("ci_type_name").unwrap_or(None),
                "parent_ci_id": parent_id,
                "lifecycle_state": row.try_get::<String, _>("lifecycle_state").unwrap_or_default(),
                "cloud_region": row.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "depth": depth,
            }),
        );

        match parent_id {
            Some(pid) => children_map.entry(pid).or_default().push(id),
            None => roots.push(id),
        }
    }

    let trees: Vec<Value> = roots
        .iter()
        .map(|id| build_topo_node(*id, &node_map, &children_map))
        .collect();

    Ok(Json(json!({
        "data": {
            "roots": trees,
            "total_nodes": rows.len(),
        }
    })))
}

// ─── Dynamic Groups v2 — SQL pushdown (T16) ──────────────────────────────────

/// Top-level CI columns the group engine may filter on.
const GROUP_TOP_LEVEL_FIELDS: &[&str] = &[
    "name",
    "lifecycle_state",
    "cloud_provider",
    "cloud_region",
    "cloud_resource_id",
];

const GROUP_OPS: &[&str] = &[
    "$eq", "$ne", "$in", "$nin", "$contains", "$startswith", "$gte", "$lte", "$gt", "$lt",
];

/// One compiled condition: a SQL fragment plus the bind value (already typed).
struct CompiledCondition {
    sql: String,
    value: Value,
}

/// Compile one condition into a parameter-bound SQL fragment against alias `c`.
/// Returns Err for fields/operators outside the whitelist (never interpolated).
pub fn compile_group_condition(cond: &Value) -> Result<CompiledCondition, String> {
    let field = cond
        .get("field")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "condition.field is required".to_string())?;
    let op = cond
        .get("operator")
        .and_then(|v| v.as_str())
        .unwrap_or("$eq");
    if !GROUP_OPS.contains(&op) {
        return Err(format!("unsupported operator '{op}'"));
    }
    let value = cond.get("value").cloned().unwrap_or(Value::Null);

    let (column, jsonb) = if GROUP_TOP_LEVEL_FIELDS.contains(&field) {
        let col = match field {
            "lifecycle_state" => "c.lifecycle_state::text".to_string(),
            "cloud_provider" => "c.cloud_provider::text".to_string(),
            // whitelisted identifier — safe to interpolate with alias
            other => format!("c.{other}"),
        };
        (col, false)
    } else if let Some(key) = field.strip_prefix("meta.") {
        if !is_safe_group_key(key) {
            return Err(format!("invalid meta key '{key}'"));
        }
        (format!("c.meta->>'{key}'"), true)
    } else if let Some(key) = field.strip_prefix("tags.") {
        if !is_safe_group_key(key) {
            return Err(format!("invalid tags key '{key}'"));
        }
        (format!("c.tags->>'{key}'"), true)
    } else {
        return Err(format!(
            "field must be one of {GROUP_TOP_LEVEL_FIELDS:?} or meta.*/tags.*"
        ));
    };

    let sql = match op {
        "$eq" => format!("{column} = {{}}"),
        "$ne" => format!("({column} IS DISTINCT FROM {{}})"),
        "$in" => format!("{column} = ANY({{}})"),
        "$nin" => format!("NOT ({column} = ANY({{}}))"),
        "$contains" => format!("{column} ILIKE {{}}"),
        "$startswith" => format!("{column} ILIKE {{}}"),
        "$gte" => numeric_expr(&column, ">=", jsonb),
        "$lte" => numeric_expr(&column, "<=", jsonb),
        "$gt" => numeric_expr(&column, ">", jsonb),
        "$lt" => numeric_expr(&column, "<", jsonb),
        _ => unreachable!("op whitelisted above"),
    };
    let _ = jsonb;

    // Value shaping: contains/startswith wrap as ILIKE patterns.
    let shaped = match op {
        "$contains" => value
            .as_str()
            .map(|s| json!(format!("%{}%", s)))
            .ok_or_else(|| "$contains requires a string value".to_string())?,
        "$startswith" => value
            .as_str()
            .map(|s| json!(format!("{}%", s)))
            .ok_or_else(|| "$startswith requires a string value".to_string())?,
        _ => value,
    };

    Ok(CompiledCondition { sql, value: shaped })
}

fn numeric_expr(column: &str, cmp: &str, _jsonb: bool) -> String {
    format!("NULLIF({column}, '')::numeric {cmp} {{}}")
}

fn is_safe_group_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 100
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Compile the whole condition list into `(where_sql, bind_values)` where
/// placeholders are numbered `$1..$n` (callers renumber via
/// [`renumber_placeholders`] when org/type binds come first).
/// AND by default; any condition carrying `"logic":"OR"` switches the whole
/// list to OR (mirrors the previous in-memory semantics).
pub fn compile_group_conditions(conditions: &[Value]) -> Result<(String, Vec<Value>), String> {
    if conditions.is_empty() {
        return Ok(("TRUE".to_string(), Vec::new()));
    }
    let use_or = conditions
        .iter()
        .any(|c| c.get("logic").and_then(|v| v.as_str()) == Some("OR"));

    let mut fragments: Vec<String> = Vec::with_capacity(conditions.len());
    let mut values: Vec<Value> = Vec::with_capacity(conditions.len());
    for cond in conditions {
        let compiled = compile_group_condition(cond)?;
        fragments.push(format!("({})", compiled.sql));
        values.push(compiled.value);
    }

    let joiner = if use_or { " OR " } else { " AND " };
    let joined = format!("({})", fragments.join(joiner));

    // Substitute each {} placeholder with $1..$n in order.
    let mut sql = String::new();
    let mut rest = joined.as_str();
    let mut idx = 0usize;
    while let Some(pos) = rest.find("{}") {
        idx += 1;
        sql.push_str(&rest[..pos]);
        sql.push_str(&format!("${idx}"));
        rest = &rest[pos + 2..];
    }
    sql.push_str(rest);
    Ok((sql, values))
}

/// A condition value converted to a concrete SQL type (serde_json::Value
/// binds as jsonb, which cannot compare against text/numeric columns).
enum GroupBind {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    StrArr(Vec<String>),
    Null,
}

fn shape_group_bind(v: &Value) -> GroupBind {
    match v {
        Value::String(s) => GroupBind::Str(s.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                GroupBind::Int(i)
            } else {
                GroupBind::Float(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(b) => GroupBind::Bool(*b),
        Value::Array(arr) => GroupBind::StrArr(
            arr.iter()
                .map(|x| match x {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect(),
        ),
        _ => GroupBind::Null,
    }
}

/// Execute a dynamic group with SQL pushdown: unified pagination, no memory
/// cap. Shared by the HTTP endpoint and the compliance target resolver (T16).
pub async fn run_dynamic_group_sql(
    db: &sqlx::PgPool,
    org_id: Uuid,
    conditions: &[Value],
    ci_type_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> AppResult<(Vec<Value>, i64)> {
    let empty: Vec<Value> = Vec::new();
    let conditions = if conditions.is_empty() { &empty } else { conditions };
    let (cond_sql, binds) = compile_group_conditions(conditions)
        .map_err(AppError::Validation)?;

    // Parameter layout: $1 org, $2 optional type, then condition binds,
    // then LIMIT/OFFSET. Building with explicit numbering keeps binds aligned.
    let type_slot = if ci_type_id.is_some() { Some(2usize) } else { None };
    let cond_base = if ci_type_id.is_some() { 3usize } else { 2usize };
    // compile_group_conditions numbered from $1 — renumber to cond_base.
    let mut cond_sql = cond_sql;
    // Re-number $k ascending → cond_base + k - 1 (safe: placeholders are $<digits>).
    let renumbered = renumber_placeholders(&cond_sql, cond_base as i64 - 1);
    cond_sql = renumbered;

    let limit_idx = cond_base + binds.len();
    let offset_idx = limit_idx + 1;

    let mut where_parts = vec!["c.organization_id = $1".to_string(), "c.deleted_at IS NULL".to_string()];
    if let Some(slot) = type_slot {
        where_parts.push(format!("c.ci_type_id = ${slot}"));
    }
    where_parts.push(cond_sql);

    let sql = format!(
        r#"SELECT c.id, c.name, c.display_name, c.lifecycle_state::text AS lifecycle_state,
                  c.cloud_resource_id, c.cloud_region, c.cloud_provider::text AS cloud_provider,
                  c.tags, c.meta
           FROM cis c
           WHERE {}
           ORDER BY c.name, c.id
           LIMIT ${} OFFSET {}"#,
        where_parts.join(" AND "),
        limit_idx,
        offset_idx
    );

    let count_sql = format!(
        r#"SELECT COUNT(*) FROM cis c WHERE {}"#,
        where_parts.join(" AND ")
    );

    let mut query = sqlx::query(&sql).bind(org_id);
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(org_id);
    if let Some(t) = ci_type_id {
        query = query.bind(t);
        count_query = count_query.bind(t);
    }
    for v in &binds {
        let shaped = shape_group_bind(v);
        match shaped {
            GroupBind::Str(x) => {
                query = query.bind(x.clone());
                count_query = count_query.bind(x);
            }
            GroupBind::Int(x) => {
                query = query.bind(x);
                count_query = count_query.bind(x);
            }
            GroupBind::Float(x) => {
                query = query.bind(x);
                count_query = count_query.bind(x);
            }
            GroupBind::Bool(x) => {
                query = query.bind(x);
                count_query = count_query.bind(x);
            }
            GroupBind::StrArr(x) => {
                query = query.bind(x.clone());
                count_query = count_query.bind(x);
            }
            GroupBind::Null => {
                query = query.bind(Option::<String>::None);
                count_query = count_query.bind(Option::<String>::None);
            }
        }
    }
    let rows = query
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await?;
    let total: i64 = count_query.fetch_one(db).await.unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<Uuid, _>("id").ok(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "display_name": r.try_get::<Option<String>, _>("display_name").unwrap_or(None),
                "lifecycle_state": r.try_get::<String, _>("lifecycle_state").unwrap_or_default(),
                "cloud_resource_id": r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
                "cloud_region": r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "cloud_provider": r.try_get::<Option<String>, _>("cloud_provider").unwrap_or(None),
                "tags": r.try_get::<Option<Value>, _>("tags").unwrap_or(None),
                "meta": r.try_get::<Option<Value>, _>("meta").unwrap_or(None),
            })
        })
        .collect();
    Ok((data, total))
}

/// Shift every `$k` placeholder in `sql` up by `shift`.
fn renumber_placeholders(sql: &str, shift: i64) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' {
            let mut num = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    num.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            if num.is_empty() {
                out.push('$');
            } else {
                let n: i64 = num.parse().unwrap_or(0);
                out.push_str(&format!("${}", n + shift));
            }
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod group_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiles_top_level_eq() {
        let c = json!({"field": "name", "operator": "$eq", "value": "web-01"});
        let compiled = compile_group_condition(&c).unwrap();
        assert!(compiled.sql.contains("c.name = {}"));
    }

    #[test]
    fn compiles_jsonb_contains_and_startswith() {
        let c = json!({"field": "meta.env", "operator": "$contains", "value": "prod"});
        let compiled = compile_group_condition(&c).unwrap();
        assert!(compiled.sql.contains("c.meta->>'env' ILIKE {}"));
        assert_eq!(compiled.value, json!("%prod%"));

        let c = json!({"field": "tags.team", "operator": "$startswith", "value": "plat"});
        let compiled = compile_group_condition(&c).unwrap();
        assert_eq!(compiled.value, json!("plat%"));
    }

    #[test]
    fn compiles_numeric_comparison_with_cast() {
        let c = json!({"field": "meta.cpu_count", "operator": "$gte", "value": 4});
        let compiled = compile_group_condition(&c).unwrap();
        assert!(compiled.sql.contains("NULLIF(c.meta->>'cpu_count', '')::numeric >="));
    }

    #[test]
    fn rejects_unknown_field_and_op_and_unsafe_key() {
        assert!(compile_group_condition(&json!({"field": "id", "operator": "$eq", "value": "x"})).is_err());
        assert!(compile_group_condition(&json!({"field": "name", "operator": "$regex", "value": "x"})).is_err());
        assert!(compile_group_condition(&json!({"field": "meta.bad-key", "operator": "$eq", "value": "x"})).is_err());
        // SQL injection via key is impossible
        assert!(compile_group_condition(&json!({"field": "meta.x' OR '1'='1", "operator": "$eq", "value": "x"})).is_err());
    }

    #[test]
    fn condition_list_and_or_and_placeholders() {
        let conds = vec![
            json!({"field": "name", "operator": "$eq", "value": "a"}),
            json!({"field": "lifecycle_state", "operator": "$eq", "value": "active"}),
        ];
        let (sql, binds) = compile_group_conditions(&conds).unwrap();
        assert_eq!(sql, "((c.name = $1) AND (c.lifecycle_state::text = $2))");
        assert_eq!(binds.len(), 2);

        let or_conds = vec![
            json!({"field": "name", "operator": "$eq", "value": "a"}),
            json!({"field": "name", "operator": "$eq", "value": "b", "logic": "OR"}),
        ];
        let (sql, _) = compile_group_conditions(&or_conds).unwrap();
        assert!(sql.contains(" OR "));

        let (sql, binds) = compile_group_conditions(&[]).unwrap();
        assert_eq!(sql, "TRUE");
        assert!(binds.is_empty());
    }

    #[test]
    fn renumbers_placeholders() {
        assert_eq!(renumber_placeholders("(a = $1 OR b = $2) AND c = $1", 1), "(a = $2 OR b = $3) AND c = $2");
        assert_eq!(renumber_placeholders("no placeholders $", 5), "no placeholders $");
    }
}
