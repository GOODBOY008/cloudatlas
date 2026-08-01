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
pub struct CreateRuleRequest {
    pub name: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub conditions: serde_json::Value,
    pub pool_id: Option<Uuid>,
    pub owner_id: Option<Uuid>,
}

pub async fn list_rules(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, priority, is_active, conditions,
                  pool_id, owner_id, created_at, updated_at
           FROM assignment_rules
           WHERE organization_id = $1
           ORDER BY priority ASC, created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM assignment_rules WHERE organization_id = $1")
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
                "priority":    r.try_get::<i32, _>("priority").unwrap_or(100),
                "is_active":   r.try_get::<bool, _>("is_active").unwrap_or(true),
                "conditions":  r.try_get::<Value, _>("conditions").unwrap_or(json!([])),
                "pool_id":     r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
                "owner_id":    r.try_get::<Option<Uuid>, _>("owner_id").unwrap_or(None),
                "created_at":  r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "updated_at":  r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateRuleRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let id = Uuid::new_v4();
    let priority = body.priority.unwrap_or(100);

    sqlx::query(
        r#"INSERT INTO assignment_rules (id, organization_id, name, description, priority, conditions, pool_id, owner_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.description.as_deref())
    .bind(priority)
    .bind(&body.conditions)
    .bind(body.pool_id)
    .bind(body.owner_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "priority": priority,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rule_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateRuleRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE assignment_rules SET
               name        = $3,
               description = $4,
               priority    = COALESCE($5, priority),
               conditions  = $6,
               pool_id     = $7,
               owner_id    = $8,
               updated_at  = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(rule_id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.description.as_deref())
    .bind(body.priority)
    .bind(&body.conditions)
    .bind(body.pool_id)
    .bind(body.owner_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Rule {rule_id} not found")));
    }

    Ok(Json(json!({ "data": { "id": rule_id, "message": "Updated" } })))
}

pub async fn delete_rule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rule_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM assignment_rules WHERE id = $1 AND organization_id = $2",
    )
    .bind(rule_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Rule {rule_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

/// Re-evaluate all active rules against all unassigned expenses.
pub async fn apply_rules(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Get active rules ordered by priority
    let rules = sqlx::query(
        r#"SELECT id, conditions, pool_id, owner_id
           FROM assignment_rules
           WHERE organization_id = $1 AND is_active = true
           ORDER BY priority ASC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut applied = 0u64;

    for rule in &rules {
        let pool_id: Option<Uuid> = rule.try_get("pool_id").unwrap_or(None);
        let owner_id: Option<Uuid> = rule.try_get("owner_id").unwrap_or(None);

        // Simple implementation: assign pool/owner to expenses without one
        if let Some(pid) = pool_id {
            let res = sqlx::query(
                r#"UPDATE expenses SET pool_id = $2, updated_at = NOW()
                   WHERE organization_id = $1 AND pool_id IS NULL"#,
            )
            .bind(org_id)
            .bind(pid)
            .execute(&state.db)
            .await?;
            applied += res.rows_affected();
        }

        if let Some(oid) = owner_id {
            let res = sqlx::query(
                r#"UPDATE expenses SET owner_id = $2, updated_at = NOW()
                   WHERE organization_id = $1 AND owner_id IS NULL"#,
            )
            .bind(org_id)
            .bind(oid)
            .execute(&state.db)
            .await?;
            applied += res.rows_affected();
        }
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": {
                "rules_evaluated": rules.len(),
                "expenses_updated": applied,
            }
        })),
    ))
}
