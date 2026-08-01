//! In-app notification inbox (roadmap G11).
//!
//! Notifications are written by platform events (budget alerts, constraint
//! violations, engine runs) via [`create_notification`] and read from the bell
//! UI. `user_id = NULL` marks an org-wide notification.

use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

/// Insert an inbox notification. `user_id = None` → org-wide.
pub async fn create_notification(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Option<Uuid>,
    kind: &str,
    title: &str,
    body: &str,
) {
    let _ = sqlx::query(
        r#"INSERT INTO notifications (organization_id, user_id, kind, title, body)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(org_id)
    .bind(user_id)
    .bind(kind)
    .bind(title)
    .bind(body)
    .execute(db)
    .await;
}

/// GET /orgs/:id/notifications — inbox for the caller (their own + org-wide).
pub async fn list_notifications(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, kind, title, body, read_at, created_at
           FROM notifications
           WHERE organization_id = $1 AND (user_id IS NULL OR user_id = $2)
           ORDER BY created_at DESC, id DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(org_id)
    .bind(user_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let unread: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM notifications
           WHERE organization_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL"#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM notifications
           WHERE organization_id = $1 AND (user_id IS NULL OR user_id = $2)"#,
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "kind": r.get::<String, _>("kind"),
                "title": r.get::<String, _>("title"),
                "body": r.get::<String, _>("body"),
                "read_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("read_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "unread": unread,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

/// PATCH /orgs/:id/notifications/:notification_id/read — mark one as read.
pub async fn mark_read(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, notification_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let result = sqlx::query(
        r#"UPDATE notifications SET read_at = NOW()
           WHERE id = $1 AND organization_id = $2
             AND (user_id IS NULL OR user_id = $3)
             AND read_at IS NULL"#,
    )
    .bind(notification_id)
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "updated": result.rows_affected() } })))
}

/// POST /orgs/:id/notifications/read-all — mark every visible notification read.
pub async fn mark_all_read(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let result = sqlx::query(
        r#"UPDATE notifications SET read_at = NOW()
           WHERE organization_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL"#,
    )
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "updated": result.rows_affected() } })))
}

/// POST /orgs/:id/notifications — internal helper exposed for tests: create one.
pub async fn create_notification_endpoint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<serde_json::Value>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;

    let kind = req["kind"].as_str().unwrap_or("system");
    let title = req["title"].as_str().unwrap_or("Notification");
    let body = req["body"].as_str().unwrap_or("");

    create_notification(&state.db, org_id, None, kind, title, body).await;

    Ok((StatusCode::CREATED, Json(json!({ "data": { "created": true } }))))
}
