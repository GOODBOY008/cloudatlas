use std::collections::BTreeMap;

use anyhow::anyhow;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use uuid::Uuid;

use super::{CloudAdapter, DiscoveredResource};
use crate::error::{AppError, AppResult};

type HmacSha1 = Hmac<Sha1>;

// ── RPC API endpoints ─────────────────────────────────────────────────────────
const ECS_ENDPOINT: &str = "ecs.aliyuncs.com";
const ECS_VERSION: &str = "2014-05-26";
const RDS_ENDPOINT: &str = "rds.aliyuncs.com";
const RDS_VERSION: &str = "2014-08-15";
const SLB_ENDPOINT: &str = "slb.aliyuncs.com";
const SLB_VERSION: &str = "2014-05-15";
const VPC_ENDPOINT: &str = "vpc.aliyuncs.com";
const VPC_VERSION: &str = "2016-04-28";
// ALB/NLB use REGIONAL endpoints (`alb.<region>.aliyuncs.com`) — the global
// hosts do not resolve. Versions stay here for the `discover_resources` calls.
const ALB_VERSION: &str = "2020-06-16";
const NLB_VERSION: &str = "2022-04-30";
const OSS_ENDPOINT: &str = "oss.aliyuncs.com";
/// Container Service (ACK) — ROA API, see [`AliyunAdapter::discover_ack_clusters`].
const ACK_ENDPOINT: &str = "cs.aliyuncs.com";
const ACK_VERSION: &str = "2015-12-15";

// ── Pure response parsers (unit-tested with fixtures) ─────────────────────────

fn tags_from_ecs_tag_list(tags_node: &Value) -> Value {
    let empty = vec![];
    let list = tags_node
        .get("Tag")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let map: serde_json::Map<String, Value> = list
        .iter()
        .filter_map(|t| {
            let k = t["TagKey"].as_str()?;
            let v = t["TagValue"].as_str().unwrap_or_default();
            Some((k.to_string(), Value::String(v.to_string())))
        })
        .collect();
    Value::Object(map)
}

fn parse_ecs_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let instances = body["Instances"]["Instance"].as_array().unwrap_or(&empty);
    instances
        .iter()
        .map(|inst| {
            let id = inst["InstanceId"].as_str().unwrap_or_default().to_string();
            let name = inst["InstanceName"].as_str().unwrap_or(&id).to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: name,
                resource_type: "instance".to_string(),
                region: Some(region_id.to_string()),
                tags: tags_from_ecs_tag_list(&inst["Tags"]),
                meta: serde_json::json!({
                    "instance_type": inst["InstanceType"].as_str().unwrap_or("unknown"),
                    "state": inst["Status"].as_str().unwrap_or("unknown"),
                    "vcpus": inst["Cpu"].as_u64().unwrap_or(0),
                    "memory_gb": inst["Memory"].as_u64().unwrap_or(0) as f64 / 1024.0,
                    "os": inst["OSName"].as_str().unwrap_or(""),
                    "zone_id": inst["ZoneId"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

fn parse_ecs_disks(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let disks = body["Disks"]["Disk"].as_array().unwrap_or(&empty);
    disks
        .iter()
        .map(|disk| {
            let id = disk["DiskId"].as_str().unwrap_or_default().to_string();
            let name = disk["DiskName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: name,
                resource_type: "volume".to_string(),
                region: Some(region_id.to_string()),
                tags: tags_from_ecs_tag_list(&disk["Tags"]),
                meta: serde_json::json!({
                    "size_gb": disk["Size"].as_u64().unwrap_or(0),
                    "category": disk["Category"].as_str().unwrap_or("unknown"),
                    "state": disk["Status"].as_str().unwrap_or("unknown"),
                    "zone_id": disk["ZoneId"].as_str().unwrap_or(""),
                    "instance_id": disk["InstanceId"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

fn parse_rds_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let dbs = body["Items"]["DBInstance"].as_array().unwrap_or(&empty);
    dbs.iter()
        .map(|db| {
            let id = db["DBInstanceId"].as_str().unwrap_or_default().to_string();
            let desc = db["DBInstanceDescription"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: desc,
                resource_type: "rds_instance".to_string(),
                region: Some(region_id.to_string()),
                tags: serde_json::json!({}),
                meta: serde_json::json!({
                    "instance_class": db["DBInstanceClass"].as_str().unwrap_or("unknown"),
                    "engine": db["Engine"].as_str().unwrap_or("unknown"),
                    "engine_version": db["EngineVersion"].as_str().unwrap_or(""),
                    "status": db["DBInstanceStatus"].as_str().unwrap_or("unknown"),
                    "storage_type": db["DBInstanceStorageType"].as_str().unwrap_or(""),
                    "storage_gb": db["DBInstanceStorage"].as_u64().unwrap_or(0),
                    "zone_id": db["ZoneId"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

fn parse_slb_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let lbs = body["LoadBalancers"]["LoadBalancer"].as_array().unwrap_or(&empty);
    lbs.iter()
        .map(|lb| {
            let id = lb["LoadBalancerId"].as_str().unwrap_or_default().to_string();
            let name = lb["LoadBalancerName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: name,
                resource_type: "load_balancer".to_string(),
                region: Some(region_id.to_string()),
                tags: serde_json::json!({}),
                meta: serde_json::json!({
                    "status": lb["LoadBalancerStatus"].as_str().unwrap_or("unknown"),
                    "address_type": lb["AddressType"].as_str().unwrap_or("unknown"),
                    "address": lb["Address"].as_str().unwrap_or(""),
                    "spec": lb["LoadBalancerSpec"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

/// ALB/NLB tags are a flat array `[{ "Key": "..", "Value": ".." }]` — not the
/// ECS `{ "Tag": [...] }` wrapper.
fn tags_from_flat_list(tags_node: &Value) -> Value {
    let empty = vec![];
    let list = tags_node.as_array().unwrap_or(&empty);
    let map: serde_json::Map<String, Value> = list
        .iter()
        .filter_map(|t| {
            let k = t["Key"].as_str().or_else(|| t["TagKey"].as_str())?;
            let v = t["Value"]
                .as_str()
                .or_else(|| t["TagValue"].as_str())
                .unwrap_or_default();
            Some((k.to_string(), Value::String(v.to_string())))
        })
        .collect();
    Value::Object(map)
}

fn parse_ecs_snapshots(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let snaps = body["Snapshots"]["Snapshot"].as_array().unwrap_or(&empty);
    snaps
        .iter()
        .map(|s| {
            let id = s["SnapshotId"].as_str().unwrap_or_default().to_string();
            let name = s["SnapshotName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: name,
                resource_type: "snapshot".to_string(),
                region: Some(region_id.to_string()),
                tags: tags_from_ecs_tag_list(&s["Tags"]),
                meta: serde_json::json!({
                    "size_gb": s["Size"].as_u64().unwrap_or(0),
                    "source_disk_id": s["SourceDiskId"].as_str().unwrap_or(""),
                    "source_disk_type": s["SourceDiskType"].as_str().unwrap_or(""),
                    "status": s["Status"].as_str().unwrap_or("unknown"),
                    "creation_time": s["CreationTime"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

fn parse_eip_addresses(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let eips = body["EipAddresses"]["EipAddress"].as_array().unwrap_or(&empty);
    eips.iter()
        .map(|e| {
            let id = e["AllocationId"].as_str().unwrap_or_default().to_string();
            let ip = e["EipAddress"].as_str().unwrap_or(&id).to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: ip.clone(),
                resource_type: "ip_address".to_string(),
                region: Some(region_id.to_string()),
                tags: tags_from_ecs_tag_list(&e["Tags"]),
                meta: serde_json::json!({
                    "ip": ip,
                    "status": e["Status"].as_str().unwrap_or("unknown"),
                    "bandwidth_mbps": e["Bandwidth"].as_u64().unwrap_or(0),
                    "charge_type": e["InternetChargeType"].as_str().unwrap_or(""),
                    "instance_id": e["InstanceId"].as_str().unwrap_or(""),
                    "zone_id": e["ZoneId"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

fn parse_alb_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    parse_flat_lb_instances(body, region_id)
}

fn parse_nlb_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    parse_flat_lb_instances(body, region_id)
}

/// ALB and NLB return `"LoadBalancers": [ … ]` (flat array), unlike classic
/// SLB's `"LoadBalancers": { "LoadBalancer": [ … ] }` wrapper.
fn parse_flat_lb_instances(body: &Value, region_id: &str) -> Vec<DiscoveredResource> {
    let empty = vec![];
    let lbs = body["LoadBalancers"].as_array().unwrap_or(&empty);
    lbs.iter()
        .map(|lb| {
            let id = lb["LoadBalancerId"].as_str().unwrap_or_default().to_string();
            let name = lb["LoadBalancerName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            DiscoveredResource {
                cloud_resource_id: id,
                resource_name: name,
                resource_type: "load_balancer".to_string(),
                region: Some(region_id.to_string()),
                tags: tags_from_flat_list(&lb["Tags"]),
                meta: serde_json::json!({
                    "status": lb["LoadBalancerStatus"].as_str().unwrap_or("unknown"),
                    "address_type": lb["AddressType"].as_str().unwrap_or("unknown"),
                    "address": lb["Address"].as_str().unwrap_or(""),
                    "vpc_id": lb["VpcId"].as_str().unwrap_or(""),
                }),
            }
        })
        .collect()
}

/// OSS GetService returns XML; `Location` is `oss-cn-hangzhou` → `cn-hangzhou`.
/// Empty/unknown locations default to `cn-hangzhou`.
fn oss_location_to_region(location: &str) -> String {
    let region = location
        .strip_prefix("oss-")
        .filter(|s| !s.is_empty())
        .unwrap_or(location);
    if region.is_empty() {
        "cn-hangzhou".to_string()
    } else {
        region.to_string()
    }
}

/// Parse the `ListAllMyBucketsResult` XML document from OSS GetService.
fn parse_oss_buckets(xml: &str) -> Vec<DiscoveredResource> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut resources = Vec::new();
    let mut in_bucket = false;
    let mut field = String::new();
    let (mut name, mut location, mut creation) = (String::new(), String::new(), String::new());
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == b"Bucket" => in_bucket = true,
            Ok(Event::Start(e)) if in_bucket => {
                field = String::from_utf8_lossy(e.name().as_ref()).into_owned();
            }
            Ok(Event::Text(t)) if in_bucket => {
                let text = t.unescape().unwrap_or_default().to_string();
                match field.as_str() {
                    "Name" => name = text,
                    "Location" => location = text,
                    "CreationDate" => creation = text,
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"Bucket" => {
                if !name.is_empty() {
                    let location_str = location.clone();
                    resources.push(DiscoveredResource {
                        cloud_resource_id: name.clone(),
                        resource_name: name.clone(),
                        resource_type: "bucket".to_string(),
                        region: Some(oss_location_to_region(&location_str)),
                        tags: serde_json::json!({}),
                        meta: serde_json::json!({
                            "creation_date": creation,
                            "location": location_str,
                        }),
                    });
                }
                name.clear();
                location.clear();
                creation.clear();
                in_bucket = false;
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                tracing::warn!(error = %e, "OSS XML parse failed");
                break;
            }
            _ => {}
        }
        buf.clear();
    }
    resources
}

/// Alibaba Cloud adapter — uses the RPC-style OpenAPI with HMAC-SHA1 signing.
///
/// Expected credential JSON:
/// ```json
/// { "access_key_id": "...", "access_key_secret": "...", "security_token": null }
/// ```
/// Expected config JSON:
/// ```json
/// { "region_id": "cn-hangzhou", "regions": ["cn-hangzhou", "cn-beijing"] }
/// ```
pub struct AliyunAdapter {
    access_key_id: String,
    access_key_secret: String,
    security_token: Option<String>,
    default_region: String,
    /// Regions to scan during `discover_resources`. Defaults to `[default_region]`.
    regions: Vec<String>,
    http: reqwest::Client,
}

impl AliyunAdapter {
    pub fn from_credentials(creds: &Value, config: &Value) -> AppResult<Self> {
        let access_key_id = creds["access_key_id"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation(
                    "Aliyun credentials missing 'access_key_id'".into(),
                )
            })?
            .to_string();
        let access_key_secret = creds["access_key_secret"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation(
                    "Aliyun credentials missing 'access_key_secret'".into(),
                )
            })?
            .to_string();
        let security_token = creds
            .get("security_token")
            .and_then(Value::as_str)
            .map(str::to_string);

        let default_region = config
            .get("region_id")
            .and_then(Value::as_str)
            .unwrap_or("cn-hangzhou")
            .to_string();

        let regions: Vec<String> = config
            .get("regions")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_else(|| vec![default_region.clone()]);

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| AppError::Internal(anyhow!("reqwest build: {e}")))?;

        Ok(Self {
            access_key_id,
            access_key_secret,
            security_token,
            default_region,
            regions,
            http,
        })
    }

    // ── Signing ───────────────────────────────────────────────────────────────

    /// Percent-encode a string using RFC 3986 rules (for Aliyun RPC signing).
    fn rfc3986_encode(s: &str) -> String {
        let mut out = String::with_capacity(s.len() * 3);
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
                | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    /// HMAC-SHA1 helper — returns raw bytes.
    fn hmac_sha1(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha1::new_from_slice(key)
            .expect("HMAC accepts any key length");
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    /// Build the signed URL for an Aliyun RPC API call.
    /// `params` should contain Action + Version + any service-specific params.
    fn signed_url(&self, endpoint: &str, mut params: BTreeMap<String, String>) -> String {
        // Standard parameters
        params.insert("Format".into(), "JSON".into());
        params.insert("AccessKeyId".into(), self.access_key_id.clone());
        params.insert("SignatureMethod".into(), "HMAC-SHA1".into());
        params.insert("SignatureNonce".into(), Uuid::new_v4().to_string());
        params.insert("SignatureVersion".into(), "1.0".into());
        params.insert(
            "Timestamp".into(),
            Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        );
        if let Some(ref tok) = self.security_token {
            params.insert("SecurityToken".into(), tok.clone());
        }

        // Canonical query string (keys sorted)
        let canonical: String = params
            .iter()
            .map(|(k, v)| {
                format!("{}={}", Self::rfc3986_encode(k), Self::rfc3986_encode(v))
            })
            .collect::<Vec<_>>()
            .join("&");

        // String to sign: METHOD + & + %2F + & + encode(canonical)
        let string_to_sign = format!(
            "GET&{}&{}",
            Self::rfc3986_encode("/"),
            Self::rfc3986_encode(&canonical)
        );

        // Sign
        let key = format!("{}&", self.access_key_secret);
        let sig_bytes = Self::hmac_sha1(key.as_bytes(), string_to_sign.as_bytes());
        let signature = BASE64.encode(&sig_bytes);

        format!(
            "https://{}/?{}&Signature={}",
            endpoint,
            canonical,
            Self::rfc3986_encode(&signature)
        )
    }

    /// Execute a signed RPC call and return the JSON body.
    async fn call(
        &self,
        endpoint: &str,
        params: BTreeMap<String, String>,
    ) -> AppResult<Value> {
        let url = self.signed_url(endpoint, params);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow!("Aliyun HTTP request: {e}")))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(anyhow!("Aliyun response parse: {e}")))?;

        if !status.is_success() {
            let code = body["Code"].as_str().unwrap_or("Unknown");
            let msg = body["Message"].as_str().unwrap_or("Unknown error");
            return Err(AppError::Internal(anyhow!(
                "Aliyun API error [{code}]: {msg}"
            )));
        }

        // Alibaba RPC APIs report application errors inside 200 responses
        // (`{"Code": ..., "Message": ...}`); surface them instead of treating
        // the response as an empty success.
        if let Some(code) = body["Code"].as_str() {
            if code != "Success" {
                let msg = body["Message"].as_str().unwrap_or("Unknown error");
                return Err(AppError::Internal(anyhow!(
                    "Aliyun API error [{code}]: {msg}"
                )));
            }
        }

        Ok(body)
    }

    /// Build the `Authorization: OSS …` header for an OSS REST call.
    /// StringToSign = VERB\nContent-MD5\nContent-Type\nDate\n[canonical
    /// x-oss-* headers]\nCanonicalizedResource (here just "/" for GetService).
    fn oss_authorization(&self, date: &str) -> String {
        let mut string_to_sign = format!("GET\n\n\n{date}\n");
        if let Some(ref tok) = self.security_token {
            string_to_sign.push_str(&format!("x-oss-security-token:{tok}\n"));
        }
        string_to_sign.push('/');
        let sig = Self::hmac_sha1(self.access_key_secret.as_bytes(), string_to_sign.as_bytes());
        format!("OSS {}:{}", self.access_key_id, BASE64.encode(&sig))
    }

    /// List all OSS buckets (GetService). Response is XML.
    async fn discover_oss_buckets(&self) -> AppResult<Vec<DiscoveredResource>> {
        let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let auth = self.oss_authorization(&date);
        let mut req = self
            .http
            .get(format!("https://{OSS_ENDPOINT}/"))
            .header(reqwest::header::DATE, &date)
            .header(reqwest::header::AUTHORIZATION, &auth);
        if let Some(ref tok) = self.security_token {
            req = req.header("x-oss-security-token", tok);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow!("OSS request failed: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(anyhow!("OSS body read failed: {e}")))?;
        if !status.is_success() {
            return Err(AppError::Internal(anyhow!(
                "OSS API error [{status}]: {text}"
            )));
        }
        Ok(parse_oss_buckets(&text))
    }

    /// ACK (Container Service for Kubernetes) — ROA-style API, not RPC:
    /// signed `GET {path}` with `x-acs-*` headers, and the HMAC key is the raw
    /// AccessKeySecret WITHOUT the trailing '&' RPC signing appends.
    async fn ack_get(&self, path: &str) -> AppResult<Value> {
        let date = Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let nonce = Uuid::new_v4().to_string();
        let mut headers = BTreeMap::from([
            ("x-acs-version".to_string(), ACK_VERSION.to_string()),
            ("x-acs-signature-nonce".to_string(), nonce.clone()),
            ("x-acs-signature-method".to_string(), "HMAC-SHA1".to_string()),
        ]);
        if let Some(ref tok) = self.security_token {
            headers.insert("x-acs-security-token".to_string(), tok.clone());
        }
        let canonical_headers: String = headers
            .iter()
            .map(|(k, v)| format!("{k}:{v}\n"))
            .collect();
        let string_to_sign = format!("GET\napplication/json\n\n\n{date}\n{canonical_headers}{path}");
        let signature = BASE64.encode(Self::hmac_sha1(
            self.access_key_secret.as_bytes(),
            string_to_sign.as_bytes(),
        ));

        let mut req = self
            .http
            .get(format!("https://{ACK_ENDPOINT}{path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::DATE, &date)
            .header("x-acs-version", ACK_VERSION)
            .header("x-acs-signature-nonce", &nonce)
            .header("x-acs-signature-method", "HMAC-SHA1")
            .header(reqwest::header::AUTHORIZATION, format!("acs {}:{}", self.access_key_id, signature));
        if let Some(ref tok) = self.security_token {
            req = req.header("x-acs-security-token", tok);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow!("ACK request failed: {e}")))?;
        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(anyhow!("ACK response parse failed: {e}")))?;
        if !status.is_success() {
            let code = body["Code"].as_str().unwrap_or("Unknown");
            let msg = body["Message"].as_str().unwrap_or("Unknown error");
            return Err(AppError::Internal(anyhow!(
                "ACK API error [{code}]: {msg}"
            )));
        }
        Ok(body)
    }

    /// List ACK clusters (global API, one call).
    async fn fetch_ack_clusters(&self) -> AppResult<Value> {
        self.ack_get("/clusters").await
    }

    /// Fetch a single ACK cluster's kubeconfig (ROA `GET /k8s/{id}/user_config`).
    /// The `config` field is the kubeconfig YAML used to reach the api-server.
    pub(crate) async fn fetch_ack_kubeconfig(&self, cluster_id: &str) -> AppResult<String> {
        let body = self.ack_get(&format!("/k8s/{cluster_id}/user_config")).await?;
        body["config"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| AppError::Internal(anyhow!("ACK kubeconfig missing 'config' field")))
    }

    /// ACK clusters → `k8s_cluster` discovery records (global API, one call).
    async fn discover_ack_clusters(&self) -> AppResult<Vec<DiscoveredResource>> {
        let body = self.fetch_ack_clusters().await?;
        let clusters = body.as_array().cloned().unwrap_or_default();
        let mut out = Vec::with_capacity(clusters.len());
        for c in &clusters {
            let Some(cluster_id) = c["cluster_id"].as_str() else { continue };
            let name = c["name"].as_str().unwrap_or(cluster_id);
            out.push(DiscoveredResource {
                cloud_resource_id: format!("ack:{cluster_id}"),
                resource_name: name.to_string(),
                resource_type: "k8s_cluster".to_string(),
                region: c["region_id"].as_str().map(str::to_string),
                tags: json!({
                    "provider": "alibaba",
                    "cluster_type": c["cluster_type"].as_str().unwrap_or(""),
                    "state": c["state"].as_str().unwrap_or(""),
                }),
                meta: json!({
                    "cluster_id": cluster_id,
                    "cluster_type": c["cluster_type"].as_str().unwrap_or(""),
                    "state": c["state"].as_str().unwrap_or(""),
                    "node_count": c["size"].as_u64().unwrap_or(0),
                    "current_version": c["current_version"].as_str().unwrap_or(""),
                }),
            });
        }
        Ok(out)
    }

    /// Generic paginated RPC discovery loop used by the new scanners.
    async fn discover_rpc_page(
        &self,
        endpoint: &str,
        version: &str,
        action: &str,
        region_id: &str,
        page_size: &str,
        parser: fn(&Value, &str) -> Vec<DiscoveredResource>,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let mut resources = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p = BTreeMap::new();
            p.insert("Action".into(), action.to_string());
            p.insert("Version".into(), version.to_string());
            p.insert("RegionId".into(), region_id.to_string());
            p.insert("PageSize".into(), page_size.to_string());
            p.insert("PageNumber".into(), page.to_string());
            let body = self.call(endpoint, p).await?;
            resources.extend(parser(&body, region_id));
            let total = body["TotalCount"].as_u64().unwrap_or(0);
            if resources.len() as u64 >= total {
                break;
            }
            page += 1;
        }
        Ok(resources)
    }

    /// RPC params for an ECS instance action (StartInstance / StopInstance).
    fn ecs_action_params(action: &str, instance_id: &str, region: &str) -> BTreeMap<String, String> {
        let mut p = BTreeMap::new();
        p.insert("Action".into(), action.to_string());
        p.insert("Version".into(), ECS_VERSION.into());
        p.insert("RegionId".into(), region.to_string());
        p.insert("InstanceId".into(), instance_id.to_string());
        p
    }

    // ── Per-region discovery helpers ──────────────────────────────────────────

    async fn discover_ecs_instances(
        &self,
        region_id: &str,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let mut resources = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p = BTreeMap::new();
            p.insert("Action".into(), "DescribeInstances".into());
            p.insert("Version".into(), ECS_VERSION.into());
            p.insert("RegionId".into(), region_id.to_string());
            p.insert("PageSize".into(), "50".into());
            p.insert("PageNumber".into(), page.to_string());

            let body = self.call(ECS_ENDPOINT, p).await?;
            resources.extend(parse_ecs_instances(&body, region_id));

            let total = body["TotalCount"].as_u64().unwrap_or(0);
            if resources.len() as u64 >= total {
                break;
            }
            page += 1;
        }
        Ok(resources)
    }

    async fn discover_ecs_disks(
        &self,
        region_id: &str,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let mut resources = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p = BTreeMap::new();
            p.insert("Action".into(), "DescribeDisks".into());
            p.insert("Version".into(), ECS_VERSION.into());
            p.insert("RegionId".into(), region_id.to_string());
            p.insert("PageSize".into(), "50".into());
            p.insert("PageNumber".into(), page.to_string());

            let body = self.call(ECS_ENDPOINT, p).await?;
            resources.extend(parse_ecs_disks(&body, region_id));

            let total = body["TotalCount"].as_u64().unwrap_or(0);
            if resources.len() as u64 >= total {
                break;
            }
            page += 1;
        }
        Ok(resources)
    }

    async fn discover_rds_instances(
        &self,
        region_id: &str,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let mut resources = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p = BTreeMap::new();
            p.insert("Action".into(), "DescribeDBInstances".into());
            p.insert("Version".into(), RDS_VERSION.into());
            p.insert("RegionId".into(), region_id.to_string());
            p.insert("PageSize".into(), "30".into());
            p.insert("PageNumber".into(), page.to_string());

            let body = self.call(RDS_ENDPOINT, p).await?;
            resources.extend(parse_rds_instances(&body, region_id));

            // RDS pagination reports TotalRecordCount (not TotalCount).
            let total = body["TotalRecordCount"].as_u64().unwrap_or(0);
            if resources.len() as u64 >= total {
                break;
            }
            page += 1;
        }
        Ok(resources)
    }

    async fn discover_slb_instances(
        &self,
        region_id: &str,
    ) -> AppResult<Vec<DiscoveredResource>> {
        let mut resources = Vec::new();
        let mut page = 1u32;
        loop {
            let mut p = BTreeMap::new();
            p.insert("Action".into(), "DescribeLoadBalancers".into());
            p.insert("Version".into(), SLB_VERSION.into());
            p.insert("RegionId".into(), region_id.to_string());
            p.insert("PageSize".into(), "50".into());
            p.insert("PageNumber".into(), page.to_string());

            let body = self.call(SLB_ENDPOINT, p).await?;
            resources.extend(parse_slb_instances(&body, region_id));

            let total = body["TotalCount"].as_u64().unwrap_or(0);
            if resources.len() as u64 >= total {
                break;
            }
            page += 1;
        }
        Ok(resources)
    }
}

// ── CloudAdapter impl ─────────────────────────────────────────────────────────

impl CloudAdapter for AliyunAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        let mut p = BTreeMap::new();
        p.insert("Action".into(), "DescribeRegions".into());
        p.insert("Version".into(), ECS_VERSION.into());

        let body = self.call(ECS_ENDPOINT, p).await.map_err(|e| {
            AppError::Internal(anyhow!("Aliyun test_connection failed: {e}"))
        })?;

        let empty = vec![];
        let regions = body["Regions"]["Region"].as_array().unwrap_or(&empty);
        let count = regions.len() as i32;

        Ok((
            true,
            format!("Connected to Alibaba Cloud — {} regions", count),
            count,
        ))
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        let mut p = BTreeMap::new();
        p.insert("Action".into(), "DescribeRegions".into());
        p.insert("Version".into(), ECS_VERSION.into());

        let body = self.call(ECS_ENDPOINT, p).await?;

        let empty = vec![];
        let regions = body["Regions"]["Region"].as_array().unwrap_or(&empty);
        Ok(regions
            .iter()
            .filter_map(|r| r["RegionId"].as_str().map(str::to_string))
            .collect())
    }

    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        let regions_to_scan: Vec<String> = if let Some(r) = region {
            vec![r.to_string()]
        } else {
            self.regions.clone()
        };

        let mut all: Vec<DiscoveredResource> = Vec::new();

        for region_id in &regions_to_scan {
            tracing::info!(region_id, "Aliyun: scanning region");

            // ECS instances
            match self.discover_ecs_instances(region_id).await {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "ECS instances scan failed"),
            }

            // ECS disks
            match self.discover_ecs_disks(region_id).await {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "ECS disks scan failed"),
            }

            // RDS instances
            match self.discover_rds_instances(region_id).await {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "RDS instances scan failed"),
            }

            // SLB load balancers
            match self.discover_slb_instances(region_id).await {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "SLB scan failed"),
            }

            // ECS snapshots
            match self
                .discover_rpc_page(ECS_ENDPOINT, ECS_VERSION, "DescribeSnapshots", region_id, "50", parse_ecs_snapshots)
                .await
            {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "ECS snapshots scan failed"),
            }

            // VPC EIPs
            match self
                .discover_rpc_page(VPC_ENDPOINT, VPC_VERSION, "DescribeEipAddresses", region_id, "50", parse_eip_addresses)
                .await
            {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "EIP scan failed"),
            }

            // ALB load balancers (regional endpoint — the global `alb.aliyuncs.com`
            // host does not resolve)
            match self
                .discover_rpc_page(&format!("alb.{region_id}.aliyuncs.com"), ALB_VERSION, "DescribeLoadBalancers", region_id, "50", parse_alb_instances)
                .await
            {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "ALB scan failed"),
            }

            // NLB load balancers (regional endpoint)
            match self
                .discover_rpc_page(&format!("nlb.{region_id}.aliyuncs.com"), NLB_VERSION, "DescribeLoadBalancers", region_id, "50", parse_nlb_instances)
                .await
            {
                Ok(mut v) => all.append(&mut v),
                Err(e) => tracing::warn!(region_id, error = ?e, "NLB scan failed"),
            }
        }

// OSS buckets (global API — once, not per region)
        match self.discover_oss_buckets().await {
            Ok(mut v) => all.append(&mut v),
            Err(e) => tracing::warn!(error = ?e, "OSS scan failed"),
        }

        // ACK clusters (global API — once, not per region)
        match self.discover_ack_clusters().await {
            Ok(mut v) => all.append(&mut v),
            Err(e) => tracing::warn!(error = ?e, "ACK scan failed"),
        }

        tracing::info!(count = all.len(), "Aliyun resource discovery complete");
        Ok(all)
    }

    async fn start_resource(&self, resource_id: &str) -> AppResult<()> {
        let p = Self::ecs_action_params("StartInstance", resource_id, &self.default_region);
        self.call(ECS_ENDPOINT, p).await?;
        Ok(())
    }

    async fn stop_resource(&self, resource_id: &str) -> AppResult<()> {
        let p = Self::ecs_action_params("StopInstance", resource_id, &self.default_region);
        self.call(ECS_ENDPOINT, p).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_ecs_instances_extracts_fields_and_tags() {
        let body = json!({
            "TotalCount": 1,
            "Instances": { "Instance": [{
                "InstanceId": "i-bp1abc",
                "InstanceName": "web-01",
                "InstanceType": "ecs.g6.large",
                "Status": "Running",
                "ZoneId": "cn-hangzhou-b",
                "Memory": 8192,
                "Cpu": 2,
                "OSName": "Alibaba Cloud Linux 3",
                "Tags": { "Tag": [ { "TagKey": "env", "TagValue": "prod" } ] }
            }]}
        });
        let res = parse_ecs_instances(&body, "cn-hangzhou");
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].cloud_resource_id, "i-bp1abc");
        assert_eq!(res[0].resource_name, "web-01");
        assert_eq!(res[0].resource_type, "instance");
        assert_eq!(res[0].region.as_deref(), Some("cn-hangzhou"));
        assert_eq!(res[0].meta["vcpus"], 2);
        assert_eq!(res[0].meta["memory_gb"], 8.0);
        assert_eq!(res[0].meta["state"], "Running");
        assert_eq!(res[0].tags["env"], "prod");
    }

    #[test]
    fn parse_ecs_instances_falls_back_to_id_when_name_missing() {
        let body = json!({
            "Instances": { "Instance": [ { "InstanceId": "i-bp2xyz" } ] }
        });
        let res = parse_ecs_instances(&body, "cn-hangzhou");
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].resource_name, "i-bp2xyz");
        assert_eq!(res[0].meta["vcpus"], 0);
    }

    #[test]
    fn parse_ecs_instances_empty_list_is_ok() {
        let body = json!({ "Instances": { "Instance": [] }, "TotalCount": 0 });
        assert!(parse_ecs_instances(&body, "cn-hangzhou").is_empty());
    }

    #[test]
    fn parse_ecs_disks_maps_volume_fields() {
        let body = json!({
            "Disks": { "Disk": [{
                "DiskId": "d-bp1disk",
                "DiskName": "data-disk",
                "Size": 100,
                "Category": "cloud_essd",
                "Status": "In_use",
                "ZoneId": "cn-hangzhou-b",
                "InstanceId": "i-bp1abc",
                "Tags": { "Tag": [ { "TagKey": "role", "TagValue": "data" } ] }
            }]}
        });
        let res = parse_ecs_disks(&body, "cn-hangzhou");
        assert_eq!(res[0].resource_type, "volume");
        assert_eq!(res[0].meta["size_gb"], 100);
        assert_eq!(res[0].meta["instance_id"], "i-bp1abc");
        assert_eq!(res[0].tags["role"], "data");
    }

    #[test]
    fn parse_rds_instances_maps_db_fields() {
        let body = json!({
            "TotalRecordCount": 1,
            "Items": { "DBInstance": [{
                "DBInstanceId": "rm-bp1rds",
                "DBInstanceDescription": "orders-db",
                "DBInstanceClass": "mysql.n2.medium.1",
                "Engine": "MySQL",
                "EngineVersion": "8.0",
                "DBInstanceStatus": "Running",
                "DBInstanceStorageType": "cloud_essd",
                "DBInstanceStorage": 200,
                "ZoneId": "cn-hangzhou-b"
            }]}
        });
        let res = parse_rds_instances(&body, "cn-hangzhou");
        assert_eq!(res[0].resource_type, "rds_instance");
        assert_eq!(res[0].meta["engine"], "MySQL");
        assert_eq!(res[0].meta["storage_gb"], 200);
        assert_eq!(res[0].meta["status"], "Running");
    }

    #[test]
    fn parse_slb_instances_maps_lb_fields() {
        let body = json!({
            "TotalCount": 1,
            "LoadBalancers": { "LoadBalancer": [{
                "LoadBalancerId": "lb-bp1slb",
                "LoadBalancerName": "api-lb",
                "LoadBalancerStatus": "active",
                "AddressType": "internet",
                "Address": "47.98.1.2",
                "LoadBalancerSpec": "slb.s2.small"
            }]}
        });
        let res = parse_slb_instances(&body, "cn-hangzhou");
        assert_eq!(res[0].resource_type, "load_balancer");
        assert_eq!(res[0].meta["address"], "47.98.1.2");
        assert_eq!(res[0].meta["status"], "active");
    }

    #[test]
    fn parse_ecs_snapshots_maps_snapshot_fields() {
        let body = json!({
            "TotalCount": 1,
            "Snapshots": { "Snapshot": [{
                "SnapshotId": "s-bp1snap",
                "SnapshotName": "pre-upgrade",
                "Size": 40,
                "SourceDiskId": "d-bp1disk",
                "SourceDiskType": "system",
                "Status": "accomplished",
                "CreationTime": "2026-08-01T04:00:00Z",
                "Tags": { "Tag": [ { "TagKey": "why", "TagValue": "backup" } ] }
            }]}
        });
        let res = parse_ecs_snapshots(&body, "cn-hangzhou");
        assert_eq!(res[0].resource_type, "snapshot");
        assert_eq!(res[0].meta["size_gb"], 40);
        assert_eq!(res[0].meta["source_disk_id"], "d-bp1disk");
        assert_eq!(res[0].tags["why"], "backup");
    }

    #[test]
    fn parse_eip_addresses_maps_ip_fields() {
        let body = json!({
            "TotalCount": 1,
            "EipAddresses": { "EipAddress": [{
                "AllocationId": "eip-bp1eip",
                "EipAddress": "47.98.3.4",
                "Status": "InUse",
                "Bandwidth": 100,
                "InternetChargeType": "PayByTraffic",
                "InstanceId": "i-bp1abc",
                "ZoneId": "cn-hangzhou-b"
            }]}
        });
        let res = parse_eip_addresses(&body, "cn-hangzhou");
        assert_eq!(res[0].resource_type, "ip_address");
        assert_eq!(res[0].resource_name, "47.98.3.4");
        assert_eq!(res[0].meta["ip"], "47.98.3.4");
        assert_eq!(res[0].meta["bandwidth_mbps"], 100);
        assert_eq!(res[0].meta["instance_id"], "i-bp1abc");
    }

    #[test]
    fn parse_alb_and_nlb_flat_arrays() {
        let body = json!({
            "LoadBalancers": [{
                "LoadBalancerId": "alb-bp1alb",
                "LoadBalancerName": "web-alb",
                "LoadBalancerStatus": "Active",
                "AddressType": "Internet",
                "Address": "47.98.5.6",
                "VpcId": "vpc-bp1vpc",
                "Tags": [ { "Key": "env", "Value": "prod" } ]
            }]
        });
        let alb = parse_alb_instances(&body, "cn-hangzhou");
        assert_eq!(alb[0].resource_type, "load_balancer");
        assert_eq!(alb[0].meta["vpc_id"], "vpc-bp1vpc");
        assert_eq!(alb[0].tags["env"], "prod");
        let nlb = parse_nlb_instances(&body, "cn-hangzhou");
        assert_eq!(nlb[0].cloud_resource_id, "alb-bp1alb");
    }

    #[test]
    fn parse_oss_buckets_extracts_buckets() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner><ID>12345</ID><DisplayName>acme</DisplayName></Owner>
  <Buckets>
    <Bucket>
      <Name>acme-logs</Name>
      <Location>oss-cn-hangzhou</Location>
      <CreationDate>2026-01-15T08:00:00.000Z</CreationDate>
    </Bucket>
    <Bucket>
      <Name>acme-backup</Name>
      <Location>oss-cn-beijing</Location>
      <CreationDate>2026-02-01T08:00:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>"#;
        let res = parse_oss_buckets(xml);
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].cloud_resource_id, "acme-logs");
        assert_eq!(res[0].resource_type, "bucket");
        assert_eq!(res[0].region.as_deref(), Some("cn-hangzhou"));
        assert_eq!(res[1].region.as_deref(), Some("cn-beijing"));
        assert_eq!(res[0].meta["creation_date"], "2026-01-15T08:00:00.000Z");
    }

    #[test]
    fn parse_oss_buckets_empty_and_owner_only() {
        let xml = r#"<ListAllMyBucketsResult><Owner><ID>1</ID></Owner><Buckets/></ListAllMyBucketsResult>"#;
        assert!(parse_oss_buckets(xml).is_empty());
    }

    #[test]
    fn oss_location_to_region_strips_prefix() {
        assert_eq!(oss_location_to_region("oss-cn-hangzhou"), "cn-hangzhou");
        assert_eq!(oss_location_to_region("oss-us-west-1"), "us-west-1");
        assert_eq!(oss_location_to_region(""), "cn-hangzhou");
    }

    #[test]
    fn ecs_action_params_build_start_and_stop() {
        let start = AliyunAdapter::ecs_action_params("StartInstance", "i-bp1abc", "cn-hangzhou");
        assert_eq!(start["Action"], "StartInstance");
        assert_eq!(start["InstanceId"], "i-bp1abc");
        assert_eq!(start["RegionId"], "cn-hangzhou");
        assert_eq!(start["Version"], ECS_VERSION);

        let stop = AliyunAdapter::ecs_action_params("StopInstance", "i-bp1abc", "cn-hangzhou");
        assert_eq!(stop["Action"], "StopInstance");
    }

    #[test]
    fn rfc3986_encode_handles_edge_chars() {
        assert_eq!(AliyunAdapter::rfc3986_encode("AZaz09-_.~"), "AZaz09-_.~");
        assert_eq!(AliyunAdapter::rfc3986_encode("a b"), "a%20b");
        assert_eq!(AliyunAdapter::rfc3986_encode("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(AliyunAdapter::rfc3986_encode("+&="), "%2B%26%3D");
    }

    fn test_adapter(security_token: Option<String>) -> AliyunAdapter {
        AliyunAdapter {
            access_key_id: "AKID".into(),
            access_key_secret: "SECRET".into(),
            security_token,
            default_region: "cn-hangzhou".into(),
            regions: vec!["cn-hangzhou".into()],
            http: reqwest::Client::new(),
        }
    }

    #[test]
    fn oss_authorization_matches_oss_signing_formula() {
        let date = "Mon, 17 Aug 2026 04:00:00 GMT";
        // Without STS: StringToSign = GET\n\n\nDate\n/
        let mut expected = format!("GET\n\n\n{date}\n/");
        let sig = BASE64.encode(AliyunAdapter::hmac_sha1(b"SECRET", expected.as_bytes()));
        assert_eq!(test_adapter(None).oss_authorization(date), format!("OSS AKID:{sig}"));

        // With STS: canonical x-oss-security-token line before the resource.
        expected = format!("GET\n\n\n{date}\nx-oss-security-token:TOKEN123\n/");
        let sig = BASE64.encode(AliyunAdapter::hmac_sha1(b"SECRET", expected.as_bytes()));
        assert_eq!(
            test_adapter(Some("TOKEN123".into())).oss_authorization(date),
            format!("OSS AKID:{sig}")
        );
    }
}
