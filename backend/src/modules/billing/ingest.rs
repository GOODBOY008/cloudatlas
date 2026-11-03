//! Provider-neutral daily billing ingestion. The database grain is one resource
//! per account per day; sum every input line before applying that unique key.
use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

pub struct BillingLine {
    pub resource_id: String,
    pub resource_name: Option<String>,
    pub resource_type: String,
    pub region: Option<String>,
    pub service: String,
    pub date: NaiveDate,
    pub amount: f64,
    pub currency: String,
    pub tags: Value,
    pub evidence: Value,
}

struct DailyBill {
    line: BillingLine,
    cost: f64,
    services: BTreeSet<String>,
    evidence: Vec<Value>,
}

pub async fn import_daily(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    lines: Vec<BillingLine>,
    mut progress: Option<&mut (dyn FnMut(usize, usize) -> bool + Send)>,
) -> AppResult<u32> {
    let currency = super::fx::org_currency(&state.db, org_id).await;
    let rates = super::fx::load_rates(&state.db, org_id).await;
    let mut days: BTreeMap<(String, NaiveDate), DailyBill> = BTreeMap::new();
    for line in lines {
        let cost = rates
            .convert(line.amount, &line.currency, &currency)
            .filter(|v| v.is_finite())
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "Missing or invalid exchange rate from {} to {}; configure it before importing",
                    line.currency, currency
                ))
            })?;
        let key = (line.resource_id.clone(), line.date);
        let evidence = line.evidence.clone();
        if let Some(day) = days.get_mut(&key) {
            day.cost += cost;
            day.services.insert(line.service);
            day.evidence.push(evidence);
            if let (Some(tags), Some(incoming)) =
                (day.line.tags.as_object_mut(), line.tags.as_object())
            {
                tags.extend(incoming.clone());
            }
        } else {
            days.insert(
                key,
                DailyBill {
                    cost,
                    services: BTreeSet::from([line.service.clone()]),
                    evidence: vec![evidence],
                    line,
                },
            );
        }
    }

    // Corrected bills replace the existing daily amount. A cancelled import or
    // failed row cannot leave a half-written account snapshot behind.
    let total = days.len();
    let mut tx = state.db.begin().await?;
    for (index, day) in days.values().enumerate() {
        if let Some(hook) = progress.as_mut() {
            if index % 100 == 0 && !hook(index, total) {
                return Ok(0);
            }
        }
        let service = day.services.iter().cloned().collect::<Vec<_>>().join(" / ");
        sqlx::query(
            r#"INSERT INTO raw_expenses
               (organization_id, cloud_account_id, external_id, billing_period,
                cloud_resource_id, resource_name, resource_type, cloud_region,
                cost, currency, service_name, cloud_specific)
               VALUES ($1, $2, $3, $4, $3, $5, $6::resource_type, $7, $8, $9, $10, $11)
               ON CONFLICT (cloud_account_id, external_id, billing_period) DO UPDATE SET
                   resource_name = EXCLUDED.resource_name, resource_type = EXCLUDED.resource_type,
                   cloud_region = EXCLUDED.cloud_region, cost = EXCLUDED.cost,
                   currency = EXCLUDED.currency, service_name = EXCLUDED.service_name,
                   cloud_specific = EXCLUDED.cloud_specific, imported_at = NOW()"#,
        )
        .bind(org_id).bind(account_id).bind(&day.line.resource_id).bind(day.line.date)
        .bind(&day.line.resource_name).bind(&day.line.resource_type).bind(&day.line.region)
        .bind(day.cost).bind(&currency).bind(service)
        .bind(json!({ "tags": day.line.tags, "line_items": day.evidence, "line_count": day.evidence.len() }))
        .execute(&mut *tx).await?;
    }
    if let Some(hook) = progress.as_mut() {
        if !hook(total, total) {
            return Ok(0);
        }
    }
    tx.commit().await?;
    Ok(total as u32)
}

/// Idempotent aggregation, shared by AWS and Aliyun. The GROUP BY exactly
/// matches the expense uniqueness constraint, including multi-service bills.
pub async fn aggregate(state: &AppState, org_id: Uuid, account_id: Uuid) -> AppResult<()> {
    let currency = super::fx::org_currency(&state.db, org_id).await;
    let mut tx = state.db.begin().await?;
    // Discovery and billing may run concurrently. Serialize their projections
    // so neither can overwrite a fresh resource cost with an older snapshot.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("cloudatlas:asset-cost:{account_id}"))
        .execute(&mut *tx)
        .await?;
    let mixed_currency: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM raw_expenses
           WHERE organization_id = $1 AND cloud_account_id = $2
           GROUP BY cloud_resource_id, billing_period HAVING COUNT(DISTINCT currency) > 1)"#,
    )
    .bind(org_id)
    .bind(account_id)
    .fetch_one(&mut *tx)
    .await?;
    if mixed_currency {
        return Err(AppError::Validation("Cannot aggregate mixed currencies for a resource/day; re-import with a consistent currency".into()));
    }
    sqlx::query(
        r#"INSERT INTO expenses
           (organization_id, cloud_account_id, cloud_resource_id, resource_name,
            service_name, date, cloud_region, resource_type, cost, currency, tags, pool_id, owner_id)
           SELECT b.organization_id, b.cloud_account_id, b.cloud_resource_id, b.resource_name,
                  b.service_name, b.date, b.cloud_region, b.resource_type, b.cost, b.currency,
                  COALESCE(b.tags, '{}'::jsonb), r.pool_id, r.owner_id
           FROM (
               SELECT organization_id, cloud_account_id, cloud_resource_id,
                      MAX(resource_name) AS resource_name,
                      string_agg(DISTINCT service_name, ' / ' ORDER BY service_name) AS service_name,
                      billing_period AS date, MAX(cloud_region) AS cloud_region,
                      MAX(resource_type) AS resource_type, SUM(cost) AS cost, MAX(currency) AS currency,
                      (array_agg(cloud_specific->'tags' ORDER BY imported_at DESC, id DESC)
                       FILTER (WHERE jsonb_typeof(cloud_specific->'tags') = 'object'))[1] AS tags
               FROM raw_expenses WHERE organization_id = $1 AND cloud_account_id = $2
                   AND cloud_resource_id IS NOT NULL
               GROUP BY organization_id, cloud_account_id, cloud_resource_id, billing_period
           ) b
           LEFT JOIN resources r ON r.organization_id = b.organization_id
               AND r.cloud_account_id = b.cloud_account_id AND r.cloud_resource_id = b.cloud_resource_id
           ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id, date) DO UPDATE SET
               cost = EXCLUDED.cost, currency = EXCLUDED.currency,
               resource_name = EXCLUDED.resource_name, service_name = EXCLUDED.service_name,
               cloud_region = EXCLUDED.cloud_region, resource_type = EXCLUDED.resource_type,
               tags = EXCLUDED.tags, pool_id = COALESCE(expenses.pool_id, EXCLUDED.pool_id),
               owner_id = COALESCE(expenses.owner_id, EXCLUDED.owner_id)"#,
    ).bind(org_id).bind(account_id).execute(&mut *tx).await?;
    sqlx::query(
        r#"UPDATE resources r SET total_cost = totals.cost, last_month_cost = totals.recent_cost
           FROM (
               SELECT r0.id, COALESCE(SUM(e.cost) FILTER (WHERE e.currency = $3), 0) AS cost,
                      COALESCE(SUM(e.cost) FILTER (WHERE e.currency = $3 AND e.date BETWEEN CURRENT_DATE - 29 AND CURRENT_DATE), 0) AS recent_cost
               FROM resources r0 LEFT JOIN expenses e ON e.organization_id = r0.organization_id
                   AND e.cloud_account_id = r0.cloud_account_id AND e.cloud_resource_id = r0.cloud_resource_id
               WHERE r0.organization_id = $1 AND r0.cloud_account_id = $2 GROUP BY r0.id
           ) totals WHERE r.id = totals.id"#,
    ).bind(org_id).bind(account_id).bind(&currency).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
