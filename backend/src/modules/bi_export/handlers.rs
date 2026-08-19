//! BI Export — export definitions, on-demand runs, and CSV/JSON downloads.
//!
//! A definition selects a scope (expenses / recommendations / resources) with
//! optional date filters. Running an export materializes the rows (counted in
//! `bi_export_runs`); the download endpoint re-queries the same scope so the
//! payload is always current — no large blobs are stored.

use axum::{
    body::Body,
    extract::{Extension, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
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

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

const SCOPES: &[&str] = &["expenses", "recommendations", "resources"];
const FORMATS: &[&str] = &["csv", "json"];

#[derive(Deserialize)]
pub struct CreateExportRequest {
    pub name: String,
    pub format: String,
    pub scope: String,
    pub filters: Option<Value>,
}

#[derive(Deserialize)]
pub struct UpdateExportRequest {
    pub name: Option<String>,
    pub format: Option<String>,
    pub scope: Option<String>,
    pub filters: Option<Value>,
    pub is_active: Option<bool>,
}

fn validate_export(name: &str, format: &str, scope: &str) -> AppResult<()> {
    crate::utils::validate::name(name, 255, "Export name").map_err(AppError::Validation)?;
    if !FORMATS.contains(&format) {
        return Err(AppError::Validation(format!(
            "format must be one of: {}",
            FORMATS.join(", ")
        )));
    }
    if !SCOPES.contains(&scope) {
        return Err(AppError::Validation(format!(
            "scope must be one of: {}",
            SCOPES.join(", ")
        )));
    }
    Ok(())
}

pub async fn list_exports(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT e.id, e.name, e.format, e.scope, e.filters, e.created_at,
                  (SELECT COUNT(*) FROM bi_export_runs r WHERE r.export_id = e.id) AS run_count,
                  (SELECT MAX(r.created_at) FROM bi_export_runs r WHERE r.export_id = e.id) AS last_run_at
           FROM bi_exports e
           WHERE e.organization_id = $1
           ORDER BY e.created_at DESC, e.id DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM bi_exports WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "format": r.get::<String, _>("format"),
                "scope": r.get::<String, _>("scope"),
                "filters": r.get::<Value, _>("filters"),
                "run_count": r.get::<i64, _>("run_count"),
                "last_run_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_run_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

pub async fn create_export(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateExportRequest>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    validate_export(&req.name, &req.format, &req.scope)?;

    let row = sqlx::query(
        r#"INSERT INTO bi_exports (organization_id, name, format, scope, filters, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at"#,
    )
    .bind(org_id)
    .bind(&req.name)
    .bind(&req.format)
    .bind(&req.scope)
    .bind(req.filters.unwrap_or(json!({})))
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate") {
            AppError::Conflict("An export with this name already exists".into())
        } else {
            AppError::Database(e)
        }
    })?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": row.get::<Uuid, _>("id"),
                "name": req.name,
                "format": req.format,
                "scope": req.scope,
                "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            }
        })),
    ))
}

pub async fn update_export(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, export_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateExportRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if let (Some(name), Some(format), Some(scope)) = (&req.name, &req.format, &req.scope) {
        validate_export(name, format, scope)?;
    } else if let Some(format) = &req.format {
        if !FORMATS.contains(&format.as_str()) {
            return Err(AppError::Validation("invalid format".into()));
        }
    } else if let Some(scope) = &req.scope {
        if !SCOPES.contains(&scope.as_str()) {
            return Err(AppError::Validation("invalid scope".into()));
        }
    }

    let result = sqlx::query(
        r#"UPDATE bi_exports SET
               name = COALESCE($3, name),
               format = COALESCE($4, format),
               scope = COALESCE($5, scope),
               filters = COALESCE($6, filters),
               updated_at = NOW()
           WHERE id = $1 AND organization_id = $2"#,
    )
    .bind(export_id)
    .bind(org_id)
    .bind(req.name.as_deref())
    .bind(req.format.as_deref())
    .bind(req.scope.as_deref())
    .bind(req.filters)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Export {export_id} not found")));
    }

    Ok(Json(
        json!({ "data": { "id": export_id, "message": "Updated" } }),
    ))
}

pub async fn delete_export(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, export_id)): Path<(Uuid, Uuid)>,
) -> AppResult<(StatusCode, Json<Value>)> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query("DELETE FROM bi_exports WHERE id = $1 AND organization_id = $2")
        .bind(export_id)
        .bind(org_id)
        .execute(&state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Export {export_id} not found")));
    }

    Ok((StatusCode::NO_CONTENT, Json(json!({}))))
}

/// Run an export: materialize the rows, record the run, return row count.
pub async fn run_export(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, export_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let def = sqlx::query(
        "SELECT id, scope, filters FROM bi_exports WHERE id = $1 AND organization_id = $2",
    )
    .bind(export_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Export {export_id} not found")))?;

    let scope: String = def.get("scope");
    let filters: Value = def.get("filters");

    let row_count = count_scope_rows(&state, org_id, &scope, &filters).await;

    let run = sqlx::query(
        r#"INSERT INTO bi_export_runs (export_id, organization_id, status, row_count)
           VALUES ($1, $2, 'completed', $3)
           RETURNING id, created_at"#,
    )
    .bind(export_id)
    .bind(org_id)
    .bind(row_count)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "run_id": run.get::<Uuid, _>("id"),
            "export_id": export_id,
            "row_count": row_count,
            "created_at": run.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        }
    })))
}

pub async fn list_runs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, export_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(page): axum::extract::Query<crate::utils::pagination::PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, export_id, status, row_count, error_message, created_at
           FROM bi_export_runs
           WHERE export_id = $1 AND organization_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(export_id)
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bi_export_runs WHERE export_id = $1 AND organization_id = $2",
    )
    .bind(export_id)
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "export_id": r.get::<Uuid, _>("export_id"),
                "status": r.get::<String, _>("status"),
                "row_count": r.get::<i64, _>("row_count"),
                "error_message": r.get::<Option<String>, _>("error_message"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(
        json!({ "data": data, "meta": crate::utils::pagination::page_meta_json(total, &bounds) }),
    ))
}

/// Download the export payload as CSV or JSON (re-queried at download time).
pub async fn download_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, export_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let def = sqlx::query(
        "SELECT name, format, scope, filters FROM bi_exports WHERE id = $1 AND organization_id = $2",
    )
    .bind(export_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("Export {export_id} not found")))?;

    let name: String = def.get("name");
    let format: String = def.get("format");
    let scope: String = def.get("scope");
    let filters: Value = def.get("filters");

    let rows = fetch_scope_rows(&state, org_id, &scope, &filters).await;

    let (content_type, body, file_ext) = if format == "json" {
        (
            "application/json",
            serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "[]".into()),
            "json",
        )
    } else {
        ("text/csv", rows_to_csv(&rows), "csv")
    };

    let disposition = format!(
        "attachment; filename=\"{}-{}.{}\"",
        name,
        chrono::Utc::now().format("%Y%m%d-%H%M%S"),
        file_ext
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
        ],
        Body::from(body),
    )
        .into_response())
}

// ─── scope queries ───────────────────────────────────────────────────────────

async fn count_scope_rows(state: &AppState, org_id: Uuid, scope: &str, filters: &Value) -> i64 {
    match scope {
        "recommendations" => sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM recommendations WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0),
        "resources" => sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM resources WHERE organization_id = $1",
        )
        .bind(org_id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0),
        _ => {
            let (start, end) = date_bounds(filters);
            if let (Some(s), Some(e)) = (start, end) {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM expenses WHERE organization_id = $1 AND date BETWEEN $2 AND $3",
                )
                .bind(org_id)
                .bind(s)
                .bind(e)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0)
            } else {
                sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM expenses WHERE organization_id = $1",
                )
                .bind(org_id)
                .fetch_one(&state.db)
                .await
                .unwrap_or(0)
            }
        }
    }
}

async fn fetch_scope_rows(
    state: &AppState,
    org_id: Uuid,
    scope: &str,
    filters: &Value,
) -> Vec<Value> {
    match scope {
        "recommendations" => {
            let rows = sqlx::query(
                r#"SELECT id, rec_type, title, status, potential_savings,
                          current_monthly_cost, cloud_resource_id, created_at
                   FROM recommendations WHERE organization_id = $1
                   ORDER BY potential_savings DESC
                   LIMIT 10000"#,
            )
            .bind(org_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

            rows.iter()
                .map(|r| {
                    json!({
                        "id": r.get::<Uuid, _>("id"),
                        "rec_type": r.get::<String, _>("rec_type"),
                        "title": r.get::<String, _>("title"),
                        "status": r.get::<String, _>("status"),
                        "potential_savings": r.get::<f64, _>("potential_savings"),
                        "current_monthly_cost": r.get::<f64, _>("current_monthly_cost"),
                        "cloud_resource_id": r.get::<Option<String>, _>("cloud_resource_id"),
                        "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                    })
                })
                .collect()
        }
        "resources" => {
            let rows = sqlx::query(
                r#"SELECT id, name, resource_type, service_name, cloud_resource_id,
                          region, total_cost::float8 AS total_cost, tags
                   FROM resources WHERE organization_id = $1
                   ORDER BY total_cost DESC
                   LIMIT 10000"#,
            )
            .bind(org_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

            rows.iter()
                .map(|r| {
                    json!({
                        "id": r.get::<Uuid, _>("id"),
                        "name": r.get::<Option<String>, _>("name"),
                        "resource_type": r.get::<Option<String>, _>("resource_type"),
                        "service_name": r.get::<Option<String>, _>("service_name"),
                        "cloud_resource_id": r.get::<String, _>("cloud_resource_id"),
                        "region": r.get::<Option<String>, _>("region"),
                        "total_cost": r.get::<f64, _>("total_cost"),
                        "tags": r.get::<Value, _>("tags"),
                    })
                })
                .collect()
        }
        _ => {
            let (start, end) = date_bounds(filters);
            let rows = if let (Some(s), Some(e)) = (start, end) {
                sqlx::query(
                    r#"SELECT date, cloud_resource_id, resource_name, service_name,
                              cloud_region, resource_type::text AS resource_type, cost::float8 AS cost, currency
                       FROM expenses
                       WHERE organization_id = $1 AND date BETWEEN $2 AND $3
                       ORDER BY date
                       LIMIT 100000"#,
                )
                .bind(org_id)
                .bind(s)
                .bind(e)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default()
            } else {
                sqlx::query(
                    r#"SELECT date, cloud_resource_id, resource_name, service_name,
                              cloud_region, resource_type::text AS resource_type, cost::float8 AS cost, currency
                       FROM expenses
                       WHERE organization_id = $1
                       ORDER BY date
                       LIMIT 100000"#,
                )
                .bind(org_id)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default()
            };

            rows.iter()
                .map(|r| {
                    json!({
                        "date": r.get::<chrono::NaiveDate, _>("date"),
                        "cloud_resource_id": r.get::<String, _>("cloud_resource_id"),
                        "resource_name": r.get::<Option<String>, _>("resource_name"),
                        "service_name": r.get::<Option<String>, _>("service_name"),
                        "cloud_region": r.get::<Option<String>, _>("cloud_region"),
                        "resource_type": r.get::<Option<String>, _>("resource_type"),
                        "cost": r.get::<f64, _>("cost"),
                        "currency": r.get::<Option<String>, _>("currency"),
                    })
                })
                .collect()
        }
    }
}

fn date_bounds(filters: &Value) -> (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>) {
    let parse = |key: &str| {
        filters
            .get(key)
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    };
    (parse("start_date"), parse("end_date"))
}

fn rows_to_csv(rows: &[Value]) -> String {
    use std::fmt::Write as _;

    let mut headers: Vec<String> = Vec::new();
    for row in rows.iter().take(1) {
        if let Some(obj) = row.as_object() {
            headers = obj.keys().cloned().collect();
        }
    }
    if headers.is_empty() {
        return String::new();
    }

    let mut out = String::new();
    let _ = writeln!(out, "{}", headers.join(","));
    for row in rows {
        let cells: Vec<String> = headers
            .iter()
            .map(|h| {
                let v = row.get(h).unwrap_or(&Value::Null);
                match v {
                    Value::Null => String::new(),
                    Value::String(s) => format!("\"{}\"", s.replace('"', "\"\"")),
                    other => other.to_string(),
                }
            })
            .collect();
        let _ = writeln!(out, "{}", cells.join(","));
    }
    out
}
