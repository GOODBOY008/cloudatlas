/// AWS Cost and Usage Report (CUR) billing importer.
///
/// In production, this module:
/// 1. Reads CUR CSV/Parquet files from S3 via cloud account credentials
/// 2. Parses line items into `raw_expenses` table
/// 3. Aggregates daily by (resource_id, service, region) into `expenses`
///
/// This implementation provides the data pipeline structure and SQL queries.
/// The actual S3 client call is behind the `CLOUD_MOCK_ENABLED` flag.
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// S3 source configuration accepted on the cloud account `config` JSONB:
/// `{"bucket": "my-cur-bucket", "prefix": "cur/", "region": "us-east-1"}`
const DEFAULT_CUR_REGION: &str = "us-east-1";

#[derive(Debug, Deserialize, Serialize)]
pub struct CurLineItem {
    pub resource_id: String,
    pub resource_name: Option<String>,
    pub service_name: String,
    pub usage_date: NaiveDate,
    pub region: Option<String>,
    pub resource_type: Option<String>,
    pub cost_usd: f64,
    pub currency: String,
    pub tags: serde_json::Value,
}

/// Download the most recent CUR file from S3 and parse it into line items.
///
/// CUR config is read from the cloud account `config` JSONB: `bucket`,
/// optional `prefix`, optional `region`. The newest object under the prefix is
/// fetched, decompressed (`.csv.gz` / `.csv`), and parsed using the standard
/// AWS CUR column names (`lineItem/...`, `product/...`, `resourceTags/user:*`).
/// Non-metered line item types (tax, credit, discount, refunds) are skipped.
pub async fn fetch_cur_line_items(
    creds: &serde_json::Value,
    config: &serde_json::Value,
    _days: i64,
    progress: Option<&mut (dyn FnMut(usize, usize) -> bool + Send)>,
) -> AppResult<Vec<CurLineItem>> {
    let bucket = config
        .get("bucket")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Validation("CUR config requires a 'bucket' key".into()))?
        .to_string();
    let prefix = config
        .get("prefix")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let region = config
        .get("region")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_CUR_REGION)
        .to_string();

    // Build the S3 client from the account's stored credentials.
    let creds = creds.clone();
    let s3 = build_s3_client(&creds, &region).await?;

    // List objects under the prefix and pick the most recent CUR file.
    let list = s3
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&prefix)
        .send()
        .await
        .map_err(|e| AppError::Cloud(format!("S3 list failed: {e}")))?;

    let mut candidates: Vec<(String, String)> = Vec::new(); // (key, display_name)
    for obj in list.contents() {
        let key = obj.key().unwrap_or_default();
        if key.ends_with(".csv.gz") || key.ends_with(".csv") {
            candidates.push((key.to_string(), key.to_string()));
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0)); // newest key first (CUR keys embed the date)

    let (key, _) = candidates.into_iter().next().ok_or_else(|| {
        AppError::NotFound("No CUR CSV files found in the configured S3 bucket/prefix".into())
    })?;

    let object = s3
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| AppError::Cloud(format!("S3 get failed for {key}: {e}")))?;

    let bytes = object
        .body
        .collect()
        .await
        .map_err(|e| AppError::Cloud(format!("S3 body read failed: {e}")))?;

    let data = bytes.into_bytes();
    let text = if key.ends_with(".gz") {
        let mut decoder = flate2::read::GzDecoder::new(&data[..]);
        let mut out = String::new();
        std::io::Read::read_to_string(&mut decoder, &mut out)
            .map_err(|e| AppError::Cloud(format!("CUR gunzip failed: {e}")))?;
        out
    } else {
        String::from_utf8(data.to_vec())
            .map_err(|e| AppError::Cloud(format!("CUR file is not UTF-8: {e}")))?
    };

    let items = parse_cur_csv(&text)?;

    // CUR resolves to a single newest object — one coarse tick satisfies the
    // hook contract ("per object when naturally countable").
    if let Some(hook) = progress {
        hook(1, 1);
    }
    Ok(items)
}

/// Build a minimal S3 client from account credentials (access key / secret /
/// optional session token). Falls back to the default credential chain when no
/// credentials object is stored.
async fn build_s3_client(creds: &serde_json::Value, region: &str) -> AppResult<aws_sdk_s3::Client> {
    let region = aws_config::Region::new(region.to_string());

    let access = creds.get("access_key_id").and_then(|v| v.as_str());
    let secret = creds.get("secret_access_key").and_then(|v| v.as_str());
    let token = creds.get("session_token").and_then(|v| v.as_str());

    if let (Some(ak), Some(sk)) = (access, secret) {
        let creds_builder = aws_sdk_s3::config::Credentials::new(
            ak.to_string(),
            sk.to_string(),
            token.map(|t| t.to_string()),
            None,
            "cloudatlas-cur",
        );
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(region)
            .credentials_provider(creds_builder)
            .load()
            .await;
        Ok(aws_sdk_s3::Client::new(&cfg))
    } else {
        // No stored keys — fall back to env / instance role chain.
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(region)
            .load()
            .await;
        Ok(aws_sdk_s3::Client::new(&cfg))
    }
}

/// Map a CUR `lineItem/UsageType` to a coarse resource type.
fn classify_resource_type(usage_type: &str, product_name: &str) -> Option<String> {
    let ut = usage_type.to_lowercase();
    let pn = product_name.to_lowercase();
    if pn.contains("s3") || ut.contains("s3") {
        Some("bucket".into())
    } else if pn.contains("rds") || ut.contains("rds") {
        Some("rds_instance".into())
    } else if ut.contains("boxusage") || pn.contains("ec2") {
        Some("instance".into())
    } else if ut.contains("loadbalancer") || ut.contains("elb") || ut.contains("loadbalanc") {
        Some("load_balancer".into())
    } else if ut.contains("eip") || ut.contains("elastic-ip") || ut.contains("address") {
        Some("ip_address".into())
    } else if ut.contains("snapshot") {
        Some("snapshot".into())
    } else if ut.contains("ebs") || ut.contains("volume") {
        Some("volume".into())
    } else {
        None
    }
}

/// Parse standard CUR CSV text (header row with `lineItem/…` columns) into
/// [`CurLineItem`]s. Rows without a resource id or cost are skipped.
fn parse_cur_csv(text: &str) -> AppResult<Vec<CurLineItem>> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(text.as_bytes());

    let headers = reader
        .headers()
        .map_err(|e| AppError::Cloud(format!("CUR header parse failed: {e}")))?
        .clone();

    let get = |record: &csv::StringRecord, col: &str| -> Option<String> {
        headers.iter().position(|h| h == col).and_then(|i| {
            let v = record.get(i).unwrap_or_default().trim();
            if v.is_empty() {
                None
            } else {
                Some(v.to_string())
            }
        })
    };

    let mut items = Vec::new();
    for (idx, record) in reader.records().enumerate() {
        let record = match record {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(row = idx, error = %e, "CUR row skipped");
                continue;
            }
        };

        let line_item_type = get(&record, "lineItem/LineItemType")
            .unwrap_or_default()
            .to_lowercase();
        if matches!(
            line_item_type.as_str(),
            "tax" | "credit" | "discount" | "refund" | "fee"
        ) {
            continue;
        }

        let cost = get(&record, "lineItem/UnblendedCost")
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);
        if cost <= 0.0 {
            continue;
        }

        let resource_id = get(&record, "lineItem/ResourceId")
            .or_else(|| get(&record, "lineItem/ResourceID"))
            .unwrap_or_else(|| {
                // Fall back to a deterministic pseudo id when CUR lacks one.
                format!(
                    "cur-{}",
                    record.iter().take(4).collect::<Vec<_>>().join("-")
                )
            });

        let usage_date = get(&record, "lineItem/UsageStartDate")
            .and_then(|d| NaiveDate::parse_from_str(&d[..10], "%Y-%m-%d").ok())
            .unwrap_or_else(|| chrono::Utc::now().date_naive());

        let usage_type = get(&record, "lineItem/UsageType").unwrap_or_default();
        let product_name = get(&record, "product/ProductName")
            .or_else(|| get(&record, "lineItem/ProductName"))
            .unwrap_or_default();

        // resourceTags/user:* → tags map
        let mut tags = serde_json::Map::new();
        for (h, v) in headers.iter().zip(record.iter()) {
            if let Some(key) = h.strip_prefix("resourceTags/user:") {
                if !v.is_empty() {
                    tags.insert(key.to_string(), serde_json::Value::String(v.to_string()));
                }
            }
        }

        items.push(CurLineItem {
            resource_id,
            resource_name: get(&record, "lineItem/ResourceId"),
            service_name: if !product_name.is_empty() {
                product_name.clone()
            } else if !usage_type.is_empty() {
                usage_type.clone()
            } else {
                "unknown".into()
            },
            usage_date,
            region: get(&record, "lineItem/AvailabilityZone").map(|az| {
                // "us-east-1a" → "us-east-1" (strip the AZ letter suffix)
                let mut r = az.clone();
                if r.ends_with(|c: char| c.is_ascii_alphabetic()) {
                    r.pop();
                }
                r
            }),
            resource_type: classify_resource_type(&usage_type, &product_name),
            cost_usd: cost,
            currency: get(&record, "lineItem/CurrencyCode").unwrap_or_else(|| "USD".into()),
            tags: serde_json::Value::Object(tags),
        });
    }

    Ok(items)
}

/// Import a batch of CUR line items for a cloud account (insert into
/// `raw_expenses` only — aggregation is a separate phase).
/// Returns number of new expense rows inserted.
///
/// `progress` is called every 500 rows with (rows_done, total); returning
/// `false` aborts the insert loop early (cooperative cancellation).
pub async fn import_line_items(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    items: Vec<CurLineItem>,
    mut progress: Option<&mut (dyn FnMut(usize, usize) -> bool + Send)>,
) -> AppResult<u32> {
    use super::fx;

    let org_cur = fx::org_currency(&state.db, org_id).await;
    let fx_table = fx::load_rates(&state.db, org_id).await;
    let mut inserted = 0u32;
    let total = items.len();
    let mut alive = true;

    for (idx, item) in items.iter().enumerate() {
        if !alive {
            break;
        }
        // Convert to the org display currency; the native cost/currency
        // survive in cloud_specific for audit.
        let (cost, _converted) = fx::convert_or_warn(
            &fx_table,
            item.cost_usd,
            &item.currency,
            &org_cur,
            "aws_cur import",
        );
        let native = serde_json::json!({
            "native_cost": item.cost_usd,
            "native_currency": item.currency,
            "tags": item.tags,
        });
        let result = sqlx::query(
            r#"INSERT INTO raw_expenses
               (organization_id, cloud_account_id, external_id, billing_period,
                cloud_resource_id, resource_name, resource_type, cloud_region,
                cost, currency, service_name, cloud_specific)
               VALUES ($1, $2, $3, $4, $3, $5, $6::resource_type, $7, $8, $9, $10, $11)
               ON CONFLICT (cloud_account_id, external_id, billing_period) DO NOTHING"#,
        )
        .bind(org_id)
        .bind(account_id)
        .bind(&item.resource_id)
        .bind(item.usage_date)
        .bind(&item.resource_name)
        .bind(&item.resource_type)
        .bind(&item.region)
        .bind(cost)
        .bind(&org_cur)
        .bind(&item.service_name)
        .bind(&native)
        .execute(&state.db)
        .await?;

        inserted += result.rows_affected() as u32;

        if let Some(hook) = progress.as_mut() {
            if idx % 500 == 0 {
                alive = hook(idx + 1, total);
            }
        }
    }

    Ok(inserted)
}

/// Re-aggregate raw_expenses → expenses for the given account.
pub async fn aggregate_to_expenses(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
) -> AppResult<()> {
    sqlx::query(
        r#"INSERT INTO expenses
           (organization_id, cloud_account_id, cloud_resource_id, resource_name,
            service_name, date, cloud_region, resource_type, cost, currency, tags)
           SELECT
               organization_id, cloud_account_id, cloud_resource_id,
               MAX(resource_name) AS resource_name,
               service_name, billing_period AS date,
               MAX(cloud_region) AS cloud_region,
               MAX(resource_type) AS resource_type,
               SUM(cost) AS cost,
               MAX(currency) AS currency,
               '{}'::jsonb AS tags
           FROM raw_expenses
           WHERE organization_id = $1 AND cloud_account_id = $2
           GROUP BY organization_id, cloud_account_id, cloud_resource_id, service_name, billing_period
           ON CONFLICT (organization_id, cloud_account_id, cloud_resource_id, date)
           DO UPDATE SET
               cost = EXCLUDED.cost,
               resource_name = EXCLUDED.resource_name,
               cloud_region = EXCLUDED.cloud_region,
               resource_type = EXCLUDED.resource_type"#,
    )
    .bind(org_id)
    .bind(account_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Simulate fetching mock CUR data (used when CLOUD_MOCK_ENABLED=true)
pub fn generate_mock_cur_data(days: i64) -> Vec<CurLineItem> {
    (0..days).flat_map(generate_mock_cur_data_for_day).collect()
}

/// One day's worth of mock CUR items, `offset` days before today. Lets the
/// async worker stream mock data day-by-day with progress ticks.
pub fn generate_mock_cur_data_for_day(offset: i64) -> Vec<CurLineItem> {
    use chrono::Duration;
    let date = chrono::Utc::now().date_naive() - Duration::days(offset);
    let services = [
        ("EC2", "instance", 3.50),
        ("S3", "bucket", 0.80),
        ("RDS", "rds_instance", 5.20),
        ("ELB", "load_balancer", 1.10),
        ("EIP", "ip_address", 0.005),
    ];

    services
        .iter()
        .map(|(service, rtype, base_cost)| CurLineItem {
            resource_id: format!("{}-mock-resource-001", rtype),
            resource_name: Some(format!("mock-{}-001", rtype)),
            service_name: service.to_string(),
            usage_date: date,
            region: Some("us-east-1".into()),
            resource_type: Some(rtype.to_string()),
            cost_usd: base_cost * (0.9 + rand_factor(offset)),
            currency: "USD".into(),
            tags: serde_json::json!({ "env": "mock", "team": "platform" }),
        })
        .collect()
}

fn rand_factor(seed: i64) -> f64 {
    // Simple deterministic "random" factor
    let x = (seed * 1234567 + 42) % 100;
    x as f64 / 500.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cur_csv_extracts_line_items() {
        let csv = concat!(
            "lineItem/LineItemType,lineItem/ResourceId,lineItem/UsageStartDate,",
            "lineItem/UsageType,lineItem/UnblendedCost,lineItem/CurrencyCode,",
            "lineItem/AvailabilityZone,product/ProductName,resourceTags/user:env\n",
            "Usage,i-0abc123,2026-08-01T00:00:00Z,BoxUsage:t3.micro,3.50,USD,",
            "us-east-1a,Amazon Elastic Compute Cloud,prod\n",
            "Usage,i-0def456,2026-08-02T00:00:00Z,BoxUsage:m5.large,12.00,USD,",
            "us-west-2b,Amazon Elastic Compute Cloud,dev\n",
            "Tax,i-0abc123,2026-08-01T00:00:00Z,BoxUsage:t3.micro,0.30,USD,",
            "us-east-1a,Amazon Elastic Compute Cloud,prod\n"
        );
        let items = parse_cur_csv(csv).expect("parse succeeds");
        assert_eq!(items.len(), 2, "tax rows are skipped");
        assert_eq!(items[0].resource_id, "i-0abc123");
        assert_eq!(items[0].service_name, "Amazon Elastic Compute Cloud");
        assert_eq!(items[0].resource_type.as_deref(), Some("instance"));
        assert_eq!(items[0].cost_usd, 3.50);
        assert_eq!(items[0].tags["env"], "prod");
        assert_eq!(items[0].region.as_deref(), Some("us-east-1"));
        assert_eq!(items[1].usage_date.to_string(), "2026-08-02");
    }

    #[test]
    fn parse_cur_csv_skips_zero_cost_rows() {
        let csv = concat!(
            "lineItem/LineItemType,lineItem/ResourceId,lineItem/UsageStartDate,",
            "lineItem/UsageType,lineItem/UnblendedCost,lineItem/CurrencyCode,product/ProductName\n",
            "Usage,i-0abc123,2026-08-01T00:00:00Z,BoxUsage:t3.micro,0.00,USD,Amazon Elastic Compute Cloud\n"
        );
        let items = parse_cur_csv(csv).expect("parse succeeds");
        assert!(items.is_empty());
    }

    #[test]
    fn classify_resource_types() {
        assert_eq!(
            classify_resource_type("BoxUsage:t3.micro", "Amazon Elastic Compute Cloud").as_deref(),
            Some("instance")
        );
        assert_eq!(
            classify_resource_type("S3-Requests", "Amazon Simple Storage Service").as_deref(),
            Some("bucket")
        );
        assert_eq!(
            classify_resource_type("RDS:Storage", "Amazon Relational Database Service").as_deref(),
            Some("rds_instance")
        );
        assert_eq!(
            classify_resource_type("ELB:DataProcessing", "Amazon Elastic Load Balancing")
                .as_deref(),
            Some("load_balancer")
        );
        assert_eq!(
            classify_resource_type("EIP:Address", "Amazon Elastic Compute Cloud").as_deref(),
            Some("ip_address")
        );
    }
}
