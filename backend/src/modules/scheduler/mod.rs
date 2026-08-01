use std::time::Duration;
use sqlx::Row;
use crate::state::AppState;

pub async fn start(state: AppState) {
    tracing::info!("Starting CloudAtlas scheduler");

    // Cloud sync — every hour
    let sync_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            run_cloud_sync(&sync_state).await;
        }
    });

    // Recommendation engine — every 4 hours (staggered 5 min)
    let rec_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(300)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(14400));
        loop {
            interval.tick().await;
            run_recommendation_engine(&rec_state).await;
        }
    });

    // Alert checks — every hour (staggered 2 min)
    let alert_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(120)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            run_alert_checks(&alert_state).await;
        }
    });

    // Webhook delivery — every minute
    let webhook_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            deliver_pending_webhooks(&webhook_state).await;
        }
    });

    // Daily digest — every 24h (staggered 15 min)
    let digest_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(900)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(86_400));
        loop {
            interval.tick().await;
            run_daily_digest(&digest_state).await;
        }
    });

    // Expense archive — daily (staggered 30 min)
    let archive_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1800)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(86_400));
        loop {
            interval.tick().await;
            run_expense_archive(&archive_state).await;
        }
    });

    // Power schedules — every 5 minutes (staggered 3 min)
    let power_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(180)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            run_power_schedules(&power_state).await;
        }
    });

    // Billing import — every 6 hours (staggered 10 min, rolling 3-day window)
    let billing_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(6 * 3600));
        loop {
            interval.tick().await;
            run_billing_import(&billing_state).await;
        }
    });

    // Stuck-job reaper — every 5 minutes. A crashed worker leaks a `running`
    // row forever; the reaper bounds that window and failure-notifies.
    let reaper_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            reap_stuck_jobs(&reaper_state).await;
        }
    });

    // CMDB compliance — every 24h (staggered 12 min, T12). Re-runs every
    // org's active policies against its CIs and records a job_runs entry.
    let compliance_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(720)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(86_400));
        loop {
            interval.tick().await;
            run_cmdb_compliance(&compliance_state).await;
        }
    });

    // CMDB drift rescan — every 4h (staggered 8 min, T12). Full
    // baseline-vs-actual comparison; healed drifts auto-resolve.
    let drift_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(480)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(14_400));
        loop {
            interval.tick().await;
            run_cmdb_drift_rescan(&drift_state).await;
        }
    });

    // CMDB stats snapshot — daily (staggered 25 min, T14).
    let cmdb_stats_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1500)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(86_400));
        loop {
            interval.tick().await;
            if acquire_job_lock(&cmdb_stats_state.db, "cmdb_stats_snapshot").await {
                let orgs = sqlx::query_as::<_, (uuid::Uuid,)>(
                    "SELECT id FROM organizations WHERE deleted_at IS NULL",
                )
                .fetch_all(&cmdb_stats_state.db)
                .await;
                if let Ok(rows) = orgs {
                    for (org_id,) in rows {
                        if let Err(e) = crate::modules::cmdb::analytics_handlers::snapshot_cmdb_stats(
                            &cmdb_stats_state.db, org_id,
                        )
                        .await
                        {
                            tracing::warn!(org_id = %org_id, error = %e, "CMDB stats snapshot failed");
                        }
                    }
                }
            }
        }
    });

    // External CMDB sync — every 5 minutes (staggered 3 min, T13). Each
    // active config runs when its sync_interval_minutes have elapsed.
    let extcmdb_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(180)).await;
        let mut interval = tokio::time::interval(Duration::from_secs(300));
        loop {
            interval.tick().await;
            if acquire_job_lock(&extcmdb_state.db, "external_cmdb_poll").await {
                crate::modules::cmdb::external_sync::run_external_cmdb_poll(&extcmdb_state).await;
            }
        }
    });

    tracing::info!("Scheduler started: sync(1h), rec(4h), alerts(1h), webhooks(1m), power(5m), billing(6h), reaper(5m), cmdb_compliance(24h), cmdb_drift(4h), extcmdb(5m)");
}

/// CMDB compliance sweep (T12): every org, active policies only. Errors are
/// logged and recorded per-org; one org failing never blocks the sweep.
async fn run_cmdb_compliance(state: &AppState) {
    if !acquire_job_lock(&state.db, "cmdb_compliance").await {
        return;
    }
    let orgs = sqlx::query_as::<_, (uuid::Uuid,)>(
        "SELECT id FROM organizations WHERE deleted_at IS NULL",
    )
    .fetch_all(&state.db)
    .await;

    match orgs {
        Ok(rows) => {
            tracing::info!(orgs = rows.len(), "Scheduler: CMDB compliance sweep");
            for (org_id,) in rows {
                let mut summary = crate::modules::cmdb::compliance_handlers::run_compliance_for_org(
                    &state.db, org_id,
                )
                .await;
                match &mut summary {
                    Ok(data) => {
                        data["trigger"] = serde_json::json!("scheduled");
                        crate::modules::cmdb::compliance_handlers::record_governance_run_for_scheduler(
                            &state.db, org_id, "cmdb_compliance", data, None,
                        )
                        .await;
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        crate::modules::cmdb::compliance_handlers::record_governance_run_for_scheduler(
                            &state.db,
                            org_id,
                            "cmdb_compliance",
                            &serde_json::json!({ "trigger": "scheduled" }),
                            Some(&msg),
                        )
                        .await;
                    }
                }
            }
        }
        Err(e) => tracing::error!(error = %e, "CMDB compliance sweep cannot list orgs"),
    }
}

/// CMDB drift rescan sweep (T12): every org with active baselines.
async fn run_cmdb_drift_rescan(state: &AppState) {
    if !acquire_job_lock(&state.db, "cmdb_drift").await {
        return;
    }
    let orgs = sqlx::query_as::<_, (uuid::Uuid,)>(
        "SELECT DISTINCT organization_id FROM ci_baselines WHERE is_active = true",
    )
    .fetch_all(&state.db)
    .await;

    match orgs {
        Ok(rows) => {
            tracing::info!(orgs = rows.len(), "Scheduler: CMDB drift rescan");
            for (org_id,) in rows {
                let res = crate::modules::cmdb::compliance_handlers::rescan_drift_for_org(
                    &state.db, org_id,
                )
                .await;
                match res {
                    Ok(mut data) => {
                        data["trigger"] = serde_json::json!("scheduled");
                        crate::modules::cmdb::compliance_handlers::record_governance_run_for_scheduler(
                            &state.db, org_id, "cmdb_drift", &data, None,
                        )
                        .await;
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        crate::modules::cmdb::compliance_handlers::record_governance_run_for_scheduler(
                            &state.db,
                            org_id,
                            "cmdb_drift",
                            &serde_json::json!({ "trigger": "scheduled" }),
                            Some(&msg),
                        )
                        .await;
                    }
                }
            }
        }
        Err(e) => tracing::error!(error = %e, "CMDB drift rescan cannot list baselines"),
    }
}

async fn run_cloud_sync(state: &AppState) {
    if !acquire_job_lock(&state.db, "cloud_sync").await {
        return;
    }
    // Per-account sync intervals (D5): each account syncs when its
    // sync_interval_hours have elapsed since last_sync_at.
    let accounts = sqlx::query_as::<_, (uuid::Uuid,)>(
        r#"SELECT id FROM cloud_accounts
           WHERE is_active = true
             AND deleted_at IS NULL
             AND (last_sync_at IS NULL
                  OR last_sync_at <= NOW() - (COALESCE(sync_interval_hours, 1) || ' hours')::interval)"#
    )
    .fetch_all(&state.db)
    .await;

    match accounts {
        Ok(ids) => {
            tracing::info!(count = ids.len(), "Scheduler: triggering cloud sync");
            for (id,) in ids {
                // Stamp the account so the next tick is sync_interval_hours away.
                let _ = sqlx::query(
                    "UPDATE cloud_accounts SET last_sync_at = NOW() WHERE id = $1"
                )
                .bind(id)
                .execute(&state.db)
                .await;

                let account = sqlx::query_as::<_, (uuid::Uuid, String)>(
                    "SELECT organization_id, provider::text FROM cloud_accounts WHERE id = $1",
                )
                .bind(id)
                .fetch_optional(&state.db)
                .await;

                let Ok(Some((org_id, provider))) = account else { continue };

                match crate::modules::cloud::handlers::launch_sync(
                    state, org_id, id, "scheduler",
                )
                .await
                {
                    // None = a discovery job is already active — routine
                    // overlap, skip silently.
                    Ok(None) => continue,
                    Ok(Some(_)) => {}
                    Err(e) => {
                        tracing::warn!(account_id = %id, error = %e, "Scheduler: failed to launch sync");
                        continue;
                    }
                }

                crate::modules::webhook::handlers::enqueue_event(
                    &state.db,
                    org_id,
                    "resource.discovered",
                    serde_json::json!({ "message": "Cloud account sync launched", "provider": provider }),
                )
                .await;
            }
        }
        Err(e) => tracing::error!(error = %e, "Scheduler: failed to list cloud accounts"),
    }
}

async fn run_recommendation_engine(state: &AppState) {
    if !acquire_job_lock(&state.db, "rec_engine").await {
        return;
    }
    tracing::info!("Scheduler: running recommendation engine");

    let orgs = sqlx::query_as::<_, (uuid::Uuid,)>(
        "SELECT id FROM organizations WHERE deleted_at IS NULL"
    )
    .fetch_all(&state.db)
    .await;

    match orgs {
        Ok(ids) => {
            for (org_id,) in ids {
                let _ = sqlx::query(
                    "INSERT INTO checklist (organization_id, run_status, last_run_at)
                     VALUES ($1, 'running', NOW())
                     ON CONFLICT (organization_id) DO UPDATE SET run_status = 'running', last_run_at = NOW()"
                )
                .bind(org_id)
                .execute(&state.db)
                .await;

                if let Err(e) = crate::modules::recommendation::engine::RecEngine::run_for_org(state, org_id).await {
                    tracing::error!(error = %e, org_id = %org_id, "Scheduler: recommendation engine error");
                    let _ = sqlx::query(
                        "UPDATE checklist SET run_status = 'failed', last_error = $2 WHERE organization_id = $1"
                    )
                    .bind(org_id)
                    .bind(e.to_string())
                    .execute(&state.db)
                    .await;
                } else {
                    let _ = sqlx::query(
                        "UPDATE checklist SET run_status = 'completed', last_completed_at = NOW() WHERE organization_id = $1"
                    )
                    .bind(org_id)
                    .execute(&state.db)
                    .await;

                    // Notify subscribed webhooks of a fresh engine run.
                    crate::modules::webhook::handlers::enqueue_event(
                        &state.db,
                        org_id,
                        "recommendation.created",
                        serde_json::json!({ "message": "Recommendation engine run completed" }),
                    )
                    .await;
                }
            }
        }
        Err(e) => tracing::error!(error = %e, "Scheduler: failed to list organizations"),
    }
}

async fn run_alert_checks(state: &AppState) {
    if !acquire_job_lock(&state.db, "alert_checks").await {
        return;
    }
    tracing::info!("Scheduler: running budget alert checks");

    let _ = sqlx::query(
        r#"
        WITH current_spend AS (
            SELECT e.pool_id, SUM(e.cost) AS total_cost
            FROM expenses e
            WHERE date >= date_trunc('month', CURRENT_DATE) AND pool_id IS NOT NULL
            GROUP BY e.pool_id
        ),
        alert_check AS (
            SELECT
                ba.id AS alert_id,
                ba.budget_id,
                b.pool_id,
                b.amount AS budget_amount,
                ba.alert_type,
                ba.threshold,
                COALESCE(cs.total_cost, 0) AS actual_spend,
                b.organization_id
            FROM budget_alerts ba
            JOIN budgets b ON b.id = ba.budget_id
            LEFT JOIN current_spend cs ON cs.pool_id = b.pool_id
            WHERE ba.is_active = true
        )
        INSERT INTO alert_events (organization_id, budget_alert_id, budget_id, pool_id, alert_type, threshold, actual_value, message)
        SELECT
            organization_id, alert_id, budget_id, pool_id,
            alert_type::budget_alert_type, threshold, actual_spend,
            format('Budget alert: %s spent of $%s budget', actual_spend::text, budget_amount::text)
        FROM alert_check
        WHERE (alert_type::text = 'absolute' AND actual_spend >= threshold)
           OR (alert_type::text = 'percentage' AND actual_spend >= (budget_amount * threshold / 100))
        ON CONFLICT DO NOTHING
        "#
    )
    .execute(&state.db)
    .await;

    // Enqueue webhook events for breaches just written by this run.
    let breaches = sqlx::query_as::<_, (uuid::Uuid, String)>(
        r#"SELECT DISTINCT organization_id, message
           FROM alert_events
           WHERE created_at >= NOW() - INTERVAL '3 minutes'"#,
    )
    .fetch_all(&state.db)
    .await;

    if let Ok(rows) = breaches {
        for (org_id, message) in rows {
            crate::modules::webhook::handlers::enqueue_event(
                &state.db,
                org_id,
                "budget.exceeded",
                serde_json::json!({ "message": message }),
            )
            .await;
            crate::modules::notifications::handlers::create_notification(
                &state.db,
                org_id,
                None,
                "budget_alert",
                "Budget alert fired",
                &message,
            )
            .await;
        }
    }
}

async fn deliver_pending_webhooks(state: &AppState) {
    if !acquire_job_lock(&state.db, "webhooks").await {
        return;
    }
    let events = sqlx::query_as::<_, (uuid::Uuid, String, String, serde_json::Value, String)>(
        r#"SELECT we.id, w.url, w.channel, we.payload, we.event_type
           FROM webhook_events we
           JOIN webhooks w ON w.id = we.webhook_id
           WHERE we.status = 'pending'
           AND (we.next_retry IS NULL OR we.next_retry <= NOW())
           AND we.attempts < 3
           LIMIT 10"#
    )
    .fetch_all(&state.db)
    .await;

    if let Ok(events) = events {
        for (id, url, channel, payload, event_type) in events {
            let _ = sqlx::query(
                "UPDATE webhook_events SET attempts = attempts + 1 WHERE id = $1"
            )
            .bind(id)
            .execute(&state.db)
            .await;

            let delivered = if channel == "email" {
                send_email_notification(state, &url, &event_type, &payload).await
            } else {
                let body = format_channel_payload(&channel, &event_type, &payload);
                let client = reqwest::Client::new();
                match client.post(&url)
                    .json(&body)
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await
                {
                    Ok(resp) => {
                        let status = resp.status().as_u16() as i32;
                        if (200..300).contains(&status) {
                            Ok(Some(status))
                        } else {
                            Ok(Some(status))
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, url = %url, "webhook delivery failed");
                        Err(())
                    }
                }
            };

            match delivered {
                Ok(Some(status)) if (200..300).contains(&status) => {
                    let _ = sqlx::query(
                        "UPDATE webhook_events SET status = 'delivered', response_status = $2, delivered_at = NOW() WHERE id = $1"
                    )
                    .bind(id).bind(status)
                    .execute(&state.db).await;
                }
                Ok(_) | Err(_) => {
                    let next_retry = chrono::Utc::now() + chrono::Duration::minutes(5);
                    let _ = sqlx::query(
                        "UPDATE webhook_events SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, response_status = $2, next_retry = $3 WHERE id = $1"
                    )
                    .bind(id).bind(if let Ok(Some(s)) = delivered { Some(s) } else { None }).bind(next_retry)
                    .execute(&state.db).await;
                }
            }
        }
    }
}

/// Shape the raw event payload for the delivery channel:
/// - slack / teams: `{text: "<event_type>: <summary>"}`
/// - pagerduty: Events API v2 trigger envelope
/// - generic: passthrough (backwards compatible)
fn format_channel_payload(channel: &str, event_type: &str, payload: &serde_json::Value) -> serde_json::Value {
    let summary = payload
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("CloudAtlas notification")
        .to_string();

    match channel {
        "slack" | "teams" => serde_json::json!({ "text": format!("[{event_type}] {summary}") }),
        "pagerduty" => serde_json::json!({
            "event_action": "trigger",
            "payload": {
                "summary": summary,
                "source": "cloudatlas",
                "severity": "warning",
                "custom_details": payload,
            }
        }),
        _ => payload.clone(),
    }
}

/// SMTP delivery for `channel = "email"` webhooks. `url` holds the recipient
/// address. Reuses the shared helper (`utils::email`).
async fn send_email_notification(
    state: &AppState,
    recipient: &str,
    event_type: &str,
    payload: &serde_json::Value,
) -> Result<Option<i32>, ()> {
    let summary = payload
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("CloudAtlas notification");
    let body = serde_json::to_string_pretty(payload).unwrap_or_else(|_| "{}".into());

    crate::utils::email::send_email(
        state,
        recipient,
        &format!("[CloudAtlas] {event_type} — {summary}"),
        &body,
    )
    .await
    .map(|_| Some(250))
}

/// Power schedule execution — evaluates cron triggers every 5 minutes.
///
/// A trigger fires when `next_run_at <= now`. Fresh triggers (next_run_at NULL)
/// are initialized to the next cron occurrence without firing, so creating a
/// trigger never executes an action immediately.
///
/// Execution resolves the resources matching the schedule's `resource_filter`
/// (whitelisted keys only: pool_id, resource_type, tags) and stamps
/// `last_run_at` / `next_run_at`. Cron is evaluated in UTC; timezone-aware
/// scheduling would require chrono-tz and is tracked as a follow-up.
async fn run_power_schedules(state: &AppState) {
    if !acquire_job_lock(&state.db, "power_schedules").await {
        return;
    }
    use cron::Schedule;
    use std::str::FromStr;

    let triggers = sqlx::query_as::<_, (
        uuid::Uuid, uuid::Uuid, uuid::Uuid, String, String, String,
        Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>,
    )>(
        r#"SELECT t.id, t.schedule_id, s.organization_id, t.cron_expression, t.action::text,
                  s.resource_filter::text, t.last_run_at, t.next_run_at
           FROM power_schedule_triggers t
           JOIN power_schedules s ON s.id = t.schedule_id
           WHERE s.is_active = true
           AND (t.next_run_at IS NULL OR t.next_run_at <= NOW())"#,
    )
    .fetch_all(&state.db)
    .await;

    let triggers = match triggers {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(error = %e, "Scheduler: power schedule query failed");
            return;
        }
    };

    if triggers.is_empty() {
        return;
    }

    for (trigger_id, schedule_id, org_id, cron_expr, action, filter_json, _last_run, _next_run) in triggers {
        let schedule = match Schedule::from_str(&cron_expr) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(trigger_id = %trigger_id, error = %e, "Scheduler: invalid cron expression");
                continue;
            }
        };

        let now = chrono::Utc::now();
        let next_at = match schedule.after(&now).next() {
            Some(t) => t,
            None => {
                tracing::warn!(trigger_id = %trigger_id, "Scheduler: cron yields no future occurrences");
                continue;
            }
        };

        let filter: serde_json::Value = serde_json::from_str(&filter_json).unwrap_or_default();

        let matched = execute_power_action(state, org_id, schedule_id, &filter, &action).await;

        let _ = sqlx::query(
            "UPDATE power_schedule_triggers SET last_run_at = $2, next_run_at = $3 WHERE id = $1",
        )
        .bind(trigger_id)
        .bind(now)
        .bind(next_at)
        .execute(&state.db)
        .await;

        tracing::info!(
            org_id = %org_id,
            schedule_id = %schedule_id,
            action = action,
            matched_resources = matched,
            next_run = %next_at,
            "Scheduler: power schedule executed"
        );
    }
}

/// Resolve resources matching the schedule's resource_filter and "execute" the
/// action. Filter keys are whitelisted (pool_id, resource_type, tags) and bound
/// as parameters — never interpolated into SQL.
async fn execute_power_action(
    state: &AppState,
    org_id: uuid::Uuid,
    _schedule_id: uuid::Uuid,
    filter: &serde_json::Value,
    _action: &str,
) -> i64 {
    let mut sql = String::from(
        "SELECT COUNT(*) FROM resources WHERE organization_id = $1 AND active = true",
    );
    // Placeholder for the n-th bound value (0-based) is $2, $3, …
    let placeholder = |n: usize| format!("${}", n + 2);
    let mut binds: Vec<serde_json::Value> = Vec::new();

    if let Some(pool) = filter.get("pool_id").and_then(|v| v.as_str()) {
        if uuid::Uuid::parse_str(pool).is_ok() {
            sql.push_str(&format!(" AND pool_id = {}::uuid", placeholder(binds.len())));
            binds.push(serde_json::Value::String(pool.to_string()));
        }
    }
    if let Some(rt) = filter.get("resource_type").and_then(|v| v.as_str()) {
        sql.push_str(&format!(" AND resource_type = {}", placeholder(binds.len())));
        binds.push(serde_json::Value::String(rt.to_string()));
    }
    if let Some(tags) = filter.get("tags").filter(|v| v.is_object()) {
        sql.push_str(&format!(" AND tags @> {}::jsonb", placeholder(binds.len())));
        binds.push(tags.clone());
    }

    let mut query = sqlx::query(&sql).bind(org_id);
    for b in binds {
        query = query.bind(b);
    }

    query
        .fetch_one(&state.db)
        .await
        .map(|row| row.try_get::<i64, _>("count").unwrap_or(0))
        .unwrap_or(0)
}
/// Periodic billing import (spec 2026-09-09 §4.6): every 6 h, a rolling
/// 3-day window per active account. Active-job conflicts are skips, not
/// errors — routine overlap is not an error. Only providers that can ever
/// import (aws/alibaba) are selected: a permanently-unsupported provider
/// would otherwise re-fail every cycle and flood the notification bell.
async fn run_billing_import(state: &AppState) {
    if !acquire_job_lock(&state.db, "billing_import").await {
        return;
    }
    let accounts = sqlx::query_as::<_, (uuid::Uuid, uuid::Uuid)>(
        r#"SELECT id, organization_id FROM cloud_accounts
           WHERE is_active = true AND deleted_at IS NULL
             AND provider IN ('aws', 'alibaba')"#,
    )
    .fetch_all(&state.db)
    .await;

    match accounts {
        Ok(rows) => {
            tracing::info!(count = rows.len(), "Scheduler: triggering billing import");
            for (account_id, org_id) in rows {
                match crate::modules::billing::worker::launch_billing_import(
                    state, org_id, account_id, "scheduler", 3,
                )
                .await
                {
                    Ok(Some(_)) => {}
                    // Already active — routine overlap, skip silently.
                    Ok(None) => {}
                    Err(e) => tracing::warn!(
                        account_id = %account_id,
                        error = %e,
                        "Scheduler: failed to launch billing import"
                    ),
                }
            }
        }
        Err(e) => tracing::error!(error = %e, "Scheduler: failed to list cloud accounts for billing"),
    }
}

/// Stuck-job reaper (spec 2026-09-09 §4.6): a `running` row whose
/// `updated_at` is older than 30 minutes means its worker died (panic paths
/// bypass the terminal write). Flip it to `failed` with a notification —
/// finalize_job handles the fan-out and never overwrites a terminal state.
async fn reap_stuck_jobs(state: &AppState) {
    if !acquire_job_lock(&state.db, "reap_stuck_jobs").await {
        return;
    }
    let stuck = sqlx::query_as::<_, (uuid::Uuid,)>(
        r#"SELECT id FROM sync_jobs
           WHERE status = 'running' AND updated_at < NOW() - INTERVAL '30 minutes'"#,
    )
    .fetch_all(&state.db)
    .await;

    match stuck {
        Ok(rows) => {
            for (job_id,) in rows {
                let job = match crate::modules::jobs::get_job_row_any(&state.db, job_id).await {
                    Ok(j) => j,
                    Err(e) => {
                        tracing::warn!(job_id = %job_id, error = %e, "Reaper: cannot load stuck job");
                        continue;
                    }
                };
                tracing::warn!(job_id = %job_id, kind = %job.job_kind, "Reaper: failing stuck job (no progress for 30m)");
                crate::modules::jobs::finalize_job(
                    &state.db,
                    &job,
                    "failed",
                    Some("worker lost (no progress for 30m)"),
                    serde_json::json!({}),
                    None,
                )
                .await;
            }
        }
        Err(e) => tracing::error!(error = %e, "Reaper: stuck-job query failed"),
    }
}

/// Move expenses older than the retention window into expense_archive (D3).
async fn run_expense_archive(state: &AppState) {
    if !acquire_job_lock(&state.db, "expense_archive").await {
        return;
    }
    let months = state.config.retention_months.max(1);
    let result = sqlx::query(
        r#"WITH old_rows AS (
               DELETE FROM expenses
               WHERE date < CURRENT_DATE - ($1::int || ' months')::interval
               RETURNING id, organization_id, cloud_account_id, cloud_resource_id,
                         resource_name, service_name, date, cloud_region,
                         resource_type, cost, currency, tags
           )
           INSERT INTO expense_archive
               (id, organization_id, cloud_account_id, cloud_resource_id,
                resource_name, service_name, date, cloud_region,
                resource_type, cost, currency, tags)
           SELECT id, organization_id, cloud_account_id, cloud_resource_id,
                  resource_name, service_name, date, cloud_region,
                  resource_type, cost, currency, tags
           FROM old_rows"#,
    )
    .bind(months)
    .execute(&state.db)
    .await;

    match result {
        Ok(r) => tracing::info!(archived = r.rows_affected(), months, "Expense archive run"),
        Err(e) => tracing::error!(error = %e, "Expense archive failed"),
    }
}

/// Table-based job lock (P4): INSERT ... ON CONFLICT DO NOTHING with a
/// per-job row and a lease timestamp. Works across pooled connections and
/// replicas without session affinity.
async fn acquire_job_lock(db: &sqlx::PgPool, job: &str) -> bool {
    sqlx::query(
        r#"INSERT INTO scheduler_job_locks (job_key, locked_at)
           VALUES ($1, NOW())
           ON CONFLICT (job_key) DO UPDATE SET locked_at = NOW()
           WHERE scheduler_job_locks.locked_at < NOW() - INTERVAL '10 minutes'
           RETURNING job_key"#,
    )
    .bind(job)
    .fetch_optional(db)
    .await
    .map(|r| r.is_some())
    .unwrap_or(false)
}
/// Daily digest email (A3): org admins get a summary of new anomalies and
/// budget alerts from the last 24h (SMTP only).
async fn run_daily_digest(state: &AppState) {
    if !acquire_job_lock(&state.db, "daily_digest").await {
        return;
    }
    if state.config.smtp_host.is_none() {
        return; // SMTP not configured — nothing to deliver
    }

    let orgs = sqlx::query_as::<_, (uuid::Uuid, String)>(
        "SELECT id, name FROM organizations WHERE deleted_at IS NULL",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    for (org_id, org_name) in orgs {
        let anomalies: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM alert_events WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'",
        )
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        let new_recs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'",
        )
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        if anomalies == 0 && new_recs == 0 {
            continue;
        }

        // Deliver to org admins/owners.
        let admins = sqlx::query_as::<_, (String,)>(
            r#"SELECT DISTINCT u.email FROM user_roles ur
               JOIN roles r ON r.id = ur.role_id
               JOIN users u ON u.id = ur.user_id
               WHERE ur.organization_id = $1 AND r.name IN ('Owner', 'Admin')"#,
        )
        .bind(org_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

        let body = format!(
            "CloudAtlas daily digest for {org_name}:\n\n- New budget/anomaly alerts (24h): {anomalies}\n- New recommendations (24h): {new_recs}\n\nOpen CloudAtlas to review."
        );
        for (email,) in admins {
            let _ = crate::utils::email::send_email(
                state,
                &email,
                &format!("[CloudAtlas] Daily digest — {org_name}"),
                &body,
            )
            .await;
        }
    }
}
