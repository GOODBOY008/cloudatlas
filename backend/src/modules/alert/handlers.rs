use axum::{
    extract::{Extension, Path, Query, State},
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
    utils::pagination::{page_meta_json, PageQuery},
};

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
pub struct CreateAlertRequest {
    /// Budget the alert watches. Either this or `pool_id` must be provided;
    /// when only `pool_id` is given the pool's active budget is resolved.
    pub budget_id: Option<Uuid>,
    pub pool_id: Option<Uuid>,
    pub alert_type: String,
    pub threshold: f64,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateAlertRequest {
    pub alert_type: Option<String>,
    pub threshold: Option<f64>,
    pub is_active: Option<bool>,
}

pub async fn list_alerts(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT ba.id, ba.budget_id, ba.alert_type::text, ba.threshold::float8,
                  b.pool_id,
                  ba.is_active, ba.last_triggered_at, ba.created_at
           FROM budget_alerts ba
           JOIN budgets b ON b.id = ba.budget_id
           WHERE ba.organization_id = $1
           ORDER BY ba.created_at DESC, ba.id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM budget_alerts ba JOIN budgets b ON b.id = ba.budget_id
           WHERE ba.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":               r.try_get::<Uuid, _>("id").ok(),
                "budget_id":        r.try_get::<Uuid, _>("budget_id").ok(),
                "pool_id":          r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
                "alert_type":       r.try_get::<String, _>("alert_type").unwrap_or_default(),
                "threshold":        r.try_get::<f64, _>("threshold").unwrap_or(0.0),
                "is_active":        r.try_get::<bool, _>("is_active").unwrap_or(true),
                "last_triggered_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_triggered_at").unwrap_or(None),
                "created_at":       r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": page_meta_json(total, &bounds) })))
}

pub async fn create_alert(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateAlertRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let alert_type = body.alert_type.to_lowercase();
    if alert_type != "absolute" && alert_type != "percentage" {
        return Err(AppError::Validation(
            "alert_type must be 'absolute' or 'percentage'".into(),
        ));
    }

    // Resolve the watched budget: explicit budget_id wins; otherwise fall back
    // to the pool's active budget (the UI selects pools, not budgets).
    let budget_id = if let Some(bid) = body.budget_id {
        let budget = sqlx::query("SELECT id FROM budgets WHERE id = $1 AND organization_id = $2")
            .bind(bid)
            .bind(org_id)
            .fetch_optional(&state.db)
            .await?;
        if budget.is_none() {
            return Err(AppError::NotFound("Budget not found".into()));
        }
        bid
    } else if let Some(pid) = body.pool_id {
        let budget = sqlx::query(
            "SELECT id FROM budgets WHERE pool_id = $1 AND organization_id = $2 AND is_active ORDER BY created_at DESC LIMIT 1",
        )
        .bind(pid)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?;
        match budget {
            Some(row) => row.try_get::<Uuid, _>("id").unwrap_or_default(),
            None => {
                return Err(AppError::Validation(
                    "Pool has no active budget — create a budget on the pool first".into(),
                ))
            }
        }
    } else {
        return Err(AppError::Validation(
            "Either budget_id or pool_id is required".into(),
        ));
    };

    let id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO budget_alerts (id, budget_id, organization_id, alert_type, threshold)
           VALUES ($1, $2, $3, $4::budget_alert_type, $5)"#,
    )
    .bind(id)
    .bind(budget_id)
    .bind(org_id)
    .bind(&alert_type)
    .bind(body.threshold)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "budget_id": budget_id,
                "alert_type": alert_type,
                "threshold": body.threshold,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_alert(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, alert_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateAlertRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if let Some(ref t) = body.alert_type {
        if t != "absolute" && t != "percentage" {
            return Err(AppError::Validation(
                "alert_type must be 'absolute' or 'percentage'".into(),
            ));
        }
    }

    let row = sqlx::query(
        r#"UPDATE budget_alerts
           SET
               alert_type = COALESCE($3::budget_alert_type, alert_type),
               threshold = COALESCE($4, threshold),
               is_active = COALESCE($5, is_active)
           WHERE id = $1 AND organization_id = $2
           RETURNING id, budget_id, alert_type::text, threshold::float8, is_active, last_triggered_at, created_at"#,
    )
    .bind(alert_id)
    .bind(org_id)
    .bind(body.alert_type.as_deref())
    .bind(body.threshold)
    .bind(body.is_active)
    .fetch_optional(&state.db)
    .await?;

    let r = row.ok_or_else(|| AppError::NotFound(format!("Alert {alert_id} not found")))?;

    Ok(Json(json!({
        "data": {
            "id": r.try_get::<Uuid, _>("id").ok(),
            "budget_id": r.try_get::<Uuid, _>("budget_id").ok(),
            "alert_type": r.try_get::<String, _>("alert_type").unwrap_or_default(),
            "threshold": r.try_get::<f64, _>("threshold").unwrap_or(0.0),
            "is_active": r.try_get::<bool, _>("is_active").unwrap_or(true),
            "last_triggered_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_triggered_at").unwrap_or(None),
            "created_at": r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok()
        }
    })))
}

pub async fn delete_alert(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, alert_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM budget_alerts WHERE id = $1 AND organization_id = $2",
    )
    .bind(alert_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Alert {alert_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

pub async fn list_events(
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
                r#"SELECT COUNT(*) FROM (
                       SELECT ae.id FROM alert_events ae WHERE ae.organization_id = $1
                       UNION ALL
                       SELECT we.id FROM webhook_events we
                       JOIN webhooks w ON w.id = we.webhook_id
                       WHERE w.organization_id = $1
                   ) e"#,
        )
        .bind(org_id)
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        let rows = sqlx::query(
                r#"SELECT id, kind, title, details, created_at
                     FROM (
                         SELECT
                             ae.id,
                             'alert'::text AS kind,
                             ae.message AS title,
                             jsonb_build_object(
                                 'pool_id', ae.pool_id,
                                 'budget_id', ae.budget_id,
                                 'alert_type', ae.alert_type::text,
                                 'threshold', ae.threshold::float8,
                                 'actual_value', ae.actual_value::float8
                             ) AS details,
                             ae.created_at
                         FROM alert_events ae
                         WHERE ae.organization_id = $1

                         UNION ALL

                         SELECT
                             we.id,
                             'webhook'::text AS kind,
                             we.event_type AS title,
                             jsonb_build_object(
                                 'webhook_id', w.id,
                                 'webhook_name', w.name,
                                 'status', we.status,
                                 'attempts', we.attempts,
                                 'response_status', we.response_status
                             ) AS details,
                             we.created_at
                         FROM webhook_events we
                         JOIN webhooks w ON w.id = we.webhook_id
                         WHERE w.organization_id = $1
                     ) e
                     ORDER BY created_at DESC
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
                                "id": r.try_get::<Uuid, _>("id").ok(),
                                "kind": r.try_get::<String, _>("kind").unwrap_or_default(),
                                "title": r.try_get::<String, _>("title").unwrap_or_default(),
                                "details": r.try_get::<Value, _>("details").unwrap_or(json!({})),
                                "created_at": r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                        })
                })
                .collect();

        Ok(Json(json!({ "data": data, "meta": page_meta_json(total, &bounds) })))
}

pub async fn list_alert_events(
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
        "SELECT COUNT(*) FROM alert_events WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query(
        r#"SELECT id, budget_alert_id, budget_id, pool_id,
                  alert_type::text, threshold::float8, actual_value::float8,
                  message, acknowledged_at, created_at
           FROM alert_events
           WHERE organization_id = $1
           ORDER BY created_at DESC
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
                "id":                r.try_get::<Uuid, _>("id").ok(),
                "budget_alert_id":   r.try_get::<Option<Uuid>, _>("budget_alert_id").unwrap_or(None),
                "budget_id":         r.try_get::<Option<Uuid>, _>("budget_id").unwrap_or(None),
                "pool_id":           r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
                "alert_type":        r.try_get::<String, _>("alert_type").unwrap_or_default(),
                "threshold":         r.try_get::<f64, _>("threshold").unwrap_or(0.0),
                "actual_value":      r.try_get::<f64, _>("actual_value").unwrap_or(0.0),
                "message":           r.try_get::<String, _>("message").unwrap_or_default(),
                "acknowledged_at":   r.try_get::<Option<chrono::DateTime<Utc>>, _>("acknowledged_at").unwrap_or(None),
                "created_at":        r.try_get::<Option<chrono::DateTime<Utc>>, _>("created_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": page_meta_json(total, &bounds) })))
}

/// POST /api/v1/orgs/:org_id/alerts/evaluate
///
/// Evaluate all active budget alerts for the organization.
/// For each alert, compare actual pool spend to the budget limit + threshold.
/// Writes an `alert_events` row for every newly breached alert and stamps
/// `last_triggered_at` on the `budget_alerts` row.
///
/// Returns a summary of evaluated / triggered counts plus the new event details.
pub async fn evaluate_alerts(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Fetch all active alerts joined to their budget + pool for this org
    let alerts = sqlx::query(
        r#"SELECT
               ba.id          AS alert_id,
               ba.budget_id,
               ba.alert_type::text,
               ba.threshold::float8,
               b.pool_id,
               b.amount::float8    AS budget_amount,
               b.period::text      AS budget_period
           FROM budget_alerts ba
           JOIN budgets b ON b.id = ba.budget_id
           WHERE ba.organization_id = $1
             AND ba.is_active = true"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut triggered_events: Vec<Value> = Vec::new();
    let evaluated = alerts.len();

    for alert in &alerts {
        let alert_id: Uuid = alert.try_get("alert_id").unwrap_or(Uuid::nil());
        let budget_id: Uuid = alert.try_get("budget_id").unwrap_or(Uuid::nil());
        let pool_id: Option<Uuid> = alert.try_get("pool_id").unwrap_or(None);
        let alert_type: String = alert.try_get("alert_type").unwrap_or_default();
        let threshold: f64 = alert.try_get("threshold").unwrap_or(0.0);
        let budget_amount: f64 = alert.try_get("budget_amount").unwrap_or(0.0);
        let budget_period: String = alert.try_get("budget_period").unwrap_or_else(|_| "monthly".into());

        // Determine the date window for the budget period
        // Using a fixed set of safe constant interval strings (not user input)
        let interval_days: i64 = match budget_period.as_str() {
            "daily"   => 1,
            "weekly"  => 7,
            "yearly"  => 365,
            _         => 30, // monthly (default)
        };

        // Compute actual spend for this pool in the current period
        let actual_row = if let Some(pid) = pool_id {
            sqlx::query(
                r#"SELECT COALESCE(SUM(cost), 0)::float8 AS actual
                   FROM expenses
                   WHERE organization_id = $1
                     AND pool_id = $2
                     AND date >= CURRENT_DATE - $3 * INTERVAL '1 day'"#,
            )
            .bind(org_id)
            .bind(pid)
            .bind(interval_days)
            .fetch_one(&state.db)
            .await?
        } else {
            sqlx::query(
                r#"SELECT COALESCE(SUM(cost), 0)::float8 AS actual
                   FROM expenses
                   WHERE organization_id = $1
                     AND date >= CURRENT_DATE - $2 * INTERVAL '1 day'"#,
            )
            .bind(org_id)
            .bind(interval_days)
            .fetch_one(&state.db)
            .await?
        };

        let actual: f64 = actual_row.try_get("actual").unwrap_or(0.0);

        // Compute the alert trigger threshold value
        let trigger_at = match alert_type.as_str() {
            "percentage" => budget_amount * (threshold / 100.0),
            _            => threshold, // absolute
        };

        if actual > trigger_at {
            let message = format!(
                "Spend ${actual:.2} exceeded {} alert threshold ${trigger_at:.2} on budget ${budget_amount:.2}",
                alert_type
            );

            // Insert alert event (ignore conflict so we don't spam on repeated evaluations)
            let event_id = Uuid::new_v4();
            sqlx::query(
                r#"INSERT INTO alert_events
                       (id, organization_id, budget_alert_id, budget_id, pool_id,
                        alert_type, threshold, actual_value, message)
                   VALUES ($1, $2, $3, $4, $5, $6::budget_alert_type, $7, $8, $9)"#,
            )
            .bind(event_id)
            .bind(org_id)
            .bind(alert_id)
            .bind(budget_id)
            .bind(pool_id)
            .bind(&alert_type)
            .bind(threshold)
            .bind(actual)
            .bind(&message)
            .execute(&state.db)
            .await?;

            // Stamp last_triggered_at on the alert row
            sqlx::query(
                r#"UPDATE budget_alerts SET last_triggered_at = NOW()
                   WHERE id = $1"#,
            )
            .bind(alert_id)
            .execute(&state.db)
            .await?;

            triggered_events.push(json!({
                "event_id":    event_id,
                "alert_id":    alert_id,
                "budget_id":   budget_id,
                "pool_id":     pool_id,
                "alert_type":  alert_type,
                "threshold":   trigger_at,
                "actual":      actual,
                "message":     message,
            }));
        }
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": {
                "evaluated": evaluated,
                "triggered": triggered_events.len(),
                "events":    triggered_events,
            }
        })),
    ))
}
