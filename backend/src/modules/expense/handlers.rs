use axum::{
    body::Body,
    extract::{Extension, Path, Query, State},
    http::{header, Response, StatusCode},
    Json,
};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use super::{
    dto::{
        AnomalyQuery, ExpenseQuery, ExpenseSummaryResponse, ForecastQuery, RegionCost, ServiceCost,
        TopResourceEntry, TrendPoint,
    },
    models::Expense,
};

// ─── Shared ───────────────────────────────────────────────────────────────────

const EXPENSE_SELECT: &str = r#"
    SELECT
        id, organization_id, cloud_account_id,
        cloud_resource_id,
        resource_name,
        resource_type::text AS resource_type,
        cloud_region, service_name,
        date,
        cost::float8 AS cost,
        currency,
        pool_id, owner_id, tags,
        created_at, updated_at
    FROM expenses
"#;

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    let row = sqlx::query(
        "SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    if row.is_none() {
        return Err(AppError::Forbidden(
            "You are not a member of this organization".into(),
        ));
    }
    Ok(())
}

/// Parse an ISO date string (YYYY-MM-DD) to NaiveDate, returning a Validation error on failure.
fn parse_date(s: &str, field: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| AppError::Validation(format!("{field} must be YYYY-MM-DD")))
}

/// Returns (start_date, end_date) — defaults to the last 30 days.
fn resolve_date_range(start: Option<&str>, end: Option<&str>) -> AppResult<(NaiveDate, NaiveDate)> {
    let end_date = match end {
        Some(s) => parse_date(s, "end_date")?,
        None => Utc::now().date_naive(),
    };
    let start_date = match start {
        Some(s) => parse_date(s, "start_date")?,
        None => end_date - Duration::days(30),
    };
    Ok((start_date, end_date))
}

// ─── list_expenses ────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/expenses",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
    ),
    responses(
        (status = 200, description = "Paginated expense list"),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "expenses"
)]
pub async fn list_expenses(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    // Build a dynamic WHERE clause.
    let mut conditions = vec![
        "organization_id = $1".to_string(),
        "date >= $2".to_string(),
        "date <= $3".to_string(),
    ];
    let mut bind_idx = 4usize;

    if q.cloud_account_id.is_some() {
        conditions.push(format!("cloud_account_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.pool_id.is_some() {
        conditions.push(format!("pool_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.resource_type.is_some() {
        conditions.push(format!("resource_type::text = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.cloud_region.is_some() {
        conditions.push(format!("cloud_region = ${bind_idx}"));
        bind_idx += 1;
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        r#"
        {EXPENSE_SELECT}
        WHERE {where_clause}
        ORDER BY date DESC, cost DESC
        LIMIT ${bind_idx} OFFSET ${}
        "#,
        bind_idx + 1
    );

    let mut query = sqlx::query_as::<_, Expense>(sqlx::AssertSqlSafe(&*sql))
        .bind(org_id)
        .bind(start_date)
        .bind(end_date);

    if let Some(v) = q.cloud_account_id {
        query = query.bind(v);
    }
    if let Some(v) = q.pool_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.resource_type {
        query = query.bind(v);
    }
    if let Some(ref v) = q.cloud_region {
        query = query.bind(v);
    }

    let expenses = query.bind(limit).bind(offset).fetch_all(&state.db).await?;

    // COUNT under the identical WHERE so meta.total matches the filtered set.
    let count_sql = format!("SELECT COUNT(*) FROM expenses WHERE {where_clause}");
    let mut count_query = sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(&*count_sql))
        .bind(org_id)
        .bind(start_date)
        .bind(end_date);
    if let Some(v) = q.cloud_account_id {
        count_query = count_query.bind(v);
    }
    if let Some(v) = q.pool_id {
        count_query = count_query.bind(v);
    }
    if let Some(ref v) = q.resource_type {
        count_query = count_query.bind(v);
    }
    if let Some(ref v) = q.cloud_region {
        count_query = count_query.bind(v);
    }
    let total: i64 = count_query.fetch_one(&state.db).await.unwrap_or(0);

    Ok(Json(json!({
        "data": expenses,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

// ─── summary ──────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/expenses/summary",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses((status = 200, description = "Cost summary", body = ExpenseSummaryResponse)),
    security(("bearer_auth" = [])),
    tag = "expenses"
)]
pub async fn summary(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;
    let period_days = (end_date - start_date).num_days() as i32;

    // Total cost + resource count.
    let totals_row = sqlx::query(
        r#"
        SELECT
            COALESCE(SUM(cost), 0)::float8 AS total_cost,
            COUNT(DISTINCT cloud_resource_id)          AS resource_count
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_one(&state.db)
    .await?;

    let total_cost: f64 = totals_row.try_get("total_cost").unwrap_or(0.0);
    let resource_count: i64 = totals_row.try_get("resource_count").unwrap_or(0);

    // Cost by service.
    let service_rows = sqlx::query(
        r#"
        SELECT
            COALESCE(service_name, 'Unknown') AS service_name,
            SUM(cost)::float8                  AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY service_name
        ORDER BY cost DESC
        LIMIT 20
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let by_service: Vec<ServiceCost> = service_rows
        .iter()
        .map(|r| {
            let cost: f64 = r.try_get("cost").unwrap_or(0.0);
            ServiceCost {
                service_name: r.try_get("service_name").unwrap_or_default(),
                cost,
                percentage: if total_cost > 0.0 {
                    cost / total_cost * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect();

    // Cost by region.
    let region_rows = sqlx::query(
        r#"
        SELECT
            COALESCE(cloud_region, 'global') AS region,
            SUM(cost)::float8                 AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY cloud_region
        ORDER BY cost DESC
        LIMIT 20
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let by_region: Vec<RegionCost> = region_rows
        .iter()
        .map(|r| {
            let cost: f64 = r.try_get("cost").unwrap_or(0.0);
            RegionCost {
                region: r.try_get("region").unwrap_or_default(),
                cost,
                percentage: if total_cost > 0.0 {
                    cost / total_cost * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect();

    Ok(Json(json!({
        "data": ExpenseSummaryResponse {
            total_cost,
            currency: "USD".into(),
            period_days,
            resource_count,
            by_service,
            by_region,
        }
    })))
}

// ─── by_cloud ─────────────────────────────────────────────────────────────────

pub async fn by_cloud(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            ca.provider::text  AS provider,
            ca.name            AS account_name,
            SUM(e.cost)::float8 AS cost
        FROM expenses e
        JOIN cloud_accounts ca ON ca.id = e.cloud_account_id
        WHERE e.organization_id = $1 AND e.date >= $2 AND e.date <= $3
        GROUP BY ca.provider, ca.name
        ORDER BY cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "provider":     r.try_get::<String, _>("provider").unwrap_or_default(),
                "account_name": r.try_get::<String, _>("account_name").unwrap_or_default(),
                "cost":         r.try_get::<f64, _>("cost").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── by_pool ──────────────────────────────────────────────────────────────────

pub async fn by_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            p.id               AS pool_id,
            p.name             AS pool_name,
            SUM(e.cost)::float8 AS cost
        FROM expenses e
        LEFT JOIN pools p ON p.id = e.pool_id
        WHERE e.organization_id = $1 AND e.date >= $2 AND e.date <= $3
        GROUP BY p.id, p.name
        ORDER BY cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "pool_id":   r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
                "pool_name": r.try_get::<Option<String>, _>("pool_name").unwrap_or(None),
                "cost":      r.try_get::<f64, _>("cost").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── by_service ───────────────────────────────────────────────────────────────

pub async fn by_service(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            COALESCE(service_name, 'Unknown') AS service_name,
            SUM(cost)::float8                  AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY service_name
        ORDER BY cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "service_name": r.try_get::<String, _>("service_name").unwrap_or_default(),
                "cost":         r.try_get::<f64, _>("cost").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── by_region ────────────────────────────────────────────────────────────────

pub async fn by_region(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            COALESCE(cloud_region, 'global') AS region,
            SUM(cost)::float8                 AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY cloud_region
        ORDER BY cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "region": r.try_get::<String, _>("region").unwrap_or_else(|_| "global".into()),
                "cost": r.try_get::<f64, _>("cost").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── trend ────────────────────────────────────────────────────────────────────

pub async fn trend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            date::text         AS date,
            SUM(cost)::float8  AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY date
        ORDER BY date ASC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<TrendPoint> = rows
        .iter()
        .map(|r| TrendPoint {
            date: r.try_get("date").unwrap_or_default(),
            cost: r.try_get("cost").unwrap_or(0.0),
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── top_resources ────────────────────────────────────────────────────────────

pub async fn top_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            e.cloud_resource_id,
            e.resource_name,
            e.resource_type::text AS resource_type,
            SUM(e.cost)::float8   AS total_cost,
            p.name                AS pool_name
        FROM expenses e
        LEFT JOIN pools p ON p.id = e.pool_id
        WHERE e.organization_id = $1 AND e.date >= $2 AND e.date <= $3
        GROUP BY e.cloud_resource_id, e.resource_name, e.resource_type, p.name
        ORDER BY total_cost DESC
        LIMIT 10
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<TopResourceEntry> = rows
        .iter()
        .map(|r| TopResourceEntry {
            cloud_resource_id: r.try_get("cloud_resource_id").unwrap_or_default(),
            resource_name: r.try_get("resource_name").ok(),
            resource_type: r.try_get("resource_type").unwrap_or_default(),
            total_cost: r.try_get("total_cost").unwrap_or(0.0),
            pool_name: r.try_get("pool_name").ok(),
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── forecast_expenses ────────────────────────────────────────────────────────

pub async fn forecast_expenses(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ForecastQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let forecast_days = q.days.unwrap_or(30).clamp(1, 90);
    let hist_start = Utc::now().date_naive() - Duration::days(90);

    let rows = sqlx::query(
        r#"SELECT date::text AS date, SUM(cost)::float8 AS daily_cost
           FROM expenses
           WHERE organization_id = $1 AND date >= $2
           GROUP BY date ORDER BY date"#,
    )
    .bind(org_id)
    .bind(hist_start)
    .fetch_all(&state.db)
    .await?;

    let history: Vec<(String, f64)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>("date").unwrap_or_default(),
                r.try_get::<f64, _>("daily_cost").unwrap_or(0.0),
            )
        })
        .collect();

    // Linear regression on the last 14 data points for trend projection
    let reg_pts: Vec<f64> = history.iter().rev().take(14).map(|(_, c)| *c).collect();
    let reg_pts: Vec<f64> = reg_pts.into_iter().rev().collect();
    let n = reg_pts.len() as f64;

    let (slope, intercept) = if n >= 2.0 {
        let sum_x: f64 = (0..reg_pts.len()).map(|i| i as f64).sum();
        let sum_y: f64 = reg_pts.iter().sum();
        let sum_xy: f64 = reg_pts.iter().enumerate().map(|(i, &c)| i as f64 * c).sum();
        let sum_xx: f64 = (0..reg_pts.len()).map(|i| (i as f64).powi(2)).sum();
        let denom = n * sum_xx - sum_x * sum_x;
        if denom.abs() < f64::EPSILON {
            (0.0, if n > 0.0 { sum_y / n } else { 0.0 })
        } else {
            let s = (n * sum_xy - sum_x * sum_y) / denom;
            (s, (sum_y - s * sum_x) / n)
        }
    } else {
        (0.0, reg_pts.first().copied().unwrap_or(0.0))
    };

    let last_x = reg_pts.len().saturating_sub(1) as f64;
    let last_date = history
        .last()
        .and_then(|(d, _)| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .unwrap_or_else(|| Utc::now().date_naive());

    let forecast: Vec<Value> = (1..=forecast_days)
        .map(|i| {
            let predicted = (intercept + slope * (last_x + i as f64)).max(0.0);
            json!({
                "date": (last_date + Duration::days(i)).to_string(),
                "predicted_cost": (predicted * 100.0).round() / 100.0,
                "lower": ((predicted * 0.85) * 100.0).round() / 100.0,
                "upper": ((predicted * 1.15) * 100.0).round() / 100.0,
            })
        })
        .collect();

    let projected_monthly: f64 = forecast
        .iter()
        .take(30)
        .map(|f| f["predicted_cost"].as_f64().unwrap_or(0.0))
        .sum();
    let trend_direction = if slope > 0.01 {
        "increasing"
    } else if slope < -0.01 {
        "decreasing"
    } else {
        "stable"
    };
    let avg_recent = if n > 0.0 {
        reg_pts.iter().sum::<f64>() / n
    } else {
        0.0
    };
    let change_percent = if avg_recent > 0.0 {
        slope / avg_recent * 100.0
    } else {
        0.0
    };

    let history_json: Vec<Value> = history
        .iter()
        .map(|(d, c)| json!({ "date": d, "cost": c }))
        .collect();

    Ok(Json(json!({
        "history": history_json,
        "forecast": forecast,
        "summary": {
            "projected_monthly": (projected_monthly * 100.0).round() / 100.0,
            "trend_direction": trend_direction,
            "change_percent": (change_percent * 100.0).round() / 100.0,
        }
    })))
}

// ─── expense_anomalies ────────────────────────────────────────────────────────

pub async fn expense_anomalies(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<AnomalyQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let recent_days = q.days.unwrap_or(7).clamp(1, 30);
    let stats_start = Utc::now().date_naive() - Duration::days(30);
    let recent_start = Utc::now().date_naive() - Duration::days(recent_days);

    let rows = sqlx::query(
        r#"WITH stats AS (
               SELECT cloud_resource_id, resource_name, resource_type::text AS resource_type,
                      AVG(cost) AS mean_cost, STDDEV(cost) AS stddev_cost
               FROM expenses
               WHERE organization_id = $1 AND date >= $2
               GROUP BY cloud_resource_id, resource_name, resource_type
               HAVING STDDEV(cost) > 0
           ),
           scored AS (
               SELECT e.date::text AS date,
                      e.cloud_resource_id,
                      e.resource_name,
                      e.cost::float8 AS cost,
                      s.resource_type,
                      s.mean_cost::float8 AS mean_cost,
                      ABS(e.cost::float8 - s.mean_cost::float8)
                        / NULLIF(s.stddev_cost::float8, 0) AS z_score,
                      ((e.cost::float8 - s.mean_cost::float8)
                        / NULLIF(s.mean_cost::float8, 0)) * 100.0 AS deviation_pct
               FROM expenses e
               JOIN stats s ON s.cloud_resource_id = e.cloud_resource_id
               WHERE e.organization_id = $1 AND e.date >= $3
           )
           SELECT * FROM scored WHERE z_score > 2.5 ORDER BY z_score DESC LIMIT 50"#,
    )
    .bind(org_id)
    .bind(stats_start)
    .bind(recent_start)
    .fetch_all(&state.db)
    .await?;

    let anomalies: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "date":              r.try_get::<String, _>("date").unwrap_or_default(),
                "cloud_resource_id": r.try_get::<String, _>("cloud_resource_id").unwrap_or_default(),
                "resource_name":     r.try_get::<Option<String>, _>("resource_name").unwrap_or(None),
                "resource_type":     r.try_get::<String, _>("resource_type").unwrap_or_default(),
                "cost":              r.try_get::<f64, _>("cost").unwrap_or(0.0),
                "mean_cost":         r.try_get::<f64, _>("mean_cost").unwrap_or(0.0),
                "z_score":           r.try_get::<f64, _>("z_score").unwrap_or(0.0),
                "deviation_pct":     r.try_get::<f64, _>("deviation_pct").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(Json(json!({ "anomalies": anomalies })))
}

// ─── export_expenses ──────────────────────────────────────────────────────────

pub async fn export_expenses(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Response<Body>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let mut conditions = vec![
        "organization_id = $1".to_string(),
        "date >= $2".to_string(),
        "date <= $3".to_string(),
    ];
    let mut bind_idx = 4usize;

    if q.cloud_account_id.is_some() {
        conditions.push(format!("cloud_account_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.pool_id.is_some() {
        conditions.push(format!("pool_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.resource_type.is_some() {
        conditions.push(format!("resource_type::text = ${bind_idx}"));
    }

    let where_clause = conditions.join(" AND ");
    let sql = format!(
        r#"{EXPENSE_SELECT} WHERE {where_clause} ORDER BY date DESC, cost DESC LIMIT 10000"#
    );

    let mut query = sqlx::query_as::<_, Expense>(sqlx::AssertSqlSafe(&*sql))
        .bind(org_id)
        .bind(start_date)
        .bind(end_date);

    if let Some(v) = q.cloud_account_id {
        query = query.bind(v);
    }
    if let Some(v) = q.pool_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.resource_type {
        query = query.bind(v);
    }

    let expenses = query.fetch_all(&state.db).await?;

    let mut csv = String::from(
        "date,cloud_resource_id,resource_name,resource_type,service_name,cloud_region,cost,currency,pool_id\n",
    );
    for e in &expenses {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{:.6},{},{}\n",
            e.date,
            e.cloud_resource_id,
            e.resource_name.as_deref().unwrap_or(""),
            e.resource_type,
            e.service_name.as_deref().unwrap_or(""),
            e.cloud_region.as_deref().unwrap_or(""),
            e.cost,
            e.currency,
            e.pool_id.map(|u| u.to_string()).unwrap_or_default(),
        ));
    }

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"expenses.csv\"",
        )
        .body(Body::from(csv))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;

    Ok(response)
}

// ─── ri_coverage ──────────────────────────────────────────────────────────────

pub async fn ri_coverage(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT
               COUNT(*) FILTER (WHERE resource_type::text = 'reserved_instance') AS ri_count,
               COUNT(*) FILTER (WHERE resource_type::text = 'savings_plan')       AS sp_count,
               COUNT(*) FILTER (WHERE resource_type::text IN ('instance','rds_instance')) AS compute_count,
               COALESCE(SUM(cost::float8) FILTER (WHERE resource_type::text IN ('instance','rds_instance')), 0) AS on_demand_cost,
               COALESCE(SUM(cost::float8) FILTER (WHERE resource_type::text IN ('reserved_instance','savings_plan')), 0) AS commitment_cost
           FROM expenses
           WHERE organization_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    let ri_count: i64 = row.try_get("ri_count").unwrap_or(0);
    let sp_count: i64 = row.try_get("sp_count").unwrap_or(0);
    let compute_count: i64 = row.try_get("compute_count").unwrap_or(0);
    let on_demand_cost: f64 = row.try_get("on_demand_cost").unwrap_or(0.0);
    let commitment_cost: f64 = row.try_get("commitment_cost").unwrap_or(0.0);

    let total = compute_count + ri_count + sp_count;
    let coverage_pct = if total > 0 {
        (ri_count + sp_count) as f64 / total as f64 * 100.0
    } else {
        0.0
    };

    Ok(Json(json!({
        "data": {
            "ri_count":          ri_count,
            "sp_count":          sp_count,
            "total_instances":   compute_count,
            "coverage_pct":      (coverage_pct * 100.0).round() / 100.0,
            "on_demand_cost":    on_demand_cost,
            "commitment_cost":   commitment_cost,
            "potential_savings": ((on_demand_cost * 0.35) * 100.0).round() / 100.0,
        }
    })))
}

/// GET /api/v1/orgs/{org_id}/showback
///
/// Showback/Chargeback allocation report.
/// Returns cost breakdown by pool (with cost-center ownership) and by cost center
/// over the last 30 days, including each bucket's share of total org spend.
/// Intended for finance teams doing internal chargeback to business units.
pub async fn showback_report(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Total org spend in the last 30 days
    let total_cost: f64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(cost), 0)::float8
           FROM expenses
           WHERE organization_id = $1
             AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);

    // ── By pool ──────────────────────────────────────────────────────────────
    let pool_rows = sqlx::query(
        r#"SELECT
               p.id           AS pool_id,
               p.name         AS pool_name,
               p.description  AS pool_description,
               COALESCE(SUM(e.cost), 0)::float8 AS cost,
               COUNT(DISTINCT e.cloud_resource_id) AS resource_count
           FROM pools p
           LEFT JOIN expenses e
               ON  e.pool_id = p.id
               AND e.organization_id = $1
               AND e.date >= CURRENT_DATE - INTERVAL '30 days'
           WHERE p.organization_id = $1
             AND p.deleted_at IS NULL
           GROUP BY p.id, p.name, p.description
           ORDER BY cost DESC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let by_pool: Vec<Value> = pool_rows
        .iter()
        .map(|r| {
            let cost: f64 = r.try_get("cost").unwrap_or(0.0);
            let pct = if total_cost > 0.0 { cost / total_cost * 100.0 } else { 0.0 };
            json!({
                "pool_id":           r.try_get::<Uuid, _>("pool_id").ok(),
                "pool_name":         r.try_get::<String, _>("pool_name").unwrap_or_default(),
                "pool_description":  r.try_get::<Option<String>, _>("pool_description").unwrap_or(None),
                "cost":              (cost * 100.0).round() / 100.0,
                "resource_count":    r.try_get::<i64, _>("resource_count").unwrap_or(0),
                "allocation_pct":    (pct * 10.0).round() / 10.0,
            })
        })
        .collect();

    // ── By cost center ────────────────────────────────────────────────────────
    // Cost centers own business_capabilities → services → service_cis → CIs → expenses
    let cc_rows = sqlx::query(
        r#"SELECT
               cc.id    AS cost_center_id,
               cc.name  AS cost_center_name,
               cc.code  AS cost_center_code,
               COALESCE(SUM(e.cost), 0)::float8 AS cost,
               COUNT(DISTINCT e.cloud_resource_id) AS resource_count
           FROM cost_centers cc
           LEFT JOIN business_capabilities bc ON bc.cost_center_id = cc.id
               AND bc.organization_id = $1
           LEFT JOIN services svc ON svc.name = bc.name
               AND svc.organization_id = $1
           LEFT JOIN service_cis sc ON sc.service_id = svc.id
           LEFT JOIN cis c ON c.id = sc.ci_id AND c.organization_id = $1
           LEFT JOIN expenses e
               ON  e.cloud_resource_id = c.cloud_resource_id
               AND e.organization_id = $1
               AND e.date >= CURRENT_DATE - INTERVAL '30 days'
           WHERE cc.organization_id = $1
           GROUP BY cc.id, cc.name, cc.code
           ORDER BY cost DESC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let by_cost_center: Vec<Value> = cc_rows
        .iter()
        .map(|r| {
            let cost: f64 = r.try_get("cost").unwrap_or(0.0);
            let pct = if total_cost > 0.0 {
                cost / total_cost * 100.0
            } else {
                0.0
            };
            json!({
                "cost_center_id":   r.try_get::<Uuid, _>("cost_center_id").ok(),
                "cost_center_name": r.try_get::<String, _>("cost_center_name").unwrap_or_default(),
                "cost_center_code": r.try_get::<String, _>("cost_center_code").unwrap_or_default(),
                "cost":             (cost * 100.0).round() / 100.0,
                "resource_count":   r.try_get::<i64, _>("resource_count").unwrap_or(0),
                "allocation_pct":   (pct * 10.0).round() / 10.0,
            })
        })
        .collect();

    // ── Unallocated (expenses not assigned to any pool) ───────────────────────
    let unallocated_cost: f64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(cost), 0)::float8
           FROM expenses
           WHERE organization_id = $1
             AND pool_id IS NULL
             AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);

    let unallocated_pct = if total_cost > 0.0 {
        unallocated_cost / total_cost * 100.0
    } else {
        0.0
    };

    Ok(Json(json!({
        "data": {
            "period_days":       30,
            "total_cost":        (total_cost * 100.0).round() / 100.0,
            "currency":          "USD",
            "unallocated_cost":  (unallocated_cost * 100.0).round() / 100.0,
            "unallocated_pct":   (unallocated_pct * 10.0).round() / 10.0,
            "by_pool":           by_pool,
            "by_cost_center":    by_cost_center,
        }
    })))
}

// ─── raw_expenses_by_resource ────────────────────────────────────────────────

pub async fn raw_expenses_by_resource(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, String)>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;
    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let rows = sqlx::query(
        r#"
        SELECT
            id,
            cloud_account_id,
            external_id,
            billing_period,
            cloud_resource_id,
            resource_name,
            resource_type::text AS resource_type,
            cloud_region,
            cost::float8 AS cost,
            currency,
            service_name,
            usage_type,
            operation,
            cloud_specific,
            imported_at
        FROM raw_expenses
        WHERE organization_id = $1
          AND cloud_resource_id = $2
          AND billing_period >= $3
          AND billing_period <= $4
        ORDER BY imported_at DESC, id DESC
        LIMIT $5 OFFSET $6
        "#,
    )
    .bind(org_id)
    .bind(&resource_id)
    .bind(start_date)
    .bind(end_date)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM raw_expenses
        WHERE organization_id = $1
          AND cloud_resource_id = $2
          AND billing_period >= $3
          AND billing_period <= $4
        "#,
    )
    .bind(org_id)
    .bind(&resource_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<Uuid, _>("id").ok(),
                "cloud_account_id": r.try_get::<Uuid, _>("cloud_account_id").ok(),
                "external_id": r.try_get::<Option<String>, _>("external_id").unwrap_or(None),
                "billing_period": r.try_get::<chrono::NaiveDate, _>("billing_period").ok().map(|d| d.to_string()),
                "cloud_resource_id": r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
                "resource_name": r.try_get::<Option<String>, _>("resource_name").unwrap_or(None),
                "resource_type": r.try_get::<String, _>("resource_type").unwrap_or_default(),
                "cloud_region": r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "cost": r.try_get::<f64, _>("cost").unwrap_or(0.0),
                "currency": r.try_get::<String, _>("currency").unwrap_or_else(|_| "USD".into()),
                "service_name": r.try_get::<Option<String>, _>("service_name").unwrap_or(None),
                "usage_type": r.try_get::<Option<String>, _>("usage_type").unwrap_or(None),
                "operation": r.try_get::<Option<String>, _>("operation").unwrap_or(None),
                "cloud_specific": r.try_get::<Value, _>("cloud_specific").unwrap_or(json!({})),
                "imported_at": r.try_get::<chrono::DateTime<Utc>, _>("imported_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

// ─── expense_heatmap ─────────────────────────────────────────────────────────
//
// GET /api/v1/orgs/{org_id}/expenses/heatmap
//
// Returns a cost matrix: each row is a resource_type, each column is an ISO
// week (YYYY-Www), value is total cost.  Useful for spotting which resource
// categories are driving cost spikes in which weeks.
//
// Query params:
//   start_date  YYYY-MM-DD  (default: 12 weeks ago)
//   end_date    YYYY-MM-DD  (default: today)

pub async fn expense_heatmap(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let default_start = Utc::now().date_naive() - Duration::weeks(12);
    let end_date = match q.end_date.as_deref() {
        Some(s) => parse_date(s, "end_date")?,
        None => Utc::now().date_naive(),
    };
    let start_date = match q.start_date.as_deref() {
        Some(s) => parse_date(s, "start_date")?,
        None => default_start,
    };

    // Aggregate cost per (resource_type, week).
    let rows = sqlx::query(
        r#"
        SELECT
            resource_type::text                          AS resource_type,
            TO_CHAR(DATE_TRUNC('week', date), 'IYYY-"W"IW') AS week,
            SUM(cost)::float8                            AS cost
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY resource_type, week
        ORDER BY resource_type, week
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    // Collect distinct weeks (sorted) and build a map: resource_type → week → cost.
    use std::collections::{BTreeMap, BTreeSet};
    let mut weeks: BTreeSet<String> = BTreeSet::new();
    let mut matrix: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();

    for row in &rows {
        let rt: String = row.try_get("resource_type").unwrap_or_default();
        let wk: String = row.try_get("week").unwrap_or_default();
        let cost: f64 = row.try_get("cost").unwrap_or(0.0);
        weeks.insert(wk.clone());
        matrix.entry(rt).or_default().insert(wk, cost);
    }

    let weeks_vec: Vec<String> = weeks.into_iter().collect();

    // Build row objects: { resource_type, data: [{week, cost}...], total }
    let heatmap: Vec<Value> = matrix
        .into_iter()
        .map(|(rt, week_map)| {
            let data: Vec<Value> = weeks_vec
                .iter()
                .map(|w| json!({ "week": w, "cost": week_map.get(w).copied().unwrap_or(0.0) }))
                .collect();
            let total: f64 = week_map.values().sum();
            json!({
                "resource_type": rt,
                "data": data,
                "total": (total * 100.0).round() / 100.0,
            })
        })
        .collect();

    Ok(Json(json!({
        "weeks": weeks_vec,
        "heatmap": heatmap,
    })))
}

// ─── resource_expense_history ─────────────────────────────────────────────────
//
// GET /api/v1/orgs/{org_id}/expenses/resources/{resource_id}/history
//
// Returns the full daily cost history for a single cloud resource, plus:
//   - 30-day total, 7-day total
//   - Period comparison (current 30d vs previous 30d)
//   - Pool & service assignments
//   - Tags snapshot (latest)
//
// Unlike `raw_expenses_by_resource` (which returns raw billing line items),
// this endpoint returns aggregated-by-day analytics suitable for charting.

pub async fn resource_expense_history(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, resource_id)): Path<(Uuid, String)>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    // Daily cost series
    let daily_rows = sqlx::query(
        r#"
        SELECT
            date::text         AS date,
            SUM(cost)::float8  AS cost,
            currency
        FROM expenses
        WHERE organization_id = $1 AND cloud_resource_id = $2
          AND date >= $3 AND date <= $4
        GROUP BY date, currency
        ORDER BY date ASC
        "#,
    )
    .bind(org_id)
    .bind(&resource_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let daily: Vec<Value> = daily_rows
        .iter()
        .map(|r| {
            json!({
                "date": r.try_get::<String, _>("date").unwrap_or_default(),
                "cost": r.try_get::<f64, _>("cost").unwrap_or(0.0),
                "currency": r.try_get::<String, _>("currency").unwrap_or_else(|_| "USD".into()),
            })
        })
        .collect();

    // Aggregated totals: current period vs previous period of same length
    let period_days = (end_date - start_date).num_days().max(1);
    let prev_end = start_date - Duration::days(1);
    let prev_start = prev_end - Duration::days(period_days);

    let totals_row = sqlx::query(
        r#"
        SELECT
            COALESCE(SUM(cost) FILTER (WHERE date >= $3 AND date <= $4), 0)::float8 AS current_cost,
            COALESCE(SUM(cost) FILTER (WHERE date >= $5 AND date <= $6), 0)::float8 AS prev_cost
        FROM expenses
        WHERE organization_id = $1 AND cloud_resource_id = $2
        "#,
    )
    .bind(org_id)
    .bind(&resource_id)
    .bind(start_date)
    .bind(end_date)
    .bind(prev_start)
    .bind(prev_end)
    .fetch_one(&state.db)
    .await?;

    let current_cost: f64 = totals_row.try_get("current_cost").unwrap_or(0.0);
    let prev_cost: f64 = totals_row.try_get("prev_cost").unwrap_or(0.0);
    let delta_pct = if prev_cost > 0.0 {
        (current_cost - prev_cost) / prev_cost * 100.0
    } else {
        0.0
    };

    // Pool & service membership
    let meta_row = sqlx::query(
        r#"
        SELECT DISTINCT ON (e.cloud_resource_id)
            e.resource_name,
            e.resource_type::text AS resource_type,
            e.cloud_region,
            e.service_name,
            e.tags,
            p.name AS pool_name,
            p.id   AS pool_id
        FROM expenses e
        LEFT JOIN pools p ON p.id = e.pool_id
        WHERE e.organization_id = $1 AND e.cloud_resource_id = $2
        ORDER BY e.cloud_resource_id, e.updated_at DESC
        "#,
    )
    .bind(org_id)
    .bind(&resource_id)
    .fetch_optional(&state.db)
    .await?;

    let resource_meta = meta_row.map(|r| {
        json!({
            "resource_id":   &resource_id,
            "resource_name": r.try_get::<Option<String>, _>("resource_name").unwrap_or(None),
            "resource_type": r.try_get::<String, _>("resource_type").unwrap_or_default(),
            "cloud_region":  r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
            "service_name":  r.try_get::<Option<String>, _>("service_name").unwrap_or(None),
            "tags":          r.try_get::<Value, _>("tags").unwrap_or(json!({})),
            "pool_name":     r.try_get::<Option<String>, _>("pool_name").unwrap_or(None),
            "pool_id":       r.try_get::<Option<Uuid>, _>("pool_id").unwrap_or(None),
        })
    });

    Ok(Json(json!({
        "resource": resource_meta,
        "daily": daily,
        "summary": {
            "current_cost":  (current_cost * 100.0).round() / 100.0,
            "prev_cost":     (prev_cost * 100.0).round() / 100.0,
            "delta_pct":     (delta_pct * 10.0).round() / 10.0,
            "period_days":   period_days,
        }
    })))
}

// ─── expenses_by_tag_breakdown ───────────────────────────────────────────────
//
// GET /api/v1/orgs/{org_id}/expenses/by-tag-breakdown
//
// Groups expenses by every tag key present in the period, then for each key
// groups by tag value.  Provides a two-level hierarchy for tag cost explorer.
// Query params: start_date, end_date, limit (default 50 tag keys, max 200).

pub async fn expenses_by_tag_breakdown(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;
    // Breakdown endpoint (not a paginated list): `limit` = number of tag keys.
    let key_limit = q
        .page
        .limit
        .as_deref()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 200);

    // Top tag keys by total cost in period
    let key_rows = sqlx::query(
        r#"
        SELECT
            tag_key,
            SUM(cost)::float8 AS total_cost
        FROM (
            SELECT jsonb_object_keys(tags) AS tag_key, cost
            FROM expenses
            WHERE organization_id = $1 AND date >= $2 AND date <= $3
              AND tags != '{}'::jsonb
        ) sub
        GROUP BY tag_key
        ORDER BY total_cost DESC
        LIMIT $4
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .bind(key_limit)
    .fetch_all(&state.db)
    .await?;

    // For each key, get values breakdown
    let mut result: Vec<Value> = Vec::new();
    for key_row in &key_rows {
        let tag_key: String = key_row.try_get("tag_key").unwrap_or_default();
        let key_total: f64 = key_row.try_get("total_cost").unwrap_or(0.0);

        let val_rows = sqlx::query(
            r#"
            SELECT
                COALESCE(tags ->> $4, '(unset)') AS tag_value,
                SUM(cost)::float8                 AS cost
            FROM expenses
            WHERE organization_id = $1 AND date >= $2 AND date <= $3
            GROUP BY tag_value
            ORDER BY cost DESC
            LIMIT 20
            "#,
        )
        .bind(org_id)
        .bind(start_date)
        .bind(end_date)
        .bind(&tag_key)
        .fetch_all(&state.db)
        .await?;

        let values: Vec<Value> = val_rows
            .iter()
            .map(|r| {
                let cost: f64 = r.try_get("cost").unwrap_or(0.0);
                json!({
                    "tag_value": r.try_get::<String, _>("tag_value").unwrap_or_default(),
                    "cost": (cost * 100.0).round() / 100.0,
                    "pct": if key_total > 0.0 { (cost / key_total * 1000.0).round() / 10.0 } else { 0.0 },
                })
            })
            .collect();

        result.push(json!({
            "tag_key":   tag_key,
            "total_cost": (key_total * 100.0).round() / 100.0,
            "values":    values,
        }));
    }

    Ok(Json(json!({ "data": result })))
}

// ─── cost_map ─────────────────────────────────────────────────────────────────

/// Dimension name → static SQL expression + whether it needs a cloud_accounts JOIN.
/// All values are whitelisted here; no user input is ever interpolated into SQL.
fn dim_sql_expr(dim: &str) -> Option<&'static str> {
    match dim {
        "cloud" => Some("COALESCE(ca.provider::text, 'Unknown')"),
        "service" => Some("COALESCE(e.service_name, 'Unknown')"),
        "region" => Some("COALESCE(e.cloud_region, 'global')"),
        "resource_type" => Some("e.resource_type::text"),
        "pool" => Some("COALESCE(p.name, 'Unassigned')"),
        _ => None,
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct CostMapQuery {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub primary_dim: Option<String>,
    pub secondary_dim: Option<String>,
    pub filter_dim: Option<String>,
    pub filter_val: Option<String>,
}

/// GET /api/v1/orgs/{org_id}/expenses/cost-map
///
/// Returns cost grouped by one or two dimensions for treemap visualisation.
/// Primary dimension is required; secondary is optional and produces nested children.
/// Optional filter_dim + filter_val pair narrows the dataset to a single dimension value
/// (used for drill-down). All dimension keys are validated against a whitelist.
pub async fn cost_map(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<CostMapQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let primary = q.primary_dim.as_deref().unwrap_or("service");
    let primary_expr = dim_sql_expr(primary)
        .ok_or_else(|| AppError::Validation(format!("Unknown dimension: {primary}")))?;

    let secondary_expr = q
        .secondary_dim
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            dim_sql_expr(s)
                .ok_or_else(|| AppError::Validation(format!("Unknown secondary dimension: {s}")))
        })
        .transpose()?;

    // Validate filter_dim if provided (filter_val is a bound param, not interpolated)
    let filter_expr = q
        .filter_dim
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| {
            dim_sql_expr(s)
                .ok_or_else(|| AppError::Validation(format!("Unknown filter dimension: {s}")))
        })
        .transpose()?;

    let has_filter = filter_expr.is_some() && q.filter_val.is_some();
    let has_secondary = secondary_expr.is_some();

    // Always LEFT JOIN cloud_accounts and pools so expressions are always resolvable
    let filter_clause = if has_filter {
        format!(" AND {} = $4", filter_expr.unwrap())
    } else {
        String::new()
    };

    let secondary_select = if let Some(sec) = secondary_expr {
        format!(", {sec} AS secondary_key")
    } else {
        String::new()
    };

    let secondary_group = if has_secondary { ", secondary_key" } else { "" };

    let sql = format!(
        r#"
        SELECT
            {primary_expr} AS primary_key
            {secondary_select},
            COUNT(DISTINCT e.cloud_resource_id) AS resource_count,
            SUM(e.cost)::float8                 AS cost
        FROM expenses e
        LEFT JOIN cloud_accounts ca ON ca.id = e.cloud_account_id
        LEFT JOIN pools p ON p.id = e.pool_id
        WHERE e.organization_id = $1
          AND e.date >= $2
          AND e.date <= $3
          {filter_clause}
        GROUP BY primary_key{secondary_group}
        ORDER BY cost DESC
        LIMIT 200
        "#
    );

    let mut query = sqlx::query(sqlx::AssertSqlSafe(&*sql))
        .bind(org_id)
        .bind(start_date)
        .bind(end_date);
    if has_filter {
        query = query.bind(q.filter_val.as_deref().unwrap_or(""));
    }

    let rows = query.fetch_all(&state.db).await?;

    // Compute grand total for percentage calculation
    let grand_total: f64 = rows
        .iter()
        .map(|r| r.try_get::<f64, _>("cost").unwrap_or(0.0))
        .sum();

    if !has_secondary {
        // Flat list
        let nodes: Vec<Value> = rows
            .iter()
            .map(|r| {
                let cost: f64 = r.try_get("cost").unwrap_or(0.0);
                let rc: i64 = r.try_get("resource_count").unwrap_or(0);
                json!({
                    "key":            r.try_get::<String, _>("primary_key").unwrap_or_default(),
                    "label":          r.try_get::<String, _>("primary_key").unwrap_or_default(),
                    "cost":           (cost * 100.0).round() / 100.0,
                    "pct":            if grand_total > 0.0 { (cost / grand_total * 1000.0).round() / 10.0 } else { 0.0 },
                    "resource_count": rc,
                })
            })
            .collect();

        let no_secondary: Option<String> = None;
        return Ok(Json(json!({
            "total_cost": (grand_total * 100.0).round() / 100.0,
            "nodes": nodes,
            "dims": { "primary": primary, "secondary": no_secondary },
        })));
    }

    // Two-level: group rows by primary_key, accumulate children
    let mut primary_map: std::collections::BTreeMap<String, (f64, i64, Vec<Value>)> =
        std::collections::BTreeMap::new();

    for r in &rows {
        let pk: String = r.try_get("primary_key").unwrap_or_default();
        let sk: String = r.try_get("secondary_key").unwrap_or_default();
        let cost: f64 = r.try_get("cost").unwrap_or(0.0);
        let rc: i64 = r.try_get("resource_count").unwrap_or(0);
        let entry = primary_map.entry(pk).or_insert((0.0, 0, vec![]));
        entry.0 += cost;
        entry.1 += rc;
        entry.2.push(json!({
            "key":            &sk,
            "label":          &sk,
            "cost":           (cost * 100.0).round() / 100.0,
            "pct":            if entry.0 > 0.0 { (cost / entry.0 * 1000.0).round() / 10.0 } else { 0.0 },
            "resource_count": rc,
        }));
    }

    let mut nodes: Vec<Value> = primary_map
        .into_iter()
        .map(|(pk, (cost, rc, children))| {
            json!({
                "key":            &pk,
                "label":          &pk,
                "cost":           (cost * 100.0).round() / 100.0,
                "pct":            if grand_total > 0.0 { (cost / grand_total * 1000.0).round() / 10.0 } else { 0.0 },
                "resource_count": rc,
                "children":       children,
            })
        })
        .collect();

    // Sort by descending cost
    nodes.sort_by(|a, b| {
        b["cost"]
            .as_f64()
            .unwrap_or(0.0)
            .partial_cmp(&a["cost"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(Json(json!({
        "total_cost": (grand_total * 100.0).round() / 100.0,
        "nodes": nodes,
        "dims": { "primary": primary, "secondary": q.secondary_dim },
    })))
}

// ─── unit_economics ───────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/expenses/unit-economics
///
/// Returns per-resource-type aggregates: count, total cost, avg daily cost, % of total.
pub async fn unit_economics(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;
    let period_days = (end_date - start_date).num_days().max(1) as f64;

    let rows = sqlx::query(
        r#"
        SELECT
            resource_type::text                          AS resource_type,
            COUNT(DISTINCT cloud_resource_id)            AS resource_count,
            SUM(cost)::float8                            AS total_cost,
            SUM(cost)::float8 / $4                       AS avg_daily_cost,
            SUM(cost)::float8
                / NULLIF(COUNT(DISTINCT cloud_resource_id), 0) AS avg_cost_per_resource
        FROM expenses
        WHERE organization_id = $1 AND date >= $2 AND date <= $3
        GROUP BY resource_type
        ORDER BY total_cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .bind(period_days)
    .fetch_all(&state.db)
    .await?;

    let grand_total: f64 = rows
        .iter()
        .map(|r| r.try_get::<f64, _>("total_cost").unwrap_or(0.0))
        .sum();

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let total: f64 = r.try_get("total_cost").unwrap_or(0.0);
            {
                let rtype: String = r.try_get("resource_type").unwrap_or_default();
                let rcount: i64 = r.try_get("resource_count").unwrap_or(0);
                let avg_daily: f64 = r.try_get("avg_daily_cost").unwrap_or(0.0);
                let avg_per: f64 = r.try_get("avg_cost_per_resource").unwrap_or(0.0);
                json!({
                    "resource_type":         rtype,
                    "resource_count":        rcount,
                    "total_cost":            (total * 100.0).round() / 100.0,
                    "avg_daily_cost":        (avg_daily * 100.0).round() / 100.0,
                    "avg_cost_per_resource": (avg_per * 100.0).round() / 100.0,
                    "pct_of_total":          if grand_total > 0.0 { (total / grand_total * 1000.0).round() / 10.0 } else { 0.0 },
                })
            }
        })
        .collect();

    Ok(Json(json!({
        "data":        data,
        "total_cost":  (grand_total * 100.0).round() / 100.0,
        "period_days": period_days as i64,
    })))
}

// ─── region_expenses ──────────────────────────────────────────────────────────

/// Static geographic coordinates for well-known cloud provider regions.
/// Keys match the `cloud_region` values stored in the expenses table.
/// Returns (latitude, longitude, human-readable label).
fn region_coords(region: &str) -> Option<(f64, f64, &'static str)> {
    match region {
        // AWS
        "us-east-1" => Some((37.9268, -77.0177, "N. Virginia")),
        "us-east-2" => Some((40.4173, -82.9071, "Ohio")),
        "us-west-1" => Some((37.3382, -121.8863, "N. California")),
        "us-west-2" => Some((45.5051, -122.6750, "Oregon")),
        "ca-central-1" => Some((45.5017, -73.5673, "Canada Central")),
        "eu-west-1" => Some((53.3498, -6.2603, "Ireland")),
        "eu-west-2" => Some((51.5074, -0.1278, "London")),
        "eu-west-3" => Some((48.8566, 2.3522, "Paris")),
        "eu-central-1" => Some((50.1109, 8.6821, "Frankfurt")),
        "eu-north-1" => Some((59.3293, 18.0686, "Stockholm")),
        "eu-south-1" => Some((45.4654, 9.1859, "Milan")),
        "ap-east-1" => Some((22.3193, 114.1694, "Hong Kong")),
        "ap-northeast-1" => Some((35.6762, 139.6503, "Tokyo")),
        "ap-northeast-2" => Some((37.5665, 126.9780, "Seoul")),
        "ap-northeast-3" => Some((34.6937, 135.5023, "Osaka")),
        "ap-southeast-1" => Some((1.3521, 103.8198, "Singapore")),
        "ap-southeast-2" => Some((-33.8688, 151.2093, "Sydney")),
        "ap-south-1" => Some((19.0760, 72.8777, "Mumbai")),
        "ap-south-2" => Some((17.3850, 78.4867, "Hyderabad")),
        "sa-east-1" => Some((-23.5505, -46.6333, "São Paulo")),
        "me-south-1" => Some((26.0667, 50.5577, "Bahrain")),
        "me-central-1" => Some((25.2048, 55.2708, "UAE")),
        "af-south-1" => Some((-33.9249, 18.4241, "Cape Town")),
        "us-gov-west-1" => Some((47.6062, -122.3321, "GovCloud West")),
        "us-gov-east-1" => Some((38.9072, -77.0369, "GovCloud East")),
        // Azure
        "eastus" => Some((37.3719, -79.8164, "East US")),
        "eastus2" => Some((36.6681, -78.3889, "East US 2")),
        "westus" => Some((37.7837, -122.4089, "West US")),
        "westus2" => Some((47.2330, -119.8520, "West US 2")),
        "westus3" => Some((33.4484, -112.0740, "West US 3")),
        "centralus" => Some((41.5908, -93.6208, "Central US")),
        "northeurope" => Some((53.3478, -6.2597, "North Europe")),
        "westeurope" => Some((52.3667, 4.9000, "West Europe")),
        "uksouth" => Some((50.9410, -0.7990, "UK South")),
        "ukwest" => Some((53.4270, -3.0840, "UK West")),
        "francecentral" => Some((46.3772, 2.3730, "France Central")),
        "germanywestcentral" => Some((50.1109, 8.6821, "Germany West Central")),
        "swedencentral" => Some((60.6749, 17.1422, "Sweden Central")),
        "eastasia" => Some((22.2670, 114.1880, "East Asia")),
        "southeastasia" => Some((1.2834, 103.8607, "Southeast Asia")),
        "japaneast" => Some((35.6762, 139.6503, "Japan East")),
        "japanwest" => Some((34.6939, 135.5022, "Japan West")),
        "australiaeast" => Some((-33.8688, 151.2093, "Australia East")),
        "brazilsouth" => Some((-23.5505, -46.6333, "Brazil South")),
        // GCP
        "us-central1" => Some((41.2619, -95.8608, "Iowa")),
        "us-east4" => Some((38.9072, -77.0369, "N. Virginia")),
        "us-west1" => Some((45.5946, -121.1787, "Oregon")),
        "us-west2" => Some((34.0522, -118.2437, "Los Angeles")),
        "us-west3" => Some((40.7608, -111.8910, "Salt Lake City")),
        "us-west4" => Some((36.1699, -115.1398, "Las Vegas")),
        "northamerica-northeast1" => Some((45.5017, -73.5673, "Montréal")),
        "northamerica-northeast2" => Some((43.6532, -79.3832, "Toronto")),
        "europe-west1" => Some((50.4501, 3.8181, "Belgium")),
        "europe-west2" => Some((51.5074, -0.1278, "London")),
        "europe-west3" => Some((50.1109, 8.6821, "Frankfurt")),
        "europe-west4" => Some((52.3667, 5.3833, "Netherlands")),
        "europe-west6" => Some((47.3769, 8.5417, "Zürich")),
        "europe-north1" => Some((60.5693, 27.1878, "Finland")),
        "asia-east1" => Some((24.0518, 120.5161, "Taiwan")),
        "asia-east2" => Some((22.3193, 114.1694, "Hong Kong")),
        "asia-northeast1" => Some((35.6762, 139.6503, "Tokyo")),
        "asia-northeast3" => Some((37.5665, 126.9780, "Seoul")),
        "asia-south1" => Some((19.0760, 72.8777, "Mumbai")),
        "asia-southeast1" => Some((1.3521, 103.8198, "Singapore")),
        "asia-southeast2" => Some((-6.2146, 106.8451, "Jakarta")),
        "australia-southeast1" => Some((-33.8688, 151.2093, "Sydney")),
        "southamerica-east1" => Some((-23.5505, -46.6333, "São Paulo")),
        _ => None,
    }
}

/// GET /api/v1/orgs/{org_id}/expenses/region-expenses
///
/// Returns cloud spend aggregated by region with geographic coordinates
pub async fn region_expenses(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<ExpenseQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let (start_date, end_date) =
        resolve_date_range(q.start_date.as_deref(), q.end_date.as_deref())?;

    let rows = sqlx::query(
        r#"
        SELECT
            COALESCE(e.cloud_region, 'global')   AS region,
            COALESCE(ca.provider::text, 'unknown') AS cloud_type,
            COUNT(DISTINCT e.cloud_resource_id)  AS resource_count,
            SUM(e.cost)::float8                  AS total_cost
        FROM expenses e
        LEFT JOIN cloud_accounts ca ON ca.id = e.cloud_account_id
        WHERE e.organization_id = $1
          AND e.date >= $2
          AND e.date <= $3
        GROUP BY e.cloud_region, ca.provider
        ORDER BY total_cost DESC
        "#,
    )
    .bind(org_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let grand_total: f64 = rows
        .iter()
        .map(|r| r.try_get::<f64, _>("total_cost").unwrap_or(0.0))
        .sum();

    let expenses: Vec<Value> = rows
        .iter()
        .map(|r| {
            let region: String = r.try_get("region").unwrap_or_else(|_| "global".into());
            let cloud_type: String = r.try_get("cloud_type").unwrap_or_else(|_| "unknown".into());
            let cost: f64 = r.try_get("total_cost").unwrap_or(0.0);
            let rc: i64 = r.try_get("resource_count").unwrap_or(0);
            let (lat, lon, label) = region_coords(&region)
                .unwrap_or((0.0, 0.0, "Unknown"));
            json!({
                "region":         region,
                "cloud_type":     cloud_type,
                "total_cost":     (cost * 100.0).round() / 100.0,
                "resource_count": rc,
                "pct":            if grand_total > 0.0 { (cost / grand_total * 1000.0).round() / 10.0 } else { 0.0 },
                "coordinates":    { "lat": lat, "lon": lon },
                "label":          label,
            })
        })
        .collect();

    Ok(Json(json!({
        "expenses":    expenses,
        "total_cost":  (grand_total * 100.0).round() / 100.0,
        "start_date":  start_date.to_string(),
        "end_date":    end_date.to_string(),
    })))
}
