use axum::{
    extract::{Extension, Path, Query, State},
    http::StatusCode,
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

#[allow(unused_imports)]
use super::dto::{RecommendationListQuery, RecommendationResponse, RecommendationSummaryResponse};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/recommendations",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "List of recommendations", body = Vec<RecommendationResponse>),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "recommendations"
)]
pub async fn list(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<RecommendationListQuery>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);
    let status = q.status.as_deref();
    let rec_type = q.rec_type.as_deref();
    let search = q
        .search
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let rows = sqlx::query(
        r#"SELECT id, rec_type::text, status::text, title, description,
                  current_monthly_cost::float8, potential_savings::float8, savings_percent::float8,
                cloud_resource_id, cloud_account_id, ci_id, details,
                dismissed_at, dismiss_reason, created_at, updated_at
           FROM recommendations
           WHERE organization_id = $1
             AND ($2::text IS NULL OR status::text = $2)
             AND ($3::text IS NULL OR rec_type::text = $3)
             AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR COALESCE(description, '') ILIKE '%' || $4 || '%' OR COALESCE(cloud_resource_id, '') ILIKE '%' || $4 || '%')
            ORDER BY
             CASE WHEN status = 'dismissed'::recommendation_status THEN dismissed_at END DESC NULLS LAST,
             CASE WHEN status <> 'dismissed'::recommendation_status THEN potential_savings END DESC NULLS LAST,
             updated_at DESC
           LIMIT $5 OFFSET $6"#,
    )
    .bind(org_id)
    .bind(status)
    .bind(rec_type)
    .bind(search.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM recommendations
           WHERE organization_id = $1
             AND ($2::text IS NULL OR status::text = $2)
             AND ($3::text IS NULL OR rec_type::text = $3)
             AND ($4::text IS NULL OR title ILIKE '%' || $4 || '%' OR COALESCE(description, '') ILIKE '%' || $4 || '%' OR COALESCE(cloud_resource_id, '') ILIKE '%' || $4 || '%')"#,
    )
    .bind(org_id)
    .bind(status)
    .bind(rec_type)
    .bind(search.as_deref())
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id":                    r.try_get::<Uuid, _>("id").ok(),
                "rec_type":              r.try_get::<String, _>("rec_type").unwrap_or_default(),
                "status":                r.try_get::<String, _>("status").unwrap_or_default(),
                "title":                 r.try_get::<String, _>("title").unwrap_or_default(),
                "description":           r.try_get::<Option<String>, _>("description").unwrap_or(None),
                "current_monthly_cost":  r.try_get::<Option<f64>, _>("current_monthly_cost").unwrap_or(None),
                "potential_savings":     r.try_get::<Option<f64>, _>("potential_savings").unwrap_or(None),
                "savings_percent":       r.try_get::<Option<f64>, _>("savings_percent").unwrap_or(None),
                "cloud_resource_id":     r.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
                "cloud_account_id":      r.try_get::<Option<Uuid>, _>("cloud_account_id").unwrap_or(None),
                "ci_id":                 r.try_get::<Option<Uuid>, _>("ci_id").unwrap_or(None),
                "details":               r.try_get::<Value, _>("details").unwrap_or(json!({})),
                "dismissed_at":          r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("dismissed_at").unwrap_or(None),
                "dismiss_reason":        r.try_get::<Option<String>, _>("dismiss_reason").unwrap_or(None),
                "created_at":            r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
                "updated_at":            r.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/recommendations/summary",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Recommendation summary", body = RecommendationSummaryResponse),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "recommendations"
)]
pub async fn summary(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT
               COUNT(*)                                                     AS total,
               COUNT(*) FILTER (WHERE status = 'active')                   AS open,
               COUNT(*) FILTER (WHERE status = 'dismissed')                AS dismissed,
               COALESCE(SUM(potential_savings) FILTER (WHERE status = 'active'), 0)::float8 AS total_savings
           FROM recommendations WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "total":                    row.try_get::<i64, _>("total").unwrap_or(0),
            "open":                     row.try_get::<i64, _>("open").unwrap_or(0),
            "dismissed":                row.try_get::<i64, _>("dismissed").unwrap_or(0),
            "total_potential_savings":  row.try_get::<f64, _>("total_savings").unwrap_or(0.0),
            "currency": "USD"
        }
    })))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT id, rec_type::text, status::text, title, description,
                  current_monthly_cost::float8, potential_savings::float8, savings_percent::float8,
                  cloud_resource_id, cloud_account_id, ci_id, details,
                  dismissed_at, dismiss_reason, created_at, updated_at
           FROM recommendations
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Recommendation {id} not found")))?;

    Ok(Json(json!({
        "data": {
            "id":                    row.try_get::<Uuid, _>("id").ok(),
            "rec_type":              row.try_get::<String, _>("rec_type").unwrap_or_default(),
            "status":                row.try_get::<String, _>("status").unwrap_or_default(),
            "title":                 row.try_get::<String, _>("title").unwrap_or_default(),
            "description":           row.try_get::<Option<String>, _>("description").unwrap_or(None),
            "current_monthly_cost":  row.try_get::<Option<f64>, _>("current_monthly_cost").unwrap_or(None),
            "potential_savings":     row.try_get::<Option<f64>, _>("potential_savings").unwrap_or(None),
            "savings_percent":       row.try_get::<Option<f64>, _>("savings_percent").unwrap_or(None),
            "cloud_resource_id":     row.try_get::<Option<String>, _>("cloud_resource_id").unwrap_or(None),
            "cloud_account_id":      row.try_get::<Option<Uuid>, _>("cloud_account_id").unwrap_or(None),
            "details":               row.try_get::<Value, _>("details").unwrap_or(json!({})),
            "dismissed_at":          row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("dismissed_at").unwrap_or(None),
            "dismiss_reason":        row.try_get::<Option<String>, _>("dismiss_reason").unwrap_or(None),
            "created_at":            row.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at").ok(),
            "updated_at":            row.try_get::<chrono::DateTime<chrono::Utc>, _>("updated_at").ok(),
        }
    })))
}

pub async fn dismiss(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE recommendations SET
               status       = 'dismissed'::recommendation_status,
               dismissed_by = $3,
               dismissed_at = NOW(),
               updated_at   = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(id)
    .bind(org_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Recommendation {id} not found")));
    }

    Ok((
        StatusCode::OK,
        Json(json!({ "data": { "id": id, "status": "dismissed" } })),
    ))
}

pub async fn trigger_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    // Update checklist status
    let _ = sqlx::query(
        "INSERT INTO checklist (organization_id, run_status, last_run_at)
         VALUES ($1, 'running', NOW())
         ON CONFLICT (organization_id) DO UPDATE SET run_status = 'running', last_run_at = NOW()",
    )
    .bind(org_id)
    .execute(&state.db)
    .await;

    // Run engine in background
    let state_clone = state.clone();
    tokio::spawn(async move {
        match super::engine::RecEngine::run_for_org(&state_clone, org_id).await {
            Ok(count) => {
                tracing::info!(org_id = %org_id, count, "Recommendation run complete");
                let _ = sqlx::query(
                    "UPDATE checklist SET run_status = 'completed', last_completed_at = NOW() WHERE organization_id = $1"
                )
                .bind(org_id)
                .execute(&state_clone.db)
                .await;
            }
            Err(e) => {
                tracing::error!(error = %e, org_id = %org_id, "Recommendation run failed");
                let _ = sqlx::query(
                    "UPDATE checklist SET run_status = 'failed', last_error = $2 WHERE organization_id = $1"
                )
                .bind(org_id)
                .bind(e.to_string())
                .execute(&state_clone.db)
                .await;
            }
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "message": "Recommendation run started", "org_id": org_id })),
    ))
}

pub async fn checklist_status(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let row = sqlx::query(
        r#"SELECT last_run_at, last_completed_at, last_error, run_status, modules_config
           FROM checklist
           WHERE organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    let active_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1 AND status = 'active'",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let dismissed_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1 AND status = 'dismissed'",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let payload = if let Some(row) = row {
        json!({
            "run_status": row.try_get::<String, _>("run_status").unwrap_or_else(|_| "idle".to_string()),
            "last_run_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_run_at").unwrap_or(None),
            "last_completed_at": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_completed_at").unwrap_or(None),
            "last_error": row.try_get::<Option<String>, _>("last_error").unwrap_or(None),
            "modules_config": row.try_get::<Value, _>("modules_config").unwrap_or_else(|_| json!({})),
            "recommendation_counts": {
                "active": active_count,
                "dismissed": dismissed_count,
            }
        })
    } else {
        json!({
            "run_status": "idle",
            "last_run_at": Value::Null,
            "last_completed_at": Value::Null,
            "last_error": Value::Null,
            "modules_config": {},
            "recommendation_counts": {
                "active": active_count,
                "dismissed": dismissed_count,
            }
        })
    };

    Ok(Json(json!({ "data": payload })))
}

// ─── patch_checklist_modules ──────────────────────────────────────────────────

/// Request body for PATCH /orgs/{id}/recommendations/checklist
///
/// Merges `modules_config` into the checklist row using jsonb `||` (object merge),
/// so callers can update a single module without overwriting others.
///
/// Example body:
/// ```json
/// {
///   "modules_config": {
///     "abandoned_volume": { "enabled": false, "threshold_days": 14 },
///     "inactive_iam_users": { "enabled": true }
///   }
/// }
/// ```
#[derive(Deserialize)]
pub struct PatchChecklistRequest {
    pub modules_config: Value,
}

pub async fn patch_checklist_modules(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<PatchChecklistRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if !body.modules_config.is_object() {
        return Err(AppError::Validation(
            "modules_config must be a JSON object".into(),
        ));
    }

    // Upsert the checklist row, merging the provided modules_config into any existing value.
    sqlx::query(
        r#"INSERT INTO checklist (organization_id, modules_config)
           VALUES ($1, $2)
           ON CONFLICT (organization_id) DO UPDATE
               SET modules_config = checklist.modules_config || $2,
                   updated_at     = NOW()"#,
    )
    .bind(org_id)
    .bind(&body.modules_config)
    .execute(&state.db)
    .await?;

    // Return the full updated row.
    let row = sqlx::query(
        "SELECT modules_config, run_status, last_run_at FROM checklist WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "modules_config":  row.try_get::<Value, _>("modules_config").unwrap_or(json!({})),
            "run_status":      row.try_get::<String, _>("run_status").unwrap_or_else(|_| "idle".into()),
            "last_run_at":     row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_run_at").unwrap_or(None),
            "message": "modules_config updated"
        }
    })))
}

// ─── reactivate ───────────────────────────────────────────────────────────────

/// POST /api/v1/orgs/{org_id}/recommendations/{id}/reactivate
///
/// Un-dismisses a recommendation, returning it to `active` status and clearing
/// all dismissal fields. The unique-active-scope partial index from migration 012
/// means re-activating is rejected if a newer active recommendation already
/// covers the same resource/type scope.
pub async fn reactivate(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let result = sqlx::query(
        r#"UPDATE recommendations
           SET status        = 'active'::recommendation_status,
               dismissed_by  = NULL,
               dismissed_at  = NULL,
               dismiss_reason = NULL,
               updated_at    = NOW()
           WHERE id = $1
             AND organization_id = $2
             AND status = 'dismissed'::recommendation_status"#,
    )
    .bind(id)
    .bind(org_id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        // Unique index violation means another active rec already owns this scope.
        if e.to_string().contains("unique") || e.to_string().contains("duplicate") {
            AppError::Conflict(
                "A newer active recommendation already exists for this resource scope. \
                 Dismiss it first or delete the duplicate before re-activating."
                    .into(),
            )
        } else {
            AppError::Database(e)
        }
    })?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Recommendation {id} not found or is not in dismissed state"
        )));
    }

    tracing::info!(org_id = %org_id, rec_id = %id, reactivated_by = %user_id, "Recommendation reactivated");

    Ok((
        StatusCode::OK,
        Json(json!({ "data": { "id": id, "status": "active" } })),
    ))
}

// ─── Apply + verify (product gap C2) ──────────────────────────────────────────

/// POST /orgs/{id}/recommendations/{rec_id}/apply — mark as applied (ManageRules).
pub async fn apply_recommendation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rec_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE recommendations
           SET status = 'applied', applied_at = NOW(), applied_by = $3, updated_at = NOW()
           WHERE id = $1 AND organization_id = $2 AND status = 'active'"#,
    )
    .bind(rec_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Active recommendation {rec_id} not found"
        )));
    }
    Ok(Json(
        json!({ "data": { "id": rec_id, "status": "applied" } }),
    ))
}

#[derive(Deserialize)]
pub struct VerifyRecommendationRequest {
    pub actual_savings: f64,
}

/// POST /orgs/{id}/recommendations/{rec_id}/verify — record realized savings.
pub async fn verify_recommendation(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, rec_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<VerifyRecommendationRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE recommendations
           SET verified_at = NOW(), verified_by = $3, actual_savings = $4, updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(rec_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .bind(req.actual_savings)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "Recommendation {rec_id} not found"
        )));
    }
    Ok(Json(json!({ "data": { "id": rec_id, "verified": true } })))
}
