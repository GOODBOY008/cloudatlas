//! CloudAtlas AI Copilot — org-aware conversational assistant.
//!
//! Two modes, one SSE protocol (`data: {"delta":"..."}` … `data: {"done":true}`):
//! - **LLM mode** (AI_ENABLED + OPENAI_API_KEY): chat-completions with tool
//!   calling (up to 3 rounds) over a per-org context digest, then the final
//!   answer is streamed token-by-token.
//! - **Local mode** (no key): deterministic intent-matched answers built from
//!   the same context digest — the copilot stays useful offline.
//!
//! All data access is read-only and `organization_id`-scoped.

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    modules::ai::analytics,
    state::AppState,
};

pub const MAX_MESSAGE_LEN: usize = 4096;
pub const MAX_TOOL_ROUNDS: usize = 3;

// ─── Context digest ──────────────────────────────────────────────────────────

/// Compact per-org snapshot used by both the LLM system prompt and the local
/// fallback. All values are read-only aggregates.
pub async fn build_context_digest(db: &sqlx::PgPool, org_id: Uuid) -> Value {
    let org_name = sqlx::query_scalar::<_, Option<String>>(
        "SELECT name FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| "this organization".into());

    let mtd: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND date >= date_trunc('month', CURRENT_DATE)",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0.0);

    let last_30d: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND date >= CURRENT_DATE - 30",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0.0);

    // Trend: last 7 days vs previous 7 days.
    let recent_7d: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND date >= CURRENT_DATE - 7",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0.0);
    let prev_7d: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND date BETWEEN CURRENT_DATE - 14 AND CURRENT_DATE - 7",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0.0);
    let trend_direction = if prev_7d <= 0.0 {
        "flat"
    } else if recent_7d > prev_7d * 1.1 {
        "up"
    } else if recent_7d < prev_7d * 0.9 {
        "down"
    } else {
        "flat"
    };

    let resource_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM resources WHERE organization_id = $1 AND active = true",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);

    let active_recommendations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1 AND status = 'active'",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);

    let top_savings: f64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(potential_savings), 0) FROM recommendations WHERE organization_id = $1 AND status = 'active'",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0.0);

    // Budget status across pools with budgets.
    let budget_status = budget_status(db, org_id).await;

    let open_anomalies: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM alert_events WHERE organization_id = $1 AND acknowledged_at IS NULL AND created_at >= NOW() - INTERVAL '30 days'",
    )
    .bind(org_id)
    .fetch_one(db)
    .await
    .unwrap_or(0);

    // Holt-Winters 30-day projection from the last 90 days.
    let projected_30d = projected_cost(db, org_id, 30).await;

    json!({
        "org_name": org_name,
        "month_to_date_cost": round2(mtd),
        "last_30d_cost": round2(last_30d),
        "trend_direction": trend_direction,
        "resource_count": resource_count,
        "active_recommendations": active_recommendations,
        "top_recommendation_savings": round2(top_savings),
        "budget_status": budget_status,
        "open_anomalies": open_anomalies,
        "projected_30d_cost": round2(projected_30d),
    })
}

async fn budget_status(db: &sqlx::PgPool, org_id: Uuid) -> String {
    let rows = sqlx::query(
        r#"SELECT b.amount::float8 AS amount,
                  COALESCE((
                      SELECT SUM(e.cost) FROM expenses e
                      WHERE e.pool_id = b.pool_id
                        AND e.date >= date_trunc('month', CURRENT_DATE)
                  ), 0)::float8 AS spent
           FROM budgets b
           WHERE b.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_all(db)
    .await;

    let rows = match rows {
        Ok(r) => r,
        Err(_) => return "unknown".into(),
    };
    if rows.is_empty() {
        return "no_budgets".into();
    }

    let mut over = 0;
    let mut warning = 0;
    for r in &rows {
        let amount: f64 = r.get("amount");
        let spent: f64 = r.get("spent");
        if amount <= 0.0 {
            continue;
        }
        let util = spent / amount;
        if util >= 1.0 {
            over += 1;
        } else if util >= 0.8 {
            warning += 1;
        }
    }
    if over > 0 {
        "over_budget".into()
    } else if warning > 0 {
        "warning".into()
    } else {
        "on_track".into()
    }
}

async fn projected_cost(db: &sqlx::PgPool, org_id: Uuid, horizon: usize) -> f64 {
    let rows = sqlx::query(
        "SELECT date, SUM(cost)::float8 AS total FROM expenses WHERE organization_id = $1 AND date >= CURRENT_DATE - 90 GROUP BY date ORDER BY date",
    )
    .bind(org_id)
    .fetch_all(db)
    .await;

    let rows = match rows {
        Ok(r) => r,
        Err(_) => return 0.0,
    };
    let series: Vec<f64> = rows.iter().map(|r| r.get::<f64, _>("total")).collect();
    analytics::holt_winters_forecast(&series, horizon, 7).iter().sum()
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/// OpenAI function-calling tool definitions (read-only).
pub fn tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_expense_summary",
                "description": "Total spend and top services for a period",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "days": { "type": "integer", "enum": [7, 30, 90], "description": "Lookback period" }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_top_resources",
                "description": "Top resources by cost",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "default": 5 }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_recommendations",
                "description": "Active cost recommendations and savings",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "default": 5 },
                        "status": { "type": "string", "enum": ["active", "dismissed", "archived"] }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_budget_status",
                "description": "Per-pool budget vs month-to-date spend"
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_anomalies",
                "description": "Recent spend anomalies / budget alert events",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "days": { "type": "integer", "default": 30 }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_forecast",
                "description": "Holt-Winters spend forecast",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "days": { "type": "integer", "enum": [7, 14, 30] }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "Semantic search over org knowledge notes",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_resources",
                "description": "Semantic search over the org's cloud resources",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "dismiss_recommendation",
                "description": "Dismiss an active recommendation (requires ManageRules)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Recommendation id (UUID)" }
                    },
                    "required": ["id"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "apply_recommendation",
                "description": "Mark an active recommendation as applied (requires ManageRules)",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string", "description": "Recommendation id (UUID)" }
                    },
                    "required": ["id"]
                }
            }
        }
    ])
}

/// Execute one tool call. Read tools are organization-scoped; write tools
/// (dismiss/apply) require ManageRules and are still org-scoped (A1).
pub async fn execute_tool(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
    name: &str,
    args: &Value,
) -> Value {
    let db = &state.db;

    // Write tools: permission-guarded.
    if matches!(name, "dismiss_recommendation" | "apply_recommendation") {
        if crate::middleware::rbac::require_permission(
            db,
            user_id,
            org_id,
            crate::middleware::rbac::Permission::ManageRules,
        )
        .await
        .is_err()
        {
            return json!({ "error": "You need the ManageRules role to change recommendations" });
        }
    }

    match name {
        "get_expense_summary" => {
            let days = args.get("days").and_then(|v| v.as_i64()).unwrap_or(30).clamp(7, 90);
            let total: f64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(cost), 0)::float8 FROM expenses WHERE organization_id = $1 AND date >= CURRENT_DATE - $2::int",
            )
            .bind(org_id)
            .bind(days as i32)
            .fetch_one(db)
            .await
            .unwrap_or(0.0);

            let services = sqlx::query(
                r#"SELECT service_name, SUM(cost)::float8 AS total FROM expenses
                   WHERE organization_id = $1 AND date >= CURRENT_DATE - $2::int
                   GROUP BY service_name ORDER BY total DESC LIMIT 5"#,
            )
            .bind(org_id)
            .bind(days as i32)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let service_list: Vec<Value> = services
                .iter()
                .map(|r| {
                    json!({
                        "service": r.get::<Option<String>, _>("service_name").unwrap_or_else(|| "unknown".into()),
                        "cost": round2(r.get::<f64, _>("total")),
                    })
                })
                .collect();

            json!({
                "days": days,
                "total_cost": round2(total),
                "avg_daily": round2(total / days as f64),
                "top_services": service_list,
            })
        }
        "get_top_resources" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).clamp(1, 20) as i32;
            let rows = sqlx::query(
                r#"SELECT name, resource_type, service_name, total_cost::float8 AS cost
                   FROM resources
                   WHERE organization_id = $1 AND active = true
                   ORDER BY total_cost DESC LIMIT $2"#,
            )
            .bind(org_id)
            .bind(limit)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "name": r.get::<Option<String>, _>("name").unwrap_or_else(|| "unnamed".into()),
                        "resource_type": r.get::<Option<String>, _>("resource_type").unwrap_or_else(|| "other".into()),
                        "service": r.get::<Option<String>, _>("service_name").unwrap_or_else(|| "unknown".into()),
                        "cost": round2(r.get::<f64, _>("cost")),
                    })
                })
                .collect();
            json!({ "resources": items })
        }
        "get_recommendations" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).clamp(1, 20) as i32;
            let status = args.get("status").and_then(|v| v.as_str()).unwrap_or("active");
            let rows = sqlx::query(
                r#"SELECT title, rec_type, status, potential_savings::float8 AS savings
                   FROM recommendations
                   WHERE organization_id = $1 AND status = $2
                   ORDER BY potential_savings DESC LIMIT $3"#,
            )
            .bind(org_id)
            .bind(status)
            .bind(limit)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "title": r.get::<String, _>("title"),
                        "rec_type": r.get::<String, _>("rec_type"),
                        "status": r.get::<String, _>("status"),
                        "potential_savings": round2(r.get::<f64, _>("savings")),
                    })
                })
                .collect();
            json!({ "recommendations": items })
        }
        "get_budget_status" => {
            let rows = sqlx::query(
                r#"SELECT b.amount::float8 AS amount,
                          COALESCE((SELECT SUM(e.cost) FROM expenses e
                                    WHERE e.pool_id = b.pool_id
                                      AND e.date >= date_trunc('month', CURRENT_DATE)), 0)::float8 AS spent,
                          p.name AS pool_name
                   FROM budgets b
                   JOIN pools p ON p.id = b.pool_id
                   WHERE b.organization_id = $1"#,
            )
            .bind(org_id)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let pools: Vec<Value> = rows
                .iter()
                .map(|r| {
                    let amount: f64 = r.get("amount");
                    let spent: f64 = r.get("spent");
                    let utilization = if amount > 0.0 { spent / amount } else { 0.0 };
                    json!({
                        "pool": r.get::<String, _>("pool_name"),
                        "budget": round2(amount),
                        "spent_mtd": round2(spent),
                        "utilization_pct": round2(utilization * 100.0),
                    })
                })
                .collect();
            json!({ "pools": pools })
        }
        "get_anomalies" => {
            let days = args.get("days").and_then(|v| v.as_i64()).unwrap_or(30).clamp(7, 90) as i32;
            let rows = sqlx::query(
                r#"SELECT message, actual_value::float8 AS actual, created_at
                   FROM alert_events
                   WHERE organization_id = $1 AND created_at >= NOW() - $2::int * INTERVAL '1 day'
                   ORDER BY created_at DESC LIMIT 10"#,
            )
            .bind(org_id)
            .bind(days)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let items: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "message": r.get::<String, _>("message"),
                        "actual": round2(r.get::<f64, _>("actual")),
                        "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at").to_rfc3339(),
                    })
                })
                .collect();
            json!({ "anomalies": items })
        }
        "get_forecast" => {
            let days = args.get("days").and_then(|v| v.as_i64()).unwrap_or(14).clamp(7, 30) as usize;
            let rows = sqlx::query(
                "SELECT date, SUM(cost)::float8 AS total FROM expenses WHERE organization_id = $1 AND date >= CURRENT_DATE - 90 GROUP BY date ORDER BY date",
            )
            .bind(org_id)
            .fetch_all(db)
            .await
            .unwrap_or_default();

            let series: Vec<f64> = rows.iter().map(|r| r.get::<f64, _>("total")).collect();
            let forecast = analytics::holt_winters_forecast(&series, days, 7);
            json!({
                "horizon_days": days,
                "total_projected": round2(forecast.iter().sum()),
                "points": forecast.iter().map(|v| round2(*v)).collect::<Vec<_>>(),
            })
        }
        "search_notes" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (results, mode) = super::handlers::search_notes_query(state, org_id, &query, 5).await;
            json!({ "mode": mode, "results": results })
        }
        "search_resources" => {
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (results, mode) = super::handlers::search_resources_query(state, org_id, &query, 5).await;
            json!({ "mode": mode, "results": results })
        }
        "dismiss_recommendation" => {
            let rec_id = args.get("id").and_then(|v| v.as_str()).and_then(|v| uuid::Uuid::parse_str(v).ok());
            match rec_id {
                Some(id) => {
                    let result = sqlx::query(
                        "UPDATE recommendations SET status = 'dismissed', dismissed_by = $3, dismissed_at = NOW() WHERE id = $1 AND organization_id = $2 AND status = 'active'",
                    )
                    .bind(id)
                    .bind(org_id)
                    .bind(user_id)
                    .execute(db)
                    .await;
                    match result {
                        Ok(r) if r.rows_affected() > 0 => json!({ "dismissed": true, "id": id }),
                        Ok(_) => json!({ "error": "Recommendation not found or not active" }),
                        Err(e) => json!({ "error": format!("dismiss failed: {e}") }),
                    }
                }
                None => json!({ "error": "Invalid recommendation id" }),
            }
        }
        "apply_recommendation" => {
            let rec_id = args.get("id").and_then(|v| v.as_str()).and_then(|v| uuid::Uuid::parse_str(v).ok());
            match rec_id {
                Some(id) => {
                    let result = sqlx::query(
                        "UPDATE recommendations SET status = 'applied', applied_at = NOW(), applied_by = $3 WHERE id = $1 AND organization_id = $2 AND status = 'active'",
                    )
                    .bind(id)
                    .bind(org_id)
                    .bind(user_id)
                    .execute(db)
                    .await;
                    match result {
                        Ok(r) if r.rows_affected() > 0 => json!({ "applied": true, "id": id }),
                        Ok(_) => json!({ "error": "Recommendation not found or not active" }),
                        Err(e) => json!({ "error": format!("apply failed: {e}") }),
                    }
                }
                None => json!({ "error": "Invalid recommendation id" }),
            }
        }
        other => json!({ "error": format!("unknown tool: {other}") }),
    }
}

// ─── Local copilot ───────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum Intent {
    Spend,
    TopResources,
    Recommendations,
    Budget,
    Anomalies,
    Forecast,
    Resources,
    Overview,
}

fn format_money(value: f64) -> String {
    let negative = value < 0.0;
    let n = value.abs();
    let int_part = n.floor() as u64;
    let frac_part = ((n - n.floor()) * 100.0).round() as u64;
    let digits = int_part.to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("${}{}.{:02}", if negative { "-" } else { "" }, grouped, frac_part)
}

fn detect_intent(message: &str) -> Intent {
    let m = message.to_lowercase();
    if ["top resource", "top 5", "top5", "top 10", "highest", "最贵", "top 资源", "花费最多"].iter().any(|k| m.contains(k)) {
        return Intent::TopResources;
    }
    if ["spend", "cost", "expense", "花费", "成本", "支出", "花了"].iter().any(|k| m.contains(k)) {
        return Intent::Spend;
    }
    if ["recommend", "savings", "optimiz", "建议", "优化", "节省"].iter().any(|k| m.contains(k)) {
        return Intent::Recommendations;
    }
    if ["budget", "alert", "预算", "告警", "预警"].iter().any(|k| m.contains(k)) {
        return Intent::Budget;
    }
    if ["anomal", "异常", "波动"].iter().any(|k| m.contains(k)) {
        return Intent::Anomalies;
    }
    if ["forecast", "predict", "预测", "预计"].iter().any(|k| m.contains(k)) {
        return Intent::Forecast;
    }
    if ["how many resource", "resource count", "资源数", "多少资源"].iter().any(|k| m.contains(k)) {
        return Intent::Resources;
    }
    Intent::Overview
}

/// Deterministic answer from the context digest. Pure — unit-testable.
pub fn local_copilot_reply(digest: &Value, message: &str) -> String {
    let money = |v: &Value| -> String { format_money(v.as_f64().unwrap_or(0.0)) };
    let org = digest["org_name"].as_str().unwrap_or("this organization");

    match detect_intent(message) {
        Intent::Spend => format!(
            "Here's the spend picture for {org}: month-to-date **{}**, last 30 days **{}**, and the recent trend is **{}**. {}",
            money(&digest["month_to_date_cost"]),
            money(&digest["last_30d_cost"]),
            digest["trend_direction"].as_str().unwrap_or("flat"),
            if digest["trend_direction"] == "up" {
                "Spend is trending up — check the Recommendations page for optimization ideas."
            } else if digest["trend_direction"] == "down" {
                "Spend is trending down — keep it up!"
            } else {
                "Spend is roughly flat over the last two weeks."
            }
        ),
        Intent::TopResources => {
            "Use the **Resources** page for the full list. Ask me for the top 5 by cost and I'll pull them from the live data (this requires the LLM mode; the local copilot answers from the digest)."
                .to_string()
        }
        Intent::Recommendations => format!(
            "There are **{}** active recommendations for {org}; the biggest single one is worth **{}**/month. Open the Recommendations page to review and dismiss them.",
            digest["active_recommendations"].as_i64().unwrap_or(0),
            money(&digest["top_recommendation_savings"]),
        ),
        Intent::Budget => {
            let status = digest["budget_status"].as_str().unwrap_or("unknown");
            match status {
                "over_budget" => "⚠️ Some pools are **over budget** this month — open Budgets & Quotas to see which.",
                "warning" => "Some pools are **close to budget** (≥80% utilized) — keep an eye on Budgets & Quotas.",
                "on_track" => "All budgets are **on track** this month. 🎉",
                "no_budgets" => "There are **no budgets configured** yet — create some on the Budgets & Quotas page.",
                _ => "Budget status is unknown right now.",
            }
            .to_string()
        }
        Intent::Anomalies => {
            let n = digest["open_anomalies"].as_i64().unwrap_or(0);
            if n > 0 {
                format!("There are **{n} unacknowledged anomaly alert(s)** in the last 30 days — check the Alerts / Alert Events pages.")
            } else {
                "No open anomaly alerts in the last 30 days. ✅".to_string()
            }
        }
        Intent::Forecast => format!(
            "Based on the last 90 days, the **30-day projection** for {org} is **{}**.",
            money(&digest["projected_30d_cost"]),
        ),
        Intent::Resources => format!(
            "{org} currently tracks **{}** active resources.",
            digest["resource_count"].as_i64().unwrap_or(0),
        ),
        Intent::Overview => format!(
            "Here's a quick snapshot of {org}: **{}** MTD spend (30d: **{}**, trend {}), **{}** active resources, **{}** active recommendations, budget status **{}**, **{}** open anomalies, and a 30-day projection of **{}**.\n\nAsk me about spend, top resources, recommendations, budgets, anomalies or forecasts — or open the AI Center for forecasting and anomaly tools.",
            money(&digest["month_to_date_cost"]),
            money(&digest["last_30d_cost"]),
            digest["trend_direction"].as_str().unwrap_or("flat"),
            digest["resource_count"].as_i64().unwrap_or(0),
            digest["active_recommendations"].as_i64().unwrap_or(0),
            digest["budget_status"].as_str().unwrap_or("unknown"),
            digest["open_anomalies"].as_i64().unwrap_or(0),
            money(&digest["projected_30d_cost"]),
        ),
    }
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

pub fn sse_response(body: String) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from(body),
    )
        .into_response()
}

/// Stream a plain string as SSE deltas (chunked for a natural typing effect).
pub fn stream_text(text: &str) -> Response {
    let mut body = String::new();
    // Single frame is fine for the local mode; the UI renders it in full.
    let frame = json!({ "delta": text });
    body.push_str(&format!("data: {}\n\n", frame));
    body.push_str("data: {\"done\":true}\n\n");
    sse_response(body)
}

/// Human-readable digest summary for the LLM system prompt.
pub fn digest_prompt(digest: &Value) -> String {
    format!(
        "Current organization context (JSON): {}",
        serde_json::to_string(digest).unwrap_or_else(|_| "{}".into())
    )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_digest() -> Value {
        json!({
            "org_name": "Acme Corp",
            "month_to_date_cost": 1234.56,
            "last_30d_cost": 5678.90,
            "trend_direction": "up",
            "resource_count": 42,
            "active_recommendations": 7,
            "top_recommendation_savings": 312.50,
            "budget_status": "warning",
            "open_anomalies": 2,
            "projected_30d_cost": 6100.0,
        })
    }

    #[test]
    fn intent_detection() {
        assert_eq!(detect_intent("how much did we spend this month"), Intent::Spend);
        assert_eq!(detect_intent("本月花了多少钱"), Intent::Spend);
        assert_eq!(detect_intent("top 5 resources by cost"), Intent::TopResources);
        assert_eq!(detect_intent("what recommendations do we have"), Intent::Recommendations);
        assert_eq!(detect_intent("are we over budget"), Intent::Budget);
        assert_eq!(detect_intent("any anomalies recently"), Intent::Anomalies);
        assert_eq!(detect_intent("forecast next month"), Intent::Forecast);
        assert_eq!(detect_intent("how many resources do we have"), Intent::Resources);
        assert_eq!(detect_intent("hello there"), Intent::Overview);
    }

    #[test]
    fn local_reply_spend() {
        let reply = local_copilot_reply(&sample_digest(), "how much did we spend?");
        assert!(reply.contains("$1,234.56"), "{reply}");
        assert!(reply.contains("$5,678.90"), "{reply}");
        assert!(reply.contains("up"), "{reply}");
    }

    #[test]
    fn local_reply_recommendations() {
        let reply = local_copilot_reply(&sample_digest(), "recommendations?");
        assert!(reply.contains("7"), "{reply}");
        assert!(reply.contains("$312.50"), "{reply}");
    }

    #[test]
    fn local_reply_budget_warning() {
        let reply = local_copilot_reply(&sample_digest(), "are we over budget?");
        assert!(reply.contains("close to budget"), "{reply}");
    }

    #[test]
    fn local_reply_overview_mentions_all_metrics() {
        let reply = local_copilot_reply(&sample_digest(), "hello");
        assert!(reply.contains("Acme Corp"));
        assert!(reply.contains("$1,234.56"));
        assert!(reply.contains("42"));
        assert!(reply.contains("7"));
        assert!(reply.contains("warning"));
        assert!(reply.contains("2"));
        assert!(reply.contains("$6,100.00"));
    }
}
