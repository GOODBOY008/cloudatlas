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

#[derive(Deserialize)]
pub struct CreatePolicyRequest {
    pub name: String,
    pub description: Option<String>,
    pub policy_type: Option<String>,
    pub ttl_days: Option<i32>,
    pub idle_days: Option<i32>,
    pub action: Option<String>,
    pub resource_filter: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct AckEventRequest {
    pub notes: Option<String>,
}

/// GET /api/v1/orgs/{org_id}/lifecycle-policies
pub async fn list_policies(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, policy_type, ttl_days, idle_days,
                  resource_filter, action, is_active, last_evaluated_at, created_at
           FROM resource_lifecycle_policies
           WHERE organization_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM resource_lifecycle_policies WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "id":                 r.try_get::<Uuid, _>("id").ok(),
        "name":               r.try_get::<String, _>("name").unwrap_or_default(),
        "description":        r.try_get::<Option<String>, _>("description").unwrap_or(None),
        "policy_type":        r.try_get::<String, _>("policy_type").unwrap_or_default(),
        "ttl_days":           r.try_get::<Option<i32>, _>("ttl_days").unwrap_or(None),
        "idle_days":          r.try_get::<Option<i32>, _>("idle_days").unwrap_or(None),
        "resource_filter":    r.try_get::<Value, _>("resource_filter").unwrap_or(json!({})),
        "action":             r.try_get::<String, _>("action").unwrap_or_default(),
        "is_active":          r.try_get::<bool, _>("is_active").unwrap_or(true),
        "last_evaluated_at":  r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_evaluated_at").unwrap_or(None),
        "created_at":         r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
    })).collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// POST /api/v1/orgs/{org_id}/lifecycle-policies
pub async fn create_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreatePolicyRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let policy_type = body.policy_type.as_deref().unwrap_or("ttl");
    let action = body.action.as_deref().unwrap_or("flag");
    let filter = body.resource_filter.unwrap_or(json!({}));

    let row = sqlx::query(
        r#"INSERT INTO resource_lifecycle_policies
               (organization_id, name, description, policy_type, ttl_days, idle_days, resource_filter, action)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, name, policy_type, action, created_at"#,
    )
    .bind(org_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(policy_type)
    .bind(body.ttl_days)
    .bind(body.idle_days)
    .bind(filter)
    .bind(action)
    .fetch_one(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id":          row.try_get::<Uuid, _>("id").ok(),
                "name":        row.try_get::<String, _>("name").unwrap_or_default(),
                "policy_type": row.try_get::<String, _>("policy_type").unwrap_or_default(),
                "action":      row.try_get::<String, _>("action").unwrap_or_default(),
                "created_at":  row.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            }
        })),
    ))
}

/// DELETE /api/v1/orgs/{org_id}/lifecycle-policies/{id}
pub async fn delete_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    sqlx::query("DELETE FROM resource_lifecycle_policies WHERE id = $1 AND organization_id = $2")
        .bind(policy_id)
        .bind(org_id)
        .execute(&state.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/orgs/{org_id}/lifecycle-events
pub async fn list_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT e.id, e.policy_id, e.resource_id, e.cloud_resource_id, e.resource_type,
                  e.event_type, e.reason, e.meta, e.actor_id, e.created_at,
                  p.name AS policy_name,
                  u.display_name AS actor_name
           FROM resource_lifecycle_events e
           LEFT JOIN resource_lifecycle_policies p ON p.id = e.policy_id
           LEFT JOIN users u ON u.id = e.actor_id
           WHERE e.organization_id = $1
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM resource_lifecycle_events WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows.iter().map(|r| json!({
        "id":               r.try_get::<Uuid, _>("id").ok(),
        "policy_id":        r.try_get::<Option<Uuid>, _>("policy_id").unwrap_or(None),
        "policy_name":      r.try_get::<Option<String>, _>("policy_name").unwrap_or(None),
        "resource_id":      r.try_get::<Option<Uuid>, _>("resource_id").unwrap_or(None),
        "cloud_resource_id":r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
        "resource_type":    r.try_get::<Option<String>, _>("resource_type").unwrap_or(None),
        "event_type":       r.try_get::<String, _>("event_type").unwrap_or_default(),
        "reason":           r.try_get::<Option<String>, _>("reason").unwrap_or(None),
        "actor_name":       r.try_get::<Option<String>, _>("actor_name").unwrap_or(None),
        "created_at":       r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
    })).collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// POST /api/v1/orgs/{org_id}/lifecycle-policies/{id}/evaluate
/// Evaluates the policy against current resources and creates lifecycle events.
pub async fn evaluate_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let policy = sqlx::query(
        "SELECT policy_type, ttl_days, idle_days, action FROM resource_lifecycle_policies WHERE id = $1 AND organization_id = $2",
    )
    .bind(policy_id).bind(org_id).fetch_optional(&state.db).await?
    .ok_or_else(|| AppError::NotFound("Policy not found".into()))?;

    let policy_type: String = policy.try_get("policy_type").unwrap_or_default();
    let ttl_days: Option<i32> = policy.try_get("ttl_days").unwrap_or(None);
    let idle_days: Option<i32> = policy.try_get("idle_days").unwrap_or(None);
    let action: String = policy.try_get("action").unwrap_or("flag".to_string());

    // Find matching resources
    let flagged_count: i64 = match policy_type.as_str() {
        "ttl" if ttl_days.is_some() => {
            let days = ttl_days.unwrap();
            let stale_resources = sqlx::query(
                r#"SELECT id, cloud_resource_id, resource_type::text FROM resources
                   WHERE organization_id = $1 AND active = true
                     AND last_seen < NOW() - ($2 || ' days')::interval"#,
            )
            .bind(org_id)
            .bind(days)
            .fetch_all(&state.db)
            .await?;

            let count = stale_resources.len() as i64;
            for res in &stale_resources {
                let res_id: Uuid = res.try_get("id").unwrap_or(Uuid::new_v4());
                let cloud_id: String = res.try_get("cloud_resource_id").unwrap_or_default();
                let res_type: String = res.try_get("resource_type").unwrap_or_default();
                let _ = sqlx::query(
                    r#"INSERT INTO resource_lifecycle_events
                           (organization_id, policy_id, resource_id, cloud_resource_id, resource_type, event_type, reason, actor_id)
                       VALUES ($1, $2, $3, $4, $5, 'flagged', $6, $7)
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(org_id).bind(policy_id).bind(res_id).bind(&cloud_id).bind(&res_type)
                .bind(format!("Resource not seen for more than {} days (TTL policy)", days))
                .bind(user_id)
                .execute(&state.db).await;
            }
            count
        }
        "idle_shutdown" if idle_days.is_some() => {
            let days = idle_days.unwrap();
            let idle_resources = sqlx::query(
                r#"SELECT id, cloud_resource_id, resource_type::text FROM resources
                   WHERE organization_id = $1 AND active = true
                     AND id NOT IN (
                         SELECT DISTINCT resource_id FROM expenses
                         WHERE organization_id = $1
                           AND date >= NOW()::date - ($2 || ' days')::interval
                     )"#,
            )
            .bind(org_id)
            .bind(days)
            .fetch_all(&state.db)
            .await?;

            let count = idle_resources.len() as i64;
            for res in &idle_resources {
                let res_id: Uuid = res.try_get("id").unwrap_or(Uuid::new_v4());
                let cloud_id: String = res.try_get("cloud_resource_id").unwrap_or_default();
                let res_type: String = res.try_get("resource_type").unwrap_or_default();
                let _ = sqlx::query(
                    r#"INSERT INTO resource_lifecycle_events
                           (organization_id, policy_id, resource_id, cloud_resource_id, resource_type, event_type, reason, actor_id)
                       VALUES ($1, $2, $3, $4, $5, 'flagged', $6, $7)
                       ON CONFLICT DO NOTHING"#,
                )
                .bind(org_id).bind(policy_id).bind(res_id).bind(&cloud_id).bind(&res_type)
                .bind(format!("No cost activity for {} days (idle_shutdown policy)", days))
                .bind(user_id)
                .execute(&state.db).await;
            }
            count
        }
        _ => 0,
    };

    // Update last_evaluated_at
    let _ = sqlx::query(
        "UPDATE resource_lifecycle_policies SET last_evaluated_at = NOW() WHERE id = $1",
    )
    .bind(policy_id)
    .execute(&state.db)
    .await;

    Ok(Json(json!({
        "flagged_count": flagged_count,
        "action": action,
        "evaluated_at": Utc::now(),
    })))
}
