use anyhow::anyhow;
use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_ec2::config::Region;
use aws_sdk_ec2::Client as Ec2Client;
use aws_sdk_rds::Client as RdsClient;
use aws_sdk_s3::Client as S3Client;
use serde_json::{json, Value};

use super::{CloudAdapter, DiscoveredResource};
use crate::error::{AppError, AppResult};

/// AWS cloud adapter.  Credentials are provided explicitly (no env-var chain).
pub struct AwsAdapter {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    /// Default region used when the caller does not specify one.
    pub default_region: String,
}

impl AwsAdapter {
    pub fn from_credentials(creds: &Value, config: &Value) -> AppResult<Self> {
        let access_key_id = creds["access_key_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("AWS credentials missing 'access_key_id'".into()))?
            .to_string();
        let secret_access_key = creds["secret_access_key"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation("AWS credentials missing 'secret_access_key'".into())
            })?
            .to_string();
        let session_token = creds
            .get("session_token")
            .and_then(Value::as_str)
            .map(str::to_string);
        let default_region = config
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or("us-east-1")
            .to_string();

        Ok(Self {
            access_key_id,
            secret_access_key,
            session_token,
            default_region,
        })
    }

    fn sdk_credentials(&self) -> Credentials {
        Credentials::new(
            &self.access_key_id,
            &self.secret_access_key,
            self.session_token.clone(),
            None,
            "cloudatlas",
        )
    }

    async fn sdk_config(&self, region: &str) -> aws_config::SdkConfig {
        aws_config::defaults(BehaviorVersion::latest())
            .credentials_provider(self.sdk_credentials())
            .region(Region::new(region.to_string()))
            .load()
            .await
    }

    /// Convert EC2 tag slice to a JSON object `{"key": "value"}`.
    fn ec2_tags_to_json(tags: &[aws_sdk_ec2::types::Tag]) -> Value {
        let map: serde_json::Map<String, Value> = tags
            .iter()
            .filter_map(|t| {
                let k = t.key()?;
                let v = t.value().unwrap_or_default();
                Some((k.to_string(), Value::String(v.to_string())))
            })
            .collect();
        Value::Object(map)
    }

    /// Derive region name from an availability-zone name by stripping the trailing letter.
    fn az_to_region(az: &str) -> String {
        if az.is_empty() {
            return az.to_string();
        }
        let last = az.chars().last().unwrap_or('a');
        if last.is_alphabetic() && !az.ends_with(|c: char| c.is_ascii_digit()) {
            az[..az.len() - 1].to_string()
        } else {
            az.to_string()
        }
    }
}

impl CloudAdapter for AwsAdapter {
    // ──────────────────────────────────────────────────────────────────────────
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        let cfg = self.sdk_config(&self.default_region).await;
        let ec2 = Ec2Client::new(&cfg);

        let output = ec2
            .describe_regions()
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow!("AWS EC2 DescribeRegions: {e}")))?;

        let count = output.regions().len() as i32;
        Ok((
            true,
            format!("Connected to AWS — {} regions visible", count),
            count,
        ))
    }

    // ──────────────────────────────────────────────────────────────────────────
    async fn list_regions(&self) -> AppResult<Vec<String>> {
        let cfg = self.sdk_config(&self.default_region).await;
        let ec2 = Ec2Client::new(&cfg);

        let output = ec2
            .describe_regions()
            .all_regions(true)
            .send()
            .await
            .map_err(|e| AppError::Internal(anyhow!("AWS EC2 DescribeRegions: {e}")))?;

        Ok(output
            .regions()
            .iter()
            .filter_map(|r| r.region_name().map(str::to_string))
            .collect())
    }

    // ──────────────────────────────────────────────────────────────────────────
    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        let target = region.unwrap_or(&self.default_region).to_string();
        let mut out: Vec<DiscoveredResource> = Vec::new();

        // ── EC2 instances ─────────────────────────────────────────────────────
        {
            let cfg = self.sdk_config(&target).await;
            let ec2 = Ec2Client::new(&cfg);
            let mut next_token: Option<String> = None;
            loop {
                let mut req = ec2.describe_instances().max_results(100);
                if let Some(ref tok) = next_token {
                    req = req.next_token(tok);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(anyhow!("AWS EC2 DescribeInstances: {e}")))?;

                for reservation in resp.reservations() {
                    for inst in reservation.instances() {
                        let id = inst.instance_id().unwrap_or_default().to_string();
                        let name = inst
                            .tags()
                            .iter()
                            .find(|t| t.key() == Some("Name"))
                            .and_then(|t| t.value())
                            .unwrap_or(&id)
                            .to_string();
                        let itype = inst
                            .instance_type()
                            .map(|t| t.as_str().to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        let state = inst
                            .state()
                            .and_then(|s| s.name())
                            .map(|n| n.as_str().to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        let az = inst
                            .placement()
                            .and_then(|p| p.availability_zone())
                            .unwrap_or_default()
                            .to_string();
                        let res_region = Self::az_to_region(&az);
                        let vcpus = inst
                            .cpu_options()
                            .map(|c| {
                                c.core_count().unwrap_or(0) * c.threads_per_core().unwrap_or(1)
                            })
                            .unwrap_or(0);
                        let platform = inst.platform_details().unwrap_or("Linux/UNIX").to_string();

                        out.push(DiscoveredResource {
                            cloud_resource_id: id,
                            resource_name: name,
                            resource_type: "instance".to_string(),
                            region: Some(res_region),
                            tags: Self::ec2_tags_to_json(inst.tags()),
                            meta: json!({
                                "instance_type": itype,
                                "state": state,
                                "vcpus": vcpus,
                                "platform": platform,
                                "availability_zone": az,
                            }),
                        });
                    }
                }

                next_token = resp.next_token().map(str::to_string);
                if next_token.is_none() {
                    break;
                }
            }
        }

        // ── EBS volumes ───────────────────────────────────────────────────────
        {
            let cfg = self.sdk_config(&target).await;
            let ec2 = Ec2Client::new(&cfg);
            let mut next_token: Option<String> = None;
            loop {
                let mut req = ec2.describe_volumes().max_results(100);
                if let Some(ref tok) = next_token {
                    req = req.next_token(tok);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(anyhow!("AWS EC2 DescribeVolumes: {e}")))?;

                for vol in resp.volumes() {
                    let id = vol.volume_id().unwrap_or_default().to_string();
                    let name = vol
                        .tags()
                        .iter()
                        .find(|t| t.key() == Some("Name"))
                        .and_then(|t| t.value())
                        .unwrap_or(&id)
                        .to_string();
                    let vtype = vol
                        .volume_type()
                        .map(|t| t.as_str().to_string())
                        .unwrap_or_else(|| "gp2".to_string());
                    let state = vol
                        .state()
                        .map(|s| s.as_str().to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    let size = vol.size().unwrap_or(0);
                    let az = vol.availability_zone().unwrap_or_default().to_string();
                    let encrypted = vol.encrypted().unwrap_or(false);

                    out.push(DiscoveredResource {
                        cloud_resource_id: id,
                        resource_name: name,
                        resource_type: "volume".to_string(),
                        region: Some(target.clone()),
                        tags: Self::ec2_tags_to_json(vol.tags()),
                        meta: json!({
                            "size_gb": size,
                            "volume_type": vtype,
                            "state": state,
                            "encrypted": encrypted,
                            "availability_zone": az,
                        }),
                    });
                }

                next_token = resp.next_token().map(str::to_string);
                if next_token.is_none() {
                    break;
                }
            }
        }

        // ── Elastic IPs ───────────────────────────────────────────────────────
        {
            let cfg = self.sdk_config(&target).await;
            let ec2 = Ec2Client::new(&cfg);
            let resp = ec2
                .describe_addresses()
                .send()
                .await
                .map_err(|e| AppError::Internal(anyhow!("AWS EC2 DescribeAddresses: {e}")))?;

            for addr in resp.addresses() {
                let allocation_id = addr.allocation_id().unwrap_or_default().to_string();
                let public_ip = addr.public_ip().unwrap_or_default().to_string();
                let name = addr
                    .tags()
                    .iter()
                    .find(|t| t.key() == Some("Name"))
                    .and_then(|t| t.value())
                    .unwrap_or(&public_ip)
                    .to_string();
                let associated =
                    addr.instance_id().is_some() || addr.network_interface_id().is_some();

                out.push(DiscoveredResource {
                    cloud_resource_id: allocation_id.clone(),
                    resource_name: name,
                    resource_type: "ip_address".to_string(),
                    region: Some(target.clone()),
                    tags: Self::ec2_tags_to_json(addr.tags()),
                    meta: json!({
                        "allocation_id": allocation_id,
                        "public_ip": public_ip,
                        "associated": associated,
                        "instance_id": addr.instance_id(),
                        "network_interface_id": addr.network_interface_id(),
                    }),
                });
            }
        }

        // ── RDS instances ─────────────────────────────────────────────────────
        {
            let cfg = self.sdk_config(&target).await;
            let rds = RdsClient::new(&cfg);
            let mut marker: Option<String> = None;
            loop {
                let mut req = rds.describe_db_instances().max_records(100);
                if let Some(ref m) = marker {
                    req = req.marker(m);
                }
                let resp = req
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(anyhow!("AWS RDS DescribeDBInstances: {e}")))?;

                for db in resp.db_instances() {
                    let id = db.db_instance_identifier().unwrap_or_default().to_string();
                    let class = db.db_instance_class().unwrap_or_default().to_string();
                    let engine = db.engine().unwrap_or_default().to_string();
                    let engine_version = db.engine_version().unwrap_or_default().to_string();
                    let status = db.db_instance_status().unwrap_or_default().to_string();
                    let storage = db.allocated_storage().unwrap_or(0);
                    let az = db.availability_zone().unwrap_or_default().to_string();
                    let multi_az = db.multi_az().unwrap_or(false);
                    let endpoint = db.endpoint().and_then(|e| e.address()).map(str::to_string);

                    out.push(DiscoveredResource {
                        cloud_resource_id: id.clone(),
                        resource_name: id,
                        resource_type: "rds_instance".to_string(),
                        region: Some(target.clone()),
                        tags: json!({}),
                        meta: json!({
                            "instance_class": class,
                            "engine": engine,
                            "engine_version": engine_version,
                            "status": status,
                            "storage_gb": storage,
                            "availability_zone": az,
                            "multi_az": multi_az,
                            "endpoint": endpoint,
                        }),
                    });
                }

                marker = resp.marker().map(str::to_string);
                if marker.is_none() {
                    break;
                }
            }
        }

        // ── S3 buckets (global) ───────────────────────────────────────────────
        {
            let cfg = self.sdk_config(&self.default_region).await;
            let s3 = S3Client::new(&cfg);
            let resp = s3
                .list_buckets()
                .send()
                .await
                .map_err(|e| AppError::Internal(anyhow!("AWS S3 ListBuckets: {e}")))?;

            for bucket in resp.buckets() {
                let name = bucket.name().unwrap_or_default().to_string();
                let created_ts = bucket
                    .creation_date()
                    .and_then(|d| d.to_millis().ok())
                    .unwrap_or(0);

                out.push(DiscoveredResource {
                    cloud_resource_id: format!("s3:{name}"),
                    resource_name: name.clone(),
                    resource_type: "bucket".to_string(),
                    region: None,
                    tags: json!({}),
                    meta: json!({
                        "bucket_name": name,
                        "creation_date_ms": created_ts,
                    }),
                });
            }
        }

        tracing::info!(
            region = %target,
            count = out.len(),
            "AWS resource discovery complete"
        );
        Ok(out)
    }
}
