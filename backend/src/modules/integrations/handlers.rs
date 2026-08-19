//! Third-party integrations — connection cards for Slack, Teams, PagerDuty,
//! Jira, GitHub and generic webhooks. Each integration stores its provider
//! config; `POST /{id}/test` performs a lightweight reachability check and
//! stamps `status` / `last_checked_at`.

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

const PROVIDERS: &[&str] = &[
    "slack",
    "teams",
    "pagerduty",
    "jira",
    "github",
    "generic_webhook",
];

/// Provider metadata used by the frontend cards.
pub fn provider_info() -> Value {
    json!([
        { "provider": "slack", "label": "Slack", "icon": "💬", "fields": ["webhook_url"] },
        { "provider": "teams", "label": "Microsoft Teams", "icon": "🧩", "fields": ["webhook_url"] },
        { "provider": "pagerduty", "label": "PagerDuty", "icon": "🚨", "fields": ["service_key"] },
        { "provider": "jira", "label": "Jira", "icon": "📋", "fields": ["base_url", "email", "api_token"] },
        { "provider": "github", "label": "GitHub", "icon": "🐙", "fields": ["token", "repository"] },
        { "provider": "generic_webhook", "label": "Generic Webhook", "icon": "🔗", "fields": ["url"] },
    ])
}

#[derive(Deserialize)]
pub struct CreateIntegrationRequest {
    pub provider: String,
    pub name: String,
    pub config: Value,
}

#[derive(Deserialize)]
pub struct UpdateIntegrationRequest {
    pub name: Option<String>,
    pub config: Option<Value>,
    pub is_active: Option<bool>,
}

pub async fn list_integrations(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, provider, name, config, is_active, status, last_checked_at, created_at
           FROM integrations
           WHERE organization_id = $1
           ORDER BY provider, name, id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM integrations WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "provider": r.get::<String, _>("provider"),
                "name": r.get::<String, _>("name"),
                "config": r.get::<Value, _>("config"),
                "is_active": r.get::<bool, _>("is_active"),
                "status": r.get::<String, _>("status"),
                "last_checked_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_checked_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "providers": provider_info(),
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

pub async fn create_integration(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateIntegrationRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if !PROVIDERS.contains(&req.provider.as_str()) {
        return Err(AppError::Validation(format!(
            "provider must be one of: {}",
            PROVIDERS.join(", ")
        )));
    }
    crate::utils::validate::name(&req.name, 255, "Integration name")
        .map_err(AppError::Validation)?;

    let row = sqlx::query(
        r#"INSERT INTO integrations (organization_id, provider, name, config, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at"#,
    )
    .bind(org_id)
    .bind(&req.provider)
    .bind(&req.name)
    .bind(&req.config)
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate") {
            AppError::Conflict("An integration with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "provider": req.provider,
                "name": req.name,
                "status": "unknown",
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

pub async fn update_integration(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, integration_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateIntegrationRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE integrations SET
               name = COALESCE($3, name),
               config = COALESCE($4, config),
               is_active = COALESCE($5, is_active),
               updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(integration_id)
    .bind(org_id)
    .bind(req.name.as_deref())
    .bind(req.config)
    .bind(req.is_active)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Integration {integration_id} not found"
        )));
    }

    Ok(Json(
        json!({ "data": { "id": integration_id, "message": "Updated" } }),
    ))
}

pub async fn delete_integration(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, integration_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query("DELETE FROM integrations WHERE id = $1 AND organization_id = $2")
        .bind(integration_id)
        .bind(org_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Integration {integration_id} not found"
        )));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

/// Lightweight connection check: for webhook-based providers, HEAD/GET the
/// configured endpoint; for token providers, verify the required config keys
/// are present. Updates `status` + `last_checked_at`.
pub async fn test_integration(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, integration_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        "SELECT provider, config FROM integrations WHERE id = $1 AND organization_id = $2",
    )
    .bind(integration_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Integration {integration_id} not found")))?;

    let provider: String = row.get("provider");
    let config: Value = row.get("config");

    let (ok, message) = match provider.as_str() {
        "slack" | "teams" | "generic_webhook" => {
            match config
                .get("webhook_url")
                .or_else(|| config.get("url"))
                .and_then(|v| v.as_str())
            {
                Some(url) if url.starts_with("http") => match test_webhook_endpoint(url).await {
                    Ok(code) => (true, format!("Endpoint reachable (HTTP {code})")),
                    Err(e) => (false, format!("Endpoint unreachable: {e}")),
                },
                _ => (false, "Missing webhook_url / url in config".into()),
            }
        }
        "pagerduty" => match config.get("service_key").and_then(|v| v.as_str()) {
            Some(k) if !k.is_empty() => (true, "Service key present".into()),
            _ => (false, "Missing service_key in config".into()),
        },
        "jira" => {
            let has = config
                .get("base_url")
                .and_then(|v| v.as_str())
                .is_some_and(|u| u.starts_with("http"))
                && config.get("email").is_some()
                && config.get("api_token").is_some();
            (
                has,
                if has {
                    "Credentials present".into()
                } else {
                    "base_url (http), email and api_token required".into()
                },
            )
        }
        "github" => match config.get("token").and_then(|v| v.as_str()) {
            Some(t) if !t.is_empty() => (true, "Token present".into()),
            _ => (false, "Missing token in config".into()),
        },
        _ => (false, "Unknown provider".into()),
    };

    let status = if ok { "connected" } else { "error" };
    let _ = sqlx::query(
        "UPDATE integrations SET status = $3, last_checked_at = NOW() WHERE id = $1 AND organization_id = $2",
    )
    .bind(integration_id)
    .bind(org_id)
    .bind(status)
    .execute(&state.db)
    .await;

    Ok(Json(json!({
        "data": { "status": status, "message": message, "last_checked_at": chrono::Utc::now() }
    })))
}

async fn test_webhook_endpoint(url: &str) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;

    Ok(resp.status().as_u16())
}
