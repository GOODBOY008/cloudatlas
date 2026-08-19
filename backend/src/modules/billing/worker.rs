//! Async billing-import worker (spec 2026-09-09-async-jobs-design §4.4).
//!
//! `POST /billing/import` slims down to validation + job-row insert + spawn;
//! [`run_import`] executes the phases (fetching → importing → aggregating)
//! with progress check-points and cooperative cancellation, and terminal
//! handling is centralized in [`crate::modules::jobs::finalize_job`].

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::Value;
use uuid::Uuid;

use crate::{
    crypto,
    error::{AppError, AppResult},
    modules::jobs::{self, JobRow},
    state::AppState,
};

use super::{aliyun_bss, aws_cur};

pub(crate) fn normalize_provider(provider: &str) -> &str {
    match provider {
        "aliyun" => "alibaba",
        other => other,
    }
}

/// A sync progress hook backed by an async watcher task. The hook sends its
/// tick through an unbounded channel (never blocks the import/fetch loop)
/// while the watcher performs the conditional `report_progress` write and
/// tracks liveness — a false return is the cancellation signal.
struct ProgressReporter {
    alive: Arc<AtomicBool>,
    tx: Option<tokio::sync::mpsc::UnboundedSender<(usize, usize)>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl ProgressReporter {
    fn spawn(db: sqlx::PgPool, job_id: Uuid, phase: &'static str) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(usize, usize)>();
        let alive = Arc::new(AtomicBool::new(true));
        let watcher_alive = alive.clone();
        let handle = tokio::spawn(async move {
            while let Some((current, total)) = rx.recv().await {
                let still_running = jobs::report_progress(
                    &db,
                    job_id,
                    phase,
                    Some(current as i32),
                    Some(total as i32),
                )
                .await;
                if !still_running {
                    watcher_alive.store(false, Ordering::Relaxed);
                }
            }
        });
        ProgressReporter {
            alive,
            tx: Some(tx),
            handle: Some(handle),
        }
    }

    /// The sync closure handed to fetch/import functions. Owned captures
    /// only (channel sender + flag clone) — no borrow of the reporter.
    fn hook(&self) -> impl FnMut(usize, usize) -> bool {
        let tx = self.tx.clone().expect("channel alive while reporter lives");
        let alive = self.alive.clone();
        move |current, total| {
            let _ = tx.send((current, total));
            alive.load(Ordering::Relaxed)
        }
    }

    /// Drain pending ticks, stop the watcher, and report the authoritative
    /// liveness (the result of the last conditional progress write).
    async fn finish(mut self) -> bool {
        self.tx.take(); // drop → watcher drains and exits
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
        self.alive.load(Ordering::Relaxed)
    }
}

/// Create a pending `billing_import` job and spawn the background worker.
/// Shared by the manual endpoint and the scheduler.
///
/// Returns `Ok(None)` when a billing job is already active for the account
/// and the trigger is the scheduler (routine overlap is a silent skip);
/// manual triggers get the friendly 409 from [`billing_conflict_error`].
pub async fn launch_billing_import(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    triggered_by: &str,
    days: i64,
) -> AppResult<Option<JobRow>> {
    if let Some(existing) =
        jobs::find_active_job(&state.db, account_id, jobs::KIND_BILLING_IMPORT).await?
    {
        if triggered_by == jobs::TRIGGERED_BY_SCHEDULER {
            tracing::debug!(account_id = %account_id, existing_job = %existing, "billing import already active — scheduler skips");
            return Ok(None);
        }
        return Err(billing_conflict_error(existing));
    }

    let days = days.clamp(1, 90);
    let job = jobs::insert_job(
        &state.db,
        org_id,
        account_id,
        jobs::KIND_BILLING_IMPORT,
        serde_json::json!({ "days": days }),
        triggered_by,
    )
    .await?;

    let account = sqlx::query_as::<_, (String, String, Value)>(
        "SELECT provider::text, credentials_enc, config FROM cloud_accounts WHERE id = $1",
    )
    .bind(account_id)
    .fetch_optional(&state.db)
    .await?;

    let Some((provider_raw, credentials_enc, config)) = account else {
        // Account vanished between validation and insert — fail the job.
        jobs::finalize_job(
            &state.db,
            &job,
            "failed",
            Some("cloud account not found"),
            serde_json::json!({}),
            None,
        )
        .await;
        return Ok(Some(job));
    };

    let worker_state = state.clone();
    tokio::spawn(async move {
        let run = ImportRun {
            org_id,
            account_id,
            provider_raw,
            credentials_enc,
            config,
            days,
        };
        run_import(worker_state, job.id, run).await;
    });

    Ok(Some(job))
}

/// Per-run parameters handed to the spawned import worker.
pub struct ImportRun {
    pub org_id: Uuid,
    pub account_id: Uuid,
    pub provider_raw: String,
    pub credentials_enc: String,
    pub config: Value,
    pub days: i64,
}

/// The friendly 409 for a duplicate manual trigger (§6 compatibility table).
pub fn billing_conflict_error(existing_job_id: Uuid) -> AppError {
    AppError::ConflictWithDetails(
        "A billing import is already running for this account".into(),
        serde_json::json!({ "existing_job_id": existing_job_id }),
    )
}

/// The background import worker. Phase/progress writes are conditional on
/// `status = 'running'`; a zero rowcount means the job was cancelled — the
/// worker returns without a terminal write so the cancelled state sticks.
pub async fn run_import(state: AppState, job_id: Uuid, run: ImportRun) {
    let ImportRun {
        org_id,
        account_id,
        provider_raw,
        credentials_enc,
        config,
        days,
    } = run;
    if !jobs::claim_job(&state.db, job_id).await {
        tracing::info!(job_id = %job_id, "billing import cancelled while pending");
        return;
    }

    let provider = normalize_provider(&provider_raw).to_string();
    let mock_enabled = state.config.cloud_mock_enabled;
    let job = match jobs::get_job_row(&state.db, org_id, job_id).await {
        Ok(j) => j,
        Err(e) => {
            tracing::error!(job_id = %job_id, error = %e, "billing worker cannot reload job");
            return;
        }
    };

    // ── Phases: fetching → importing (→ aggregating at terminal) ──────────
    let outcome: AppResult<(bool, u32)> = async {
        match provider.as_str() {
            "alibaba" => {
                let items = if mock_enabled {
                    let Some(items) = fetch_mock_days(
                        &state.db,
                        job_id,
                        days,
                        aliyun_bss::generate_mock_bss_data_for_day,
                    )
                    .await
                    else {
                        return Ok((false, 0));
                    };
                    items
                } else {
                    let items = {
                        let reporter =
                            ProgressReporter::spawn(state.db.clone(), job_id, "fetching");
                        let result = {
                            let mut hook = reporter.hook();
                            aliyun_bss::fetch_recent_line_items(
                                &creds(&state, &credentials_enc),
                                &config,
                                days,
                                Some(&mut hook),
                            )
                            .await
                        };
                        // Drop the hook (it holds a channel sender clone) before
                        // draining the watcher, or finish() would block forever.
                        if !reporter.finish().await {
                            return Ok((false, 0));
                        }
                        result?
                    };
                    items
                };
                let (alive, inserted) = {
                    let reporter = ProgressReporter::spawn(state.db.clone(), job_id, "importing");
                    let result = {
                        let mut hook = reporter.hook();
                        aliyun_bss::import_line_items(
                            &state,
                            org_id,
                            account_id,
                            items,
                            Some(&mut hook),
                        )
                        .await
                    };
                    (reporter.finish().await, result?)
                };
                Ok((alive, inserted))
            }
            "aws" => {
                let items = if mock_enabled {
                    let Some(items) = fetch_mock_days(
                        &state.db,
                        job_id,
                        days,
                        aws_cur::generate_mock_cur_data_for_day,
                    )
                    .await
                    else {
                        return Ok((false, 0));
                    };
                    items
                } else {
                    // CUR resolves to a single object — no fetch progress.
                    aws_cur::fetch_cur_line_items(
                        &creds(&state, &credentials_enc),
                        &config,
                        days,
                        None,
                    )
                    .await?
                };
                let (alive, inserted) = {
                    let reporter = ProgressReporter::spawn(state.db.clone(), job_id, "importing");
                    let result = {
                        let mut hook = reporter.hook();
                        aws_cur::import_line_items(
                            &state,
                            org_id,
                            account_id,
                            items,
                            Some(&mut hook),
                        )
                        .await
                    };
                    (reporter.finish().await, result?)
                };
                Ok((alive, inserted))
            }
            other => Err(AppError::Validation(format!(
                "Unsupported provider for billing import: {other}"
            ))),
        }
    }
    .await;

    // ── Terminal ────────────────────────────────────────────────────────────
    match outcome {
        Ok((false, _)) => {
            tracing::info!(job_id = %job_id, "billing import cancelled mid-run");
        }
        Ok((true, inserted)) => {
            if let Err(e) = phase_aggregate(&state, org_id, account_id, job_id, inserted).await {
                jobs::finalize_job(
                    &state.db,
                    &job,
                    "failed",
                    Some(&e.to_string()),
                    serde_json::json!({}),
                    None,
                )
                .await;
                return;
            }
            jobs::finalize_job(
                &state.db,
                &job,
                "succeeded",
                None,
                serde_json::json!({
                    "provider": provider,
                    "raw_rows_inserted": inserted,
                    "days_imported": days,
                }),
                None,
            )
            .await;
            tracing::info!(job_id = %job_id, inserted, days, "billing import completed");
        }
        Err(e) => {
            tracing::error!(job_id = %job_id, error = %e, "billing import failed");
            jobs::finalize_job(
                &state.db,
                &job,
                "failed",
                Some(&e.to_string()),
                serde_json::json!({}),
                None,
            )
            .await;
        }
    }
}

fn creds(state: &AppState, credentials_enc: &str) -> Value {
    let key = crypto::key_from_hex(&state.config.encryption_key).unwrap_or([0u8; 32]);
    crypto::decrypt(&key, credentials_enc)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

/// Mock fetch phase: stream one day at a time so progress and cancellation
/// behave like the real BSS path. The small per-day pause keeps runs
/// observable in the UI without changing the generated data. Returns `None`
/// when the job was cancelled mid-fetch.
async fn fetch_mock_days<T>(
    db: &sqlx::PgPool,
    job_id: Uuid,
    days: i64,
    per_day: impl Fn(i64) -> Vec<T>,
) -> Option<Vec<T>> {
    let mut items = Vec::new();
    for day in 0..days {
        if !jobs::report_progress(db, job_id, "fetching", Some(day as i32), Some(days as i32)).await
        {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        items.extend(per_day(day));
    }
    Some(items)
}

/// Phase `aggregating` (indeterminate) — re-aggregate raw → expenses.
/// Returns early when the job was cancelled between phases (the cancelled
/// state sticks; no terminal write happens).
async fn phase_aggregate(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    job_id: Uuid,
    inserted: u32,
) -> AppResult<()> {
    if inserted == 0 {
        return Ok(());
    }
    if !jobs::report_progress(&state.db, job_id, "aggregating", None, None).await {
        return Ok(());
    }
    let provider =
        sqlx::query_scalar::<_, String>("SELECT provider::text FROM cloud_accounts WHERE id = $1")
            .bind(account_id)
            .fetch_optional(&state.db)
            .await?
            .unwrap_or_default();

    if normalize_provider(&provider) == "alibaba" {
        aliyun_bss::aggregate_to_expenses(state, org_id, account_id).await
    } else {
        aws_cur::aggregate_to_expenses(state, org_id, account_id).await
    }
}

// ─── Tests (§7: worker runs to succeeded; cancel mid-import; exclusion) ──────

#[cfg(test)]
mod tests {
    use super::*;

    async fn dev_pool() -> Option<sqlx::PgPool> {
        let url = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas".into()
        });
        match sqlx::PgPool::connect(&url).await {
            Ok(pool) => Some(pool),
            Err(e) => {
                eprintln!("skipping billing worker DB test — no database: {e}");
                None
            }
        }
    }

    /// Minimal AppState with the mock provider enabled.
    async fn mock_state(db: sqlx::PgPool) -> Option<AppState> {
        // Config::from_env requires DATABASE_URL / JWT_SECRET — provide
        // throwaway values when the environment doesn't have them.
        if std::env::var("DATABASE_URL").is_err() {
            std::env::set_var(
                "DATABASE_URL",
                "postgres://cloudatlas:cloudatlas@localhost:5432/cloudatlas",
            );
        }
        if std::env::var("JWT_SECRET").is_err() {
            std::env::set_var("JWT_SECRET", "test-secret-not-used-by-worker-tests");
        }
        let mut config = match crate::config::Config::from_env() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping billing worker DB test — config: {e}");
                return None;
            }
        };
        config.cloud_mock_enabled = true;
        config.scheduler_enabled = false;
        Some(AppState::new(db, config))
    }

    async fn fixture(db: &sqlx::PgPool) -> (Uuid, Uuid) {
        let org: Uuid = sqlx::query_scalar(
            "INSERT INTO organizations (name, slug) VALUES ('billing-worker-test', $1) RETURNING id",
        )
        .bind(format!("bwt-{}", Uuid::new_v4().simple()))
        .fetch_one(db)
        .await
        .expect("org insert");
        let account: Uuid = sqlx::query_scalar(
            r#"INSERT INTO cloud_accounts (organization_id, name, provider, credentials_enc)
               VALUES ($1, 'bwt-acct', 'alibaba', 'x') RETURNING id"#,
        )
        .bind(org)
        .fetch_one(db)
        .await
        .expect("account insert");
        (org, account)
    }

    async fn cleanup(db: &sqlx::PgPool, org: Uuid) {
        let _ = sqlx::query("DELETE FROM organizations WHERE id = $1")
            .bind(org)
            .execute(db)
            .await;
    }

    #[tokio::test]
    async fn mock_import_runs_to_succeeded_through_phases() {
        let Some(db) = dev_pool().await else { return };
        let Some(state) = mock_state(db.clone()).await else {
            return;
        };
        let (org, account) = fixture(&db).await;

        let job = launch_billing_import(&state, org, account, "tester", 3)
            .await
            .expect("launch")
            .expect("job row");

        // Second launch while active → friendly 409 with the job pointer.
        let err = launch_billing_import(&state, org, account, "tester", 3)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ConflictWithDetails(_, _)));

        // Scheduler overlap is a silent skip.
        let skipped = launch_billing_import(&state, org, account, jobs::TRIGGERED_BY_SCHEDULER, 3)
            .await
            .expect("launch scheduler");
        assert!(skipped.is_none());

        // Wait for terminal state (mock: 3 days × ~40 ms + inserts).
        let mut status = String::new();
        for _ in 0..100 {
            let job = jobs::get_job_row(&db, org, job.id).await.expect("job");
            status = job.status;
            if !matches!(status.as_str(), "pending" | "running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(status, "succeeded", "mock import must reach succeeded");

        let done = jobs::get_job_row(&db, org, job.id).await.expect("job");
        assert_eq!(done.result["days_imported"], 3);
        assert_eq!(done.result["provider"], "alibaba");
        let rows = done.result["raw_rows_inserted"].as_i64().unwrap_or(0);
        assert!(rows > 0, "mock rows must be inserted, got {rows}");
        // Aggregation happened.
        let expense_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM expenses WHERE cloud_account_id = $1")
                .bind(account)
                .fetch_one(&db)
                .await
                .expect("expenses count");
        assert!(expense_rows > 0, "aggregation must populate expenses");

        cleanup(&db, org).await;
    }

    #[tokio::test]
    async fn cancel_during_import_sticks_and_allows_relaunch() {
        let Some(db) = dev_pool().await else { return };
        let Some(state) = mock_state(db.clone()).await else {
            return;
        };
        let (org, account) = fixture(&db).await;

        let job = launch_billing_import(&state, org, account, "tester", 60)
            .await
            .expect("launch")
            .expect("job row");

        // Wait until the worker claims the job, then cancel mid-fetch.
        let job_id = job.id;
        let cancel_db = db.clone();
        let cancelled = tokio::spawn(async move {
            loop {
                let running = sqlx::query_scalar::<_, bool>(
                    "SELECT status = 'running' FROM sync_jobs WHERE id = $1",
                )
                .bind(job_id)
                .fetch_one(&cancel_db)
                .await
                .unwrap_or(false);
                if running {
                    return jobs::cancel_job_row(&cancel_db, org, job_id).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancel task");
        assert!(cancelled, "cancel must land while running");

        // The worker must not resurrect the job with a terminal success.
        let mut status = String::new();
        for _ in 0..100 {
            let j = jobs::get_job_row(&db, org, job_id).await.expect("job");
            status = j.status;
            if !matches!(status.as_str(), "pending" | "running") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(status, "cancelled");

        // No success notification for a cancelled job.
        let notified: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notifications WHERE organization_id = $1 AND kind = 'sync'",
        )
        .bind(org)
        .fetch_one(&db)
        .await
        .expect("notif count");
        assert_eq!(notified, 0);

        // A new job can start immediately.
        let relaunched = launch_billing_import(&state, org, account, "tester", 2)
            .await
            .expect("relaunch");
        assert!(relaunched.is_some(), "exclusion window must be released");

        cleanup(&db, org).await;
    }
}
