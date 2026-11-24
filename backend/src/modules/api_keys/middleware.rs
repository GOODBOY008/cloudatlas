//! API-key authentication middleware (product gap I1).
//!
//! Runs OUTERMOST on the protected router: when the Authorization header is a
//! `ca_…` key it resolves the key to (org, user), injects [`Claims`] into the
//! request extensions and stamps `x-api-key` so `auth_middleware` skips JWT
//! verification. Non-key requests pass through untouched.

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use chrono::Utc;
use uuid::Uuid;

use sqlx::Row;

use crate::{error::AppError, modules::auth::service::Claims, state::AppState};

use super::handlers::hash_key;

#[derive(Clone, Copy)]
pub struct ApiKeyScope(pub Uuid);

pub async fn api_key_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let Some(token) = extract_bearer(req.headers()) else {
        return Ok(next.run(req).await);
    };

    if !token.starts_with(super::handlers::KEY_PREFIX) {
        return Ok(next.run(req).await); // JWT — handled by auth_middleware
    }

    let key_hash = hash_key(&token);
    let row = sqlx::query(
        r#"SELECT ak.organization_id, ak.user_id, u.email
           FROM api_keys ak
           JOIN users u ON u.id = ak.user_id
           WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL
             AND (ak.expires_at IS NULL OR ak.expires_at > NOW())"#,
    )
    .bind(&key_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::Database)?;

    let (org_id, user_id, email) = match row {
        Some(r) => (
            r.try_get::<Uuid, _>("organization_id").unwrap_or_default(),
            r.try_get::<Uuid, _>("user_id").unwrap_or_default(),
            r.try_get::<String, _>("email").unwrap_or_default(),
        ),
        None => return Err(AppError::Unauthorized("Invalid API key".into())),
    };

    // A personal key is issued for one environment, even when the same user has several grants.
    let path = req.uri().path().trim_end_matches('/');
    let permitted = match path.strip_prefix("/api/v1/") {
        Some("organizations" | "auth/me") => req.method() == axum::http::Method::GET,
        Some(relative) => {
            let mut parts = relative.split('/');
            let resource = parts.next();
            let id = parts.next().and_then(|id| Uuid::parse_str(id).ok());
            match (resource, id) {
                (Some("orgs" | "organizations"), Some(id)) => id == org_id,
                (Some("cost-centers" | "business-capabilities"), Some(id)) => {
                    let query = if resource == Some("cost-centers") {
                        "SELECT EXISTS(SELECT 1 FROM cost_centers WHERE id=$1 AND organization_id=$2)"
                    } else {
                        "SELECT EXISTS(SELECT 1 FROM business_capabilities WHERE id=$1 AND organization_id=$2)"
                    };
                    sqlx::query_scalar::<_, bool>(query)
                        .bind(id)
                        .bind(org_id)
                        .fetch_one(&state.db)
                        .await?
                }
                _ => false,
            }
        }
        None => false,
    };
    if !permitted {
        return Err(AppError::Forbidden(
            "API key is scoped to another environment or operation".into(),
        ));
    }

    // Stamp last_used_at.
    let _ = sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1")
        .bind(&key_hash)
        .execute(&state.db)
        .await;

    let now = Utc::now().timestamp() as usize;
    let claims = Claims {
        sub: user_id.to_string(),
        jti: Uuid::new_v4().to_string(),
        email,
        exp: now + 86_400, // synthetic 24h session for this request
        iat: now,
        token_type: "api_key".into(),
    };

    let mut req = req;
    req.extensions_mut().insert(claims);
    req.extensions_mut().insert("api_key"); // marker → auth skips JWT
    req.extensions_mut().insert(ApiKeyScope(org_id));

    Ok(next.run(req).await)
}

fn extract_bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(String::from)
}
