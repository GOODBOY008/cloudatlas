use axum::{
    extract::{Extension, Path, State},
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

#[derive(Deserialize)]
pub struct CreateConstraintRequest {
    pub name: String,
    pub constraint_type: String,
    pub filters: Option<serde_json::Value>,
    pub limit_value: Option<f64>,
}

pub async fn list_constraints(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, constraint_type::text, filters, limit_value::float8,
                  is_active, last_triggered_at, created_at, updated_at
           FROM organization_constraints
           WHERE organization_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_constraints WHERE organization_id = $1",
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
                "name":             r.try_get::<String, _>("name").unwrap_or_default(),
                "constraint_type":  r.try_get::<String, _>("constraint_type").unwrap_or_default(),
                "filters":          r.try_get::<Value, _>("filters").unwrap_or(json!({})),
                "limit_value":      r.try_get::<Option<f64>, _>("limit_value").unwrap_or(None),
                "is_active":        r.try_get::<bool, _>("is_active").unwrap_or(true),
                "last_triggered_at": r.try_get::<Option<chrono::DateTime<Utc>>, _>("last_triggered_at").unwrap_or(None),
                "created_at":       r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "updated_at":       r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

pub async fn create_constraint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreateConstraintRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let id = Uuid::new_v4();
    let filters = body.filters.unwrap_or(json!({}));

    sqlx::query(
        r#"INSERT INTO organization_constraints
               (id, organization_id, name, constraint_type, filters, limit_value, created_by)
           VALUES ($1, $2, $3, $4::constraint_type, $5, $6, $7)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(&body.constraint_type)
    .bind(&filters)
    .bind(body.limit_value)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "constraint_type": body.constraint_type,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_constraint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, constraint_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateConstraintRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE organization_constraints SET
               name            = $3,
               constraint_type = $4::constraint_type,
               filters         = COALESCE($5, filters),
               limit_value     = COALESCE($6, limit_value),
               updated_at      = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(constraint_id)
    .bind(org_id)
    .bind(&body.name)
    .bind(&body.constraint_type)
    .bind(body.filters)
    .bind(body.limit_value)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Constraint {constraint_id} not found"
        )));
    }

    Ok(Json(
        json!({ "data": { "id": constraint_id, "message": "Updated" } }),
    ))
}

pub async fn delete_constraint(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, constraint_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result =
        sqlx::query("DELETE FROM organization_constraints WHERE id = $1 AND organization_id = $2")
            .bind(constraint_id)
            .bind(org_id)
            .execute(&state.db)
            .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Constraint {constraint_id} not found"
        )));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

/// Run constraint checks and return any violations.
pub async fn evaluate_constraints(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let constraints = sqlx::query(
        r#"SELECT id, name, constraint_type::text, filters, limit_value::float8
           FROM organization_constraints
           WHERE organization_id = $1 AND is_active = true"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let mut violations: Vec<Value> = Vec::new();

    for c in &constraints {
        let ctype: String = c.try_get("constraint_type").unwrap_or_default();
        let limit: Option<f64> = c.try_get("limit_value").unwrap_or(None);
        let cname: String = c.try_get("name").unwrap_or_default();
        let cid: Uuid = c.try_get("id").unwrap_or(Uuid::nil());

        match ctype.as_str() {
            "total_expense_limit" => {
                if let Some(monthly_limit) = limit {
                    let row = sqlx::query(
                        r#"SELECT COALESCE(SUM(cost), 0)::float8 AS total
                           FROM expenses
                           WHERE organization_id = $1
                           AND date >= date_trunc('month', CURRENT_DATE)"#,
                    )
                    .bind(org_id)
                    .fetch_one(&state.db)
                    .await?;

                    let total: f64 = row.try_get("total").unwrap_or(0.0);
                    if total > monthly_limit {
                        violations.push(json!({
                            "constraint_id":   cid,
                            "constraint_name": cname,
                            "constraint_type": ctype,
                            "limit":           monthly_limit,
                            "actual":          total,
                            "message":         format!("Monthly spend ${total:.2} exceeds limit ${monthly_limit:.2}"),
                        }));
                    }
                }
            }
            "resource_count" => {
                let row = sqlx::query(
                    r#"SELECT COUNT(DISTINCT cloud_resource_id) AS cnt
                       FROM expenses WHERE organization_id = $1"#,
                )
                .bind(org_id)
                .fetch_one(&state.db)
                .await?;

                let cnt: i64 = row.try_get("cnt").unwrap_or(0);
                if let Some(max) = limit {
                    if cnt as f64 > max {
                        violations.push(json!({
                            "constraint_id":   cid,
                            "constraint_name": cname,
                            "constraint_type": ctype,
                            "limit":           max,
                            "actual":          cnt,
                            "message":         format!("Resource count {cnt} exceeds limit {max}"),
                        }));
                    }
                }
            }
            "expense_anomaly" => {
                // Compare yesterday's spend to the N-day rolling average.
                // Violation if yesterday > baseline_per_day * threshold_factor.
                let filters: Value = c.try_get("filters").unwrap_or(json!({}));
                let threshold_factor = filters
                    .get("threshold_factor")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(2.0);
                let lookback_days = filters
                    .get("lookback_days")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(7)
                    .max(1);

                // Baseline: average daily spend over the lookback window (excluding yesterday)
                let baseline_row = sqlx::query(
                    r#"SELECT COALESCE(SUM(cost), 0)::float8 / $2 AS avg_daily
                       FROM expenses
                       WHERE organization_id = $1
                         AND date >= CURRENT_DATE - ($2 + 1) * INTERVAL '1 day'
                         AND date < CURRENT_DATE - INTERVAL '1 day'"#,
                )
                .bind(org_id)
                .bind(lookback_days)
                .fetch_one(&state.db)
                .await?;

                let baseline: f64 = baseline_row.try_get("avg_daily").unwrap_or(0.0);

                // Yesterday's spend
                let yesterday_row = sqlx::query(
                    r#"SELECT COALESCE(SUM(cost), 0)::float8 AS yesterday_total
                       FROM expenses
                       WHERE organization_id = $1
                         AND date = CURRENT_DATE - INTERVAL '1 day'"#,
                )
                .bind(org_id)
                .fetch_one(&state.db)
                .await?;

                let yesterday: f64 = yesterday_row.try_get("yesterday_total").unwrap_or(0.0);

                if baseline > 0.0 && yesterday > baseline * threshold_factor {
                    violations.push(json!({
                        "constraint_id":   cid,
                        "constraint_name": cname,
                        "constraint_type": ctype,
                        "threshold_factor": threshold_factor,
                        "baseline_daily":  (baseline * 100.0).round() / 100.0,
                        "yesterday_spend": (yesterday * 100.0).round() / 100.0,
                        "anomaly_ratio":   (yesterday / baseline * 100.0).round() / 100.0,
                        "message": format!(
                            "Yesterday spend ${yesterday:.2} is {:.1}x the {lookback_days}-day average ${baseline:.2} (threshold {threshold_factor}x)",
                            yesterday / baseline
                        ),
                    }));
                }
            }
            "resource_tag_coverage" => {
                // Check that at least `limit_value` percent (0-100) of active expense
                // resources carry ALL required tags defined in filters.required_tags.
                let filters: Value = c.try_get("filters").unwrap_or(json!({}));
                let min_coverage_pct = limit.unwrap_or(80.0).clamp(0.0, 100.0);
                let required_tags: Vec<String> = filters
                    .get("required_tags")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                if required_tags.is_empty() {
                    continue;
                }

                // Build a tag-existence check: ALL required keys must be present in tags
                // We count distinct cloud_resource_ids in expenses and check compliance.
                let total_row = sqlx::query(
                    r#"SELECT COUNT(DISTINCT cloud_resource_id) AS total
                       FROM expenses
                       WHERE organization_id = $1
                         AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
                )
                .bind(org_id)
                .fetch_one(&state.db)
                .await?;

                let total: i64 = total_row.try_get("total").unwrap_or(0);

                if total == 0 {
                    continue;
                }

                // Count resources that have ALL required tag keys present
                // We use the ? operator repeatedly; build a EXISTS-based count.
                // For each resource, use expenses.tags and check all required tags exist.
                let tags_json = serde_json::to_string(&required_tags).unwrap_or_default();
                let compliant_row = sqlx::query(
                    r#"SELECT COUNT(DISTINCT cloud_resource_id) AS compliant
                       FROM expenses
                       WHERE organization_id = $1
                         AND date >= CURRENT_DATE - INTERVAL '30 days'
                         AND (
                             SELECT bool_and(tags ? tag_key)
                             FROM jsonb_array_elements_text($2::jsonb) AS tag_key
                         )"#,
                )
                .bind(org_id)
                .bind(tags_json.as_str())
                .fetch_one(&state.db)
                .await?;

                let compliant: i64 = compliant_row.try_get("compliant").unwrap_or(0);
                let coverage_pct = (compliant as f64 / total as f64) * 100.0;

                if coverage_pct < min_coverage_pct {
                    violations.push(json!({
                        "constraint_id":     cid,
                        "constraint_name":   cname,
                        "constraint_type":   ctype,
                        "required_tags":     required_tags,
                        "total_resources":   total,
                        "compliant_resources": compliant,
                        "coverage_percent":  (coverage_pct * 10.0).round() / 10.0,
                        "minimum_required":  min_coverage_pct,
                        "message": format!(
                            "Tag coverage {coverage_pct:.1}% is below required {min_coverage_pct:.0}% ({} of {total} resources missing required tags: {})",
                            total - compliant,
                            required_tags.join(", ")
                        ),
                    }));
                }
            }
            _ => {}
        }
    }

    // Notify subscribed webhooks when any constraint is breached.
    if !violations.is_empty() {
        crate::modules::webhook::handlers::enqueue_event(
            &state.db,
            org_id,
            "anomaly.detected",
            json!({
                "message": format!("{} constraint violation(s) detected", violations.len())
            }),
        )
        .await;
    }

    Ok((
        StatusCode::OK,
        Json(json!({
            "data": {
                "evaluated": constraints.len(),
                "violations": violations,
            }
        })),
    ))
}
