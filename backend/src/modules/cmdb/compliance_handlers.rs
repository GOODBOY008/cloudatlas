use axum::{
    extract::{Extension, Path, Query, State},
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
    utils::pagination::{page_meta_json, PageQuery},
};

async fn ensure_org_member(db: &sqlx::PgPool, org_id: Uuid, user_id: Uuid) -> AppResult<()> {
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

// ─── Compliance Policies ──────────────────────────────────────────────────────

/// Allowed rule operators. A rule is `{"field": "<json path>", "op": "<op>", "value": ...}`.
/// Field paths resolve against CI fields: `name`, `lifecycle_state`, `cloud_provider`,
/// `tags.<key>`, `meta.<key[.nested]>`.
const RULE_OPS: &[&str] = &[
    "exists", "not_exists", "eq", "ne", "in", "contains", "gte", "lte",
];

/// Validate the `rules` JSONB array against the compliance rule schema.
/// Returns a validation error naming the first offending rule index.
pub fn validate_rules(rules: &Value) -> AppResult<()> {
    let arr = match rules.as_array() {
        Some(a) => a,
        None => {
            return Err(AppError::Validation(
                "rules must be a JSON array of rule objects".into(),
            ))
        }
    };
    if arr.is_empty() {
        return Err(AppError::Validation(
            "rules must contain at least one rule".into(),
        ));
    }

    for (i, rule) in arr.iter().enumerate() {
        let obj = match rule.as_object() {
            Some(o) => o,
            None => {
                return Err(AppError::Validation(format!(
                    "rules[{i}] must be an object with field and op"
                )))
            }
        };
        let field = obj
            .get("field")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if field.is_empty() {
            return Err(AppError::Validation(format!("rules[{i}].field is required")));
        }
        if !field.starts_with("tags.") && !field.starts_with("meta.") {
            match field {
                "name" | "lifecycle_state" | "cloud_provider" => {}
                _ => {
                    return Err(AppError::Validation(format!(
                        "rules[{i}].field must start with 'tags.'/'meta.' or be name/lifecycle_state/cloud_provider"
                    )))
                }
            }
        }
        let op = obj.get("op").and_then(|v| v.as_str()).unwrap_or_default();
        if !RULE_OPS.contains(&op) {
            return Err(AppError::Validation(format!(
                "rules[{i}].op must be one of: {}",
                RULE_OPS.join(", ")
            )));
        }
        if matches!(op, "eq" | "ne" | "in" | "contains" | "gte" | "lte")
            && !obj.contains_key("value")
        {
            return Err(AppError::Validation(format!(
                "rules[{i}].value is required for op '{op}'"
            )));
        }
    }
    Ok(())
}

/// Resolve a dotted field path against a CI record (name / lifecycle_state /
/// cloud_provider / tags.<key> / meta.<key[.nested]>).
fn resolve_field<'a>(
    root: &'a Value,
    path: &str,
) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let head = parts.next()?;
    let mut current = root.get(head)?;
    for part in parts {
        current = current.get(part)?;
    }
    Some(current)
}

/// Evaluate one rule against a CI record. Returns Ok(true/false) — rule value
/// comparison is string-coercive for eq/ne, numeric for gte/lte.
fn evaluate_rule(ci: &Value, rule: &Value) -> bool {
    let obj = match rule.as_object() {
        Some(o) => o,
        None => return false,
    };
    let field = obj.get("field").and_then(|v| v.as_str()).unwrap_or_default();
    let op = obj.get("op").and_then(|v| v.as_str()).unwrap_or_default();
    let value = obj.get("value");

    let resolved = resolve_field(ci, field);

    match op {
        "exists" => resolved.is_some(),
        "not_exists" => resolved.is_none(),
        "eq" => match (resolved, value) {
            (Some(actual), Some(expected)) => {
                json_eq(actual, expected)
            }
            _ => false,
        },
        "ne" => match (resolved, value) {
            (Some(actual), Some(expected)) => !json_eq(actual, expected),
            (None, Some(_)) => true,
            _ => false,
        },
        "in" => match (value, resolved) {
            (Some(Value::Array(choices)), Some(actual)) => choices.iter().any(|c| json_eq(actual, c)),
            _ => false,
        },
        "contains" => match (resolved, value) {
            (Some(Value::String(haystack)), Some(Value::String(needle))) => {
                haystack.contains(needle.as_str())
            }
            _ => false,
        },
        "gte" => match (resolved, value) {
            (Some(actual), Some(expected)) => {
                num_of(actual).zip(num_of(expected)).map(|(a, b)| a >= b).unwrap_or(false)
            }
            _ => false,
        },
        "lte" => match (resolved, value) {
            (Some(actual), Some(expected)) => {
                num_of(actual).zip(num_of(expected)).map(|(a, b)| a <= b).unwrap_or(false)
            }
            _ => false,
        },
        _ => false,
    }
}

fn json_eq(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        // Coerce string<->number for values like "2" vs 2
        _ => num_of(actual)
            .zip(num_of(expected))
            .map(|(a, b)| (a - b).abs() < f64::EPSILON)
            .unwrap_or(false),
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

#[derive(Deserialize)]
pub struct CreateCompliancePolicyRequest {
    pub name: String,
    pub description: Option<String>,
    pub ci_type_id: Option<Uuid>,
    pub rules: serde_json::Value,
    pub severity: Option<String>,
    /// T16: targeting — all | ci_type | dynamic_group.
    pub target_type: Option<String>,
    pub target_group_id: Option<Uuid>,
}

#[derive(Deserialize)]
pub struct UpdateCompliancePolicyRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub ci_type_id: Option<Uuid>,
    pub rules: Option<serde_json::Value>,
    pub severity: Option<String>,
    pub is_active: Option<bool>,
    pub target_type: Option<String>,
    pub target_group_id: Option<Uuid>,
}

/// Normalize the target type: dynamic_group requires a group id; a group id
/// without an explicit type implies dynamic_group.
fn normalize_target_type(target_type: Option<&str>, group_id: Option<Uuid>) -> Option<String> {
    match target_type {
        Some("dynamic_group") => Some("dynamic_group".into()),
        Some("ci_type") => Some("ci_type".into()),
        Some("all") | None => {
            if group_id.is_some() {
                Some("dynamic_group".into())
            } else {
                Some("all".into())
            }
        }
        Some(other) => Some(other.to_string()),
    }
}

pub async fn list_compliance_policies(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, description, ci_type_id, rules, severity::text AS severity,
                  is_active, created_at, target_type::text AS target_type, target_group_id
           FROM compliance_policies
           WHERE organization_id = $1 AND deleted_at IS NULL
           ORDER BY name, id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM compliance_policies WHERE organization_id = $1 AND deleted_at IS NULL",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let policies: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<Option<String>, _>("description"),
                "ci_type_id": r.get::<Option<Uuid>, _>("ci_type_id"),
                "rules": r.get::<serde_json::Value, _>("rules"),
                "severity": r.get::<Option<String>, _>("severity"),
                "is_active": r.get::<bool, _>("is_active"),
                "target_type": r.get::<String, _>("target_type"),
                "target_group_id": r.get::<Option<Uuid>, _>("target_group_id"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": policies, "meta": page_meta_json(total, &bounds) })))
}

pub async fn create_compliance_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateCompliancePolicyRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    validate_rules(&req.rules)?;

    let severity = req.severity.as_deref().unwrap_or("medium");
    let target_type = normalize_target_type(req.target_type.as_deref(), req.target_group_id);
    let row = sqlx::query(
        r#"INSERT INTO compliance_policies
           (organization_id, name, description, ci_type_id, rules, severity, target_type, target_group_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::compliance_target_type, $8)
           RETURNING id, name, created_at"#,
    )
    .bind(org_id)
    .bind(&req.name)
    .bind(&req.description)
    .bind(req.ci_type_id)
    .bind(&req.rules)
    .bind(severity)
    .bind(target_type)
    .bind(req.target_group_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": row.get::<String, _>("name"),
            "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        }
    })))
}

pub async fn update_compliance_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
    Json(req): Json<UpdateCompliancePolicyRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    if let Some(ref sev) = req.severity {
        if sev != "low" && sev != "medium" && sev != "high" && sev != "critical" {
            return Err(AppError::Validation(
                "severity must be one of: low, medium, high, critical".into(),
            ));
        }
    }
    if let Some(ref rules) = req.rules {
        validate_rules(rules)?;
    }

    let row = sqlx::query(
        r#"UPDATE compliance_policies
           SET
             name = COALESCE($3, name),
             description = COALESCE($4, description),
             ci_type_id = COALESCE($5, ci_type_id),
             rules = COALESCE($6, rules),
             severity = COALESCE($7, severity),
             is_active = COALESCE($8, is_active),
             target_type = COALESCE($9::compliance_target_type, target_type),
             target_group_id = COALESCE($10, target_group_id)
           WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING id, name, description, ci_type_id, rules, severity, is_active, created_at"#,
    )
    .bind(policy_id)
    .bind(org_id)
    .bind(req.name.as_deref())
    .bind(req.description.as_deref())
    .bind(req.ci_type_id)
    .bind(req.rules)
    .bind(req.severity.as_deref())
    .bind(req.is_active)
    .bind(normalize_target_type(req.target_type.as_deref(), req.target_group_id))
    .bind(req.target_group_id)
    .fetch_optional(&state.db)
    .await?;

    let r = row.ok_or_else(|| AppError::NotFound(format!("Compliance policy {policy_id} not found")))?;

    Ok(Json(json!({
        "data": {
            "id": r.get::<Uuid, _>("id"),
            "name": r.get::<String, _>("name"),
            "description": r.get::<Option<String>, _>("description"),
            "ci_type_id": r.get::<Option<Uuid>, _>("ci_type_id"),
            "rules": r.get::<serde_json::Value, _>("rules"),
            "severity": r.get::<Option<String>, _>("severity"),
            "is_active": r.get::<bool, _>("is_active"),
            "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at")
        }
    })))
}

pub async fn delete_compliance_policy(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, policy_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    sqlx::query(
        "UPDATE compliance_policies SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2",
    )
    .bind(policy_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "deleted": true } })))
}

/// Ensure an org-scoped scheduled_jobs row exists for bookkeeping runs and
/// return its id (shared by the manual run + scheduler, T12).
async fn ensure_scheduled_job(
    db: &sqlx::PgPool,
    org_id: Uuid,
    name: &str,
    job_type: &str,
    cron: &str,
) -> AppResult<Uuid> {
    let row = sqlx::query_scalar::<_, Uuid>(
        r#"INSERT INTO scheduled_jobs (organization_id, name, description, job_type, cron_expression, is_enabled)
           VALUES ($1, $2, $3, $4, $5, false)
           ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id"#,
    )
    .bind(org_id)
    .bind(name)
    .bind(name)
    .bind(job_type)
    .bind(cron)
    .fetch_one(db)
    .await?;
    Ok(row)
}

/// Append a job_runs history row for a compliance/drift run (T12 last-run).
async fn record_governance_run(
    db: &sqlx::PgPool,
    org_id: Uuid,
    job_type: &str,
    result: &Value,
    error: Option<&str>,
) {
    let (name, cron) = if job_type == "cmdb_compliance" {
        ("CMDB Compliance Check", "0 2 * * *")
    } else {
        ("CMDB Drift Rescan", "0 */4 * * *")
    };
    let Ok(job_id) = ensure_scheduled_job(db, org_id, name, job_type, cron).await else {
        return;
    };
    let status = if error.is_some() { "failed" } else { "succeeded" };
    let _ = sqlx::query(
        r#"INSERT INTO job_runs (job_id, organization_id, status, started_at, completed_at, result, error_message)
           VALUES ($1, $2, $3::job_status, NOW(), NOW(), $4, $5)"#,
    )
    .bind(job_id)
    .bind(org_id)
    .bind(status)
    .bind(result)
    .bind(error)
    .execute(db)
    .await;
}

/// Compliance evaluation core — shared by the manual HTTP run and the 24h
/// scheduler (T12). Returns the summary JSON.
pub async fn run_compliance_for_org(db: &sqlx::PgPool, org_id: Uuid) -> AppResult<Value> {
    let policies = sqlx::query(
        r#"SELECT id, name, ci_type_id, rules, target_type::text AS target_type, target_group_id
           FROM compliance_policies
           WHERE organization_id = $1 AND is_active = true AND deleted_at IS NULL"#,
    )
    .bind(org_id)
    .fetch_all(db)
    .await?;

    let mut total_checks = 0u64;
    let mut compliant = 0u64;
    let mut non_compliant = 0u64;

    for policy in &policies {
        let policy_id: Uuid = policy.get("id");
        let policy_name: String = policy.get("name");
        let ci_type_id: Option<Uuid> = policy.get("ci_type_id");
        let rules: Value = policy.get("rules");
        let target_type: String = policy
            .try_get::<String, _>("target_type")
            .unwrap_or_else(|_| "all".into());
        let target_group_id: Option<Uuid> = policy.try_get("target_group_id").unwrap_or(None);

        // Target CIs (T16): all / ci_type / dynamic_group membership.
        let cis = if target_type == "dynamic_group" && target_group_id.is_some() {
            let group_id = target_group_id.unwrap();
            let group = sqlx::query(
                "SELECT ci_type_id, conditions FROM ci_dynamic_groups WHERE id = $1 AND organization_id = $2",
            )
            .bind(group_id)
            .bind(org_id)
            .fetch_optional(db)
            .await?;
            if let Some(g) = group {
                let g_type: Option<Uuid> = g.try_get("ci_type_id").unwrap_or(None);
                let conds: Value = g
                    .try_get::<Value, _>("conditions")
                    .unwrap_or_else(|_| json!([]));
                let conditions: Vec<Value> = conds.as_array().cloned().unwrap_or_default();
                let (members, _) = crate::modules::cmdb::handlers::run_dynamic_group_sql(
                    db, org_id, &conditions, g_type.or(ci_type_id), 5000, 0,
                )
                .await?;
                let ids: Vec<Uuid> = members
                    .iter()
                    .filter_map(|m| m.get("id").and_then(|v| v.as_str()).and_then(|x| Uuid::parse_str(x).ok()))
                    .collect();
                sqlx::query(
                    r#"SELECT id, name, lifecycle_state::text AS lifecycle_state, cloud_provider::text AS cloud_provider,
                              COALESCE(tags, '{}'::jsonb) AS tags, COALESCE(meta, '{}'::jsonb) AS meta
                       FROM cis WHERE organization_id = $1 AND deleted_at IS NULL
                         AND id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR ci_type_id = $3)"#,
                )
                .bind(org_id)
                .bind(&ids)
                .bind(ci_type_id)
                .fetch_all(db)
                .await?
            } else {
                Vec::new()
            }
        } else if let Some(tid) = ci_type_id {
            sqlx::query(
                r#"SELECT id, name, lifecycle_state::text AS lifecycle_state, cloud_provider::text AS cloud_provider,
                          COALESCE(tags, '{}'::jsonb) AS tags, COALESCE(meta, '{}'::jsonb) AS meta
                   FROM cis WHERE organization_id = $1 AND deleted_at IS NULL AND ci_type_id = $2"#,
            )
            .bind(org_id)
            .bind(tid)
            .fetch_all(db)
            .await?
        } else {
            sqlx::query(
                r#"SELECT id, name, lifecycle_state::text AS lifecycle_state, cloud_provider::text AS cloud_provider,
                          COALESCE(tags, '{}'::jsonb) AS tags, COALESCE(meta, '{}'::jsonb) AS meta
                   FROM cis WHERE organization_id = $1 AND deleted_at IS NULL"#,
            )
            .bind(org_id)
            .fetch_all(db)
            .await?
        };

        // Evaluate in memory, then persist with ONE batched upsert per policy
        // (per-CI round trips dominated the runtime on large orgs).
        let mut ids: Vec<Uuid> = Vec::with_capacity(cis.len());
        let mut oks: Vec<bool> = Vec::with_capacity(cis.len());
        let mut violation_sets: Vec<Value> = Vec::with_capacity(cis.len());

        for ci in &cis {
            let record = json!({
                "name": ci.get::<String, _>("name"),
                "lifecycle_state": ci.get::<String, _>("lifecycle_state"),
                "cloud_provider": ci.get::<Option<String>, _>("cloud_provider"),
                "tags": ci.get::<Value, _>("tags"),
                "meta": ci.get::<Value, _>("meta"),
            });

            let mut violations: Vec<Value> = Vec::new();
            if let Some(rules_arr) = rules.as_array() {
                for rule in rules_arr {
                    let passed = evaluate_rule(&record, rule);
                    if !passed {
                        violations.push(json!({
                            "field": rule.get("field"),
                            "op": rule.get("op"),
                            "value": rule.get("value"),
                        }));
                    }
                }
            }

            total_checks += 1;
            if violations.is_empty() {
                compliant += 1;
            } else {
                non_compliant += 1;
            }
            ids.push(ci.get("id"));
            oks.push(violations.is_empty());
            violation_sets.push(Value::Array(violations));
        }

        if !ids.is_empty() {
            sqlx::query(
                r#"INSERT INTO ci_compliance (ci_id, policy_id, organization_id, is_compliant, violations)
                   SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::bool[], $5::jsonb[])
                   ON CONFLICT (ci_id, policy_id) DO UPDATE
                       SET is_compliant = EXCLUDED.is_compliant,
                           violations = EXCLUDED.violations,
                           last_evaluated = NOW()"#,
            )
            .bind(&ids)
            // policy_id / org_id repeated per row via arrays
            .bind(&vec![policy_id; ids.len()])
            .bind(&vec![org_id; ids.len()])
            .bind(&oks)
            .bind(&violation_sets)
            .execute(db)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, policy = %policy_name, "compliance batch upsert failed");
                e
            })?;
        }
    }

    Ok(json!({
        "status": if non_compliant == 0 { "compliant" } else { "non_compliant" },
        "checked": total_checks,
        "compliant": compliant,
        "non_compliant": non_compliant,
        "message": format!(
            "Evaluated {total_checks} CI(s): {compliant} compliant, {non_compliant} non-compliant"
        ),
    }))
}

/// Run compliance check: evaluate every active policy's rules against the CIs
/// it targets (all CIs, or those of `ci_type_id` when set). Results are upserted
/// into `ci_compliance` per (ci_id, policy_id).
pub async fn run_compliance_check(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let started = std::time::Instant::now();
    match run_compliance_for_org(&state.db, org_id).await {
        Ok(mut data) => {
            data["duration_ms"] = json!(started.elapsed().as_millis() as u64);
            data["trigger"] = json!("manual");
            record_governance_run(&state.db, org_id, "cmdb_compliance", &data, None).await;
            Ok(Json(json!({ "data": data })))
        }
        Err(e) => {
            let msg = e.to_string();
            record_governance_run(
                &state.db,
                org_id,
                "cmdb_compliance",
                &json!({ "trigger": "manual" }),
                Some(&msg),
            )
            .await;
            Err(e)
        }
    }
}

/// GET /api/v1/orgs/:org_id/compliance/last-run
///
/// Latest compliance run summary (manual or scheduled), sourced from
/// `job_runs` (T12).
#[utoipa::path(
    get,
    path = "/api/v1/orgs/{org_id}/compliance/last-run",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "Latest run summary (or null when never run)"),
    ),
    security(("bearer_auth" = [])),
    tag = "compliance",
)]
pub async fn compliance_last_run(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let row = sqlx::query(
        r#"SELECT jr.status::text AS status, jr.started_at, jr.completed_at, jr.result, jr.error_message
           FROM job_runs jr
           JOIN scheduled_jobs sj ON sj.id = jr.job_id
           WHERE jr.organization_id = $1 AND sj.job_type = 'cmdb_compliance'
           ORDER BY jr.created_at DESC
           LIMIT 1"#,
    )
    .bind(org_id)
    .fetch_optional(&state.db)
    .await?;

    let data = match row {
        Some(r) => json!({
            "status": r.get::<String, _>("status"),
            "started_at": r.get::<chrono::DateTime<chrono::Utc>, _>("started_at"),
            "completed_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("completed_at"),
            "result": r.get::<Value, _>("result"),
            "error": r.get::<Option<String>, _>("error_message"),
            "scheduled": true,
        }),
        None => Value::Null,
    };
    Ok(Json(json!({ "data": data })))
}

pub async fn list_compliance_results(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
           FROM ci_compliance cc
           JOIN cis c ON c.id = cc.ci_id
           WHERE c.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query(
        r#"SELECT cc.id, cc.ci_id, cc.policy_id, cc.is_compliant,
                  cc.violations, cc.last_evaluated,
                  c.name AS ci_name, cp.name AS policy_name
           FROM ci_compliance cc
           JOIN cis c ON c.id = cc.ci_id
           JOIN compliance_policies cp ON cp.id = cc.policy_id
           WHERE c.organization_id = $1
           ORDER BY cc.last_evaluated DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let results: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_id": r.get::<Uuid, _>("ci_id"),
                "ci_name": r.get::<String, _>("ci_name"),
                "policy_id": r.get::<Uuid, _>("policy_id"),
                "policy_name": r.get::<String, _>("policy_name"),
                "status": if r.get::<bool, _>("is_compliant") { "compliant" } else { "non_compliant" },
                "details": r.get::<Value, _>("violations"),
                "checked_at": r.get::<chrono::DateTime<chrono::Utc>, _>("last_evaluated"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": results, "meta": page_meta_json(total, &bounds) })))
}

// ─── Baseline & Drift ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBaselineRequest {
    pub ci_id: Uuid,
    pub snapshot: serde_json::Value,
    pub label: Option<String>,
}

pub async fn list_baselines(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM ci_baselines cb
           JOIN cis c ON c.id = cb.ci_id
           WHERE c.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query(
        r#"SELECT cb.id, cb.ci_id, cb.name AS label, cb.desired_state AS snapshot, cb.created_at,
                  c.name AS ci_name
           FROM ci_baselines cb
           JOIN cis c ON c.id = cb.ci_id
           WHERE c.organization_id = $1
           ORDER BY cb.created_at DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let baselines: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_id": r.get::<Uuid, _>("ci_id"),
                "ci_name": r.get::<String, _>("ci_name"),
                "label": r.get::<Option<String>, _>("label"),
                "snapshot": r.get::<serde_json::Value, _>("snapshot"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": baselines, "meta": page_meta_json(total, &bounds) })))
}

pub async fn create_baseline(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateBaselineRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    // Verify CI belongs to org
    sqlx::query("SELECT id FROM cis WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL")
        .bind(req.ci_id)
        .bind(org_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound("CI not found".into()))?;

    let row = sqlx::query(
        r#"INSERT INTO ci_baselines (ci_id, desired_state, name, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at"#,
    )
    .bind(req.ci_id)
    .bind(&req.snapshot)
    .bind(&req.label)
    .bind(claims.user_id()?)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "ci_id": req.ci_id,
            "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        }
    })))
}

pub async fn list_drift(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);
    let (limit, offset) = (bounds.limit, bounds.offset);

    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM ci_drift cd
           JOIN cis c ON c.id = cd.ci_id
           WHERE c.organization_id = $1"#,
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let rows = sqlx::query(
        r#"SELECT cd.id, cd.ci_id, cd.baseline_id, cd.field_name AS field_path,
                  cd.expected_value AS old_value, cd.actual_value AS new_value, cd.detected_at, cd.acknowledged_at,
                  c.name AS ci_name
           FROM ci_drift cd
           JOIN cis c ON c.id = cd.ci_id
           WHERE c.organization_id = $1
           ORDER BY cd.detected_at DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    let drifts: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "ci_id": r.get::<Uuid, _>("ci_id"),
                "ci_name": r.get::<String, _>("ci_name"),
                "baseline_id": r.get::<Uuid, _>("baseline_id"),
                "field_path": r.get::<String, _>("field_path"),
                "old_value": r.get::<Option<serde_json::Value>, _>("old_value"),
                "new_value": r.get::<Option<serde_json::Value>, _>("new_value"),
                "detected_at": r.get::<chrono::DateTime<chrono::Utc>, _>("detected_at"),
                "acknowledged_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("acknowledged_at"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": drifts, "meta": page_meta_json(total, &bounds) })))
}

/// Drift lifecycle closure (T12): open/acknowledged → resolved.
pub async fn resolve_drift(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, drift_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE ci_drift
           SET status = 'resolved', resolved_at = NOW()
           WHERE id = $1 AND status IN ('open', 'acknowledged')
             AND EXISTS (SELECT 1 FROM cis WHERE id = ci_drift.ci_id AND organization_id = $2)"#,
    )
    .bind(drift_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Drift item not found or already resolved/ignored".into(),
        ));
    }
    Ok(Json(json!({ "data": { "resolved": true } })))
}

/// Drift lifecycle closure (T12): open/acknowledged → ignored.
pub async fn ignore_drift(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, drift_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let result = sqlx::query(
        r#"UPDATE ci_drift
           SET status = 'ignored', resolved_at = NOW()
           WHERE id = $1 AND status IN ('open', 'acknowledged')
             AND EXISTS (SELECT 1 FROM cis WHERE id = ci_drift.ci_id AND organization_id = $2)"#,
    )
    .bind(drift_id)
    .bind(org_id)
    .execute(&state.db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(
            "Drift item not found or already resolved/ignored".into(),
        ));
    }
    Ok(Json(json!({ "data": { "ignored": true } })))
}

/// Full drift rescan (T12 scheduler): re-evaluate every active baseline of the
/// org against its CI's current meta — new divergences open drift rows,
/// divergences that healed are auto-resolved.
pub async fn rescan_drift_for_org(db: &sqlx::PgPool, org_id: Uuid) -> AppResult<Value> {
    let baselines = sqlx::query(
        r#"SELECT b.id, b.ci_id, b.desired_state, c.meta
           FROM ci_baselines b
           JOIN cis c ON c.id = b.ci_id AND c.deleted_at IS NULL
           WHERE b.organization_id = $1 AND b.is_active = true"#,
    )
    .bind(org_id)
    .fetch_all(db)
    .await?;

    let mut opened = 0u64;
    let mut resolved = 0u64;
    let mut scanned = 0u64;

    for row in &baselines {
        scanned += 1;
        let baseline_id: Uuid = row.get("id");
        let ci_id: Uuid = row.get("ci_id");
        let desired: Value = row
            .try_get::<Value, _>("desired_state")
            .unwrap_or_else(|_| json!({}));
        let actual: Value = row.try_get::<Value, _>("meta").unwrap_or_else(|_| json!({}));

        let desired_obj = desired.as_object().cloned().unwrap_or_default();

        // Track which baseline fields are still divergent this pass.
        let mut divergent: Vec<String> = Vec::new();

        for (field, expected) in &desired_obj {
            let actual_val = actual.get(field).cloned().unwrap_or(Value::Null);
            if &actual_val == expected {
                continue; // healed or matches — ensure no open drift remains
            }
            divergent.push(field.clone());

            let expected_str = serde_json::to_string(expected).unwrap_or_default();
            let actual_str = serde_json::to_string(&actual_val).unwrap_or_default();

            let inserted = sqlx::query(
                r#"INSERT INTO ci_drift (baseline_id, ci_id, organization_id, field_name,
                                         expected_value, actual_value, status, detected_at)
                   SELECT $1, $2, $3, $4, $5, $6, 'open'::drift_status, NOW()
                   WHERE NOT EXISTS (
                       SELECT 1 FROM ci_drift
                       WHERE baseline_id = $1 AND ci_id = $2 AND field_name = $4
                         AND status IN ('open', 'acknowledged')
                   )"#,
            )
            .bind(baseline_id)
            .bind(ci_id)
            .bind(org_id)
            .bind(field)
            .bind(&expected_str)
            .bind(&actual_str)
            .execute(db)
            .await?;
            opened += inserted.rows_affected();
        }

        // Auto-resolve drift whose field no longer diverges (or left the baseline).
        let healed = sqlx::query(
            r#"UPDATE ci_drift
               SET status = 'resolved', resolved_at = NOW()
               WHERE baseline_id = $1 AND status IN ('open', 'acknowledged')
                 AND NOT (field_name = ANY($2))"#,
        )
        .bind(baseline_id)
        .bind(&divergent)
        .execute(db)
        .await?;
        resolved += healed.rows_affected();
    }

    Ok(json!({
        "baselines_scanned": scanned,
        "drift_opened": opened,
        "drift_resolved": resolved,
    }))
}

pub async fn acknowledge_drift(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path((org_id, drift_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    sqlx::query(
        r#"UPDATE ci_drift SET acknowledged_at = NOW(), acknowledged_by = $3
           WHERE id = $1
           AND EXISTS (SELECT 1 FROM cis WHERE id = ci_drift.ci_id AND organization_id = $2)"#,
    )
    .bind(drift_id)
    .bind(org_id)
    .bind(claims.user_id()?)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "acknowledged": true } })))
}

// ─── Cloud Discovery → CMDB ───────────────────────────────────────────────────

#[derive(Deserialize, Default, utoipa::ToSchema)]
pub struct TriggerDiscoveryRequest {
    /// Optional: discover only this account. Omit to sweep every active
    /// cloud account in the org.
    pub cloud_account_id: Option<Uuid>,
}

/// Trigger CMDB discovery by enqueing real async discovery jobs (T5).
///
/// With `cloud_account_id` set, a single job is launched for that account (409
/// when one is already active). Without it, every active cloud account in the
/// org gets a job; accounts that already have an active job are skipped and
/// reported in `skipped_accounts`. Returns `202 { job_ids: [...] }`.
#[utoipa::path(
    post,
    path = "/api/v1/orgs/{org_id}/cmdb/discovery",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    request_body(content = TriggerDiscoveryRequest, description = "Optional cloud_account_id to scope the discovery"),
    responses(
        (status = 202, description = "Discovery jobs enqueued"),
        (status = 404, description = "Cloud account not found"),
        (status = 409, description = "A discovery job is already active for the account"),
    ),
    security(("bearer_auth" = [])),
    tag = "cmdb",
)]
pub async fn trigger_discovery(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    body: Option<Json<TriggerDiscoveryRequest>>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    let user_id = claims.user_id()?;
    ensure_org_member(&state.db, org_id, user_id).await?;

    let requested_account = body.and_then(|Json(b)| b.cloud_account_id);
    let triggered_by = user_id.to_string();

    let account_ids: Vec<Uuid> = if let Some(account_id) = requested_account {
        // Single-account mode: launch_sync 404s when the account is missing.
        vec![account_id]
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM cloud_accounts WHERE organization_id = $1 AND is_active = true AND deleted_at IS NULL",
        )
        .bind(org_id)
        .fetch_all(&state.db)
        .await?
    };

    let mut job_ids: Vec<Uuid> = Vec::new();
    let mut skipped_accounts: Vec<Value> = Vec::new();

    for account_id in account_ids {
        match crate::modules::cloud::handlers::launch_sync(
            &state,
            org_id,
            account_id,
            &triggered_by,
        )
        .await
        {
            Ok(Some(job)) => job_ids.push(job.id),
            // Scheduler-style overlap: report, don't fail the sweep.
            Ok(None) => skipped_accounts.push(json!({
                "cloud_account_id": account_id,
                "reason": "discovery already active",
            })),
            Err(e) => {
                // Single-account mode propagates the error (404/409); the
                // all-accounts sweep records it and continues.
                if requested_account.is_some() {
                    return Err(e);
                }
                skipped_accounts.push(json!({
                    "cloud_account_id": account_id,
                    "reason": e.to_string(),
                }));
            }
        }
    }

    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(json!({
            "data": {
                "status": "discovery_triggered",
                "job_ids": job_ids,
                "jobs_enqueued": job_ids.len(),
                "skipped_accounts": skipped_accounts,
                "message": format!("{} discovery job(s) enqueued", job_ids.len()),
            }
        })),
    ))
}

// ─── External CMDB Integration ────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateExternalCmdbRequest {
    pub name: String,
    pub provider: String,
    pub config: serde_json::Value,
}

pub async fn list_external_cmdb(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    axum::extract::Query(page): axum::extract::Query<PageQuery>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let bounds = page.resolve(50, 200);

    let rows = sqlx::query(
        r#"SELECT id, name, provider, is_active, last_synced_at, created_at,
                  ci_type_id, sync_direction, options, field_mapping
           FROM external_cmdb_configs
           WHERE organization_id = $1
           ORDER BY name, id
           LIMIT $2 OFFSET $3"#,
    )
    .bind(org_id)
    .bind(bounds.limit)
    .bind(bounds.offset)
    .fetch_all(&state.db)
    .await?;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM external_cmdb_configs WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);

    let configs: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<Uuid, _>("id"),
                "name": r.get::<String, _>("name"),
                "provider": r.get::<String, _>("provider"),
                "is_active": r.get::<bool, _>("is_active"),
                "last_sync_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_synced_at"),
                "created_at": r.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
                "ci_type_id": r.get::<Option<Uuid>, _>("ci_type_id"),
                "sync_direction": r.get::<String, _>("sync_direction"),
                "options": r.get::<Value, _>("options"),
                "field_mapping": r.get::<Value, _>("field_mapping"),
            })
        })
        .collect();

    Ok(Json(json!({ "data": configs, "meta": page_meta_json(total, &bounds) })))
}

pub async fn create_external_cmdb(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
    Json(req): Json<CreateExternalCmdbRequest>,
) -> AppResult<Json<Value>> {
    ensure_org_member(&state.db, org_id, claims.user_id()?).await?;

    let base_url = req
        .config
        .get("base_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let auth_config = req.config.get("auth_config").cloned().unwrap_or_else(|| json!({}));
    let field_mapping = req.config.get("field_mapping").cloned().unwrap_or_else(|| json!({}));
    let options = req.config.get("options").cloned().unwrap_or_else(|| json!({}));
    let ci_type_id = req
        .config
        .get("ci_type_id")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok());
    let sync_direction = match req.config.get("sync_direction").and_then(|v| v.as_str()) {
        Some(d) if d == "pull" || d == "push" || d == "bidirectional" => d.to_string(),
        _ => "pull".to_string(),
    };

    let row = sqlx::query(
        r#"INSERT INTO external_cmdb_configs
           (organization_id, name, provider, base_url, auth_config, field_mapping, options, ci_type_id, sync_direction)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, created_at"#,
    )
    .bind(org_id)
    .bind(&req.name)
    .bind(&req.provider)
    .bind(&base_url)
    .bind(&auth_config)
    .bind(&field_mapping)
    .bind(&options)
    .bind(ci_type_id)
    .bind(&sync_direction)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "data": {
            "id": row.get::<Uuid, _>("id"),
            "name": req.name,
            "provider": req.provider,
            "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_ci() -> Value {
        json!({
            "name": "web-01",
            "lifecycle_state": "active",
            "cloud_provider": "aws",
            "tags": {"env": "prod", "team": "platform"},
            "meta": {"cpu_count": 4, "memory_gb": 16, "os": "ubuntu"}
        })
    }

    #[test]
    fn rule_exists_passes_and_fails() {
        let ci = sample_ci();
        let ok = json!({"field": "tags.env", "op": "exists"});
        let missing = json!({"field": "tags.owner", "op": "exists"});
        assert!(evaluate_rule(&ci, &ok));
        assert!(!evaluate_rule(&ci, &missing));
    }

    #[test]
    fn rule_not_exists() {
        let ci = sample_ci();
        let r = json!({"field": "meta.gpu_count", "op": "not_exists"});
        assert!(evaluate_rule(&ci, &r));
    }

    #[test]
    fn rule_eq_numeric_and_string() {
        let ci = sample_ci();
        assert!(evaluate_rule(&ci, &json!({"field": "tags.env", "op": "eq", "value": "prod"})));
        assert!(!evaluate_rule(&ci, &json!({"field": "tags.env", "op": "eq", "value": "dev"})));
        assert!(evaluate_rule(&ci, &json!({"field": "meta.cpu_count", "op": "eq", "value": 4})));
        // string/number coercion
        assert!(evaluate_rule(&ci, &json!({"field": "meta.memory_gb", "op": "eq", "value": "16"})));
    }

    #[test]
    fn rule_gte_lte() {
        let ci = sample_ci();
        assert!(evaluate_rule(&ci, &json!({"field": "meta.cpu_count", "op": "gte", "value": 2})));
        assert!(!evaluate_rule(&ci, &json!({"field": "meta.cpu_count", "op": "gte", "value": 8})));
        assert!(evaluate_rule(&ci, &json!({"field": "meta.memory_gb", "op": "lte", "value": 32})));
    }

    #[test]
    fn rule_in_and_contains() {
        let ci = sample_ci();
        assert!(evaluate_rule(&ci, &json!({"field": "cloud_provider", "op": "in", "value": ["aws", "gcp"]})));
        assert!(!evaluate_rule(&ci, &json!({"field": "cloud_provider", "op": "in", "value": ["azure"]})));
        assert!(evaluate_rule(&ci, &json!({"field": "name", "op": "contains", "value": "web"})));
    }

    #[test]
    fn validate_rules_accepts_good_rejects_bad() {
        let good = json!([
            {"field": "tags.env", "op": "exists"},
            {"field": "meta.cpu_count", "op": "gte", "value": 2}
        ]);
        assert!(validate_rules(&good).is_ok());

        // unknown op
        let bad_op = json!([{"field": "tags.env", "op": "regex", "value": "p.*"}]);
        assert!(validate_rules(&bad_op).is_err());

        // bad field path
        let bad_field = json!([{"field": "unknown.field", "op": "exists"}]);
        assert!(validate_rules(&bad_field).is_err());

        // missing value
        let missing_value = json!([{"field": "tags.env", "op": "eq"}]);
        assert!(validate_rules(&missing_value).is_err());

        // empty rules array
        assert!(validate_rules(&json!([])).is_err());

        // not an array
        assert!(validate_rules(&json!({"field": "x"})).is_err());
    }
}

/// Pub wrapper so the scheduler (T12) can append governance run history rows.
pub async fn record_governance_run_for_scheduler(
    db: &sqlx::PgPool,
    org_id: Uuid,
    job_type: &str,
    result: &Value,
    error: Option<&str>,
) {
    record_governance_run(db, org_id, job_type, result, error).await;
}
