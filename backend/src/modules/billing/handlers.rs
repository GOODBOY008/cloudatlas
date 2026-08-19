use axum::{
    extract::{Extension, Path, State},
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
    modules::jobs,
    state::AppState,
};

use super::worker;

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct ImportRequest {
    pub cloud_account_id: Uuid,
    /// Days of billing data to import (1..=90, default 30).
    pub days: Option<i64>,
}

/// Trigger billing import for a cloud account — async since the
/// async-jobs redesign (spec 2026-09-09 §4.4): responds `202` with the job
/// handle; poll `GET /orgs/{org_id}/jobs/{job_id}` for phases and the terminal
/// `result` (provider / raw_rows_inserted / days_imported).
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/billing/import",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body = ImportRequest,
    responses(
        (status = 202, description = "Import job accepted — poll GET /orgs/{org_id}/jobs/{job_id}"),
        (status = 400, description = "Unsupported provider"),
        (status = 401, description = "Unauthorized"),
        (status = 403, description = "Forbidden"),
        (status = 404, description = "Cloud account not found or inactive"),
        (status = 409, description = "A billing import is already active for this account"),
    ),
    security(("bearer_auth" = [])),
    tag = "billing"
)]
pub async fn trigger_import(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<ImportRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Verify account belongs to org and is active — all validation failures
    // fail fast before any job row exists.
    let provider = sqlx::query_scalar::<_, String>(
        "SELECT provider::text FROM cloud_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true",
    )
    .bind(req.cloud_account_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("Cloud account not found or inactive".into()))?;

    match worker::normalize_provider(&provider) {
        "aws" | "alibaba" => {}
        other => {
            return Err(AppError::Validation(format!(
                "Unsupported provider for billing import: {other}"
            )));
        }
    }

    let days = req.days.unwrap_or(30).clamp(1, 90);
    let Some(job) = worker::launch_billing_import(
        &state,
        org_id,
        req.cloud_account_id,
        &claims.user_id()?.to_string(),
        days,
    )
    .await?
    else {
        // Manual triggers 409 on conflict; None is unreachable here.
        return Err(AppError::Internal(anyhow::anyhow!(
            "manual billing launch returned no job"
        )));
    };

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "data": jobs::job_to_json(&job) })),
    ))
}

#[cfg(test)]
mod tests {
    use super::worker;

    #[test]
    fn test_normalize_provider_alias() {
        assert_eq!(worker::normalize_provider("aliyun"), "alibaba");
        assert_eq!(worker::normalize_provider("alibaba"), "alibaba");
    }
}

/// Get import status / history for a cloud account.
/// Paginates the (few) account rows; the per-account aggregate subqueries over
/// the expense fact tables are kept unchanged for correctness.
pub async fn list_import_history(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query_as::<
        _,
        (
            Uuid,
            String,
            i64,
            i64,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        r#"SELECT
               ca.id,
               ca.provider::text,
               COALESCE(re_stats.raw_rows, 0) AS raw_rows,
               COALESCE(e_stats.expense_rows, 0) AS expense_rows,
               re_stats.last_import
           FROM cloud_accounts ca
           LEFT JOIN (
               SELECT cloud_account_id,
                      COUNT(*)::bigint            AS raw_rows,
                      MAX(imported_at)            AS last_import
               FROM raw_expenses
               GROUP BY cloud_account_id
           ) re_stats ON re_stats.cloud_account_id = ca.id
           LEFT JOIN (
               SELECT cloud_account_id,
                      COUNT(*)::bigint            AS expense_rows
               FROM expenses
               GROUP BY cloud_account_id
           ) e_stats ON e_stats.cloud_account_id = ca.id
           WHERE ca.organization_id = $1 AND ca.deleted_at IS NULL
           ORDER BY re_stats.last_import DESC NULLS LAST, ca.id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cloud_accounts WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let history: Vec<Value> = rows
        .iter()
        .map(|(id, provider, raw, expenses, last)| {
            json!({
                "cloud_account_id": id,
                "provider": provider,
                "raw_rows": raw,
                "expense_rows": expenses,
                "last_import_at": last,
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": history, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

// ─── Exchange rates (currency FX) ─────────────────────────────────────────────

#[derive(Deserialize, utoipa::ToSchema)]
pub struct UpsertRatesRequest {
    pub rates: Vec<RateInput>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct RateInput {
    pub from_currency: String,
    pub to_currency: String,
    pub rate: f64,
}

/// List the org's exchange rates (direct rows only; inverses/pivots are
/// computed on demand by `fx::convert`).
pub async fn list_exchange_rates(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let org_cur = super::fx::org_currency(&state.db, org_id).await;
    let rows = sqlx::query(
        r#"SELECT from_currency, to_currency, rate::float8 AS rate, updated_at
           FROM exchange_rates WHERE organization_id = $1
           ORDER BY from_currency, to_currency"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let rates: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "from_currency": r.get::<String, _>("from_currency"),
                "to_currency": r.get::<String, _>("to_currency"),
                "rate": r.get::<f64, _>("rate"),
                "updated_at": r.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": rates, "org_currency": org_cur })))
}

/// Upsert exchange rates (admin-editable static table; no external FX API).
pub async fn upsert_exchange_rates(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<UpsertRatesRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    crate::middleware::rbac::require_permission(
        &state.db,
        claims.user_id()?,
        org_id,
        crate::middleware::rbac::Permission::ManageCloudAccounts,
    )
    .await?;

    let mut upserted = 0u32;
    for r in &req.rates {
        let from = r.from_currency.trim().to_uppercase();
        let to = r.to_currency.trim().to_uppercase();
        if from.len() != 3 || to.len() != 3 || r.rate <= 0.0 {
            return Err(AppError::Validation(
                "Rates need 3-letter currency codes and a positive rate".into(),
            ));
        }
        let res = sqlx::query(
            r#"INSERT INTO exchange_rates (organization_id, from_currency, to_currency, rate)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (organization_id, from_currency, to_currency)
               DO UPDATE SET rate = EXCLUDED.rate, updated_at = NOW()"#,
        )
        .bind(org_id)
        .bind(&from)
        .bind(&to)
        .bind(r.rate)
        .execute(&state.db)
        .await?;
        upserted += res.rows_affected() as u32;
    }

    Ok(Json(json!({ "data": { "upserted": upserted } })))
}
