//! CI CSV import / export / template (gap closure T7).
//!
//! - `GET /ci-types/{id}/import-template` — CSV header + example row generated
//!   from the type's attribute definitions.
//! - `POST /cis/import` — multipart CSV upload, server-side parse; each row
//!   runs the T1 attribute validator + T2 unique-constraint check, with a
//!   per-row result and a `skip|upsert` conflict strategy.
//! - `GET /cis/export` — CSV export reusing the exact list filters.

use axum::{
    extract::{Extension, Multipart, Path, Query, State},
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

use super::validation::{self, AttrDef};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
    sqlx::query("SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not a member of this organization".into()))?;
    Ok(())
}

/// Fixed leading columns every template carries, before the dynamic attributes.
const FIXED_COLUMNS: [&str; 4] = ["name", "display_name", "cloud_provider", "cloud_region"];

// ─── Import template ─────────────────────────────────────────────────────────

/// GET /api/v1/orgs/{org_id}/ci-types/{type_id}/import-template
///
/// Generates a CSV template for the CI type: fixed columns (name,
/// display_name, cloud_provider, cloud_region) followed by one column per
/// attribute definition. The second row carries an example value per column
/// (default_value when set, otherwise a type-appropriate placeholder).
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/ci-types/{type_id}/import-template",
    params(
        ("org_id"  = Uuid, Path, description = "Organization ID"),
        ("type_id" = Uuid, Path, description = "CI type ID"),
    ),
    responses(
        (status = 200, description = "CSV template (text/csv attachment)"),
        (status = 404, description = "CI type not found"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn ci_import_template(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, type_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let type_row = sqlx::query(
        "SELECT display_name FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;
    let type_name: String = type_row.try_get("display_name").unwrap_or_default();

    let attrs = validation::load_attr_defs(&state.db, type_id).await?;

    let mut w = csv::Writer::from_writer(vec![]);
    let mut header: Vec<&str> = FIXED_COLUMNS.to_vec();
    header.extend(attrs.iter().map(|a| a.name.as_str()));
    // Header + example row (csv crate quotes as needed).
    let example: Vec<String> = header.iter().map(|h| example_value(h, &attrs)).collect();
    w.write_record(&header)
        .map_err(|e| AppError::Internal(e.into()))?;
    w.write_record(&example)
        .map_err(|e| AppError::Internal(e.into()))?;
    // A comment row documenting enum values, so users see allowed choices.
    let enum_doc: Vec<String> = header
        .iter()
        .map(|h| {
            attrs
                .iter()
                .find(|a| a.name == *h)
                .and_then(|a| a.enum_values.as_ref())
                .and_then(|v| v.as_array())
                .map(|vals| {
                    format!(
                        "one of: {}",
                        vals.iter()
                            .filter_map(|x| x.as_str())
                            .collect::<Vec<_>>()
                            .join("|")
                    )
                })
                .unwrap_or_default()
        })
        .collect();
    w.write_record(&enum_doc)
        .map_err(|e| AppError::Internal(e.into()))?;

    let body = w.into_inner().map_err(|e| AppError::Internal(e.into()))?;
    let filename = format!(
        "{}_import_template.csv",
        type_name.to_lowercase().replace(' ', "_")
    );

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        body,
    )
        .into_response())
}

fn example_value(column: &str, attrs: &[AttrDef]) -> String {
    if let Some(attr) = attrs.iter().find(|a| a.name == column) {
        if let Some(default) = attr.validation_default_placeholder() {
            return default;
        }
        return match attr.attribute_type.as_str() {
            "integer" => "4".into(),
            "float" => "8.5".into(),
            "boolean" => "true".into(),
            "datetime" => "2026-01-31".into(),
            "enum" => attr
                .enum_values
                .as_ref()
                .and_then(|v| v.as_array())
                .and_then(|vals| vals.first())
                .and_then(|x| x.as_str())
                .unwrap_or("option_a")
                .to_string(),
            "list" => "a,b".into(),
            "json" => "{}".into(),
            "url" => "https://example.com".into(),
            "ip_address" => "10.0.0.1".into(),
            "cidr" => "10.0.0.0/8".into(),
            _ => "text".into(),
        };
    }
    match column {
        "name" => "web-server-01".into(),
        "display_name" => "Web Server 01".into(),
        "cloud_provider" => "aws".into(),
        "cloud_region" => "us-east-1".into(),
        _ => String::new(),
    }
}

impl AttrDef {
    fn validation_default_placeholder(&self) -> Option<String> {
        // default_value is stored as TEXT on the attribute; surface it as the
        // example when present.
        self.stored_default.clone()
    }
}

// ─── CSV import ──────────────────────────────────────────────────────────────

/// POST /api/v1/orgs/{org_id}/cis/import
///
/// Multipart body: `file` = CSV following the import template layout, plus an
/// optional `conflict_strategy` field (`skip` default | `upsert`) and an
/// optional `ci_type_id` (falls back to the template the file came from —
/// required here because the CSV itself does not carry the type).
///
/// Each row is validated (T1) and unique-checked (T2); upsert matches an
/// existing CI by the unique-constraint values, else by name within the type.
/// Hard limit: 1000 rows.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cis/import",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body(content = String, description = "multipart/form-data: file (CSV), ci_type_id, conflict_strategy=skip|upsert"),
    responses(
        (status = 200, description = "Per-row import results"),
        (status = 422, description = "Malformed request (missing file / unknown type / too many rows)"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn cis_import_csv(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut ci_type_id: Option<Uuid> = None;
    let mut strategy = "skip".to_string();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Validation(format!("malformed multipart body: {e}")))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::Validation(format!("cannot read file field: {e}")))?;
                file_bytes = Some(data.to_vec());
            }
            "ci_type_id" => {
                let raw = field
                    .text()
                    .await
                    .map_err(|e| AppError::Validation(format!("cannot read ci_type_id: {e}")))?;
                ci_type_id = Uuid::parse_str(raw.trim()).ok();
            }
            "conflict_strategy" => {
                let raw = field.text().await.map_err(|e| {
                    AppError::Validation(format!("cannot read conflict_strategy: {e}"))
                })?;
                let raw = raw.trim();
                if raw == "upsert" || raw == "skip" {
                    strategy = raw.to_string();
                }
            }
            _ => {}
        }
    }

    let file_bytes = file_bytes
        .ok_or_else(|| AppError::Validation("multipart field 'file' (CSV) is required".into()))?;
    let ci_type_id = ci_type_id
        .ok_or_else(|| AppError::Validation("multipart field 'ci_type_id' is required".into()))?;

    // Type must be visible to this org.
    sqlx::query(
        "SELECT id FROM ci_types WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) AND deleted_at IS NULL",
    )
    .bind(ci_type_id)
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("CI type not found".into()))?;

    let attr_defs = validation::load_attr_defs(&state.db, ci_type_id).await?;
    let known_attrs: std::collections::HashMap<&str, &AttrDef> =
        attr_defs.iter().map(|a| (a.name.as_str(), a)).collect();

    let mut rdr = csv::Reader::from_reader(file_bytes.as_slice());
    let headers = rdr
        .headers()
        .map_err(|e| AppError::Validation(format!("cannot parse CSV header: {e}")))?
        .clone();

    let mut results: Vec<Value> = Vec::new();
    let mut created = 0usize;
    let mut updated = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut row_idx = 0usize;

    for record in rdr.records() {
        row_idx += 1;
        if row_idx > 1000 {
            return Err(AppError::Validation(
                "import is limited to 1000 rows per file".into(),
            ));
        }
        let record = match record {
            Ok(r) => r,
            Err(e) => {
                failed += 1;
                results.push(json!({ "row": row_idx, "status": "error", "error": format!("CSV parse: {e}") }));
                continue;
            }
        };

        let mut name = String::new();
        let mut display_name: Option<String> = None;
        let mut cloud_provider: Option<String> = None;
        let mut cloud_region: Option<String> = None;
        let mut meta = serde_json::Map::new();
        let mut row_error: Option<String> = None;

        for (i, header) in headers.iter().enumerate() {
            let cell = record.get(i).unwrap_or("").trim().to_string();
            if cell.is_empty() {
                continue;
            }
            if row_error.is_some() {
                break;
            }
            match header {
                "name" => name = cell,
                "display_name" => display_name = Some(cell),
                "cloud_provider" => cloud_provider = Some(cell),
                "cloud_region" => cloud_region = Some(cell),
                h if known_attrs.contains_key(h) => {
                    // Coerce the CSV text into the attribute's JSON type.
                    match coerce_csv_value(&cell, known_attrs[h]) {
                        Ok(v) => {
                            meta.insert(h.to_string(), v);
                        }
                        Err(msg) => row_error = Some(msg),
                    }
                }
                _ => {} // unknown columns ignored (template drift tolerance)
            }
        }

        if let Some(msg) = row_error {
            failed += 1;
            results.push(json!({ "row": row_idx, "name": name, "status": "error", "error": msg }));
            continue;
        }

        if name.is_empty() {
            failed += 1;
            results.push(
                json!({ "row": row_idx, "status": "error", "error": "name column is required" }),
            );
            continue;
        }

        let meta_value = Value::Object(meta);

        // T1 validation.
        if let Err(errors) = validation::validate_meta(&attr_defs, &meta_value) {
            failed += 1;
            let msgs: Vec<Value> = errors.iter().map(|ve| ve.to_json()).collect();
            results
                .push(json!({ "row": row_idx, "name": name, "status": "error", "errors": msgs }));
            continue;
        }

        // T2 unique check (create path; upsert resolves the conflict instead).
        // Falls back to a same-name match within the CI type when no unique
        // constraint is configured — a CSV re-run must not double-import.
        let unique_hit =
            validation::check_unique_constraints(&state.db, org_id, ci_type_id, &meta_value, None)
                .await;
        let existing_id: Option<Uuid> = match unique_hit {
            Ok(()) => sqlx::query_scalar::<_, Uuid>(
                r#"SELECT id FROM cis
                   WHERE organization_id = $1 AND ci_type_id = $2 AND name = $3 AND deleted_at IS NULL
                   LIMIT 1"#,
            )
            .bind(org_id)
            .bind(ci_type_id)
            .bind(&name)
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None),
            Err(AppError::Structured(_, code, _, details)) if code == "ERR_DUPLICATE" => {
                details
                    .get("existing_ci_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "row": row_idx, "name": name, "status": "error", "error": e.to_string() }));
                continue;
            }
        };

        if let Some(existing) = existing_id {
            if strategy == "skip" {
                skipped += 1;
                results.push(json!({ "row": row_idx, "name": name, "status": "skipped", "reason": "duplicate of existing CI" }));
                continue;
            }
            // upsert: merge meta + refresh identity fields.
            let res = sqlx::query(
                r#"UPDATE cis
                   SET meta = meta || $3,
                       display_name = COALESCE($4, display_name),
                       cloud_region = COALESCE($5, cloud_region),
                       updated_at = NOW()
                   WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL"#,
            )
            .bind(existing)
            .bind(org_id)
            .bind(&meta_value)
            .bind(display_name.as_deref())
            .bind(cloud_region.as_deref())
            .execute(&state.db)
            .await;
            match res {
                Ok(_) => {
                    updated += 1;
                    results.push(json!({ "row": row_idx, "name": name, "status": "updated", "ci_id": existing }));
                }
                Err(e) => {
                    failed += 1;
                    results.push(json!({ "row": row_idx, "name": name, "status": "error", "error": e.to_string() }));
                }
            }
            continue;
        }

        let res = sqlx::query(
            r#"INSERT INTO cis (organization_id, ci_type_id, name, display_name, cloud_provider, cloud_region, meta, lifecycle_state, discovered_at)
               VALUES ($1, $2, $3, $4,
                       CASE WHEN $5::text IS NULL THEN NULL ELSE $5::cloud_provider END,
                       $6, $7, 'active', NOW())
               RETURNING id"#,
        )
        .bind(org_id)
        .bind(ci_type_id)
        .bind(&name)
        .bind(display_name.as_deref())
        .bind(cloud_provider.as_deref())
        .bind(cloud_region.as_deref())
        .bind(&meta_value)
        .fetch_optional(&state.db)
        .await;

        match res {
            Ok(Some(row)) => {
                created += 1;
                let id: Uuid = row.try_get("id").unwrap_or_default();
                super::handlers::audit_import_row(&state.db, org_id, Some(user_id), id, &name)
                    .await;
                results.push(
                    json!({ "row": row_idx, "name": name, "status": "created", "ci_id": id }),
                );
            }
            Ok(None) => {
                skipped += 1;
                results.push(json!({ "row": row_idx, "name": name, "status": "skipped", "reason": "conflict: skipped" }));
            }
            Err(e) => {
                failed += 1;
                results.push(json!({ "row": row_idx, "name": name, "status": "error", "error": e.to_string() }));
            }
        }
    }

    Ok(Json(json!({
        "data": {
            "total_rows": row_idx,
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "failed": failed,
            "conflict_strategy": strategy,
            "results": results,
        }
    })))
}

/// CSV text → JSON value for a typed attribute. Returns Err(message) on
/// impossible coercions so the row fails with a precise reason.
fn coerce_csv_value(cell: &str, attr: &AttrDef) -> Result<Value, String> {
    match attr.attribute_type.as_str() {
        "string" | "enum" | "url" | "ip_address" | "cidr" | "datetime" => {
            Ok(Value::String(cell.to_string()))
        }
        "integer" => cell
            .parse::<i64>()
            .map(|n| json!(n))
            .map_err(|_| format!("attribute '{}' expects an integer, got '{cell}'", attr.name)),
        "float" => cell
            .parse::<f64>()
            .map(|n| json!(n))
            .map_err(|_| format!("attribute '{}' expects a number, got '{cell}'", attr.name)),
        "boolean" => match cell.to_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(json!(true)),
            "false" | "0" | "no" => Ok(json!(false)),
            _ => Err(format!(
                "attribute '{}' expects true/false, got '{cell}'",
                attr.name
            )),
        },
        "list" => {
            let items: Vec<Value> = cell.split(',').map(|s| json!(s.trim())).collect();
            Ok(Value::Array(items))
        }
        "json" => serde_json::from_str(cell)
            .map_err(|e| format!("attribute '{}' expects valid JSON: {e}", attr.name)),
        _ => Ok(Value::String(cell.to_string())),
    }
}

// ─── CSV export ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CiExportQuery {
    pub format: Option<String>,
    pub ci_type_id: Option<Uuid>,
    pub lifecycle_state: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    pub cloud_provider: Option<String>,
    pub search: Option<String>,
    /// Hard cap on exported rows (default 5000, max 20000).
    pub limit: Option<i64>,
}

/// GET /api/v1/orgs/{org_id}/cis/export
///
/// Streams the CI list as CSV using the exact same filters as `GET /cis`
/// (ci_type_id / lifecycle_state / cloud_account_id / cloud_provider /
/// search). Only `format=csv` is supported (XLSX is P3).
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cis/export",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("format" = String, Query, description = "Export format: csv"),
    ),
    responses(
        (status = 200, description = "CSV file (text/csv)"),
        (status = 400, description = "Unsupported format"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn cis_export_csv(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(q): Query<CiExportQuery>,
) -> AppResult<Response> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if let Some(fmt) = q.format.as_deref() {
        if fmt != "csv" {
            return Err(AppError::Validation(format!(
                "unsupported export format '{fmt}' — only csv is supported"
            )));
        }
    }
    let limit = q.limit.unwrap_or(5000).clamp(1, 20000);

    let mut conditions = vec![
        "c.organization_id = $1".to_string(),
        "c.deleted_at IS NULL".to_string(),
    ];
    let mut bind_idx = 2usize;
    if q.ci_type_id.is_some() {
        conditions.push(format!("c.ci_type_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.lifecycle_state.is_some() {
        conditions.push(format!("c.lifecycle_state::text = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.cloud_account_id.is_some() {
        conditions.push(format!("c.cloud_account_id = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.cloud_provider.is_some() {
        conditions.push(format!("c.cloud_provider::text = ${bind_idx}"));
        bind_idx += 1;
    }
    if q.search.is_some() {
        conditions.push(format!(
            "(c.name ILIKE ${bind_idx} OR c.cloud_resource_id ILIKE ${bind_idx})"
        ));
        bind_idx += 1;
    }

    let sql = format!(
        r#"SELECT c.id, c.name, c.display_name, c.cloud_provider::text AS cloud_provider,
                  c.cloud_region, c.cloud_resource_id, c.lifecycle_state::text AS lifecycle_state,
                  c.tags, c.meta, c.created_at
           FROM cis c WHERE {}
           ORDER BY c.created_at DESC
           LIMIT {}"#,
        conditions.join(" AND "),
        bind_idx
    );

    let mut query = sqlx::query(sqlx::AssertSqlSafe(&*sql)).bind(org_id);
    if let Some(v) = q.ci_type_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.lifecycle_state {
        query = query.bind(v);
    }
    if let Some(v) = q.cloud_account_id {
        query = query.bind(v);
    }
    if let Some(ref v) = q.cloud_provider {
        query = query.bind(v);
    }
    if let Some(ref v) = q.search {
        query = query.bind(format!("%{v}%"));
    }
    // Final bind: the LIMIT placeholder built into the SQL above.
    let rows = query.bind(limit).fetch_all(&state.db).await?;

    let mut w = csv::Writer::from_writer(vec![]);
    w.write_record([
        "id",
        "name",
        "display_name",
        "cloud_provider",
        "cloud_region",
        "cloud_resource_id",
        "lifecycle_state",
        "tags",
        "meta",
        "created_at",
    ])
    .map_err(|e| AppError::Internal(e.into()))?;

    for r in &rows {
        let tags: Value = r.try_get::<Value, _>("tags").unwrap_or_else(|_| json!({}));
        let meta: Value = r.try_get::<Value, _>("meta").unwrap_or_else(|_| json!({}));
        w.write_record(&[
            r.try_get::<Uuid, _>("id")
                .map(|u| u.to_string())
                .unwrap_or_default(),
            r.try_get::<String, _>("name").unwrap_or_default(),
            r.try_get::<Option<String>, _>("display_name")
                .unwrap_or(None)
                .unwrap_or_default(),
            r.try_get::<Option<String>, _>("cloud_provider")
                .unwrap_or(None)
                .unwrap_or_default(),
            r.try_get::<Option<String>, _>("cloud_region")
                .unwrap_or(None)
                .unwrap_or_default(),
            r.try_get::<Option<String>, _>("cloud_resource_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            r.try_get::<String, _>("lifecycle_state")
                .unwrap_or_default(),
            serde_json::to_string(&tags).unwrap_or_default(),
            serde_json::to_string(&meta).unwrap_or_default(),
            r.try_get::<chrono::DateTime<chrono::Utc>, _>("created_at")
                .map(|d| d.to_rfc3339())
                .unwrap_or_default(),
        ])
        .map_err(|e| AppError::Internal(e.into()))?;
    }

    let body = w.into_inner().map_err(|e| AppError::Internal(e.into()))?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"cis_export.csv\"".to_string(),
            ),
        ],
        body,
    )
        .into_response())
}
