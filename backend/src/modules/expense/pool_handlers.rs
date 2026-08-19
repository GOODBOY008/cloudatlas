use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{Datelike, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

use super::{
    dto::{CreatePoolRequest, PoolResponse, UpdatePoolRequest},
    models::Pool,
};

const POOL_SELECT: &str = r#"
    SELECT
        id, organization_id, parent_id, name, description, pool_type,
        owner_id,
        monthly_budget::float8 AS monthly_budget,
        created_at, updated_at
    FROM pools
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

// ─── list_pools ───────────────────────────────────────────────────────────────

pub async fn list_pools(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let pools = sqlx::query_as::<_, Pool>(sqlx::AssertSqlSafe(&*format!(
        "{POOL_SELECT} WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY name ASC"
    )))
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<PoolResponse> = pools.into_iter().map(Into::into).collect();
    Ok(Json(
        json!({ "data": data, "meta": { "total": data.len() } }),
    ))
}

// ─── create_pool ──────────────────────────────────────────────────────────────

pub async fn create_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreatePoolRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("Pool name cannot be empty".into()));
    }

    let now = Utc::now();
    let pool_id = Uuid::new_v4();

    let pool = sqlx::query_as::<_, Pool>(sqlx::AssertSqlSafe(&*format!(
        r#"
        INSERT INTO pools
            (id, organization_id, parent_id, name, description, pool_type, owner_id, monthly_budget, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        RETURNING {cols}
        "#,
        cols = "id, organization_id, parent_id, name, description, pool_type, owner_id,
                monthly_budget::float8 AS monthly_budget, created_at, updated_at"
    )))
    .bind(pool_id)
    .bind(org_id)
    .bind(body.parent_id)
    .bind(body.name.trim())
    .bind(body.description.as_deref())
    .bind(&body.pool_type)
    .bind(body.owner_id)
    .bind(body.monthly_budget)
    .bind(now)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict("A pool with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    let resp: PoolResponse = pool.into();
    Ok((StatusCode::CREATED, Json(json!({ "data": resp }))))
}

// ─── get_pool ─────────────────────────────────────────────────────────────────

pub async fn get_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let pool = sqlx::query_as::<_, Pool>(sqlx::AssertSqlSafe(&*format!(
        "{POOL_SELECT} WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"
    )))
    .bind(pool_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pool not found".into()))?;

    // Current month's total cost for this pool.
    let month_start = {
        let today = Utc::now().date_naive();
        NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today)
    };

    let cost_row = sqlx::query(
        "SELECT COALESCE(SUM(cost), 0)::float8 AS cost FROM expenses WHERE pool_id = $1 AND date >= $2",
    )
    .bind(pool_id)
    .bind(month_start)
    .fetch_one(&state.db)
    .await?;

    let current_month_cost: f64 = cost_row.try_get("cost").unwrap_or(0.0);

    let resp: PoolResponse = pool.into();
    Ok(Json(json!({
        "data": {
            "pool": resp,
            "current_month_cost": current_month_cost
        }
    })))
}

// ─── update_pool ──────────────────────────────────────────────────────────────

pub async fn update_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdatePoolRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let now = Utc::now();

    let pool = sqlx::query_as::<_, Pool>(sqlx::AssertSqlSafe(&*format!(
        r#"
        UPDATE pools
        SET
            name           = COALESCE($3, name),
            description    = COALESCE($4, description),
            owner_id       = COALESCE($5, owner_id),
            monthly_budget = COALESCE($6, monthly_budget),
            updated_at     = $7
        WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        RETURNING {cols}
        "#,
        cols = "id, organization_id, parent_id, name, description, pool_type, owner_id,
                monthly_budget::float8 AS monthly_budget, created_at, updated_at"
    )))
    .bind(pool_id)
    .bind(org_id)
    .bind(body.name.as_deref())
    .bind(body.description.as_deref())
    .bind(body.owner_id)
    .bind(body.monthly_budget)
    .bind(now)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pool not found".into()))?;

    let resp: PoolResponse = pool.into();
    Ok(Json(json!({ "data": resp })))
}

// ─── delete_pool ──────────────────────────────────────────────────────────────

pub async fn delete_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "UPDATE pools SET deleted_at = $1 WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL",
    )
    .bind(Utc::now())
    .bind(pool_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Pool not found".into()));
    }

    Ok((
        StatusCode::OK,
        Json(json!({ "data": { "message": "Pool deleted" } })),
    ))
}

// ─── Local import for NaiveDate helpers ───────────────────────────────────────

use chrono::NaiveDate;

// ─── get_pool_tree ────────────────────────────────────────────────────────────

pub async fn get_pool_tree(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let rows = sqlx::query(
        r#"WITH RECURSIVE pool_tree AS (
               SELECT id, name, description, parent_id, monthly_budget::float8 AS monthly_budget, 0 AS depth
               FROM pools
               WHERE organization_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
               UNION ALL
               SELECT p.id, p.name, p.description, p.parent_id,
                      p.monthly_budget::float8 AS monthly_budget, pt.depth + 1
               FROM pools p
               JOIN pool_tree pt ON p.parent_id = pt.id
               WHERE p.deleted_at IS NULL AND pt.depth < 10
           )
           SELECT pt.id, pt.name, pt.description, pt.parent_id, pt.monthly_budget, pt.depth,
                  COALESCE((
                      SELECT SUM(e.cost)::float8 FROM expenses e
                      WHERE e.pool_id = pt.id
                        AND e.date >= DATE_TRUNC('month', CURRENT_DATE)::date
                  ), 0) AS current_month_spend
           FROM pool_tree pt
           ORDER BY depth, name"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let monthly_budget: Option<f64> = r.try_get("monthly_budget").ok().flatten();
            let current_month_spend: f64 = r.try_get("current_month_spend").unwrap_or(0.0);
            let budget_used_pct = monthly_budget
                .filter(|&b| b > 0.0)
                .map(|b| (current_month_spend / b * 100.0).min(100.0));
            json!({
                "id":                 r.try_get::<Uuid, _>("id").ok(),
                "name":               r.try_get::<String, _>("name").unwrap_or_default(),
                "description":        r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "parent_id":          r.try_get::<Option<Uuid>, _>("parent_id").unwrap_or(None),
                "monthly_budget":     monthly_budget,
                "depth":              r.try_get::<i32, _>("depth").unwrap_or(0),
                "current_month_spend": current_month_spend,
                "budget_used_pct":    budget_used_pct,
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}

// ─── pool_expense_trend ───────────────────────────────────────────────────────
//
// GET /api/v1/orgs/{org_id}/pools/{id}/trend
//
// Returns the daily cost time-series for a specific pool, plus a forecast of
// the next 30 days using linear regression on the last 14 actual data points.
// Response also includes the current month's spend vs budget (% utilisation).
//
// Query params: start_date, end_date  (default: last 90 days)

pub async fn pool_expense_trend(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<super::dto::ExpenseQuery>,
) -> AppResult<Json<Value>> {
    use chrono::Duration;

    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Guard: pool must belong to org
    let pool_row = sqlx::query(
        "SELECT id, name, monthly_budget::float8 AS monthly_budget FROM pools WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
    )
    .bind(pool_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pool not found".into()))?;

    let pool_name: String = pool_row.try_get("name").unwrap_or_default();
    let monthly_budget: Option<f64> = pool_row.try_get("monthly_budget").ok().flatten();

    let end_date = match q.end_date.as_deref() {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("end_date must be YYYY-MM-DD".into()))?,
        None => Utc::now().date_naive(),
    };
    let start_date = match q.start_date.as_deref() {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("start_date must be YYYY-MM-DD".into()))?,
        None => end_date - Duration::days(90),
    };

    // Daily series
    let rows = sqlx::query(
        r#"
        SELECT date::text AS date, SUM(cost)::float8 AS cost
        FROM expenses
        WHERE organization_id = $1 AND pool_id = $2 AND date >= $3 AND date <= $4
        GROUP BY date ORDER BY date ASC
        "#,
    )
    .bind(org_id)
    .bind(pool_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let history: Vec<(String, f64)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>("date").unwrap_or_default(),
                r.try_get::<f64, _>("cost").unwrap_or(0.0),
            )
        })
        .collect();

    // 14-point linear regression for 30-day forecast
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

    let forecast: Vec<serde_json::Value> = (1i64..=30)
        .map(|i| {
            let predicted = (intercept + slope * (last_x + i as f64)).max(0.0);
            serde_json::json!({
                "date": (last_date + Duration::days(i)).to_string(),
                "predicted_cost": (predicted * 100.0).round() / 100.0,
            })
        })
        .collect();

    // Current month spend
    let month_start = {
        let today = Utc::now().date_naive();
        NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today)
    };
    let month_spend: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND pool_id = $2 AND date >= $3",
    )
    .bind(org_id)
    .bind(pool_id)
    .bind(month_start)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0.0);

    let projected_month: f64 = forecast
        .iter()
        .map(|f| f["predicted_cost"].as_f64().unwrap_or(0.0))
        .sum();

    let budget_used_pct = monthly_budget
        .filter(|&b| b > 0.0)
        .map(|b| (month_spend / b * 100.0).min(100.0));

    Ok(serde_json::json!({
        "pool": { "id": pool_id, "name": pool_name, "monthly_budget": monthly_budget },
        "history": history.iter().map(|(d, c)| serde_json::json!({ "date": d, "cost": c })).collect::<Vec<_>>(),
        "forecast": forecast,
        "summary": {
            "month_spend":      (month_spend * 100.0).round() / 100.0,
            "projected_month":  (projected_month * 100.0).round() / 100.0,
            "budget_used_pct":  budget_used_pct,
            "trend":            if slope > 0.01 { "increasing" } else if slope < -0.01 { "decreasing" } else { "stable" },
        }
    })
    .into())
}

// ─── pool_top_resources ───────────────────────────────────────────────────────
//
// GET /api/v1/orgs/{org_id}/pools/{id}/top-resources
//
// Returns the top 20 resources ranked by cost within the pool over a date
// window.  Includes resource_type, region, service name, and total cost.
// Also returns a daily roll-up for the pool so the caller can render a
// sparkline without a second request.
//
// Query params: start_date, end_date  (default: last 30 days)

pub async fn pool_top_resources(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
    Query(q): Query<super::dto::ExpenseQuery>,
) -> AppResult<Json<Value>> {
    use chrono::Duration;

    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Guard: pool must belong to org
    let pool_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM pools WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL)",
    )
    .bind(pool_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);

    if !pool_exists {
        return Err(AppError::NotFound("Pool not found".into()));
    }

    let end_date = match q.end_date.as_deref() {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("end_date must be YYYY-MM-DD".into()))?,
        None => Utc::now().date_naive(),
    };
    let start_date = match q.start_date.as_deref() {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|_| AppError::Validation("start_date must be YYYY-MM-DD".into()))?,
        None => end_date - Duration::days(30),
    };

    let rows = sqlx::query(
        r#"
        SELECT
            cloud_resource_id,
            MAX(resource_name)         AS resource_name,
            resource_type::text        AS resource_type,
            MAX(cloud_region)          AS cloud_region,
            MAX(service_name)          AS service_name,
            SUM(cost)::float8          AS total_cost,
            COUNT(DISTINCT date)       AS active_days
        FROM expenses
        WHERE organization_id = $1 AND pool_id = $2 AND date >= $3 AND date <= $4
        GROUP BY cloud_resource_id, resource_type
        ORDER BY total_cost DESC
        LIMIT 20
        "#,
    )
    .bind(org_id)
    .bind(pool_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let resources: Vec<Value> = rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "cloud_resource_id": r.try_get::<String, _>("cloud_resource_id").unwrap_or_default(),
                "resource_name":     r.try_get::<Option<String>, _>("resource_name").unwrap_or(None),
                "resource_type":     r.try_get::<String, _>("resource_type").unwrap_or_default(),
                "cloud_region":      r.try_get::<Option<String>, _>("cloud_region").unwrap_or(None),
                "service_name":      r.try_get::<Option<String>, _>("service_name").unwrap_or(None),
                "total_cost":        r.try_get::<f64, _>("total_cost").unwrap_or(0.0),
                "active_days":       r.try_get::<i64, _>("active_days").unwrap_or(0),
            })
        })
        .collect();

    // Daily roll-up for sparkline
    let daily_rows = sqlx::query(
        r#"
        SELECT date::text AS date, SUM(cost)::float8 AS cost
        FROM expenses
        WHERE organization_id = $1 AND pool_id = $2 AND date >= $3 AND date <= $4
        GROUP BY date ORDER BY date ASC
        "#,
    )
    .bind(org_id)
    .bind(pool_id)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&state.db)
    .await?;

    let daily: Vec<Value> = daily_rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "date": r.try_get::<String, _>("date").unwrap_or_default(),
                "cost": r.try_get::<f64, _>("cost").unwrap_or(0.0),
            })
        })
        .collect();

    Ok(serde_json::json!({
        "pool_id": pool_id,
        "resources": resources,
        "daily": daily,
    })
    .into())
}

// ─── move_pool ────────────────────────────────────────────────────────────────
//
// PATCH /api/v1/orgs/{org_id}/pools/{id}/parent
//
// Reparents a pool to a new parent (or makes it a root by setting parent to
// null).  Guards against cycles: the new parent must not be a descendant of
// the pool being moved.

#[derive(serde::Deserialize)]
pub struct MovePoolRequest {
    /// UUID of the new parent pool; omit or null to make it a root pool.
    pub parent_id: Option<Uuid>,
}

pub async fn move_pool(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, pool_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<MovePoolRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Guard: pool must exist
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM pools WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL)",
    )
    .bind(pool_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);

    if !exists {
        return Err(AppError::NotFound("Pool not found".into()));
    }

    // Cannot reparent to itself
    if body.parent_id == Some(pool_id) {
        return Err(AppError::Validation(
            "A pool cannot be its own parent".into(),
        ));
    }

    // Cycle guard: new parent must not be a descendant of pool_id.
    if let Some(new_parent) = body.parent_id {
        // Guard: new parent must also belong to org
        let parent_in_org = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM pools WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL)",
        )
        .bind(new_parent)
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        if !parent_in_org {
            return Err(AppError::NotFound("Target parent pool not found".into()));
        }

        // Walk descendants of pool_id; if new_parent appears → cycle
        let is_descendant: bool = sqlx::query_scalar(
            r#"WITH RECURSIVE descendants AS (
                   SELECT id FROM pools WHERE parent_id = $1 AND deleted_at IS NULL
                   UNION ALL
                   SELECT p.id FROM pools p JOIN descendants d ON p.parent_id = d.id
                   WHERE p.deleted_at IS NULL
               )
               SELECT EXISTS(SELECT 1 FROM descendants WHERE id = $2)"#,
        )
        .bind(pool_id)
        .bind(new_parent)
        .fetch_one(&state.db)
        .await
        .unwrap_or(false);

        if is_descendant {
            return Err(AppError::Validation(
                "Cannot reparent: the target parent is a descendant of this pool".into(),
            ));
        }
    }

    let pool = sqlx::query_as::<_, Pool>(sqlx::AssertSqlSafe(&*format!(
        r#"UPDATE pools
           SET parent_id = $3, updated_at = NOW()
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING {cols}"#,
        cols = "id, organization_id, parent_id, name, description, pool_type, owner_id,
                monthly_budget::float8 AS monthly_budget, created_at, updated_at"
    )))
    .bind(pool_id)
    .bind(org_id)
    .bind(body.parent_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Pool not found".into()))?;

    let resp: super::dto::PoolResponse = pool.into();
    Ok(Json(serde_json::json!({ "data": resp })))
}

// ─── budget_matrix ────────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/pools/budget-matrix
///
/// Returns every pool with its monthly_budget, actual spend for the current
/// calendar month-to-date, variance, utilisation %, and a status label.
/// Pools without a budget are included with budget = null.
pub async fn budget_matrix(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Current month start (UTC)
    let today = chrono::Utc::now().date_naive();
    let month_start =
        chrono::NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today);

    let rows = sqlx::query(
        r#"
        SELECT
            p.id                               AS pool_id,
            p.name                             AS pool_name,
            p.pool_type                        AS pool_type,
            p.monthly_budget::float8           AS budget,
            COALESCE(SUM(e.cost), 0)::float8   AS actual
        FROM pools p
        LEFT JOIN expenses e
            ON e.pool_id = p.id
           AND e.organization_id = $1
           AND e.date >= $2
           AND e.date <= $3
        WHERE p.organization_id = $1
          AND p.deleted_at IS NULL
        GROUP BY p.id, p.name, p.pool_type, p.monthly_budget
        ORDER BY actual DESC
        "#,
    )
    .bind(org_id)
    .bind(month_start)
    .bind(today)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            let budget: Option<f64> = r.try_get("budget").ok();
            let actual: f64 = r.try_get("actual").unwrap_or(0.0);
            let (variance, utilization_pct, status) = match budget {
                Some(b) if b > 0.0 => {
                    let v = b - actual;
                    let pct = (actual / b * 1000.0).round() / 10.0;
                    let s = if pct >= 100.0 {
                        "over_budget"
                    } else if pct >= 80.0 {
                        "warning"
                    } else {
                        "on_track"
                    };
                    (Some((v * 100.0).round() / 100.0), Some(pct), s)
                }
                _ => (None, None, "no_budget"),
            };
            json!({
                "pool_id":         r.try_get::<Uuid, _>("pool_id").ok(),
                "pool_name":       r.try_get::<String, _>("pool_name").unwrap_or_default(),
                "pool_type":       r.try_get::<String, _>("pool_type").unwrap_or_default(),
                "budget":          budget.map(|b| (b * 100.0).round() / 100.0),
                "actual":          (actual * 100.0).round() / 100.0,
                "variance":        variance,
                "utilization_pct": utilization_pct,
                "status":          status,
            })
        })
        .collect();

    Ok(Json(json!({ "data": data })))
}
