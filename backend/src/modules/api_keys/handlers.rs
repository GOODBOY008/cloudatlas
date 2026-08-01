//! API key management (product gap I1).
//!
//! Keys are `ca_<32 hex>` tokens; only the SHA-256 hash is stored. The key
//! acts as an org-scoped member identity for integrations — `api_key_middleware`
//! resolves it into a synthetic Claims context.

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    Json,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

pub const KEY_PREFIX: &str = "ca_";

/// Hash a key for storage (SHA-256 hex).
pub fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    hex::encode(hasher.finalize())
}

/// Generate a new plaintext key (`ca_` + 32 hex chars).
pub fn generate_key() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{KEY_PREFIX}{}", hex::encode(bytes))
}

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

#[derive(Deserialize)]
pub struct CreateApiKeyRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateApiKeyRequest {
    pub name: Option<String>,
}

/// GET /orgs/:id/api-keys — list keys (hashes/prefixes only, no secrets).
pub async fn list_api_keys(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, key_prefix, last_used_at, expires_at, revoked_at, created_at
           FROM api_keys
           WHERE organization_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL",
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
                "key_prefix": r.get::<String, _>("key_prefix"),
                "last_used_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_used_at"),
                "expires_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("expires_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

/// POST /orgs/:id/api-keys — create a key; plaintext returned exactly once.
pub async fn create_api_key(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateApiKeyRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    crate::utils::validate::name(&req.name, 255, "Key name").map_err(AppError::Validation)?;

    let plaintext = generate_key();
    let key_hash = hash_key(&plaintext);
    let key_id = Uuid::new_v4();

    sqlx::query(
        r#"INSERT INTO api_keys (id, organization_id, user_id, name, key_hash, key_prefix)
           VALUES ($1, $2, $3, $4, $5, $6)"#,
    )
    .bind(key_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .bind(&req.name)
    .bind(&key_hash)
    .bind(&plaintext[..KEY_PREFIX.len() + 8])
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": key_id,
                "name": req.name,
                "key": plaintext, // shown once
                "message": "Store this key securely — it will not be shown again",
            }
        })),
    ))
}

/// PATCH /orgs/:id/api-keys/:key_id — rename.
pub async fn update_api_key(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, key_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateApiKeyRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        "UPDATE api_keys SET name = COALESCE($3, name) WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL",
    )
    .bind(key_id)
    .bind(org_id)
    .bind(req.name.as_deref())
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("API key {key_id} not found")));
    }
    Ok(Json(json!({ "data": { "id": key_id, "message": "Updated" } })))
}

/// DELETE /orgs/:id/api-keys/:key_id — revoke.
pub async fn revoke_api_key(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, key_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        "UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL",
    )
    .bind(key_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("API key {key_id} not found")));
    }
    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_generation_and_hashing() {
        let key = generate_key();
        assert!(key.starts_with(KEY_PREFIX));
        assert_eq!(key.len(), KEY_PREFIX.len() + 32);
        let h1 = hash_key(&key);
        let h2 = hash_key(&key);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        assert_ne!(hash_key(&format!("{key}x")), h1);
    }

    #[test]
    fn keys_are_unique() {
        let a = generate_key();
        let b = generate_key();
        assert_ne!(a, b);
    }
}
