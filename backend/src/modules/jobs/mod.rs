//! Shared async-job model for discovery and billing import workers
//! (spec 2026-09-09-async-jobs-design §4.2–§4.3, §4.7).
//!
//! `sync_jobs` is generalized into a job table via `job_kind`. All worker
//! writes are conditional `UPDATE`s so that cooperative cancellation needs no
//! separate flag: the cancel endpoint flips the row to a terminal state and
//! every subsequent worker write simply matches zero rows.
//!
//! Terminal handling is centralized in [`finalize_job`], which fans out the
//! in-app notification (anti-flood policy) and the webhook events.

use axum::{
    extract::{Extension, Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

/// Job kinds sharing the `sync_jobs` table.
pub const KIND_DISCOVERY: &str = "discovery";
pub const KIND_BILLING_IMPORT: &str = "billing_import";

/// How the terminal write distinguishes manual runs (notify on success)
/// from scheduled ones (never notify on success — anti-flood, §4.7).
pub const TRIGGERED_BY_SCHEDULER: &str = "scheduler";

/// A `sync_jobs` row with the joined account name. `account_name` is a LEFT
/// JOIN convenience for header-indicator rendering.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JobRow {
    pub id: Uuid,
    pub cloud_account_id: Uuid,
    pub organization_id: Uuid,
    /// PostgreSQL `sync_status` enum, selected as text.
    pub status: String,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub resources_discovered: Option<i32>,
    pub resources_created: Option<i32>,
    pub resources_updated: Option<i32>,
    pub resources_deleted: Option<i32>,
    pub error_message: Option<String>,
    pub triggered_by: String,
    pub created_at: DateTime<Utc>,
    pub job_kind: String,
    pub phase: Option<String>,
    pub progress_current: Option<i32>,
    pub progress_total: Option<i32>,
    pub params: Value,
    pub result: Value,
    pub updated_at: DateTime<Utc>,
    pub account_name: Option<String>,
}

pub const JOB_SELECT: &str = r#"
    SELECT j.id, j.cloud_account_id, j.organization_id, j.status::text AS status,
           j.started_at, j.completed_at,
           j.resources_discovered, j.resources_created,
           j.resources_updated, j.resources_deleted,
           j.error_message, j.triggered_by, j.created_at,
           j.job_kind, j.phase, j.progress_current, j.progress_total,
           j.params, j.result, j.updated_at,
           ca.name AS account_name
    FROM sync_jobs j
    LEFT JOIN cloud_accounts ca ON ca.id = j.cloud_account_id
"#;

/// Render a job row as the API JSON documented in §4.3.
pub fn job_to_json(j: &JobRow) -> Value {
    json!({
        "id": j.id,
        "organization_id": j.organization_id,
        "cloud_account_id": j.cloud_account_id,
        "account_name": j.account_name,
        "job_kind": j.job_kind,
        "status": j.status,
        "phase": j.phase,
        "progress_current": j.progress_current,
        "progress_total": j.progress_total,
        "params": j.params,
        "result": j.result,
        "resources_discovered": j.resources_discovered,
        "resources_created": j.resources_created,
        "resources_updated": j.resources_updated,
        "resources_deleted": j.resources_deleted,
        "error_message": j.error_message,
        "triggered_by": j.triggered_by,
        "created_at": j.created_at,
        "started_at": j.started_at,
        "completed_at": j.completed_at,
        "updated_at": j.updated_at,
    })
}

/// Load a single job (org-scoped).
pub async fn get_job_row(db: &PgPool, org_id: Uuid, job_id: Uuid) -> AppResult<JobRow> {
    sqlx::query_as::<_, JobRow>(&format!(
        "{JOB_SELECT} WHERE j.id = $1 AND j.organization_id = $2"
    ))
    .bind(job_id)
    .bind(org_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::NotFound("Job not found".into()))
}

/// Load a job by id alone — used by internal machinery (the reaper) where
/// the org is discovered from the row itself.
pub async fn get_job_row_any(db: &PgPool, job_id: Uuid) -> AppResult<JobRow> {
    sqlx::query_as::<_, JobRow>(&format!("{JOB_SELECT} WHERE j.id = $1"))
        .bind(job_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound("Job not found".into()))
}

// ─── State machine helpers (§4.2) ─────────────────────────────────────────────

/// Insert a pending job of the given kind.
pub async fn insert_job(
    db: &PgPool,
    org_id: Uuid,
    account_id: Uuid,
    job_kind: &str,
    params: Value,
    triggered_by: &str,
) -> AppResult<JobRow> {
    let job = sqlx::query_as::<_, JobRow>(
        r#"
        INSERT INTO sync_jobs (cloud_account_id, organization_id, status, triggered_by, job_kind, params)
        VALUES ($1, $2, 'pending', $3, $4, $5)
        RETURNING id, cloud_account_id, organization_id, 'pending' AS status,
                  NULL::timestamptz AS started_at, NULL::timestamptz AS completed_at,
                  NULL::int AS resources_discovered, NULL::int AS resources_created,
                  NULL::int AS resources_updated, NULL::int AS resources_deleted,
                  NULL::text AS error_message, triggered_by, NOW() AS created_at,
                  job_kind, NULL::varchar AS phase, NULL::int AS progress_current,
                  NULL::int AS progress_total, params, '{}'::jsonb AS result,
                  NOW() AS updated_at,
                  (SELECT name FROM cloud_accounts WHERE id = $1) AS account_name
        "#,
    )
    .bind(account_id)
    .bind(org_id)
    .bind(triggered_by)
    .bind(job_kind)
    .bind(params)
    .fetch_one(db)
    .await?;
    Ok(job)
}

/// Mutual exclusion: the active job of this kind for this account, if any.
/// Backed by `idx_sync_jobs_active_kind`.
pub async fn find_active_job(
    db: &PgPool,
    account_id: Uuid,
    job_kind: &str,
) -> AppResult<Option<Uuid>> {
    let row = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT id FROM sync_jobs
           WHERE cloud_account_id = $1 AND job_kind = $2 AND status IN ('pending', 'running')
           LIMIT 1"#,
    )
    .bind(account_id)
    .bind(job_kind)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Worker claims the job: `pending → running`. Returns `false` when the job
/// was cancelled while pending — the worker must exit without side effects.
pub async fn claim_job(db: &PgPool, job_id: Uuid) -> bool {
    sqlx::query(
        "UPDATE sync_jobs SET status = 'running', started_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending'",
    )
    .bind(job_id)
    .execute(db)
    .await
    .map(|r| r.rows_affected() > 0)
    .unwrap_or(false)
}

/// Progress check-point. Every worker write is conditional on
/// `status = 'running'`; a zero rowcount is the cancellation signal.
/// `current`/`total` of `None` leave the columns NULL (indeterminate).
/// Returns `false` when the job is no longer running (cancelled/reaped).
pub async fn report_progress(
    db: &PgPool,
    job_id: Uuid,
    phase: &str,
    current: Option<i32>,
    total: Option<i32>,
) -> bool {
    sqlx::query(
        r#"UPDATE sync_jobs
           SET phase = $2, progress_current = $3, progress_total = $4, updated_at = NOW()
           WHERE id = $1 AND status = 'running'"#,
    )
    .bind(job_id)
    .bind(phase)
    .bind(current)
    .bind(total)
    .execute(db)
    .await
    .map(|r| r.rows_affected() > 0)
    .unwrap_or(false)
}

/// Cancel endpoint write: flips pending/running to terminal `cancelled`.
/// Rowcount 0 ⇒ already terminal ⇒ the caller answers 409.
pub async fn cancel_job_row(db: &PgPool, org_id: Uuid, job_id: Uuid) -> bool {
    sqlx::query(
        r#"UPDATE sync_jobs
           SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
               error_message = 'cancelled by user'
           WHERE id = $1 AND organization_id = $2 AND status IN ('pending', 'running')"#,
    )
    .bind(job_id)
    .bind(org_id)
    .execute(db)
    .await
    .map(|r| r.rows_affected() > 0)
    .unwrap_or(false)
}

// ─── Terminal fan-out (§4.7) ──────────────────────────────────────────────────

/// Write the terminal state (guarded — a cancelled or already-terminal job is
/// never resurrected) and fan out the notification + webhook events.
///
/// `counters` = (discovered, created, updated); only discovery jobs set them.
/// `result` is the terminal result JSON (billing rows/days, provider).
pub async fn finalize_job(
    db: &PgPool,
    job: &JobRow,
    status: &str,
    error: Option<&str>,
    result: Value,
    counters: Option<(i32, i32, i32)>,
) {
    let (discovered, created, updated) = counters.unwrap_or((0, 0, 0));
    let write = sqlx::query(
        r#"UPDATE sync_jobs
           SET status = $2::sync_status, completed_at = NOW(), updated_at = NOW(),
               error_message = $3, result = $4,
               resources_discovered = COALESCE($5, resources_discovered),
               resources_created    = COALESCE($6, resources_created),
               resources_updated    = COALESCE($7, resources_updated),
               resources_deleted    = COALESCE($8, resources_deleted)
           WHERE id = $1 AND status IN ('pending', 'running')"#,
    )
    .bind(job.id)
    .bind(status)
    .bind(error)
    .bind(&result)
    .bind(counters.map(|_| discovered))
    .bind(counters.map(|_| created))
    .bind(counters.map(|_| updated))
    .bind(counters.map(|_| 0i32))
    .execute(db)
    .await;

    let won = write.map(|r| r.rows_affected() > 0).unwrap_or(false);
    if !won {
        // Cancelled (or reaped) before this write — never resurrect, never fan out.
        tracing::debug!(job_id = %job.id, status, "terminal write skipped — job no longer active");
        return;
    }

    let job = match get_job_row(db, job.organization_id, job.id).await {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!(job_id = %job.id, error = %e, "finalize_job: reload failed");
            return;
        }
    };
    let account = job.account_name.clone().unwrap_or_else(|| job.cloud_account_id.to_string());
    let user_triggered = job.triggered_by != TRIGGERED_BY_SCHEDULER;
    let succeeded = status == "succeeded";

    // In-app notification — anti-flood policy: failures always notify
    // (cancels never do); successes only for user-triggered runs.
    if !succeeded || user_triggered {
        let (title, body) = match (job.job_kind.as_str(), succeeded) {
            (KIND_DISCOVERY, true) => (
                "资源同步完成",
                format!("{account}: 发现 {discovered} · 新建 {created} · 更新 {updated}"),
            ),
            (KIND_DISCOVERY, false) => (
                "资源同步失败",
                format!("{account}: {}", truncate(error.unwrap_or("unknown error"), 200)),
            ),
            (KIND_BILLING_IMPORT, true) => {
                let rows = job.result["raw_rows_inserted"].as_i64().unwrap_or(0);
                let days = job.result["days_imported"].as_i64().unwrap_or_else(|| {
                    job.params["days"].as_i64().unwrap_or(0)
                });
                (
                    "账单导入完成",
                    format!("{account}: {rows} 行 · {days} 天"),
                )
            }
            (KIND_BILLING_IMPORT, false) => (
                "账单导入失败",
                format!("{account}: {}", truncate(error.unwrap_or("unknown error"), 200)),
            ),
            _ => return,
        };
        crate::modules::notifications::handlers::create_notification(
            db, job.organization_id, None, "sync", title, &body,
        )
        .await;
    }

    // Webhook events — always emitted regardless of trigger source; channels
    // are opt-in and routine events are the point (§4.7).
    let duration_s = match (job.started_at, job.completed_at) {
        (Some(s), Some(c)) => Some((c - s).num_seconds()),
        _ => None,
    };
    let job_payload = json!({
        "id": job.id,
        "cloud_account_id": job.cloud_account_id,
        "account_name": account,
        "job_kind": job.job_kind,
        "triggered_by": job.triggered_by,
        "resources_discovered": job.resources_discovered,
        "resources_created": job.resources_created,
        "resources_updated": job.resources_updated,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "duration_s": duration_s,
        "result": job.result,
        "error_message": job.error_message,
    });

    let (event, message) = match (job.job_kind.as_str(), succeeded) {
        (KIND_DISCOVERY, true) => (
            "sync.completed",
            format!("{account} 资源同步完成：发现 {discovered} · 新建 {created} · 更新 {updated}"),
        ),
        (KIND_DISCOVERY, false) => (
            "sync.failed",
            format!("{account} 资源同步失败: {}", truncate(error.unwrap_or("unknown error"), 120)),
        ),
        (KIND_BILLING_IMPORT, true) => {
            let rows = job.result["raw_rows_inserted"].as_i64().unwrap_or(0);
            let days = job.result["days_imported"]
                .as_i64()
                .or_else(|| job.params["days"].as_i64())
                .unwrap_or(0);
            ("billing.imported", format!("{account} 账单导入完成: {rows} 行 · {days} 天"))
        }
        (KIND_BILLING_IMPORT, false) => (
            "billing.failed",
            format!("{account} 账单导入失败: {}", truncate(error.unwrap_or("unknown error"), 120)),
        ),
        _ => return,
    };

    crate::modules::webhook::handlers::enqueue_event(
        db,
        job.organization_id,
        event,
        json!({
            "event": event,
            "organization_id": job.organization_id,
            "message": message,
            "job": job_payload,
        }),
    )
    .await;
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}

// ─── Jobs API (§4.3) ──────────────────────────────────────────────────────────

async fn ensure_org_member(db: &PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

#[derive(Deserialize, Default)]
pub struct ListJobsQuery {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    /// `true` → only pending + running.
    pub active: Option<bool>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

/// GET /orgs/:org_id/jobs — unified job list.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/jobs",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("kind" = Option<String>, Query, description = "Filter by job kind (discovery | billing_import)"),
        ("status" = Option<String>, Query, description = "Filter by status (pending | running | succeeded | failed | cancelled)"),
        ("cloud_account_id" = Option<Uuid>, Query, description = "Filter by cloud account"),
        ("active" = Option<bool>, Query, description = "Only pending + running jobs"),
        ("page" = Option<i64>, Query, description = "1-based page, default 1"),
        ("per_page" = Option<i64>, Query, description = "Page size, default 50, max 200"),
        ("limit" = Option<i64>, Query, description = "Deprecated alias of per_page"),
        ("offset" = Option<i64>, Query, description = "Deprecated alias, page = offset/per_page + 1"),
    ),
    responses(
        (status = 200, description = "Job list"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
    ),
    security(("bearer_auth" = [])),
    tag = "jobs"
)]
pub async fn list_jobs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ListJobsQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = q.page.resolve(50, 200);

    let (final_sql, where_sql, binds) = build_list_query(&q);
    let mut query = sqlx::query_as::<_, JobRow>(&final_sql).bind(org_id);
    for b in &binds {
        query = query.bind(b);
    }
    query = query.bind(bounds.limit).bind(bounds.offset);
    let jobs = query.fetch_all(&state.db).await?;

    // COUNT under the identical WHERE so meta.total matches the filtered set.
    let count_sql = format!("SELECT COUNT(*) FROM sync_jobs j{where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(org_id);
    for b in &binds {
        count_query = count_query.bind(b);
    }
    let total: i64 = count_query.fetch_one(&state.db).await.unwrap_or(0);

    let data: Vec<Value> = jobs.iter().map(job_to_json).collect();
    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

/// Compose the filter SQL. `$1` is org_id; every pushed bind occupies the
/// next `$n`; LIMIT/OFFSET are `$n+1`/`$n+2` after the last bind. Returns
/// (page SQL, WHERE-only SQL for COUNT, binds). Pure so the placeholder
/// numbering is unit-testable.
fn build_list_query(q: &ListJobsQuery) -> (String, String, Vec<String>) {
    let mut where_sql = String::from(" WHERE j.organization_id = $1");
    let mut binds: Vec<String> = Vec::new();
    if let Some(kind) = &q.kind {
        binds.push(kind.clone());
        where_sql.push_str(&format!(" AND j.job_kind = ${}", binds.len() + 1));
    }
    if let Some(status) = &q.status {
        binds.push(status.clone());
        where_sql.push_str(&format!(" AND j.status::text = ${}", binds.len() + 1));
    }
    if let Some(account) = q.cloud_account_id {
        binds.push(account.to_string());
        where_sql.push_str(&format!(" AND j.cloud_account_id = ${}::uuid", binds.len() + 1));
    }
    if q.active == Some(true) {
        where_sql.push_str(" AND j.status IN ('pending', 'running')");
    }
    let mut final_sql = String::from(JOB_SELECT);
    final_sql.push_str(&where_sql);
    final_sql.push_str(&format!(
        " ORDER BY j.created_at DESC, j.id DESC LIMIT ${} OFFSET ${}",
        binds.len() + 2,
        binds.len() + 3
    ));
    (final_sql, where_sql, binds)
}

/// GET /orgs/:org_id/jobs/:job_id — the polling target.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/jobs/{job_id}",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("job_id" = Uuid, Path, description = "Job ID"),
    ),
    responses(
        (status = 200, description = "Job detail"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Job not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "jobs"
)]
pub async fn get_job(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, job_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;
    let job = get_job_row(&state.db, org_id, job_id).await?;
    Ok(Json(json!({ "data": job_to_json(&job) })))
}

/// POST /orgs/:org_id/jobs/:job_id/cancel — cooperative cancel.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/jobs/{job_id}/cancel",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("job_id" = Uuid, Path, description = "Job ID"),
    ),
    responses(
        (status = 200, description = "Job cancelled"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Job not found"),
        (status = 409, description = "Job already terminal"),
    ),
    security(("bearer_auth" = [])),
    tag = "jobs"
)]
pub async fn cancel_job(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, job_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // 404 when the job doesn't exist in this org at all.
    get_job_row(&state.db, org_id, job_id).await?;

    if cancel_job_row(&state.db, org_id, job_id).await {
        let job = get_job_row(&state.db, org_id, job_id).await?;
        Ok(Json(json!({ "data": job_to_json(&job) })))
    } else {
        Err(AppError::ConflictWithDetails(
            "Job is already in a terminal state".into(),
            json!({ "job_id": job_id }),
        ))
    }
}

// ─── Tests (§7: conditional-update semantics, reaper, notification guard) ─────

#[cfg(test)]
mod tests {
    use super::*;

    /// Placeholder numbering must stay contiguous: $1 org, then one $n per
    /// filter, LIMIT and OFFSET last. A mis-numbered LIMIT gets bound as
    /// text → 500.
    #[test]
    fn list_query_placeholders_are_contiguous() {
        let account = Uuid::new_v4();
        let no_query = || ListJobsQuery::default();

        let (sql, where_sql, binds) = build_list_query(&no_query());
        assert_eq!(binds.len(), 0);
        assert!(sql.contains("organization_id = $1"));
        assert!(sql.ends_with("LIMIT $2 OFFSET $3"), "limit must follow org bind: {sql}");
        assert_eq!(where_sql, " WHERE j.organization_id = $1");

        let (sql, _, binds) = build_list_query(&ListJobsQuery {
            kind: Some("billing_import".into()), active: Some(true), ..no_query()
        });
        assert_eq!(binds, vec!["billing_import".to_string()]);
        assert!(sql.contains("j.job_kind = $2"));
        assert!(sql.contains("IN ('pending', 'running')"));
        assert!(sql.ends_with("LIMIT $3 OFFSET $4"), "limit must follow the kind bind: {sql}");

        let (sql, where_sql, binds) = build_list_query(&ListJobsQuery {
            kind: Some("discovery".into()),
            status: Some("failed".into()),
            cloud_account_id: Some(account),
            ..no_query()
        });
        assert_eq!(binds.len(), 3);
        assert!(sql.contains("j.job_kind = $2"));
        assert!(sql.contains("j.status::text = $3"));
        assert!(sql.contains(&format!("j.cloud_account_id = $4::uuid")));
        assert!(sql.ends_with("LIMIT $5 OFFSET $6"), "limit must follow all binds: {sql}");
        // COUNT reuses the identical WHERE.
        assert!(where_sql.contains("j.status::text = $3"));
        assert!(!where_sql.contains("ORDER BY"), "COUNT WHERE must stay order-free");
    }

    /// Connect to the dev Postgres when it is reachable; otherwise skip.
    /// Keeps `cargo test` green in environments without a database while
    /// exercising the real state machine where one exists.
    async fn dev_pool() -> Option<PgPool> {
        let url = std::env::var("TEST_DATABASE_URL")
            .unwrap_or_else(|_| "postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas".into());
        match sqlx::PgPool::connect(&url).await {
            Ok(pool) => Some(pool),
            Err(e) => {
                eprintln!("skipping jobs DB test — no database: {e}");
                None
            }
        }
    }

    /// Throwaway org + account (cascade-cleaned).
    async fn fixture(db: &PgPool) -> (Uuid, Uuid) {
        let org: Uuid = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ('jobs-test', $1) RETURNING id",
        )
        .bind(format!("jobs-test-{}", Uuid::new_v4().simple()))
        .fetch_one(db)
        .await
        .expect("org insert");
        let account: Uuid = sqlx::query_scalar(
            r#"INSERT INTO cloud_accounts (organization_id, name, provider, credentials_enc)
               VALUES ($1, 'jobs-test-acct', 'mock', 'x') RETURNING id"#,
        )
        .bind(org)
        .fetch_one(db)
        .await
        .expect("account insert");
        (org, account)
    }

    async fn cleanup(db: &PgPool, org: Uuid) {
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org)
            .execute(db)
            .await;
    }

    #[tokio::test]
    async fn worker_state_machine_and_notification_fanout() {
        let Some(db) = dev_pool().await else { return };
        let (org, account) = fixture(&db).await;

        // Launch → claim → progress → terminal succeeds.
        let job = insert_job(&db, org, account, KIND_BILLING_IMPORT, json!({"days": 3}), "11111111-1111-1111-1111-111111111111")
            .await
            .expect("insert");
        assert!(claim_job(&db, job.id).await, "worker wins the claim");
        assert!(!claim_job(&db, job.id).await, "second claim loses");
        assert!(report_progress(&db, job.id, "fetching", Some(1), Some(3)).await);
        finalize_job(
            &db,
            &job,
            "succeeded",
            None,
            json!({"provider": "mock", "raw_rows_inserted": 15, "days_imported": 3}),
            None,
        )
        .await;

        let done = get_job_row(&db, org, job.id).await.expect("reload");
        assert_eq!(done.status, "succeeded");
        assert_eq!(done.result["raw_rows_inserted"], 15);
        assert!(done.completed_at.is_some());

        // User-triggered success → notification written.
        let notified: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE organization_id = $1 AND kind = 'sync'",
        )
        .bind(org)
        .fetch_one(&db)
        .await
        .expect("notif count");
        assert_eq!(notified, 1, "user-triggered success notifies");

        cleanup(&db, org).await;
    }

    #[tokio::test]
    async fn cancel_blocks_progress_and_terminal_writes() {
        let Some(db) = dev_pool().await else { return };
        let (org, account) = fixture(&db).await;

        let job = insert_job(&db, org, account, KIND_DISCOVERY, json!({}), "scheduler")
            .await
            .expect("insert");
        assert!(claim_job(&db, job.id).await);

        // Cancel endpoint flips to terminal…
        assert!(cancel_job_row(&db, org, job.id).await);
        // …and a second cancel 409s.
        assert!(!cancel_job_row(&db, org, job.id).await);

        // Worker progress + terminal writes match zero rows — no resurrection.
        assert!(!report_progress(&db, job.id, "upserting", Some(1), Some(9)).await);
        finalize_job(&db, &job, "succeeded", None, json!({}), Some((9, 4, 5))).await;
        let done = get_job_row(&db, org, job.id).await.expect("reload");
        assert_eq!(done.status, "cancelled", "terminal write must not resurrect");
        assert_eq!(done.phase, None, "progress write must not land");

        // Cancelled jobs never notify.
        let notified: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE organization_id = $1 AND kind = 'sync'",
        )
        .bind(org)
        .fetch_one(&db)
        .await
        .expect("notif count");
        assert_eq!(notified, 0);

        // A new job of the same kind can start immediately.
        assert!(find_active_job(&db, account, KIND_DISCOVERY).await.unwrap().is_none());

        cleanup(&db, org).await;
    }

    #[tokio::test]
    async fn scheduler_success_does_not_notify_but_failure_does() {
        let Some(db) = dev_pool().await else { return };
        let (org, account) = fixture(&db).await;

        // Scheduler success → no notification.
        let ok_job = insert_job(&db, org, account, KIND_DISCOVERY, json!({}), TRIGGERED_BY_SCHEDULER)
            .await
            .expect("insert");
        assert!(claim_job(&db, ok_job.id).await);
        finalize_job(&db, &ok_job, "succeeded", None, json!({}), Some((5, 2, 3))).await;

        // Scheduler failure → notification.
        let bad_job = insert_job(&db, org, account, KIND_BILLING_IMPORT, json!({"days": 1}), TRIGGERED_BY_SCHEDULER)
            .await
            .expect("insert");
        assert!(claim_job(&db, bad_job.id).await);
        finalize_job(&db, &bad_job, "failed", Some("boom"), json!({}), None).await;

        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT title, body FROM notifications WHERE organization_id = $1 AND kind = 'sync' ORDER BY created_at",
        )
        .bind(org)
        .fetch_all(&db)
        .await
        .expect("notifs");
        assert_eq!(rows.len(), 1, "only the failure notifies");
        assert!(rows[0].0.contains("账单导入失败"));
        assert!(rows[0].1.contains("boom"));

        cleanup(&db, org).await;
    }

    #[tokio::test]
    async fn mutual_exclusion_finds_active_jobs_only() {
        let Some(db) = dev_pool().await else { return };
        let (org, account) = fixture(&db).await;

        let job = insert_job(&db, org, account, KIND_BILLING_IMPORT, json!({}), "scheduler")
            .await
            .expect("insert");
        // Pending counts as active.
        assert_eq!(find_active_job(&db, account, KIND_BILLING_IMPORT).await.unwrap(), Some(job.id));
        // Cross-kind concurrency is allowed.
        assert!(find_active_job(&db, account, KIND_DISCOVERY).await.unwrap().is_none());

        assert!(claim_job(&db, job.id).await);
        assert_eq!(find_active_job(&db, account, KIND_BILLING_IMPORT).await.unwrap(), Some(job.id));

        finalize_job(&db, &job, "failed", Some("x"), json!({}), None).await;
        assert!(find_active_job(&db, account, KIND_BILLING_IMPORT).await.unwrap().is_none());

        cleanup(&db, org).await;
    }

    /// The reaper path (scheduler::reap_stuck_jobs): a `running` row with an
    /// aged `updated_at` is failed through finalize_job, which writes the
    /// failure notification and never overwrites a terminal state.
    #[tokio::test]
    async fn stuck_running_row_is_reaped_and_notifies() {
        let Some(db) = dev_pool().await else { return };
        let (org, account) = fixture(&db).await;

        let job = insert_job(&db, org, account, KIND_DISCOVERY, json!({}), TRIGGERED_BY_SCHEDULER)
            .await
            .expect("insert");
        assert!(claim_job(&db, job.id).await);
        // Age the row past the 30-minute staleness bound.
        sqlx::query("UPDATE sync_jobs SET updated_at = NOW() - INTERVAL '31 minutes' WHERE id = $1")
            .bind(job.id)
            .execute(&db)
            .await
            .expect("age row");

        // The exact terminal write the reaper performs.
        finalize_job(&db, &job, "failed", Some("worker lost (no progress for 30m)"), json!({}), None).await;

        let done = get_job_row(&db, org, job.id).await.expect("reload");
        assert_eq!(done.status, "failed");
        assert!(done.error_message.unwrap().contains("worker lost"));

        // Scheduler failures always notify.
        let (title, _body): (String, String) = sqlx::query_as(
            "SELECT title, body FROM notifications WHERE organization_id = $1 AND kind = 'sync'",
        )
        .bind(org)
        .fetch_one(&db)
        .await
        .expect("notifs");
        assert!(title.contains("资源同步失败"));

        cleanup(&db, org).await;
    }
}
