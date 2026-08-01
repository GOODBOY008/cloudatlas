use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
    utils::pagination::{page_meta_json, PageQuery},
};

async fn ensure_org_member(db: &PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
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
pub struct CreateWebhookRequest {
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
    pub secret: Option<String>,
    pub channel: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateWebhookRequest {
    pub name: Option<String>,
    pub url: Option<String>,
    pub events: Option<Vec<String>>,
    pub secret: Option<String>,
    pub is_active: Option<bool>,
    pub channel: Option<String>,
}

/// Allowed delivery channels. See migration 017.
const WEBHOOK_CHANNELS: &[&str] = &["generic", "slack", "teams", "pagerduty", "email"];

fn normalize_channel(channel: &Option<String>) -> AppResult<String> {
    let ch = channel.as_deref().unwrap_or("generic");
    if WEBHOOK_CHANNELS.contains(&ch) {
        Ok(ch.to_string())
    } else {
        Err(AppError::Validation(format!(
            "channel must be one of: {}",
            WEBHOOK_CHANNELS.join(", ")
        )))
    }
}

pub async fn list_webhooks(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, url, events, is_active, channel, last_triggered_at, last_status, created_at
           FROM webhooks WHERE organization_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhooks WHERE organization_id = $1")
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":               r.try_get::<Uuid, _>("id").ok(),
                "name":             r.try_get::<String, _>("name").unwrap_or_default(),
                "url":              r.try_get::<String, _>("url").unwrap_or_default(),
                "events":           r.try_get::<Value, _>("events").unwrap_or(json!([])),
                "is_active":        r.try_get::<bool, _>("is_active").unwrap_or(true),
                "channel":          r.try_get::<String, _>("channel").unwrap_or_else(|_| "generic".into()),
                "last_triggered_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_triggered_at").unwrap_or(None),
                "last_status":      r.try_get::<Option<i32>, _>("last_status").unwrap_or(None),
                "created_at":       r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": page_meta_json(total, &bounds) })))
}

pub async fn create_webhook(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateWebhookRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }
    let channel = normalize_channel(&body.channel)?;
    if channel == "email" {
        crate::utils::validate::email(&body.url).map_err(AppError::Validation)?;
    } else {
        crate::utils::validate::webhook_url(&body.url).map_err(AppError::Validation)?;
    }

    let id = Uuid::new_v4();
    let events = serde_json::to_value(&body.events).unwrap_or(json!([]));

    sqlx::query(
        r#"INSERT INTO webhooks (id, organization_id, name, url, events, secret, channel, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(&body.url)
    .bind(&events)
    .bind(body.secret.as_deref())
    .bind(&channel)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "url": body.url,
                "events": body.events,
                "channel": channel,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_webhook(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, webhook_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateWebhookRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let existing = sqlx::query(
        "SELECT id FROM webhooks WHERE id = $1 AND organization_id = $2",
    )
    .bind(webhook_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    if existing.is_none() {
        return Err(AppError::NotFound(format!("Webhook {webhook_id} not found")));
    }

    let channel = normalize_channel(&body.channel)?;

    let events_val = body
        .events
        .as_ref()
        .map(|e| serde_json::to_value(e).unwrap_or(json!([])));

    sqlx::query(
        r#"UPDATE webhooks SET
               name       = COALESCE($3, name),
               url        = COALESCE($4, url),
               events     = COALESCE($5, events),
               secret     = COALESCE($6, secret),
               is_active  = COALESCE($7, is_active),
               channel    = COALESCE($8, channel),
               updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(webhook_id)
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.url.as_deref())
    .bind(events_val)
    .bind(body.secret.as_deref())
    .bind(body.is_active)
    .bind(if body.channel.is_some() { Some(channel.as_str()) } else { None })
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "id": webhook_id, "message": "Updated" } })))
}

pub async fn delete_webhook(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, webhook_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM webhooks WHERE id = $1 AND organization_id = $2",
    )
    .bind(webhook_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Webhook {webhook_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

pub async fn list_webhook_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM webhook_events we
           JOIN webhooks w ON w.id = we.webhook_id
           WHERE w.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query(
        r#"SELECT we.id, we.webhook_id, w.name AS webhook_name,
                  we.event_type, we.payload, we.status, we.attempts,
                  we.response_status, we.created_at, we.delivered_at
           FROM webhook_events we
           JOIN webhooks w ON w.id = we.webhook_id
           WHERE w.organization_id = $1
           ORDER BY we.created_at DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":              r.try_get::<Uuid, _>("id").ok(),
                "webhook_id":      r.try_get::<Uuid, _>("webhook_id").ok(),
                "webhook_name":    r.try_get::<String, _>("webhook_name").unwrap_or_default(),
                "event_type":      r.try_get::<String, _>("event_type").unwrap_or_default(),
                "payload":         r.try_get::<Value, _>("payload").unwrap_or(json!({})),
                "status":          r.try_get::<String, _>("status").unwrap_or_default(),
                "attempts":        r.try_get::<i32, _>("attempts").unwrap_or(0),
                "response_status": r.try_get::<Option<i32>, _>("response_status").unwrap_or(None),
                "created_at":      r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "delivered_at":    r.try_get::<Option<chrono::DateTime<Utc>>, _>("delivered_at").unwrap_or(None),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": page_meta_json(total, &bounds) })))
}

/// Enqueue an event for all active webhooks subscribed to the given event type.
pub async fn enqueue_event(db: &PgPool, org_id: Uuid, event_type: &str, payload: Value) {
    let webhooks = sqlx::query_as::<_, (Uuid,)>(
        r#"SELECT id FROM webhooks
           WHERE organization_id = $1 AND is_active = true
           AND events @> $2::jsonb"#,
    )
    .bind(org_id)
    .bind(json!([event_type]))
    .fetch_all(db)
    .await;

    if let Ok(hooks) = webhooks {
        for (hook_id,) in hooks {
            let _ = sqlx::query(
                "INSERT INTO webhook_events (id, webhook_id, event_type, payload) VALUES ($1, $2, $3, $4)",
            )
            .bind(Uuid::new_v4())
            .bind(hook_id)
            .bind(event_type)
            .bind(&payload)
            .execute(db)
            .await;
        }
    }
}
