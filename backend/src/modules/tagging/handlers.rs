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
};

async fn ensure_org_member(
    db: &sqlx::PgPool,
    org_id: Uuid,
    user_id: Uuid,
) -> AppResult<()> {
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
pub struct CreatePolicyRequest {
    pub name: String,
    pub description: Option<String>,
    pub required_tags: serde_json::Value,
    pub apply_to: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct TagQuery {
    pub key: Option<String>,
}

pub async fn list_policies(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, required_tags, apply_to, is_active, created_at, updated_at
           FROM tagging_policies WHERE organization_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tagging_policies WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":            r.try_get::<Uuid, _>("id").ok(),
                "name":          r.try_get::<String, _>("name").unwrap_or_default(),
                "description":   r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "required_tags": r.try_get::<Value, _>("required_tags").unwrap_or(json!([])),
                "apply_to":      r.try_get::<Value, _>("apply_to").unwrap_or(json!([])),
                "is_active":     r.try_get::<bool, _>("is_active").unwrap_or(true),
                "created_at":    r.try_get::<chrono::DateTime<Utc>, _>("created_at").ok(),
                "updated_at":    r.try_get::<chrono::DateTime<Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) })))
}

pub async fn create_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<CreatePolicyRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.name.trim().is_empty() {
        return Err(AppError::Validation("name is required".into()));
    }

    let id = Uuid::new_v4();
    let apply_to = body.apply_to.unwrap_or(json!([]));

    sqlx::query(
        r#"INSERT INTO tagging_policies (id, organization_id, name, description, required_tags, apply_to, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.description.as_deref())
    .bind(&body.required_tags)
    .bind(&apply_to)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": id,
                "name": body.name,
                "is_active": true,
                "created_at": Utc::now(),
            }
        })),
    ))
}

pub async fn update_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreatePolicyRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE tagging_policies SET
               name          = $3,
               description   = COALESCE($4, description),
               required_tags = $5,
               apply_to      = COALESCE($6, apply_to),
               updated_at    = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(policy_id)
    .bind(org_id)
    .bind(&body.name)
    .bind(body.description.as_deref())
    .bind(&body.required_tags)
    .bind(body.apply_to)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Policy {policy_id} not found")));
    }

    Ok(Json(json!({ "data": { "id": policy_id, "message": "Updated" } })))
}

pub async fn delete_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        "DELETE FROM tagging_policies WHERE id = $1 AND organization_id = $2",
    )
    .bind(policy_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Policy {policy_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

/// Aggregate expenses by a tag key, returning cost per tag value.
pub async fn expenses_by_tag(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<TagQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let tag_key = q.key.unwrap_or_else(|| "env".into());

    let rows = sqlx::query(
        r#"SELECT
               tags ->> $1 AS tag_value,
               SUM(cost)::float8 AS cost,
               COUNT(DISTINCT cloud_resource_id) AS resource_count
           FROM expenses
           WHERE organization_id = $2
           AND tags ? $1
           GROUP BY tags ->> $1
           ORDER BY cost DESC"#,
    )
    .bind(&tag_key)
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "tag_key":        &tag_key,
                "tag_value":      r.try_get::<Option<String>, _>("tag_value").unwrap_or(None),
                "cost":           r.try_get::<f64, _>("cost").unwrap_or(0.0),
                "resource_count": r.try_get::<i64, _>("resource_count").unwrap_or(0),
            })
        })
        .collect();

    Ok(Json(json!({ "data": data, "tag_key": tag_key })))
}

/// GET /api/v1/orgs/:org_id/tagging/coverage
///
/// Evaluate every active tagging policy for the organization and return per-policy
/// compliance metrics: how many distinct resources (based on the last 30 days of
/// expense data) carry all required tag keys, what percentage that represents, and
/// the aggregate monthly cost of non-compliant resources.
pub async fn tag_coverage_analysis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let policies = sqlx::query(
        r#"SELECT id, name, description, required_tags
           FROM tagging_policies
           WHERE organization_id = $1 AND is_active = true
           ORDER BY name"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    // Total distinct resources in the org over the past 30 days
    let total_row = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(DISTINCT cloud_resource_id)
           FROM expenses
           WHERE organization_id = $1
             AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let mut policy_reports: Vec<Value> = Vec::new();

    for policy in &policies {
        let policy_id: Uuid = policy.try_get("id").unwrap_or(Uuid::nil());
        let policy_name: String = policy.try_get("name").unwrap_or_default();
        let policy_desc: Option<String> = policy.try_get("description").unwrap_or(None);
        let required_tags: Value = policy.try_get("required_tags").unwrap_or(json!([]));

        let tag_keys: Vec<String> = required_tags
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        if tag_keys.is_empty() {
            policy_reports.push(json!({
                "policy_id":            policy_id,
                "policy_name":          policy_name,
                "description":          policy_desc,
                "required_tags":        tag_keys,
                "total_resources":      total_row,
                "compliant_resources":  total_row,
                "coverage_percent":     100.0,
                "uncovered_resources":  0,
                "uncovered_cost":       0.0,
            }));
            continue;
        }

        let tags_json = serde_json::to_string(&tag_keys).unwrap_or_else(|_| "[]".to_string());

        // Count resources where ALL required tag keys are present
        let compliant_row = sqlx::query(
            r#"SELECT
                   COUNT(DISTINCT cloud_resource_id) AS compliant,
                   COALESCE(SUM(cost), 0)::float8     AS compliant_cost
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
        let compliant_cost: f64 = compliant_row.try_get("compliant_cost").unwrap_or(0.0);

        // Total cost (to compute uncovered cost)
        let total_cost_row = sqlx::query_scalar::<_, f64>(
            r#"SELECT COALESCE(SUM(cost), 0)::float8
               FROM expenses
               WHERE organization_id = $1
                 AND date >= CURRENT_DATE - INTERVAL '30 days'"#,
        )
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0.0);

        let uncovered = total_row - compliant;
        let uncovered_cost = (total_cost_row - compliant_cost).max(0.0);
        let coverage_pct = if total_row == 0 {
            100.0_f64
        } else {
            (compliant as f64 / total_row as f64) * 100.0
        };

        policy_reports.push(json!({
            "policy_id":           policy_id,
            "policy_name":         policy_name,
            "description":         policy_desc,
            "required_tags":       tag_keys,
            "total_resources":     total_row,
            "compliant_resources": compliant,
            "coverage_percent":    (coverage_pct * 10.0).round() / 10.0,
            "uncovered_resources": uncovered,
            "uncovered_cost":      (uncovered_cost * 100.0).round() / 100.0,
        }));
    }

    Ok(Json(json!({
        "data": policy_reports,
        "meta": {
            "total_resources": total_row,
            "active_policies": policies.len(),
        }
    })))
}
