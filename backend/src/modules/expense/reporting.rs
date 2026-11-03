use axum::{
    extract::{Extension, Path, State},
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{error::AppResult, modules::auth::service::Claims, state::AppState};

/// Both allocation views reconcile independently to the same 30-day total.
/// Ambiguous ownership stays unallocated rather than charging every owner.
pub async fn showback(db: &sqlx::PgPool, org_id: Uuid) -> AppResult<Value> {
    let currency = crate::modules::billing::fx::org_currency(db, org_id).await;
    let report: Value = sqlx::query_scalar(
        r#"WITH period AS MATERIALIZED (
               SELECT * FROM expenses WHERE organization_id = $1
                   AND date BETWEEN CURRENT_DATE - 29 AND CURRENT_DATE
           ), spend AS MATERIALIZED (SELECT * FROM period WHERE currency = $2),
           owners AS (
               SELECT DISTINCT c.cloud_account_id, c.cloud_resource_id, cc.id AS cost_center_id
               FROM cis c JOIN service_cis sc ON sc.ci_id = c.id
               JOIN services s ON s.id = sc.service_id AND s.organization_id = $1 AND s.deleted_at IS NULL
               JOIN business_capabilities bc ON bc.organization_id = $1 AND bc.name = s.name
               JOIN cost_centers cc ON cc.id = bc.cost_center_id AND cc.organization_id = $1
               WHERE c.organization_id = $1 AND c.deleted_at IS NULL
                   AND c.cloud_account_id IS NOT NULL AND c.cloud_resource_id IS NOT NULL
           ), ownership AS (
               SELECT cloud_account_id, cloud_resource_id, COUNT(*) AS owner_count,
                      (array_agg(cost_center_id ORDER BY cost_center_id))[1] AS cost_center_id
               FROM owners GROUP BY cloud_account_id, cloud_resource_id
           ), attributed AS MATERIALIZED (
               SELECT e.*, o.owner_count,
                      CASE WHEN o.owner_count = 1 THEN o.cost_center_id END AS cost_center_id
               FROM spend e LEFT JOIN ownership o
                   ON o.cloud_account_id = e.cloud_account_id AND o.cloud_resource_id = e.cloud_resource_id
           ), pools_report AS (
               SELECT p.id AS pool_id, p.name AS pool_name, p.description AS pool_description,
                      COALESCE(SUM(e.cost), 0) AS cost,
                      COUNT(DISTINCT (e.cloud_account_id, e.cloud_resource_id)) FILTER (WHERE e.id IS NOT NULL) AS resource_count
               FROM pools p LEFT JOIN spend e ON e.pool_id = p.id
               WHERE p.organization_id = $1 AND p.deleted_at IS NULL GROUP BY p.id
           ), centers_report AS (
               SELECT cc.id AS cost_center_id, cc.name AS cost_center_name, cc.code AS cost_center_code,
                      COALESCE(SUM(e.cost), 0) AS cost,
                      COUNT(DISTINCT (e.cloud_account_id, e.cloud_resource_id)) FILTER (WHERE e.id IS NOT NULL) AS resource_count
               FROM cost_centers cc LEFT JOIN attributed e ON e.cost_center_id = cc.id
               WHERE cc.organization_id = $1 GROUP BY cc.id
           ), totals AS (
               SELECT COALESCE(SUM(cost), 0) AS total_cost,
                      COALESCE(SUM(cost) FILTER (WHERE cost_center_id IS NULL), 0) AS cc_unallocated,
                      COALESCE(SUM(cost) FILTER (WHERE owner_count > 1), 0) AS ambiguous_cost,
                      COUNT(DISTINCT (cloud_account_id, cloud_resource_id)) FILTER (WHERE owner_count > 1) AS ambiguous_resources
               FROM attributed
           ), unallocated AS (
               SELECT COALESCE(SUM(e.cost), 0) AS cost FROM spend e
               WHERE NOT EXISTS (SELECT 1 FROM pools p WHERE p.id = e.pool_id
                   AND p.organization_id = $1 AND p.deleted_at IS NULL)
           )
           SELECT jsonb_build_object(
               'period_days', 30, 'start_date', CURRENT_DATE - 29, 'end_date', CURRENT_DATE,
               'currency', $2::text, 'total_cost', t.total_cost,
               'unallocated_cost', u.cost,
               'unallocated_pct', CASE WHEN t.total_cost > 0 THEN u.cost / t.total_cost * 100 ELSE 0 END,
               'cost_center_unallocated_cost', t.cc_unallocated,
               'ambiguous_cost', t.ambiguous_cost, 'ambiguous_resources', t.ambiguous_resources,
               'excluded_currency_rows', (SELECT COUNT(*) FROM period WHERE currency <> $2),
               'by_pool', COALESCE((SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object(
                   'allocation_pct', CASE WHEN t.total_cost > 0 THEN p.cost / t.total_cost * 100 ELSE 0 END
               ) ORDER BY p.cost DESC, p.pool_name) FROM pools_report p), '[]'::jsonb),
               'by_cost_center', COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object(
                   'allocation_pct', CASE WHEN t.total_cost > 0 THEN c.cost / t.total_cost * 100 ELSE 0 END
               ) ORDER BY c.cost DESC, c.cost_center_name) FROM centers_report c), '[]'::jsonb)
           ) FROM totals t CROSS JOIN unallocated u"#,
    ).bind(org_id).bind(&currency).fetch_one(db).await?;
    Ok(report)
}

#[utoipa::path(
    get, path = "/api/v1/orgs/{org_id}/data-flow",
    params(("org_id" = Uuid, Path, description = "Organization ID")),
    responses((status = 200, description = "CMDB and FinOps coverage, 30-day billing quality and latest jobs")),
    security(("bearer_auth" = [])), tag = "expenses"
)]
pub async fn data_flow(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Path(org_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    super::handlers::ensure_org_member(&state.db, org_id, claims.user_id()?).await?;
    let currency = crate::modules::billing::fx::org_currency(&state.db, org_id).await;
    // Aggregate each relation once; joining raw bills to expenses would multiply
    // costs. Every identity match includes organization, account and resource.
    let accounts: Vec<Value> = sqlx::query_scalar(
        r#"WITH inventory AS (
               SELECT r.cloud_account_id, COUNT(*) AS resources,
                      COUNT(*) FILTER (WHERE EXISTS (
                          SELECT 1 FROM cis c WHERE c.organization_id = $1 AND c.deleted_at IS NULL
                              AND c.cloud_account_id = r.cloud_account_id AND c.cloud_resource_id = r.cloud_resource_id
                      )) AS linked_resources
               FROM resources r WHERE r.organization_id = $1 AND r.active GROUP BY r.cloud_account_id
           ), ci_counts AS (
               SELECT cloud_account_id, COUNT(*) AS cis FROM cis
               WHERE organization_id = $1 AND deleted_at IS NULL GROUP BY cloud_account_id
           ), raw AS (
               SELECT cloud_account_id, COUNT(*) AS raw_rows, MAX(imported_at) AS last_import_at
               FROM raw_expenses WHERE organization_id = $1 AND billing_period BETWEEN CURRENT_DATE - 29 AND CURRENT_DATE
               GROUP BY cloud_account_id
           ), costs AS (
               SELECT e.cloud_account_id, COUNT(*) AS expense_rows, MAX(e.date) AS latest_expense_date,
                      COUNT(*) FILTER (WHERE currency <> $2) AS currency_mismatch_rows,
                      COUNT(*) FILTER (WHERE c.id IS NULL) AS unmatched_rows,
                      COALESCE(SUM(e.cost) FILTER (WHERE e.currency = $2), 0) AS total_cost,
                      COALESCE(SUM(e.cost) FILTER (WHERE c.id IS NULL AND e.currency = $2), 0) AS unmatched_cost,
                      COALESCE(SUM(e.cost) FILTER (WHERE p.id IS NULL AND e.currency = $2), 0) AS unallocated_cost
               FROM expenses e LEFT JOIN cis c ON c.organization_id = $1 AND c.deleted_at IS NULL
                   AND c.cloud_account_id = e.cloud_account_id AND c.cloud_resource_id = e.cloud_resource_id
               LEFT JOIN pools p ON p.id = e.pool_id AND p.organization_id = $1 AND p.deleted_at IS NULL
               WHERE e.organization_id = $1 AND e.date BETWEEN CURRENT_DATE - 29 AND CURRENT_DATE
               GROUP BY e.cloud_account_id
           ), recent_jobs AS (
               SELECT DISTINCT ON (cloud_account_id, job_kind)
                      cloud_account_id, job_kind, id, status::text, phase, created_at, completed_at, error_message
               FROM sync_jobs WHERE organization_id = $1
               ORDER BY cloud_account_id, job_kind, created_at DESC, id DESC
           )
           SELECT jsonb_build_object(
               'id', a.id, 'name', a.name, 'provider', a.provider, 'is_active', a.is_active,
               'resources', COALESCE(i.resources, 0), 'linked_resources', COALESCE(i.linked_resources, 0),
               'cis', COALESCE(c.cis, 0), 'raw_rows', COALESCE(r.raw_rows, 0), 'last_import_at', r.last_import_at,
               'expense_rows', COALESCE(e.expense_rows, 0), 'latest_expense_date', e.latest_expense_date,
               'currency_mismatch_rows', COALESCE(e.currency_mismatch_rows, 0),
               'unmatched_rows', COALESCE(e.unmatched_rows, 0),
               'total_cost', COALESCE(e.total_cost, 0), 'unmatched_cost', COALESCE(e.unmatched_cost, 0),
               'unallocated_cost', COALESCE(e.unallocated_cost, 0),
               'discovery_job', (SELECT to_jsonb(j) - 'cloud_account_id' FROM recent_jobs j WHERE j.cloud_account_id = a.id AND j.job_kind = 'discovery'),
               'billing_job', (SELECT to_jsonb(j) - 'cloud_account_id' FROM recent_jobs j WHERE j.cloud_account_id = a.id AND j.job_kind = 'billing_import')
           )
           FROM cloud_accounts a LEFT JOIN inventory i ON i.cloud_account_id = a.id
           LEFT JOIN ci_counts c ON c.cloud_account_id = a.id LEFT JOIN raw r ON r.cloud_account_id = a.id
           LEFT JOIN costs e ON e.cloud_account_id = a.id
           WHERE a.organization_id = $1 AND a.deleted_at IS NULL ORDER BY a.name, a.id"#,
    ).bind(org_id).bind(&currency).fetch_all(&state.db).await?;
    Ok(Json(
        json!({ "data": { "accounts": accounts, "currency": currency,
        "period_days": 30, "as_of": chrono::Utc::now() } }),
    ))
}
