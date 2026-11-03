/// Alibaba Cloud BSS (Billing and Cost Management) billing importer.
///
/// In production, this module:
/// 1. Calls Alibaba Cloud BSS OpenAPI to fetch monthly bills
/// 2. Normalizes line items to match our internal schema
/// 3. Imports into raw_expenses → expenses tables
///
/// API Reference: https://help.aliyun.com/document_detail/87998.html
use crate::error::AppResult;
use crate::state::AppState;
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

use anyhow::anyhow;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::digest::KeyInit;
use hmac::{Hmac, Mac};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

const BSS_ENDPOINT: &str = "business.aliyuncs.com";
const BSS_VERSION: &str = "2017-12-14";

struct AliyunBssClient {
    access_key_id: String,
    access_key_secret: String,
    security_token: Option<String>,
    endpoint: String,
    http: reqwest::Client,
}

impl AliyunBssClient {
    fn from_credentials(credentials: &Value, config: &Value) -> AppResult<Self> {
        let access_key_id = credentials["access_key_id"]
            .as_str()
            .ok_or_else(|| {
                crate::error::AppError::Validation(
                    "Aliyun credentials missing 'access_key_id'".into(),
                )
            })?
            .to_string();
        let access_key_secret = credentials["access_key_secret"]
            .as_str()
            .ok_or_else(|| {
                crate::error::AppError::Validation(
                    "Aliyun credentials missing 'access_key_secret'".into(),
                )
            })?
            .to_string();
        let security_token = credentials
            .get("security_token")
            .and_then(Value::as_str)
            .map(str::to_string);

        let endpoint = config
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or(BSS_ENDPOINT)
            .to_string();

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| crate::error::AppError::Internal(anyhow!("reqwest build: {e}")))?;

        Ok(Self {
            access_key_id,
            access_key_secret,
            security_token,
            endpoint,
            http,
        })
    }

    fn rfc3986_encode(s: &str) -> String {
        let mut out = String::with_capacity(s.len() * 3);
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha1::new_from_slice(key).expect("HMAC accepts any key length");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    fn signed_url(&self, mut params: BTreeMap<String, String>) -> String {
        params.insert("Format".into(), "JSON".into());
        params.insert("AccessKeyId".into(), self.access_key_id.clone());
        params.insert("SignatureMethod".into(), "HMAC-SHA1".into());
        params.insert("SignatureNonce".into(), Uuid::new_v4().to_string());
        params.insert("SignatureVersion".into(), "1.0".into());
        params.insert(
            "Timestamp".into(),
            Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        );
        if let Some(ref token) = self.security_token {
            params.insert("SecurityToken".into(), token.clone());
        }

        let canonical = params
            .iter()
            .map(|(k, v)| format!("{}={}", Self::rfc3986_encode(k), Self::rfc3986_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let string_to_sign = format!(
            "GET&{}&{}",
            Self::rfc3986_encode("/"),
            Self::rfc3986_encode(&canonical)
        );

        let signing_key = format!("{}&", self.access_key_secret);
        let signature = BASE64.encode(Self::hmac_sha1(
            signing_key.as_bytes(),
            string_to_sign.as_bytes(),
        ));

        format!(
            "https://{}/?{}&Signature={}",
            self.endpoint,
            canonical,
            Self::rfc3986_encode(&signature)
        )
    }

    async fn call(&self, params: BTreeMap<String, String>) -> AppResult<Value> {
        let url = self.signed_url(params);
        let resp = self.http.get(&url).send().await.map_err(|e| {
            crate::error::AppError::Internal(anyhow!(
                "Aliyun BSS request failed: {}",
                e.without_url()
            ))
        })?;

        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| {
            crate::error::AppError::Internal(anyhow!("Aliyun BSS response parse failed: {e}"))
        })?;

        if !status.is_success() {
            let code = body["Code"].as_str().unwrap_or("Unknown");
            let msg = body["Message"].as_str().unwrap_or("Unknown error");
            return Err(crate::error::AppError::Internal(anyhow!(
                "Aliyun BSS API error [{code}]: {msg}"
            )));
        }

        // Alibaba RPC APIs report application errors inside a 200 response:
        // `{"Code": "InvalidParameter", "Message": "..."}`. Only `Success`
        // (or an absent Code) is a real success — anything else must surface,
        // otherwise a rejected request silently imports zero rows.
        if let Some(code) = body["Code"].as_str() {
            if code != "Success" {
                let msg = body["Message"].as_str().unwrap_or("Unknown error");
                return Err(crate::error::AppError::Internal(anyhow!(
                    "Aliyun BSS API error [{code}]: {msg}"
                )));
            }
        }

        Ok(body)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BssLineItem {
    pub instance_id: String,
    pub instance_name: Option<String>,
    pub product_code: String,
    pub product_name: Option<String>,
    pub bill_date: NaiveDate,
    pub region: Option<String>,
    pub zone: Option<String>,
    pub resource_type: Option<String>,
    pub subscription_type: Option<String>,
    pub billing_item: Option<String>,
    pub pretax_amount: f64,
    pub currency: String,
    pub tags: serde_json::Value,
}

/// Map Alibaba BSS product codes / product names to normalized resource
/// types. Product code wins; unknown codes fall back to the Chinese
/// `ProductName` fragments the BSS API returns.
pub fn classify_bss_type(product_code: &str, product_name: Option<&str>) -> &'static str {
    match product_code {
        "ecs" => "instance",
        "oss" => "bucket",
        "rds" => "rds_instance",
        "slb" | "alb" | "nlb" => "load_balancer",
        "eip" => "ip_address",
        "snapshot" => "snapshot",
        _ => match product_name {
            Some(n) if n.contains("云服务器") => "instance",
            Some(n) if n.contains("对象存储") => "bucket",
            Some(n) if n.contains("云数据库") => "rds_instance",
            Some(n) if n.contains("负载均衡") => "load_balancer",
            Some(n) if n.contains("弹性公网") => "ip_address",
            Some(n) if n.contains("快照") => "snapshot",
            _ => "other",
        },
    }
}

/// DescribeInstanceBill returns tags as `{ "TagList": { "Tag": [{TagKey,
/// TagValue}] } }`; some products return a flat array instead.
fn parse_bss_tags(node: &Value) -> Value {
    let empty = vec![];
    let list = node["TagList"]["Tag"]
        .as_array()
        .or_else(|| node.get("TagList").and_then(Value::as_array))
        .or_else(|| node.as_array())
        .unwrap_or(&empty);
    let map: serde_json::Map<String, Value> = list
        .iter()
        .filter_map(|t| {
            let k = t["TagKey"].as_str().or_else(|| t["Key"].as_str())?;
            let v = t["TagValue"]
                .as_str()
                .or_else(|| t["Value"].as_str())
                .unwrap_or_default();
            Some((k.to_string(), Value::String(v.to_string())))
        })
        .collect();
    Value::Object(map)
}

fn parse_cost(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

fn parse_bill_date(v: &Value) -> Option<NaiveDate> {
    let s = v.as_str()?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().or_else(|| {
        chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
            .ok()
            .map(|dt| dt.date())
    })
}

fn parse_bss_row(row: &Value) -> Option<BssLineItem> {
    let product_code = row["ProductCode"]
        .as_str()
        .or_else(|| row["ProductName"].as_str())?
        .to_string();
    let bill_date =
        parse_bill_date(&row["BillingDate"]).or_else(|| parse_bill_date(&row["UsageDate"]))?;
    let pretax_amount = parse_cost(&row["PretaxAmount"])
        .or_else(|| parse_cost(&row["PretaxGrossAmount"]))
        .or_else(|| parse_cost(&row["Cost"]))?;

    let instance_id = row["InstanceID"]
        .as_str()
        .or_else(|| row["InstanceId"].as_str())
        .or_else(|| row["ResourceId"].as_str())
        .or_else(|| row["BillAccountID"].as_str())
        .unwrap_or("unknown")
        .to_string();

    let instance_name = row["InstanceName"]
        .as_str()
        .or_else(|| row["ResourceName"].as_str())
        .map(str::to_string);

    let region = row["Region"]
        .as_str()
        .or_else(|| row["RegionCode"].as_str())
        .or_else(|| row["Zone"].as_str())
        .map(str::to_string);

    let zone = row["Zone"]
        .as_str()
        .or_else(|| row["ZoneId"].as_str())
        .map(str::to_string);

    let subscription_type = row["SubscriptionType"].as_str().map(str::to_string);
    let product_name = row["ProductName"].as_str().map(str::to_string);
    let billing_item = row["Item"]
        .as_str()
        .or_else(|| row["BillingItem"].as_str())
        .map(str::to_string);
    let tags = parse_bss_tags(&row["Tags"]);

    let currency = row["Currency"].as_str().unwrap_or("CNY").to_string();

    let resource_type = Some(classify_bss_type(&product_code, product_name.as_deref()).to_string());

    Some(BssLineItem {
        instance_id,
        instance_name,
        product_code,
        product_name,
        bill_date,
        region,
        zone,
        resource_type,
        subscription_type,
        billing_item,
        pretax_amount,
        currency,
        tags,
    })
}

/// Fetch recent Aliyun BSS line items directly from Alibaba Cloud OpenAPI.
///
/// `DescribeInstanceBill` with `Granularity=DAILY` requires a `BillingDate`
/// (yyyy-MM-dd) — `BillingCycle` alone is rejected with InvalidParameter — so
/// the window is queried one day at a time.
pub async fn fetch_recent_line_items(
    credentials: &Value,
    config: &Value,
    days: i64,
    mut progress: Option<&mut (dyn FnMut(usize, usize) -> bool + Send)>,
) -> AppResult<Vec<BssLineItem>> {
    let client = AliyunBssClient::from_credentials(credentials, config)?;

    let safe_days = days.clamp(1, 90);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - Duration::days(safe_days - 1);

    let mut all_items = Vec::new();
    let mut cursor = start_date;
    let mut day_index = 0usize;

    while cursor <= end_date {
        day_index += 1;
        // One progress tick per day — returning false stops fetching further
        // days (cooperative cancellation).
        if let Some(hook) = progress.as_mut() {
            if !hook(day_index, safe_days as usize) {
                break;
            }
        }
        let billing_cycle = cursor.format("%Y-%m").to_string();
        let billing_date = cursor.format("%Y-%m-%d").to_string();

        let rows =
            fetch_bss_pages(&billing_cycle, &billing_date, |params| client.call(params)).await?;
        for row in &rows {
            if let Some(item) = parse_bss_row(row) {
                if item.bill_date >= start_date && item.bill_date <= end_date {
                    all_items.push(item);
                }
            }
        }

        cursor += Duration::days(1);
    }

    Ok(all_items)
}

async fn fetch_bss_pages<F, Fut>(cycle: &str, date: &str, mut call: F) -> AppResult<Vec<Value>>
where
    F: FnMut(BTreeMap<String, String>) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    let mut rows = Vec::new();
    let mut token: Option<String> = None;
    let mut seen_tokens = std::collections::HashSet::new();
    loop {
        let mut params = BTreeMap::new();
        params.insert("Action".into(), "DescribeInstanceBill".into());
        params.insert("Version".into(), BSS_VERSION.into());
        params.insert("BillingCycle".into(), cycle.into());
        params.insert("BillingDate".into(), date.into());
        params.insert("Granularity".into(), "DAILY".into());
        params.insert("MaxResults".into(), "100".into());
        if let Some(ref value) = token {
            params.insert("NextToken".into(), value.clone());
        }

        let body = call(params).await?;
        if let Some(page) = body["Data"]["Items"]["Item"]
            .as_array()
            .or_else(|| body["Data"]["Items"].as_array())
            .or_else(|| body["Items"]["Item"].as_array())
            .or_else(|| body["Items"].as_array())
        {
            rows.extend(page.iter().cloned());
        }

        token = body["Data"]["NextToken"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        match &token {
            None => break,
            Some(value) if !seen_tokens.insert(value.clone()) => {
                return Err(crate::error::AppError::Internal(anyhow!(
                    "Aliyun BSS returned a repeated pagination token"
                )));
            }
            Some(_) => {}
        }
    }
    Ok(rows)
}

/// Import BSS line items for a cloud account (insert into `raw_expenses`
/// only — aggregation is a separate phase).
///
/// `progress` is called every 100 daily resource groups; returning
/// `false` aborts the insert loop early (cooperative cancellation).
pub async fn import_line_items(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
    items: Vec<BssLineItem>,
    progress: Option<&mut (dyn FnMut(usize, usize) -> bool + Send)>,
) -> AppResult<u32> {
    let lines = items
        .into_iter()
        .map(|item| {
            let evidence = serde_json::json!(item);
            let resource_type =
                classify_bss_type(&item.product_code, item.product_name.as_deref()).to_string();
            super::ingest::BillingLine {
                evidence,
                resource_id: item.instance_id,
                resource_name: item.instance_name,
                resource_type,
                region: item.region,
                service: item.product_code,
                date: item.bill_date,
                amount: item.pretax_amount,
                currency: item.currency,
                tags: item.tags,
            }
        })
        .collect();
    super::ingest::import_daily(state, org_id, account_id, lines, progress).await
}

/// Re-aggregate raw_expenses → expenses for the given account.
pub async fn aggregate_to_expenses(
    state: &AppState,
    org_id: Uuid,
    account_id: Uuid,
) -> AppResult<()> {
    super::ingest::aggregate(state, org_id, account_id).await
}

/// Generate mock Aliyun billing data for development/testing
pub fn generate_mock_bss_data(days: i64) -> Vec<BssLineItem> {
    (0..days).flat_map(generate_mock_bss_data_for_day).collect()
}

/// One day's worth of mock BSS items, `offset` days before today. Lets the
/// async worker stream mock data day-by-day with progress ticks.
pub fn generate_mock_bss_data_for_day(offset: i64) -> Vec<BssLineItem> {
    use chrono::Duration;
    let date = chrono::Utc::now().date_naive() - Duration::days(offset);
    let products = [
        ("ecs", 4.20),
        ("oss", 0.60),
        ("rds", 6.80),
        ("slb", 0.90),
        ("eip", 0.01),
        ("snapshot", 0.30),
        ("nlb", 1.20),
    ];

    products
        .iter()
        .map(|(product, base_cost)| BssLineItem {
            instance_id: format!("{}-aliyun-mock-001", product),
            instance_name: Some(format!("aliyun-{}-001", product)),
            product_code: product.to_string(),
            product_name: None,
            bill_date: date,
            region: Some("cn-hangzhou".into()),
            zone: None,
            resource_type: Some(classify_bss_type(product, None).to_string()),
            subscription_type: Some("PayAsYouGo".into()),
            billing_item: None,
            pretax_amount: base_cost * (0.9 + seed_factor(offset)),
            currency: "CNY".into(),
            tags: serde_json::json!({ "env": "mock", "provider": "aliyun" }),
        })
        .collect()
}

fn seed_factor(seed: i64) -> f64 {
    let x = (seed * 987654 + 13) % 100;
    x as f64 / 500.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn follows_bss_tokens_until_exhausted() {
        let requests = std::cell::RefCell::new(Vec::new());
        let rows = fetch_bss_pages("2026-08", "2026-08-15", |params| {
            let token = params.get("NextToken").cloned();
            requests.borrow_mut().push(params);
            std::future::ready(Ok(match token.as_deref() {
                None => json!({"Data": {"Items": [{"InstanceID": "first"}], "TotalCount": 1, "NextToken": "next"}}),
                Some("next") => json!({"Data": {"Items": [{"InstanceID": "second"}], "NextToken": ""}}),
                _ => panic!("unexpected token"),
            }))
        }).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["InstanceID"], "second");
        let requests = requests.borrow();
        assert_eq!(requests[0]["MaxResults"], "100");
        assert!(!requests[0].contains_key("NextToken"));
        assert_eq!(requests[1]["NextToken"], "next");
    }

    #[tokio::test]
    async fn rejects_repeated_bss_pagination_tokens() {
        let result = fetch_bss_pages("2026-08", "2026-08-15", |_| {
            std::future::ready(Ok(json!({"Data": {"Items": [], "NextToken": "same"}})))
        })
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn test_classify_bss_type_known_codes() {
        assert_eq!(classify_bss_type("ecs", None), "instance");
        assert_eq!(classify_bss_type("rds", None), "rds_instance");
        assert_eq!(classify_bss_type("slb", None), "load_balancer");
        assert_eq!(classify_bss_type("alb", None), "load_balancer");
        assert_eq!(classify_bss_type("nlb", None), "load_balancer");
        assert_eq!(classify_bss_type("eip", None), "ip_address");
        assert_eq!(classify_bss_type("snapshot", None), "snapshot");
        assert_eq!(classify_bss_type("oss", None), "bucket");
    }

    #[test]
    fn test_classify_bss_type_falls_back_to_product_name() {
        assert_eq!(
            classify_bss_type("unknown-code", Some("云服务器 ECS")),
            "instance"
        );
        assert_eq!(
            classify_bss_type("unknown-code", Some("对象存储 OSS")),
            "bucket"
        );
        assert_eq!(
            classify_bss_type("unknown-code", Some("弹性公网IP")),
            "ip_address"
        );
        assert_eq!(
            classify_bss_type("unknown-code", Some("负载均衡")),
            "load_balancer"
        );
        assert_eq!(
            classify_bss_type("unknown-code", Some("云数据库 RDS")),
            "rds_instance"
        );
        assert_eq!(classify_bss_type("unknown-code", Some("快照")), "snapshot");
        assert_eq!(classify_bss_type("unknown-code", Some("云监控")), "other");
        assert_eq!(classify_bss_type("unknown-code", None), "other");
    }

    #[test]
    fn test_parse_bss_row_full_fixture() {
        let row = json!({
            "InstanceID": "i-bp1abc",
            "InstanceName": "web-01",
            "ProductCode": "ecs",
            "ProductName": "云服务器 ECS",
            "BillingDate": "2026-08-01",
            "PretaxAmount": "42.00",
            "Currency": "CNY",
            "Region": "cn-hangzhou",
            "Zone": "cn-hangzhou-b",
            "SubscriptionType": "PayAsYouGo",
            "Item": "云盘",
            "Tags": { "TagList": { "Tag": [ { "TagKey": "env", "TagValue": "prod" } ] } }
        });
        let item = parse_bss_row(&row).expect("row parses");
        assert_eq!(item.instance_id, "i-bp1abc");
        assert_eq!(item.resource_type.as_deref(), Some("instance"));
        assert_eq!(item.pretax_amount, 42.0);
        assert_eq!(item.zone.as_deref(), Some("cn-hangzhou-b"));
        assert_eq!(item.subscription_type.as_deref(), Some("PayAsYouGo"));
        assert_eq!(item.billing_item.as_deref(), Some("云盘"));
        assert_eq!(item.tags["env"], "prod");
    }

    #[test]
    fn test_parse_bss_tags_flat_array_variant() {
        let tags = parse_bss_tags(&json!([ { "Key": "team", "Value": "data" } ]));
        assert_eq!(tags["team"], "data");
        assert!(parse_bss_tags(&json!({})).as_object().unwrap().is_empty());
    }
}
