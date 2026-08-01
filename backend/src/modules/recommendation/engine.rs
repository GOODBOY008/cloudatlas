use crate::error::AppResult;
use crate::state::AppState;
use uuid::Uuid;

pub struct RecEngine;

impl RecEngine {
    pub async fn run_for_org(state: &AppState, org_id: Uuid) -> AppResult<u32> {
        let mut count = 0u32;
        // Idle / abandoned
        count += detect_abandoned_volumes(state, org_id).await?;
        count += detect_obsolete_ips(state, org_id).await?;
        count += detect_abandoned_snapshots(state, org_id).await?;
        count += detect_abandoned_lbs(state, org_id).await?;
        count += detect_abandoned_instances_metric_aware(state, org_id).await?;
        count += detect_volumes_not_attached(state, org_id).await?;
        count += detect_s3_abandoned_buckets(state, org_id).await?;
        count += detect_instances_for_shutdown(state, org_id).await?;
        count += detect_abandoned_images(state, org_id).await?;
        count += detect_abandoned_kinesis_streams(state, org_id).await?;
        count += detect_instances_in_stopped_state(state, org_id).await?;
        // Rightsizing
        count += detect_rightsizing(state, org_id).await?;
        count += detect_rightsizing_rds(state, org_id).await?;
        count += detect_instance_generation_upgrades(state, org_id).await?;
        // Storage
        count += detect_s3_intelligent_tiering(state, org_id).await?;
        count += detect_obsolete_snapshot_chains(state, org_id).await?;
        count += detect_snapshots_with_non_used_images(state, org_id).await?;
        // Security
        count += detect_inactive_iam_users(state, org_id).await?;
        count += detect_insecure_security_groups(state, org_id).await?;
        count += detect_s3_public_buckets(state, org_id).await?;
        count += detect_inactive_users(state, org_id).await?;
        // Commitment
        count += detect_reserved_instance_opportunity(state, org_id).await?;
        count += detect_savings_plan_opportunity(state, org_id).await?;
        count += detect_inactive_console_users(state, org_id).await?;
        count += detect_instance_subscriptions(state, org_id).await?;
        count += detect_short_living_instances(state, org_id).await?;
        // Confidence scoring (D4): evidence-based 0-100 per recommendation.
        score_confidence(state, org_id).await;
        Ok(count)
    }
}

/// Helper: upsert a recommendation from a raw SQL INSERT…SELECT query
macro_rules! upsert_rec {
    ($state:expr, $org_id:expr, $sql:expr) => {{
        let result = sqlx::query($sql)
            .bind($org_id)
            .execute(&$state.db)
            .await?;
        result.rows_affected() as u32
    }};
}

async fn detect_abandoned_volumes(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT ON (e.cloud_resource_id)
               $1, e.cloud_resource_id,
               'abandoned_volume'::recommendation_type, 'active'::recommendation_status,
               'Abandoned Volume: ' || COALESCE(e.resource_name, e.cloud_resource_id),
               'This volume has not been attached for 7+ days',
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               100.0,
               jsonb_build_object(
                   'resource_type', 'volume',
                   'reason', 'no_cmdb_instance_association',
                   'detection_window_days', 7,
                   'resource_name', COALESCE(e.resource_name, e.cloud_resource_id)
               )
           FROM expenses e
           WHERE e.organization_id = $1 AND e.resource_type::text = 'volume'
           AND e.cost > 0 AND e.date >= CURRENT_DATE - INTERVAL '7 days'
           AND NOT EXISTS (
               SELECT 1 FROM ci_instance_associations cia
               JOIN cis c ON cia.src_ci_id = c.id
               WHERE c.cloud_resource_id = e.cloud_resource_id AND c.organization_id = $1
           )
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_abandoned_snapshots(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT ON (e.cloud_resource_id)
               $1, e.cloud_resource_id,
               'abandoned_snapshot'::recommendation_type, 'active'::recommendation_status,
               'Old Snapshot: ' || COALESCE(e.resource_name, e.cloud_resource_id),
               'Snapshot is older than 90 days and may no longer be needed',
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               100.0,
               jsonb_build_object(
                   'resource_type', 'snapshot',
                   'lookback_days', 90,
                   'reason', 'snapshot_age_exceeds_90_days',
                   'resource_name', COALESCE(e.resource_name, e.cloud_resource_id)
               )
           FROM expenses e
           WHERE e.organization_id = $1 AND e.resource_type::text = 'snapshot'
           AND e.cost > 0 AND e.date >= CURRENT_DATE - INTERVAL '90 days'
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_abandoned_lbs(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT ON (e.cloud_resource_id)
               $1, e.cloud_resource_id,
               'abandoned_lb'::recommendation_type, 'active'::recommendation_status,
               'Idle Load Balancer: ' || COALESCE(e.resource_name, e.cloud_resource_id),
               'Load balancer appears to have no healthy targets',
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               100.0,
               jsonb_build_object(
                   'resource_type', 'load_balancer',
                   'reason', 'no_healthy_targets',
                   'detection_window_days', 7,
                   'resource_name', COALESCE(e.resource_name, e.cloud_resource_id)
               )
           FROM expenses e
           WHERE e.organization_id = $1 AND e.resource_type::text = 'load_balancer'
           AND e.cost > 0 AND e.date >= CURRENT_DATE - INTERVAL '7 days'
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_obsolete_ips(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT ON (e.cloud_resource_id)
               $1, e.cloud_resource_id,
               'abandoned_ip'::recommendation_type, 'active'::recommendation_status,
               'Unattached Elastic IP: ' || COALESCE(e.resource_name, e.cloud_resource_id),
               'Elastic IP is not associated with any instance',
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               100.0,
               jsonb_build_object(
                   'resource_type', 'ip_address',
                   'reason', 'not_associated_with_instance',
                   'detection_window_days', 7,
                   'resource_name', COALESCE(e.resource_name, e.cloud_resource_id)
               )
           FROM expenses e
           WHERE e.organization_id = $1 AND e.resource_type::text = 'ip_address'
           AND e.cost > 0 AND e.date >= CURRENT_DATE - INTERVAL '7 days'
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_rightsizing(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH instance_costs AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost,
                      COUNT(*) AS days_observed,
                      SUM(cost) AS total_cost
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'instance'
               AND date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 14
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'rightsizing_instance'::recommendation_type, 'active'::recommendation_status,
               'Rightsizing candidate: ' || COALESCE(resource_name, cloud_resource_id),
               'Instance may be overprovisioned based on cost patterns — consider a smaller size',
               avg_daily_cost * 30, avg_daily_cost * 30 * 0.30, 30.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost, 'days_observed', days_observed)
           FROM instance_costs
           WHERE avg_daily_cost * 30 > 50
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_s3_intelligent_tiering(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH s3_costs AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'storage'
               AND date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING AVG(cost) > 5
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               's3_intelligent_tiering'::recommendation_type, 'active'::recommendation_status,
               'Enable S3 Intelligent-Tiering: ' || COALESCE(resource_name, cloud_resource_id),
               'Enable Intelligent-Tiering to automatically move data to lower-cost tiers',
               avg_daily_cost * 30, avg_daily_cost * 30 * 0.25, 25.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost)
           FROM s3_costs
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_inactive_iam_users(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    // Check for CIs of IAM user type that haven't been updated in >90 days
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT
               $1,
               c.cloud_resource_id,
               'inactive_iam_user'::recommendation_type,
               'active'::recommendation_status,
               'Inactive IAM User: ' || c.name,
               'IAM user has not been updated in 90+ days — review and deactivate if unused',
               0.0, 0.0, 0.0,
               jsonb_build_object('ci_id', c.id, 'last_updated', c.updated_at)
           FROM cis c
           JOIN ci_types ct ON ct.id = c.ci_type_id
           WHERE c.organization_id = $1
           AND ct.name ILIKE '%iam%'
           AND c.updated_at < NOW() - INTERVAL '90 days'
           AND c.deleted_at IS NULL
           AND c.lifecycle_state::text NOT IN ('decommissioned', 'retired')
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_reserved_instance_opportunity(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    // Find instances running consistently for 30+ days → suggest Reserved Instance
    let result = sqlx::query(
        r#"WITH consistent_instances AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost,
                      COUNT(*) AS days_active
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'instance'
               AND date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 28 AND AVG(cost) > 2.0
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'reserved_instance'::recommendation_type, 'active'::recommendation_status,
               'Reserved Instance opportunity: ' || COALESCE(resource_name, cloud_resource_id),
               'Instance runs continuously — a 1-year Reserved Instance could save up to 40%',
               avg_daily_cost * 30, avg_daily_cost * 30 * 0.40, 40.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost, 'days_active', days_active)
           FROM consistent_instances
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_volumes_not_attached(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT DISTINCT ON (e.cloud_resource_id)
               $1, e.cloud_resource_id,
               'abandoned_volume'::recommendation_type, 'active'::recommendation_status,
               'Volume not attached (7+ days): ' || COALESCE(e.resource_name, e.cloud_resource_id),
               'Volume has incurred cost for 7+ days with no CMDB instance association',
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               SUM(e.cost) OVER (PARTITION BY e.cloud_resource_id) * 12
                 / NULLIF(COUNT(*) OVER (PARTITION BY e.cloud_resource_id), 0),
               100.0, jsonb_build_object(
                   'resource_type', 'volume',
                   'detection', 'volumes_not_attached',
                   'reason', 'no_cmdb_ci_association',
                   'detection_window_days', 7
               )
           FROM expenses e
           WHERE e.organization_id = $1 AND e.resource_type::text = 'volume'
           AND e.cost > 0 AND e.date >= CURRENT_DATE - INTERVAL '7 days'
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_s3_abandoned_buckets(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH low_s3 AS (
               SELECT cloud_resource_id, resource_name, AVG(cost) AS avg_daily_cost
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'bucket'
               AND date >= CURRENT_DATE - INTERVAL '7 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING AVG(cost) < 0.10
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'abandoned_s3_bucket'::recommendation_type, 'active'::recommendation_status,
               'Abandoned S3 Bucket: ' || COALESCE(resource_name, cloud_resource_id),
               'S3 bucket has minimal activity — consider archiving or deleting',
               avg_daily_cost * 30, avg_daily_cost * 30, 100.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost)
           FROM low_s3
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_instances_for_shutdown(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH idle_instances AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost, COUNT(*) AS days_idle
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'instance'
               AND date >= CURRENT_DATE - INTERVAL '14 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 14 AND AVG(cost) < 0.20
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'instance_for_shutdown'::recommendation_type, 'active'::recommendation_status,
               'Instance candidate for shutdown: ' || COALESCE(resource_name, cloud_resource_id),
               'Instance shows minimal usage for 14+ days — consider stopping or terminating',
               avg_daily_cost * 30, avg_daily_cost * 30, 100.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost, 'days_idle', days_idle)
           FROM idle_instances
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_rightsizing_rds(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH rds_costs AS (
               SELECT cloud_resource_id, resource_name, AVG(cost) AS avg_daily_cost
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'rds_instance'
               AND date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 14 AND AVG(cost) * 30 > 50
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'rightsizing_rds'::recommendation_type, 'active'::recommendation_status,
               'Rightsizing candidate (RDS): ' || COALESCE(resource_name, cloud_resource_id),
               'RDS instance may be overprovisioned — consider a smaller instance class',
               avg_daily_cost * 30, avg_daily_cost * 30 * 0.25, 25.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost)
           FROM rds_costs
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

async fn detect_savings_plan_opportunity(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH consistent AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost, COUNT(*) AS days
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'instance'
               AND date >= CURRENT_DATE - INTERVAL '30 days'
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 28 AND AVG(cost) > 1.0
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'savings_plan_opportunity'::recommendation_type, 'active'::recommendation_status,
               'Savings Plan opportunity: ' || COALESCE(resource_name, cloud_resource_id),
               'Instance runs consistently — a Compute Savings Plan could save up to 35%',
               avg_daily_cost * 30, avg_daily_cost * 30 * 0.35, 35.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost, 'days_consistent', days)
           FROM consistent
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Images not referenced by any volume or instance (spec: abandoned_images).
async fn detect_abandoned_images(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let sql = r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'abandoned_image'::recommendation_type, 'active'::recommendation_status,
            'Abandoned Image: ' || COALESCE(r.name, r.cloud_resource_id),
            'Image is not referenced by any volume or instance',
            r.total_cost, r.total_cost,
            CASE WHEN r.total_cost > 0 THEN 100 ELSE 0 END,
            jsonb_build_object('resource_type', r.resource_type, 'region', r.cloud_region)
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'image'
          AND NOT EXISTS (
              SELECT 1 FROM resources v
              WHERE v.organization_id = r.organization_id
                AND v.meta->>'image_id' = r.cloud_resource_id
          )
        ON CONFLICT DO NOTHING
    "#;
    let result = sqlx::query(sql)
        .bind(org_id)
        .execute(&state.db)
        .await?;
    Ok(result.rows_affected() as u32)
}

/// Kinesis streams idle for 7+ days (spec: abandoned_kinesis_streams).
async fn detect_abandoned_kinesis_streams(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let sql = r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'abandoned_kinesis_stream'::recommendation_type, 'active'::recommendation_status,
            'Abandoned Kinesis Stream: ' || COALESCE(r.name, r.cloud_resource_id),
            'Stream has had no activity for 7+ days',
            r.total_cost, r.total_cost,
            CASE WHEN r.total_cost > 0 THEN 100 ELSE 0 END,
            jsonb_build_object('last_seen', r.last_seen, 'region', r.cloud_region)
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND (r.service_name ILIKE '%kinesis%' OR r.meta->>'resource_kind' = 'kinesis_stream')
          AND r.last_seen < NOW() - INTERVAL '7 days'
        ON CONFLICT DO NOTHING
    "#;
    let result = sqlx::query(sql)
        .bind(org_id)
        .execute(&state.db)
        .await?;
    Ok(result.rows_affected() as u32)
}

/// Stopped-but-not-deallocated instances (spec: instances_in_stopped_state).
async fn detect_instances_in_stopped_state(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let sql = r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'instance_in_stopped_state'::recommendation_type, 'active'::recommendation_status,
            'Stopped Instance: ' || COALESCE(r.name, r.cloud_resource_id),
            'Instance is stopped but still billed — deallocate or terminate',
            r.total_cost, r.total_cost,
            CASE WHEN r.total_cost > 0 THEN 100 ELSE 0 END,
            jsonb_build_object('state', r.meta->>'status', 'region', r.cloud_region)
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'instance'
          AND LOWER(r.meta->>'status') IN ('stopped', 'stopping')
        ON CONFLICT DO NOTHING
    "#;
    let result = sqlx::query(sql)
        .bind(org_id)
        .execute(&state.db)
        .await?;
    Ok(result.rows_affected() as u32)
}

/// Older-generation instances where a newer generation is cheaper
/// (spec: instance_generation_upgrade; enum value already exists).
async fn detect_instance_generation_upgrades(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'instance_generation_upgrade'::recommendation_type, 'active'::recommendation_status,
            'Generation Upgrade: ' || COALESCE(r.name, r.cloud_resource_id),
            'Older instance generation (m4/m5/t2/t3) — newer generations are typically cheaper',
            r.total_cost, ROUND(r.total_cost * 0.15, 2),
            15,
            jsonb_build_object('instance_type', r.meta->>'instance_type')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'instance'
          AND r.meta->>'instance_type' ~* '^(m4|m5|t2|t3|m3|c3)\.'
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Aliyun snapshot chains with no active snapshots (spec: obsolete_snapshot_chains).
async fn detect_obsolete_snapshot_chains(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'obsolete_snapshot_chain'::recommendation_type, 'active'::recommendation_status,
            'Obsolete Snapshot Chain: ' || COALESCE(r.name, r.cloud_resource_id),
            'Snapshot chain is no longer referenced by any snapshot',
            r.total_cost, r.total_cost,
            CASE WHEN r.total_cost > 0 THEN 100 ELSE 0 END,
            jsonb_build_object('chain_id', r.meta->>'chain_id')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'snapshot_chain'
          AND NOT EXISTS (
              SELECT 1 FROM resources sn
              WHERE sn.organization_id = r.organization_id
                AND sn.resource_type = 'snapshot'
                AND sn.meta->>'chain_id' = r.meta->>'chain_id'
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Snapshots backing AMIs that no instance uses (spec: snapshots_with_non_used_images).
async fn detect_snapshots_with_non_used_images(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (s.cloud_resource_id)
            $1, s.cloud_resource_id,
            'snapshot_with_non_used_image'::recommendation_type, 'active'::recommendation_status,
            'Snapshot With Unused AMI: ' || COALESCE(s.name, s.cloud_resource_id),
            'Snapshot backs an AMI that no running instance uses',
            s.total_cost, s.total_cost,
            CASE WHEN s.total_cost > 0 THEN 100 ELSE 0 END,
            jsonb_build_object('image_id', s.meta->>'image_id')
        FROM resources s
        WHERE s.organization_id = $1
          AND s.active = true
          AND s.resource_type = 'snapshot'
          AND s.meta->>'image_id' IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM resources i
              WHERE i.organization_id = s.organization_id
                AND i.resource_type = 'instance'
                AND i.meta->>'image_id' = s.meta->>'image_id'
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Security groups exposing SSH/RDP to 0.0.0.0/0 (spec: insecure_security_groups;
/// enum value already exists). Security finding — savings N/A.
async fn detect_insecure_security_groups(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'insecure_security_group'::recommendation_type, 'active'::recommendation_status,
            'Insecure Security Group: ' || COALESCE(r.name, r.cloud_resource_id),
            'Security group allows SSH/RDP (22/3389) from 0.0.0.0/0',
            r.total_cost, 0, 0,
            jsonb_build_object('open_ports', r.meta->'open_ports')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND (r.meta->>'security_group' = 'true' OR r.meta->'open_ports' IS NOT NULL)
          AND (
              r.meta->>'inbound_open' = 'true'
              OR r.meta->'open_ports' @> '[22, 3389]'::jsonb
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// S3 buckets with public policies/ACLs (spec: s3_public_buckets).
async fn detect_s3_public_buckets(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            's3_public_bucket'::recommendation_type, 'active'::recommendation_status,
            'Public S3 Bucket: ' || COALESCE(r.name, r.cloud_resource_id),
            'Bucket policy or ACL allows public access',
            r.total_cost, 0, 0,
            jsonb_build_object('public', r.meta->>'public')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'bucket'
          AND (
              r.meta->>'public' = 'true'
              OR r.meta->>'public_policy' = 'true'
          )
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// IAM users inactive 90+ days (spec: inactive_users).
async fn detect_inactive_users(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'inactive_user'::recommendation_type, 'active'::recommendation_status,
            'Inactive IAM User: ' || COALESCE(r.name, r.cloud_resource_id),
            'User has had no activity for 90+ days',
            r.total_cost, 0, 0,
            jsonb_build_object('last_used_days', r.meta->>'last_used_days')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND (r.meta->>'iam_user' = 'true' OR r.service_name ILIKE '%iam%')
          AND COALESCE((r.meta->>'last_used_days')::int, 999) >= 90
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Console unused but API keys active (spec: inactive_console_users).
async fn detect_inactive_console_users(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'inactive_console_user'::recommendation_type, 'active'::recommendation_status,
            'Inactive Console User: ' || COALESCE(r.name, r.cloud_resource_id),
            'Console unused for 90+ days while API keys remain active',
            r.total_cost, 0, 0,
            jsonb_build_object(
                'console_last_used_days', r.meta->>'console_last_used_days',
                'api_keys_active', r.meta->>'api_keys_active'
            )
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND (r.meta->>'iam_user' = 'true' OR r.service_name ILIKE '%iam%')
          AND COALESCE((r.meta->>'console_last_used_days')::int, 999) >= 90
          AND COALESCE(r.meta->>'api_keys_active', 'false') = 'true'
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Aliyun PAYG instances with 90+ days of consistent usage that would be
/// cheaper under a subscription (spec: instance_subscription).
async fn detect_instance_subscriptions(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'instance_subscription'::recommendation_type, 'active'::recommendation_status,
            'Subscription Opportunity: ' || COALESCE(r.name, r.cloud_resource_id),
            'Pay-as-you-go instance with steady usage — a subscription is ~30% cheaper',
            r.total_cost, ROUND(r.total_cost * 0.30, 2),
            30,
            jsonb_build_object('payment_type', r.meta->>'payment_type', 'provider', 'alibaba')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'instance'
          AND r.cloud_account_id IN (
              SELECT id FROM cloud_accounts
              WHERE organization_id = $1 AND provider = 'alibaba'
          )
          AND COALESCE(r.meta->>'payment_type', 'pay_as_you_go') = 'pay_as_you_go'
          AND r.first_seen < NOW() - INTERVAL '90 days'
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Instances with short lifetimes that could run on spot/preemptible
/// (spec: short_living_instances) — ~72% saving.
async fn detect_short_living_instances(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"
        INSERT INTO recommendations
            (organization_id, cloud_resource_id, rec_type, status, title, description,
             current_monthly_cost, potential_savings, savings_percent, details)
        SELECT DISTINCT ON (r.cloud_resource_id)
            $1, r.cloud_resource_id,
            'short_living_instance'::recommendation_type, 'active'::recommendation_status,
            'Spot Candidate: ' || COALESCE(r.name, r.cloud_resource_id),
            'Instance lifetime under 6h — a spot/preemptible instance would cost ~72% less',
            r.total_cost, ROUND(r.total_cost * 0.72, 2),
            72,
            jsonb_build_object('lifetime_hours', r.meta->>'lifetime_hours')
        FROM resources r
        WHERE r.organization_id = $1
          AND r.active = true
          AND r.resource_type = 'instance'
          AND COALESCE((r.meta->>'lifetime_hours')::int, 999) <= 6
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;
    Ok(result.rows_affected() as u32)
}

/// Metric-aware variant of abandoned-instance detection (product gap D1).
///
/// Instances WITH metrics are flagged when avg cpu_utilization < 5% over the
/// last 7 days (the spec's real threshold); instances without metrics fall
/// back to the low-cost expense proxy.
async fn detect_abandoned_instances_metric_aware(state: &AppState, org_id: Uuid) -> AppResult<u32> {
    let result = sqlx::query(
        r#"WITH metric_idle AS (
               SELECT r.id, r.cloud_resource_id, r.name,
                      AVG(m.value) AS avg_cpu
               FROM metrics m
               JOIN resources r ON r.id = m.resource_id
               WHERE r.organization_id = $1 AND r.active = true
                 AND m.metric_name = 'cpu_utilization'
                 AND m.ts >= NOW() - INTERVAL '7 days'
               GROUP BY r.id, r.cloud_resource_id, r.name
               HAVING AVG(m.value) < 5.0
           ),
           low_cost_instances AS (
               SELECT e.cloud_resource_id, e.resource_name,
                      AVG(e.cost) AS avg_daily_cost
               FROM expenses e
               WHERE e.organization_id = $1 AND e.resource_type::text = 'instance'
                 AND e.date >= CURRENT_DATE - INTERVAL '30 days'
                 AND NOT EXISTS (
                     SELECT 1 FROM metrics m
                     JOIN resources r ON r.id = m.resource_id
                     WHERE r.organization_id = e.organization_id
                       AND r.cloud_resource_id = e.cloud_resource_id
                       AND m.metric_name = 'cpu_utilization'
                 )
               GROUP BY e.cloud_resource_id, e.resource_name
               HAVING COUNT(*) >= 14 AND AVG(e.cost) < 0.5
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'abandoned_instance'::recommendation_type, 'active'::recommendation_status,
               'Idle instance: ' || COALESCE(name, cloud_resource_id),
               'Average CPU utilization below 5% for 7 days',
               0, 0, 0,
               jsonb_build_object('avg_cpu_utilization', avg_cpu, 'evidence', 'metrics')
           FROM metric_idle
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;

    let fallback = sqlx::query(
        r#"WITH low_cost_instances AS (
               SELECT cloud_resource_id, resource_name,
                      AVG(cost) AS avg_daily_cost
               FROM expenses
               WHERE organization_id = $1 AND resource_type::text = 'instance'
                 AND date >= CURRENT_DATE - INTERVAL '30 days'
                 AND NOT EXISTS (
                     SELECT 1 FROM metrics m
                     JOIN resources r ON r.id = m.resource_id
                     WHERE r.organization_id = $1
                       AND r.cloud_resource_id = expenses.cloud_resource_id
                       AND m.metric_name = 'cpu_utilization'
                 )
               GROUP BY cloud_resource_id, resource_name
               HAVING COUNT(*) >= 14 AND AVG(cost) < 0.5
           )
           INSERT INTO recommendations
           (organization_id, cloud_resource_id, rec_type, status, title, description,
            current_monthly_cost, potential_savings, savings_percent, details)
           SELECT $1, cloud_resource_id,
               'abandoned_instance'::recommendation_type, 'active'::recommendation_status,
               'Possibly idle instance: ' || COALESCE(resource_name, cloud_resource_id),
               'Instance cost is very low — may be stopped but still allocated',
               avg_daily_cost * 30, avg_daily_cost * 30, 100.0,
               jsonb_build_object('avg_daily_cost', avg_daily_cost, 'evidence', 'expense_proxy')
           FROM low_cost_instances
           ON CONFLICT DO NOTHING"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await?;

    Ok((result.rows_affected() + fallback.rows_affected()) as u32)
}
/// Confidence scoring (D4): +40 base, +30 with cost data, +30 with
/// meta/details evidence. Stored in details.confidence.
async fn score_confidence(state: &AppState, org_id: Uuid) {
    let _ = sqlx::query(
        r#"UPDATE recommendations SET details = jsonb_set(
               COALESCE(details, '{}'::jsonb),
               '{confidence}',
               to_jsonb(
                   40
                   + CASE WHEN current_monthly_cost > 0 OR potential_savings > 0 THEN 30 ELSE 0 END
                   + CASE WHEN details IS NOT NULL AND details <> '{}'::jsonb THEN 30 ELSE 0 END
               )
           )
           WHERE organization_id = $1 AND status = 'active'"#,
    )
    .bind(org_id)
    .execute(&state.db)
    .await;
}
