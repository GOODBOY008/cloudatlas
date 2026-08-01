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
pub struct CreateScheduleRequest {
    pub name: String,
    pub description: Option<String>,
    pub resource_filter: Option<serde_json::Value>,
    pub timezone: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateScheduleRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub resource_filter: Option<serde_json::Value>,
    pub timezone: Option<String>,
    pub is_active: Option<bool>,
}

#[derive(Deserialize)]
pub struct CreateTriggerRequest {
    pub cron_expression: String,
    pub action: String,
}

pub async fn list_schedules(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, resource_filter, timezone, is_active, created_at, updated_at
           FROM power_schedules WHERE organization_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM power_schedules WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":              r.try_get::<Uuid, _>("id").ok(),
                "name":            r.try_get::<String, _>("name").unwrap_or_default(),
                "description":     r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "resource_filter": r.try_get::<Value, _>("resource_filter").unwrap_or(json!({})),
                "timezone":        r.try_get::<String, _>("timezone").unwrap_or_else(|_| "UTC".into()),
                "is_active":       r.try_get::<bool, _>("is_active").unwrap_or(true),
                "created_at":      r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "updated_at":      r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_schedule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateScheduleRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let id = Uuid::new_v4();
    let resource_filter = body.resource_filter.unwrap_or(json!({}));
    let timezone = body.timezone.unwrap_or_else(|| "UTC".into());

    sqlx::query(
        r#"INSERT INTO power_schedules (id, organization_id, name, description, resource_filter, timezone, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.description.as_deref())
    .bind(&resource_filter)
    .bind(&timezone)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "timezone": timezone,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_schedule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, schedule_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateScheduleRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE power_schedules SET
               name            = COALESCE($3, name),
               description     = COALESCE($4, description),
               resource_filter = COALESCE($5, resource_filter),
               timezone        = COALESCE($6, timezone),
               is_active       = COALESCE($7, is_active),
               updated_at      = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(schedule_id)
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.resource_filter)
    .bind(body.timezone.as_deref())
    .bind(body.is_active)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Schedule {schedule_id} not found")));
    }

    Ok(Json(json!({ "data": { "id": schedule_id, "message": "Updated" } })))
}

pub async fn delete_schedule(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, schedule_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM power_schedules WHERE id = $1 AND organization_id = $2",
    )
    .bind(schedule_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Schedule {schedule_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

pub async fn list_triggers(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, schedule_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Verify schedule belongs to org
    let schedule = sqlx::query(
        "SELECT id FROM power_schedules WHERE id = $1 AND organization_id = $2",
    )
    .bind(schedule_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    if schedule.is_none() {
        return Err(AppError::NotFound(format!("Schedule {schedule_id} not found")));
    }

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, cron_expression, action, last_run_at, next_run_at, created_at
           FROM power_schedule_triggers WHERE schedule_id = $1
           ORDER BY created_at ASC, id ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(schedule_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM power_schedule_triggers WHERE schedule_id = $1",
    )
    .bind(schedule_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":              r.try_get::<Uuid, _>("id").ok(),
                "cron_expression": r.try_get::<String, _>("cron_expression").unwrap_or_default(),
                "action":          r.try_get::<String, _>("action").unwrap_or_default(),
                "last_run_at":     r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_run_at").unwrap_or(None),
                "next_run_at":     r.try_get::<Option<chrono::DateTime<Utc>>, _>("next_run_at").unwrap_or(None),
                "created_at":      r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_trigger(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, schedule_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateTriggerRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.action != "start" && body.action != "stop" {
        return Err(AppError::Validation("action must be 'start' or 'stop'".into()));
    }

    let schedule = sqlx::query(
        "SELECT id FROM power_schedules WHERE id = $1 AND organization_id = $2",
    )
    .bind(schedule_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    if schedule.is_none() {
        return Err(AppError::NotFound(format!("Schedule {schedule_id} not found")));
    }

    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO power_schedule_triggers (id, schedule_id, cron_expression, action) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(schedule_id)
    .bind(&body.cron_expression)
    .bind(&body.action)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "schedule_id": schedule_id,
                "cron_expression": body.cron_expression,
                "action": body.action,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn delete_trigger(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, schedule_id, trigger_id)): Path<(Uuid, Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"DELETE FROM power_schedule_triggers
           WHERE id = $1 AND schedule_id = $2
           AND EXISTS (SELECT 1 FROM power_schedules WHERE id = $2 AND organization_id = $3)"#,
    )
    .bind(trigger_id)
    .bind(schedule_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Trigger {trigger_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}
