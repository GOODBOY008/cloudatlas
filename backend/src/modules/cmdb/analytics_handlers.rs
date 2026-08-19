use axum::{
    extract::{Extension, Path, State},
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

// ─── CMDB Statistics ────────────────────────────────────────────────────────

pub async fn cmdb_stats(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Total CIs
    let total_cis: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cis WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    // CIs by lifecycle state
    let lifecycle_rows = sqlx::query(
        r#"SELECT lifecycle_state::text AS state, COUNT(*) AS cnt
           FROM cis
           WHERE organization_id = $1 AND deleted_at IS NULL
           GROUP BY lifecycle_state
           ORDER BY cnt DESC"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let lifecycle_dist: Vec<Value> = lifecycle_rows
        .iter()
        .map(|r| {
            json!({
                "state": r.get::<String, _>("state"),
                "count": r.get::<i64, _>("cnt"),
            })
        })
        .collect();

    // CIs by CI type (top 10)
    let type_rows = sqlx::query(
        r#"SELECT ct.name AS type_name, ct.display_name AS type_display,
                  COUNT(c.id) AS cnt
           FROM ci_types ct
           LEFT JOIN cis c ON c.ci_type_id = ct.id
               AND c.organization_id = $1 AND c.deleted_at IS NULL
           WHERE (ct.organization_id = $1 OR ct.organization_id IS NULL)
           GROUP BY ct.id
           ORDER BY cnt DESC
           LIMIT 10"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let type_dist: Vec<Value> = type_rows
        .iter()
        .map(|r| {
            json!({
                "type_name": r.get::<String, _>("type_name"),
                "type_display": r.get::<String, _>("type_display"),
                "count": r.get::<i64, _>("cnt"),
            })
        })
        .collect();

    // Recent CI changes (last 7 days)
    let recent_changes: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM ci_audit_logs
           WHERE organization_id = $1 AND created_at > NOW() - INTERVAL '7 days'"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    // Active services
    let total_services: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM services WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    // Compliance summary
    let compliance_total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM compliance_policies WHERE organization_id = $1 AND deleted_at IS NULL AND is_active = true",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    let non_compliant: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(DISTINCT ci_id) FROM ci_compliance
           WHERE organization_id = $1 AND is_compliant = false"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    // Open drift items
    let open_drift: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ci_drift WHERE organization_id = $1 AND status = 'open'",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await?;

    // Dynamic groups
    let total_groups: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ci_dynamic_groups WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await?;

    // Recent audit entries (last 10)
    let recent_audit_rows = sqlx::query(
        r#"SELECT al.id, al.operation, al.created_at,
                  c.name AS ci_name, c.id AS ci_id
           FROM ci_audit_logs al
           JOIN cis c ON c.id = al.ci_id
           WHERE al.organization_id = $1
           ORDER BY al.created_at DESC
           LIMIT 10"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let recent_audit: Vec<Value> = recent_audit_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "operation": r.get::<String, _>("operation"),
                "ci_id": r.get::<Uuid, _>("ci_id"),
                "ci_name": r.get::<String, _>("ci_name"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": {
            "total_cis": total_cis,
            "lifecycle_distribution": lifecycle_dist,
            "type_distribution": type_dist,
            "recent_changes_7d": recent_changes,
            "total_services": total_services,
            "compliance": {
                "active_policies": compliance_total,
                "non_compliant_cis": non_compliant,
            },
            "open_drift": open_drift,
            "total_dynamic_groups": total_groups,
            "recent_audit": recent_audit,
        }
    })))
}

// ─── Model Topology ────────────────────────────────────────────────────────
/// Returns all CI types and the object associations between them.
pub async fn model_topology(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Nodes: CI types
    let type_rows = sqlx::query(
        r#"SELECT t.id, t.name, t.display_name, t.icon, t.is_builtin,
                  cl.name AS classification_name,
                  COUNT(DISTINCT c.id) AS ci_count
           FROM ci_types t
           LEFT JOIN ci_classifications cl ON cl.id = t.classification_id
           LEFT JOIN cis c ON c.ci_type_id = t.id
               AND c.organization_id = $1 AND c.deleted_at IS NULL
           WHERE (t.organization_id = $1 OR t.organization_id IS NULL)
           GROUP BY t.id, cl.name
           ORDER BY t.name"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let nodes: Vec<Value> = type_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "display_name": r.get::<String, _>("display_name"),
                "icon": r.get::<Option<String>, _>("icon"),
                "is_builtin": r.get::<bool, _>("is_builtin"),
                "classification": r.get::<Option<String>, _>("classification_name"),
                "ci_count": r.get::<i64, _>("ci_count"),
            })
        })
        .collect();

    // Edges: object associations
    let edge_rows = sqlx::query(
        r#"SELECT oa.id, oa.src_ci_type_id, oa.dst_ci_type_id,
                  oa.cardinality::text AS cardinality,
                  ak.name AS kind_name, ak.display_name AS kind_display,
                  ak.is_directional
           FROM ci_object_associations oa
           JOIN ci_association_kinds ak ON ak.id = oa.association_kind_id
           WHERE (oa.organization_id = $1 OR oa.organization_id IS NULL)"#,
    )
    .bind(org_id)
    .fetch_all(&state.db)
    .await?;

    let edges: Vec<Value> = edge_rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "source": r.get::<Uuid, _>("src_ci_type_id"),
                "target": r.get::<Uuid, _>("dst_ci_type_id"),
                "kind_name": r.get::<String, _>("kind_name"),
                "kind_display": r.get::<String, _>("kind_display"),
                "cardinality": r.get::<String, _>("cardinality"),
                "directed": r.get::<bool, _>("is_directional"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": { "nodes": nodes, "edges": edges } })))
}

// ─── Bulk CI Import ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BulkCiImportItem {
    pub name: String,
    pub display_name: Option<String>,
    pub ci_type_id: Uuid,
    pub cloud_region: Option<String>,
    pub cloud_provider: Option<String>,
    pub meta: Option<Value>,
    pub tags: Option<Value>,
}

#[derive(Deserialize)]
pub struct BulkCiImportRequest {
    pub items: Vec<BulkCiImportItem>,
}

pub async fn bulk_import_cis(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<BulkCiImportRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    if body.items.is_empty() {
        return Err(AppError::Validation("Import list cannot be empty".into()));
    }
    if body.items.len() > 500 {
        return Err(AppError::Validation(
            "Bulk import is limited to 500 CIs per request".into(),
        ));
    }

    let mut created = 0usize;
    let mut errors: Vec<Value> = vec![];

    // T1/T2: attribute definitions + unique constraints, cached per CI type so
    // a 500-row import of one type does not re-fetch definitions per row.
    let mut attr_cache: std::collections::HashMap<
        Uuid,
        Vec<crate::modules::cmdb::validation::AttrDef>,
    > = std::collections::HashMap::new();

    for (idx, item) in body.items.iter().enumerate() {
        if item.name.trim().is_empty() {
            errors.push(json!({ "index": idx, "error": "name is required" }));
            continue;
        }

        let meta = item.meta.clone().unwrap_or(json!({}));

        // T1: validate against the type's attribute definitions.
        let attr_defs = match attr_cache.get(&item.ci_type_id) {
            Some(defs) => defs.clone(),
            None => {
                match crate::modules::cmdb::validation::load_attr_defs(&state.db, item.ci_type_id)
                    .await
                {
                    Ok(defs) => {
                        attr_cache.insert(item.ci_type_id, defs.clone());
                        defs
                    }
                    Err(e) => {
                        errors.push(
                            json!({ "index": idx, "name": item.name, "error": e.to_string() }),
                        );
                        continue;
                    }
                }
            }
        };
        if let Err(ves) = crate::modules::cmdb::validation::validate_meta(&attr_defs, &meta) {
            let msgs: Vec<Value> = ves.iter().map(|ve| ve.to_json()).collect();
            errors.push(json!({ "index": idx, "name": item.name, "error": "attribute validation failed", "details": msgs }));
            continue;
        }

        // T2: unique constraints.
        if let Err(e) = crate::modules::cmdb::validation::check_unique_constraints(
            &state.db,
            org_id,
            item.ci_type_id,
            &meta,
            None,
        )
        .await
        {
            errors.push(json!({ "index": idx, "name": item.name, "error": e.to_string() }));
            continue;
        }

        let result = sqlx::query(
            r#"INSERT INTO cis
               (organization_id, ci_type_id, name, display_name,
                cloud_provider, cloud_region, meta, tags, lifecycle_state, discovered_at)
               VALUES ($1, $2, $3, $4,
                       CASE WHEN $5::text IS NULL THEN NULL ELSE $5::cloud_provider END,
                       $6, $7, $8, 'active', NOW())
               ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id)
               DO NOTHING
               RETURNING id"#,
        )
        .bind(org_id)
        .bind(item.ci_type_id)
        .bind(item.name.trim())
        .bind(&item.display_name)
        .bind(&item.cloud_provider)
        .bind(&item.cloud_region)
        .bind(item.meta.clone().unwrap_or(json!({})))
        .bind(item.tags.clone().unwrap_or(json!({})))
        .fetch_optional(&state.db)
        .await;

        match result {
            Ok(Some(_)) => created += 1,
            Ok(None) => errors
                .push(json!({ "index": idx, "name": item.name, "error": "conflict: skipped" })),
            Err(e) => {
                errors.push(json!({ "index": idx, "name": item.name, "error": e.to_string() }))
            }
        }
    }

    Ok(Json(json!({
        "data": {
            "total_submitted": body.items.len(),
            "created": created,
            "skipped": body.items.len() - created - errors.len(),
            "errors": errors,
        }
    })))
}

// ─── CMDB Audit Logs (paginated) ───────────────────────────────────────────

#[derive(Deserialize)]
pub struct AuditLogQuery {
    pub ci_id: Option<Uuid>,
    pub operation: Option<String>,
    /// T4: filter by audit target kind — ci | ci_type | ci_attribute |
    /// ci_classification | ci_association_kind | ci_object_association |
    /// service | service_template | field_template.
    pub resource_type: Option<String>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

pub async fn list_cmdb_audit_logs(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<AuditLogQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = q.page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    // LEFT JOINs: model-layer audit rows (T4) have ci_id NULL.
    let rows = sqlx::query(
        r#"SELECT al.id, al.ci_id, al.user_id, al.operation,
                  al.field_changes, al.source, al.created_at,
                  al.resource_type, al.resource_id, al.resource_name,
                  c.name AS ci_name, c.ci_type_id,
                  ct.display_name AS ci_type_display,
                  u.email AS user_email
           FROM ci_audit_logs al
           LEFT JOIN cis c ON c.id = al.ci_id
           LEFT JOIN ci_types ct ON ct.id = c.ci_type_id
           LEFT JOIN users u ON u.id = al.user_id
           WHERE al.organization_id = $1
             AND ($2::uuid IS NULL OR al.ci_id = $2)
             AND ($3::text IS NULL OR al.operation = $3)
             AND ($4::text IS NULL OR al.resource_type = $4)
           ORDER BY al.created_at DESC
           LIMIT $5 OFFSET $6"#,
    )
    .bind(org_id)
    .bind(q.ci_id)
    .bind(&q.operation)
    .bind(&q.resource_type)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM ci_audit_logs
           WHERE organization_id = $1
             AND ($2::uuid IS NULL OR ci_id = $2)
             AND ($3::text IS NULL OR operation = $3)
             AND ($4::text IS NULL OR resource_type = $4)"#,
    )
    .bind(org_id)
    .bind(q.ci_id)
    .bind(&q.operation)
    .bind(&q.resource_type)
    .fetch_one(&state.db)
    .await?;

    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_id": r.get::<Option<Uuid>, _>("ci_id"),
                "ci_name": r.get::<Option<String>, _>("ci_name"),
                "ci_type_display": r.get::<Option<String>, _>("ci_type_display"),
                "resource_type": r.get::<String, _>("resource_type"),
                "resource_id": r.get::<Option<String>, _>("resource_id"),
                "resource_name": r.get::<Option<String>, _>("resource_name"),
                "user_id": r.get::<Option<Uuid>, _>("user_id"),
                "user_email": r.get::<Option<String>, _>("user_email"),
                "operation": r.get::<String, _>("operation"),
                "field_changes": r.get::<Option<Value>, _>("field_changes"),
                "source": r.get::<String, _>("source"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": data,
        "meta": crate::utils::pagination::page_meta_json(total, &bounds)
    })))
}

// ─── CI Change Events (T6 — cursor-paged polling stream) ────────────────────

#[derive(Deserialize)]
pub struct CiEventsQuery {
    /// Return only events with id strictly greater than this cursor.
    pub after: Option<i64>,
    /// Comma-separated event type filter, e.g. `ci.created,ci.updated`.
    pub types: Option<String>,
    /// Page size (default 100, max 500).
    pub limit: Option<i64>,
    /// Optional CI filter.
    pub ci_id: Option<Uuid>,
}

/// GET /api/v1/orgs/{org_id}/cmdb/events
///
/// Polling event stream (lightweight resource watch): newest-first
/// rows from `ci_events`, paged with the `after=<id>` cursor. The response
/// carries `next_after` (the id to continue from) and `latest_id` (for
/// long-poll anchors).
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cmdb/events",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("after"  = i64, Query, description = "Cursor: return events with id > after"),
        ("types"  = String, Query, description = "Comma-separated event types (ci.created,ci.updated,...)"),
        ("limit"  = i64, Query, description = "Page size (default 100, max 500)"),
    ),
    responses(
        (status = 200, description = "Event page with cursor metadata"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn list_ci_events(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<CiEventsQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let after = q.after.unwrap_or(0);

    let allowed_types = [
        "ci.created",
        "ci.updated",
        "ci.deleted",
        "ci.lifecycle_changed",
        "ci.association_changed",
    ];
    let type_filter: Vec<String> = q
        .types
        .as_deref()
        .map(|t| {
            t.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| allowed_types.contains(&s.as_str()))
                .collect()
        })
        .unwrap_or_default();

    let rows = sqlx::query(
        r#"SELECT id, event_type, ci_id, ci_name, payload, created_at
           FROM ci_events
           WHERE organization_id = $1
             AND id > $2
             AND ($3::uuid IS NULL OR ci_id = $3)
             AND ($4::text[] IS NULL OR event_type = ANY($4))
           ORDER BY id DESC
           LIMIT $5"#,
    )
    .bind(org_id)
    .bind(after)
    .bind(q.ci_id)
    .bind(if type_filter.is_empty() {
        None
    } else {
        Some(type_filter)
    })
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    let latest_id: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM ci_events WHERE organization_id = $1")
            .bind(org_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    let events: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i64, _>("id"),
                "event_type": r.get::<String, _>("event_type"),
                "ci_id": r.get::<Uuid, _>("ci_id"),
                "ci_name": r.get::<Option<String>, _>("ci_name"),
                "payload": r.get::<Value, _>("payload"),
                "created_at": r.get::<i64, _>("created_at"),
            })
        })
        .collect();

    let next_after = events
        .last()
        .and_then(|e| e.get("id"))
        .and_then(|v| v.as_i64())
        .unwrap_or(after);

    Ok(Json(json!({
        "data": events,
        "meta": {
            "count": events.len(),
            "next_after": next_after,
            "latest_id": latest_id,
        }
    })))
}

// ─── CMDB Stats Trends (T14 — daily snapshots) ───────────────────────────────

/// Snapshot one org's CI counts for today (upsert on the daily row). Shared by
/// the daily scheduler; `change_count` derives from that day's audit volume.
pub async fn snapshot_cmdb_stats(db: &sqlx::PgPool, org_id: Uuid) -> AppResult<()> {
    sqlx::query(
        r#"
        WITH by_type AS (
            SELECT COALESCE(jsonb_object_agg(t.name, t.cnt), '{}'::jsonb) AS v
            FROM (
                SELECT ct.name, COUNT(ci.id)::int AS cnt
                FROM cis ci JOIN ci_types ct ON ct.id = ci.ci_type_id
                WHERE ci.organization_id = $1 AND ci.deleted_at IS NULL
                GROUP BY ct.name
            ) t
        ),
        by_lifecycle AS (
            SELECT COALESCE(jsonb_object_agg(c.state, c.cnt), '{}'::jsonb) AS v
            FROM (
                SELECT ci.lifecycle_state::text AS state, COUNT(*)::int AS cnt
                FROM cis ci
                WHERE ci.organization_id = $1 AND ci.deleted_at IS NULL
                GROUP BY ci.lifecycle_state
            ) c
        ),
        total AS (
            SELECT COUNT(*)::int AS v FROM cis
            WHERE organization_id = $1 AND deleted_at IS NULL
        )
        INSERT INTO cmdb_stats_daily (organization_id, snapshot_date, total_cis, by_type, by_lifecycle, change_count)
        SELECT $1, CURRENT_DATE,
               (SELECT v FROM total),
               (SELECT v FROM by_type),
               (SELECT v FROM by_lifecycle),
               (SELECT COUNT(*)::int FROM ci_audit_logs
                WHERE organization_id = $1 AND created_at::date = CURRENT_DATE)
        ON CONFLICT (organization_id, snapshot_date) DO UPDATE SET
            total_cis = EXCLUDED.total_cis,
            by_type = EXCLUDED.by_type,
            by_lifecycle = EXCLUDED.by_lifecycle,
            change_count = EXCLUDED.change_count
        "#,
    )
    .bind(org_id)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct StatsTrendsQuery {
    /// Window length in days (default 30, max 365).
    pub days: Option<i64>,
}

/// GET /api/v1/orgs/{org_id}/cmdb/stats/trends
///
/// Daily snapshots: total CI count and daily change volume over the window,
/// plus per-type / per-lifecycle breakdowns per day.
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/cmdb/stats/trends",
    params(
        ("org_id" = Uuid, Path, description = "Organization ID"),
        ("days"  = i64, Query, description = "Window in days (default 30, max 365)"),
    ),
    responses(
        (status = 200, description = "Daily CI totals and change counts"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn cmdb_stats_trends(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(q): axum::extract::Query<StatsTrendsQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let days = q.days.unwrap_or(30).clamp(1, 365);

    // Snapshot today on read so the chart is never stale by a scheduler miss.
    let _ = snapshot_cmdb_stats(&state.db, org_id).await;

    let rows = sqlx::query(
        r#"SELECT snapshot_date, total_cis, by_type, by_lifecycle, change_count
           FROM cmdb_stats_daily
           WHERE organization_id = $1 AND snapshot_date >= CURRENT_DATE - ($2::int)
           ORDER BY snapshot_date ASC"#,
    )
    .bind(org_id)
    .bind(days as i32)
    .fetch_all(&state.db)
    .await?;

    let points: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "date": r.get::<chrono::NaiveDate, _>("snapshot_date").to_string(),
                "total_cis": r.get::<i32, _>("total_cis"),
                "change_count": r.get::<i32, _>("change_count"),
                "by_type": r.get::<Value, _>("by_type"),
                "by_lifecycle": r.get::<Value, _>("by_lifecycle"),
            })
        })
        .collect();

    Ok(Json(json!({
        "data": {
            "days": days,
            "points": points,
        }
    })))
}
