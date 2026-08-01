//! External CMDB sync engine (gap closure T13).
//!
//! Pulls/pushes CI records between CloudAtlas and an external CMDB
//! (generic REST / ServiceNow Table API). Records map through
//! the config's `field_mapping`; the remote id is anchored on
//! `meta.external_id` so re-runs upsert instead of duplicating.
//!
//! The mapping/request-building logic is pure and unit-tested; the HTTP layer
//! stays thin (30s timeout, bounded pages).

use axum::{
    extract::{Extension, Path, State},
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

/// One external_cmdb_configs row.
#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub auth_config: Value,
    pub field_mapping: Value,
    pub options: Value,
    pub sync_direction: String,
    pub ci_type_id: Option<Uuid>,
    pub is_active: bool,
    pub last_synced_at: Option<chrono::DateTime<chrono::Utc>>,
}

async fn load_config(db: &sqlx::PgPool, org_id: Uuid, config_id: Uuid) -> AppResult<SyncConfig> {
    let row = sqlx::query(
        r#"SELECT id, organization_id, name, provider, base_url, auth_config, field_mapping,
                  options, sync_direction, ci_type_id, is_active, last_synced_at
           FROM external_cmdb_configs
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(config_id)
    .bind(org_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("External CMDB config not found".into()))?;

    Ok(SyncConfig {
        id: row.get("id"),
        org_id: row.get("organization_id"),
        name: row.get("name"),
        provider: row.get("provider"),
        base_url: row.get("base_url"),
        auth_config: row.get("auth_config"),
        field_mapping: row.get("field_mapping"),
        options: row.get("options"),
        sync_direction: row.get("sync_direction"),
        ci_type_id: row.get("ci_type_id"),
        is_active: row.get("is_active"),
        last_synced_at: row.get("last_synced_at"),
    })
}

// ─── Pure mapping helpers (unit-tested) ──────────────────────────────────────

/// Map one external record into the local shape using `field_mapping`
/// (`{"external_id": "...", "name": "...", "display_name": "...",
///    "meta": {"local_attr": "remote_field"}}`).
pub fn map_record(mapping: &Value, record: &Value) -> Option<(String, String, Value)> {
    let obj = record.as_object()?;
    let get_mapped = |key: &str| -> Option<String> {
        mapping
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(|field| obj.get(field))
            .and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                other => Some(other.to_string()),
            })
    };

    let external_id = get_mapped("external_id")?;
    let name = get_mapped("name").unwrap_or_else(|| format!("ext-{external_id}"));
    let display_name = get_mapped("display_name");

    let mut meta = serde_json::Map::new();
    meta.insert("external_id".into(), json!(external_id));
    if let Some(meta_map) = mapping.get("meta").and_then(|v| v.as_object()) {
        for (local_attr, remote_field) in meta_map {
            if let Some(field) = remote_field.as_str() {
                if let Some(v) = obj.get(field) {
                    if !v.is_null() {
                        meta.insert(local_attr.clone(), v.clone());
                    }
                }
            }
        }
    }
    let mut meta_value = Value::Object(meta);
    if let Some(dn) = display_name {
        meta_value["external_display_name"] = json!(dn);
    }
    Some((external_id, name, meta_value))
}

/// Build the (method, url, body, headers) of one pull page request.
/// Returns None when the provider is unknown.
pub fn build_pull_request(cfg: &SyncConfig, page: usize, per_page: usize) -> Option<(String, String, Option<Value>)> {
    let base = cfg.base_url.trim_end_matches('/');
    match cfg.provider.as_str() {
        "rest" => {
            let path = cfg.options.get("list_path").and_then(|v| v.as_str()).unwrap_or("");
            Some((
                "GET".into(),
                format!("{base}/{path}?page={page}&per_page={per_page}"),
                None,
            ))
        }
        "servicenow" => {
            let table = cfg.options.get("table").and_then(|v| v.as_str()).unwrap_or("cmdb_ci");
            Some((
                "GET".into(),
                format!("{base}/api/now/table/{table}?sysparm_offset={}&sysparm_limit={per_page}", (page - 1) * per_page),
                None,
            ))
        }
        _ => None,
    }
}

/// Extract the record array from a provider response.
pub fn extract_records(provider: &str, body: &Value) -> Vec<Value> {
    match provider {
        "servicenow" => body
            .get("result")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default(),
        // rest: either a bare array or {data: [...]} / {items: [...]}
        _ => body
            .as_array()
            .cloned()
            .or_else(|| body.get("data").and_then(|d| d.as_array()).cloned())
            .or_else(|| body.get("items").and_then(|d| d.as_array()).cloned())
            .unwrap_or_default(),
    }
}

/// Apply the auth config onto a request builder.
fn apply_auth(
    mut req: reqwest::RequestBuilder,
    auth: &Value,
) -> reqwest::RequestBuilder {
    match auth.get("auth_type").and_then(|v| v.as_str()).unwrap_or("none") {
        "bearer" => {
            if let Some(tok) = auth.get("token").and_then(|v| v.as_str()) {
                req = req.bearer_auth(tok);
            }
        }
        "header" => {
            if let (Some(name), Some(val)) = (
                auth.get("header_name").and_then(|v| v.as_str()),
                auth.get("token").and_then(|v| v.as_str()),
            ) {
                req = req.header(name, val);
            }
        }
        "basic" => {
            if let (Some(u), Some(p)) = (
                auth.get("username").and_then(|v| v.as_str()),
                auth.get("password").and_then(|v| v.as_str()),
            ) {
                req = req.basic_auth(u, Some(p));
            }
        }
        _ => {}
    }
    req
}

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Internal(e.into()))
}

// ─── Pull engine ─────────────────────────────────────────────────────────────

pub struct PullOutcome {
    pub created: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub failed: u64,
    pub samples: Vec<Value>,
}

/// Fetch remote records and upsert them as CIs of the bound type.
/// `dry_run` fetches and classifies but never writes. `max_pages` bounds the
/// sweep (background sync: 50; interactive dry-run: 5).
pub async fn pull_once(
    db: &sqlx::PgPool,
    cfg: &SyncConfig,
    dry_run: bool,
    max_pages: usize,
) -> AppResult<PullOutcome> {
    let ci_type_id = cfg
        .ci_type_id
        .ok_or_else(|| AppError::Validation("config has no ci_type_id bound".into()))?;

    let client = http_client()?;
    let mut outcome = PullOutcome { created: 0, updated: 0, unchanged: 0, failed: 0, samples: Vec::new() };

    for page in 1..=max_pages {
        let (method, url, body) = build_pull_request(cfg, page, 100)
            .ok_or_else(|| AppError::Unsupported(format!("unsupported provider '{}'", cfg.provider)))?;

        let mut req = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET), &url);
        req = apply_auth(req, &cfg.auth_config);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| AppError::Cloud(format!("external CMDB request failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Cloud(format!(
                "external CMDB returned HTTP {}",
                resp.status()
            )));
        }
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Cloud(format!("external CMDB response is not JSON: {e}")))?;

        let records = extract_records(&cfg.provider, &payload);
        if records.is_empty() {
            break;
        }

        for record in &records {
            let Some((external_id, name, meta)) = map_record(&cfg.field_mapping, record) else {
                outcome.failed += 1;
                continue;
            };

            let existing = sqlx::query_scalar::<_, (Uuid, Value)>(
                r#"SELECT id, meta FROM cis
                   WHERE organization_id = $1 AND ci_type_id = $2
                     AND meta->>'external_id' = $3 AND deleted_at IS NULL
                   LIMIT 1"#,
            )
            .bind(cfg.org_id)
            .bind(ci_type_id)
            .bind(&external_id)
            .fetch_optional(db)
            .await?;

            match existing {
                None => {
                    outcome.created += 1;
                    if outcome.samples.len() < 20 {
                        outcome.samples.push(json!({
                            "external_id": external_id, "name": name, "action": "create",
                            "remote": record,
                        }));
                    }
                    if !dry_run {
                        let res = sqlx::query(
                            r#"INSERT INTO cis (organization_id, ci_type_id, name, meta, tags, lifecycle_state, discovered_at)
                               VALUES ($1, $2, $3, $4, '{}'::jsonb, 'active', NOW())"#,
                        )
                        .bind(cfg.org_id)
                        .bind(ci_type_id)
                        .bind(&name)
                        .bind(&meta)
                        .execute(db)
                        .await;
                        if let Err(e) = res {
                            tracing::warn!(config = %cfg.id, external_id = %external_id, error = %e, "external CMDB pull insert failed");
                            outcome.created -= 1;
                            outcome.failed += 1;
                        }
                    }
                }
                Some((ci_id, existing_meta)) => {
                    // Shallow-merge: incoming keys win; existing extra keys stay.
                    let mut merged = existing_meta.as_object().cloned().unwrap_or_default();
                    if let Some(incoming) = meta.as_object() {
                        for (k, v) in incoming {
                            merged.insert(k.clone(), v.clone());
                        }
                    }
                    let merged_value = Value::Object(merged);
                    if merged_value == existing_meta {
                        outcome.unchanged += 1;
                    } else {
                        outcome.updated += 1;
                        if outcome.samples.len() < 20 {
                            outcome.samples.push(json!({
                                "external_id": external_id, "name": name, "action": "update",
                                "diff": { "local_meta": existing_meta, "remote_meta": meta },
                            }));
                        }
                        if !dry_run {
                            let res = sqlx::query(
                                "UPDATE cis SET meta = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2",
                            )
                            .bind(ci_id)
                            .bind(cfg.org_id)
                            .bind(&merged_value)
                            .execute(db)
                            .await;
                            if let Err(e) = res {
                                tracing::warn!(config = %cfg.id, external_id = %external_id, error = %e, "external CMDB pull update failed");
                                outcome.updated -= 1;
                                outcome.failed += 1;
                            }
                        }
                    }
                }
            }
        }

        if records.len() < 100 {
            break;
        }
    }

    Ok(outcome)
}

// ─── Push engine ─────────────────────────────────────────────────────────────

/// Push locally-changed CIs (updated_at > last_synced_at, cap 200) back to the
/// external system. The reverse field mapping sends `meta` values out; the
/// remote record id comes from `meta.external_id`.
pub async fn push_once(db: &sqlx::PgPool, cfg: &SyncConfig) -> AppResult<(u64, u64)> {
    let ci_type_id = cfg
        .ci_type_id
        .ok_or_else(|| AppError::Validation("config has no ci_type_id bound".into()))?;

    let since = cfg.last_synced_at.unwrap_or_else(|| chrono::Utc::now() - chrono::Duration::days(1));
    let rows = sqlx::query(
        r#"SELECT name, meta FROM cis
           WHERE organization_id = $1 AND ci_type_id = $2 AND deleted_at IS NULL
             AND updated_at > $3
           ORDER BY updated_at DESC LIMIT 200"#,
    )
    .bind(cfg.org_id)
    .bind(ci_type_id)
    .bind(since)
    .fetch_all(db)
    .await?;

    let client = http_client()?;
    let base = cfg.base_url.trim_end_matches('/');
    let (path, method) = match cfg.provider.as_str() {
        "rest" => (
            cfg.options.get("push_path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            "PUT",
        ),
        "servicenow" => (
            format!(
                "/api/now/table/{}",
                cfg.options.get("table").and_then(|v| v.as_str()).unwrap_or("cmdb_ci")
            ),
            "PATCH",
        ),
        other => return Err(AppError::Unsupported(format!("unsupported provider '{other}'"))),
    };

    // Reverse mapping: remote_field <- local meta key / name.
    let reverse: std::collections::HashMap<String, String> = cfg
        .field_mapping
        .get("meta")
        .and_then(|m| m.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(local, remote)| {
                    remote.as_str().map(|r| (r.to_string(), local.clone()))
                })
                .collect()
        })
        .unwrap_or_default();
    let name_remote = cfg
        .field_mapping
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("name")
        .to_string();

    let mut pushed = 0u64;
    let mut failed = 0u64;

    for row in &rows {
        let name: String = row.get("name");
        let meta: Value = row.get("meta");
        let external_id = meta.get("external_id").and_then(|v| v.as_str()).map(String::from);
        let Some(external_id) = external_id else { continue };

        let mut payload = serde_json::Map::new();
        payload.insert(name_remote.clone(), json!(name));
        if let Some(m) = meta.as_object() {
            for (k, v) in m {
                if k == "external_id" {
                    continue;
                }
                if let Some(remote_field) = reverse.get(k) {
                    payload.insert(remote_field.clone(), v.clone());
                }
            }
        }

        let url = format!("{base}{path}/{external_id}");
        let req = client.request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::PUT),
            &url,
        );
        let req = apply_auth(req, &cfg.auth_config).json(&Value::Object(payload));

        match req.send().await {
            Ok(resp) if resp.status().is_success() => pushed += 1,
            Ok(resp) => {
                tracing::warn!(config = %cfg.id, external_id = %external_id, status = %resp.status(), "external CMDB push rejected");
                failed += 1;
            }
            Err(e) => {
                tracing::warn!(config = %cfg.id, external_id = %external_id, error = %e, "external CMDB push failed");
                failed += 1;
            }
        }
    }

    Ok((pushed, failed))
}

// ─── Sync run + logging ──────────────────────────────────────────────────────

/// Run one full sync per `sync_direction`, writing the sync log and stamping
/// last_synced_at. Shared by the HTTP trigger and the scheduler.
pub async fn run_sync(db: &sqlx::PgPool, cfg: &SyncConfig, trigger: &str) {
    let log_id = Uuid::new_v4();
    let _ = sqlx::query(
        r#"INSERT INTO external_cmdb_sync_logs (id, config_id, organization_id, status)
           VALUES ($1, $2, $3, 'running')"#,
    )
    .bind(log_id)
    .bind(cfg.id)
    .bind(cfg.org_id)
    .execute(db)
    .await;

    let result = run_sync_inner(db, cfg).await;
    let (status, created, updated, pulled, pushed, failed, error) = match result {
        Ok(r) => ("success", r.0, r.1, r.2, r.3, r.4, None),
        Err(e) => ("failed", 0u64, 0u64, 0u64, 0u64, 0u64, Some(e.to_string())),
    };

    let _ = sqlx::query(
        r#"UPDATE external_cmdb_sync_logs
           SET status = $2, completed_at = NOW(), records_created = $3, records_updated = $4,
               records_pulled = $5, records_pushed = $6, records_failed = $7, error_message = $8
           WHERE id = $1"#,
    )
    .bind(log_id)
    .bind(status)
    .bind(created as i32)
    .bind(updated as i32)
    .bind(pulled as i32)
    .bind(pushed as i32)
    .bind(failed as i32)
    .bind(error)
    .execute(db)
    .await;

    if status == "success" {
        let _ = sqlx::query("UPDATE external_cmdb_configs SET last_synced_at = NOW() WHERE id = $1")
            .bind(cfg.id)
            .execute(db)
            .await;
    }
    tracing::info!(config = %cfg.id, trigger = trigger, status = status, "external CMDB sync finished");
}

async fn run_sync_inner(
    db: &sqlx::PgPool,
    cfg: &SyncConfig,
) -> AppResult<(u64, u64, u64, u64, u64)> {
    let mut created = 0u64;
    let mut updated = 0u64;
    let mut failed = 0u64;

    if cfg.sync_direction == "pull" || cfg.sync_direction == "bidirectional" {
        let outcome = pull_once(db, cfg, false, 50).await?;
        created += outcome.created;
        updated += outcome.updated;
        failed += outcome.failed;
    }

    let mut pushed = 0u64;
    if cfg.sync_direction == "push" || cfg.sync_direction == "bidirectional" {
        let (p, f) = push_once(db, cfg).await?;
        pushed = p;
        failed += f;
    }

    Ok((created, updated, created + updated, pushed, failed))
}

// ─── HTTP handlers ───────────────────────────────────────────────────────────

#[derive(Deserialize, Default, utoipa::ToSchema)]
pub struct TriggerSyncRequest {
    pub dry_run: Option<bool>,
}

/// POST /api/v1/orgs/:org_id/external-cmdb/:id/sync — 202, runs in background.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/external-cmdb/{id}/sync",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "External CMDB config ID"),
    ),
    request_body = TriggerSyncRequest,
    responses(
        (status = 202, description = "Sync started in the background"),
        (status = 404, description = "Config not found"),
        (status = 422, description = "Config has no ci_type_id bound"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn trigger_external_sync(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, config_id)): Path<(Uuid, Uuid)>,
    body: Option<Json<TriggerSyncRequest>>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // For a dry-run request, run the bounded preview synchronously instead.
    if body.map(|Json(b)| b.dry_run.unwrap_or(false)).unwrap_or(false) {
        let cfg = load_config(&state.db, org_id, config_id).await?;
        let outcome = pull_once(&state.db, &cfg, true, 5).await?;
        return Ok((
            axum::http::StatusCode::OK,
            Json(json!({
                "data": {
                    "dry_run": true,
                    "would_create": outcome.created,
                    "would_update": outcome.updated,
                    "unchanged": outcome.unchanged,
                    "failed": outcome.failed,
                    "samples": outcome.samples,
                }
            })),
        ));
    }

    let cfg = load_config(&state.db, org_id, config_id).await?;
    if cfg.ci_type_id.is_none() {
        return Err(AppError::Validation(
            "bind a ci_type_id to this config before syncing".into(),
        ));
    }
    let mut cfg = cfg;
    if cfg.sync_direction.is_empty() {
        cfg.sync_direction = "pull".into();
    }
    let direction = cfg.sync_direction.clone();

    let db = state.db.clone();
    tokio::spawn(async move {
        run_sync(&db, &cfg, "manual").await;
    });

    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(json!({
            "data": {
                "status": "sync_started",
                "config_id": config_id,
                "direction": direction,
            }
        })),
    ))
}

/// GET /api/v1/orgs/:org_id/external-cmdb/:id/dry-run — bounded preview.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/external-cmdb/{id}/dry-run",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "External CMDB config ID"),
    ),
    responses(
        (status = 200, description = "Dry-run preview (no writes)"),
        (status = 404, description = "Config not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn external_sync_dry_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, config_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    let cfg = load_config(&state.db, org_id, config_id).await?;
    let outcome = pull_once(&state.db, &cfg, true, 5).await?;
    Ok(Json(json!({
        "data": {
            "would_create": outcome.created,
            "would_update": outcome.updated,
            "unchanged": outcome.unchanged,
            "failed": outcome.failed,
            "samples": outcome.samples,
        }
    })))
}

/// GET /api/v1/orgs/:org_id/external-cmdb/:id/logs — paginated sync history.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/external-cmdb/{id}/logs",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("id"     = Uuid, Path, description = "External CMDB config ID"),
    ),
    responses(
        (status = 200, description = "Paginated sync log"),
        (status = 404, description = "Config not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn external_sync_logs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, config_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Config must belong to the org.
    load_config(&state.db, org_id, config_id).await?;

    let bounds = page.resolve(20, 100);

    let rows = sqlx::query(
        r#"SELECT id, started_at, completed_at, status, records_pulled, records_pushed,
                  records_created, records_updated, records_failed, error_message
           FROM external_cmdb_sync_logs
           WHERE config_id = $1 AND organization_id = $2
           ORDER BY started_at DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(config_id)
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM external_cmdb_sync_logs WHERE config_id = $1 AND organization_id = $2",
    )
    .bind(config_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "started_at": r.get::<chrono::DateTime<chrono::Utc>, _>("started_at"),
                "completed_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("completed_at"),
                "status": r.get::<String, _>("status"),
                "records_pulled": r.get::<i32, _>("records_pulled"),
                "records_pushed": r.get::<i32, _>("records_pushed"),
                "records_created": r.get::<i32, _>("records_created"),
                "records_updated": r.get::<i32, _>("records_updated"),
                "records_failed": r.get::<i32, _>("records_failed"),
                "error": r.get::<Option<String>, _>("error_message"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

/// Scheduler entry (T13): poll every 5 minutes for due active configs.
pub async fn run_external_cmdb_poll(state: &AppState) {
    let rows = sqlx::query_as::<_, (Uuid, Uuid)>(
        r#"SELECT id, organization_id FROM external_cmdb_configs
           WHERE is_active = true AND ci_type_id IS NOT NULL
             AND (last_synced_at IS NULL
                  OR last_synced_at <= NOW() - (sync_interval_minutes || ' minutes')::interval)"#,
    )
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(configs) if !configs.is_empty() => {
            tracing::info!(count = configs.len(), "Scheduler: external CMDB sync");
            for (config_id, org_id) in configs {
                if let Ok(cfg) = load_config(&state.db, org_id, config_id).await {
                    run_sync(&state.db, &cfg, "scheduler").await;
                }
            }
        }
        Ok(_) => {}
        Err(e) => tracing::error!(error = %e, "external CMDB poll cannot list configs"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str, options: Value, mapping: Value) -> SyncConfig {
        SyncConfig {
            id: Uuid::new_v4(),
            org_id: Uuid::new_v4(),
            name: "test".into(),
            provider: provider.into(),
            base_url: "https://cmdb.example.com".into(),
            auth_config: json!({"auth_type":"bearer","token":"t"}),
            field_mapping: mapping,
            options,
            sync_direction: "pull".into(),
            ci_type_id: Some(Uuid::new_v4()),
            is_active: true,
            last_synced_at: None,
        }
    }

    #[test]
    fn map_record_full_mapping() {
        let mapping = json!({
            "external_id": "sys_id",
            "name": "host",
            "display_name": "label",
            "meta": { "environment": "env", "owner_team": "team" }
        });
        let record = json!({
            "sys_id": "abc-123", "host": "web-01", "label": "Web One",
            "env": "prod", "team": "platform", "ignored": "x"
        });
        let (eid, name, meta) = map_record(&mapping, &record).unwrap();
        assert_eq!(eid, "abc-123");
        assert_eq!(name, "web-01");
        assert_eq!(meta["external_id"], "abc-123");
        assert_eq!(meta["external_display_name"], "Web One");
        assert_eq!(meta["environment"], "prod");
        assert_eq!(meta["owner_team"], "platform");
        assert!(meta.get("ignored").is_none());
    }

    #[test]
    fn map_record_requires_external_id() {
        let mapping = json!({"external_id": "missing_field", "name": "host"});
        let record = json!({"host": "web-01"});
        assert!(map_record(&mapping, &record).is_none());
    }

    #[test]
    fn build_pull_requests_per_provider() {
        let rest = cfg("rest", json!({"list_path": "api/cis"}), json!({}));
        let (m, url, body) = build_pull_request(&rest, 2, 100).unwrap();
        assert_eq!(m, "GET");
        assert_eq!(url, "https://cmdb.example.com/api/cis?page=2&per_page=100");
        assert!(body.is_none());

        let sn = cfg("servicenow", json!({"table": "cmdb_ci_linux"}), json!({}));
        let (m, url, _) = build_pull_request(&sn, 2, 100).unwrap();
        assert_eq!(m, "GET");
        assert!(url.contains("sysparm_offset=100"));
        assert!(url.contains("cmdb_ci_linux"));

        let unknown = cfg("jira", json!({}), json!({}));
        assert!(build_pull_request(&unknown, 1, 100).is_none());
    }

    #[test]
    fn extract_records_shapes() {
        assert_eq!(extract_records("rest", &json!([{ "a": 1 }, { "a": 2 }])).len(), 2);
        assert_eq!(extract_records("rest", &json!({"data": [{ "a": 1 }]})).len(), 1);
        assert_eq!(extract_records("rest", &json!({"items": [{ "a": 1 }]})).len(), 1);
        assert_eq!(extract_records("servicenow", &json!({"result": [{ "a": 1 }]})).len(), 1);
        assert_eq!(extract_records("rest", &json!({"unexpected": true})).len(), 0);
    }
}
