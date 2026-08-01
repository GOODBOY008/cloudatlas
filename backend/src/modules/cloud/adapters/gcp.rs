//! Google Cloud Platform adapter — REST-based discovery and connection tests.
//!
//! Credentials: `{"access_token": "...", "project_id": "..."}` (OAuth2 token
//! for a service account with the required scopes). All calls go through the
//! public GCP REST APIs with a Bearer token — no SDK dependency.

use serde_json::{json, Value};

use super::{CloudAdapter, DiscoveredResource};
use crate::error::{AppError, AppResult};

pub struct GcpAdapter {
    access_token: String,
    project_id: String,
    default_region: String,
}

impl GcpAdapter {
    pub fn from_credentials(creds: &Value, config: &Value) -> AppResult<Self> {
        let access_token = creds["access_token"]
            .as_str()
            .ok_or_else(|| AppError::Validation("GCP credentials missing 'access_token'".into()))?
            .to_string();
        let project_id = creds["project_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("GCP credentials missing 'project_id'".into()))?
            .to_string();
        let default_region = config
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or("us-central1")
            .to_string();

        Ok(Self {
            access_token,
            project_id,
            default_region,
        })
    }

    async fn get(&self, url: &str) -> AppResult<Value> {
        let client = reqwest::Client::new();
        let resp = client
            .get(url)
            .bearer_auth(&self.access_token)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| AppError::Cloud(format!("GCP request failed: {e}")))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Cloud(format!("GCP response parse failed: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Cloud(format!(
                "GCP API error (HTTP {status}): {}",
                body["error"]["message"].as_str().unwrap_or("unknown")
            )));
        }
        Ok(body)
    }
}

impl CloudAdapter for GcpAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        let url = format!(
            "https://cloudresourcemanager.googleapis.com/v1/projects/{}",
            self.project_id
        );
        match self.get(&url).await {
            Ok(_) => Ok((true, "GCP project reachable".into(), 1)),
            Err(AppError::Cloud(msg)) => Ok((false, msg, 0)),
            Err(e) => Err(e),
        }
    }

    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        let region = region
            .map(String::from)
            .or_else(|| Some(self.default_region.clone()));
        let url = if let Some(region) = region {
            format!(
                "https://compute.googleapis.com/compute/v1/projects/{}/zones/{}-*/instances?maxResults=500",
                self.project_id, region
            )
        } else {
            format!(
                "https://compute.googleapis.com/compute/v1/projects/{}/aggregated/instances?maxResults=500",
                self.project_id
            )
        };

        let body = self.get(&url).await?;
        let mut resources = Vec::new();

        // Aggregated response: items.{zones/...}.instances[]
        if let Some(items) = body["items"].as_object() {
            for (key, group) in items {
                if let Some(instances) = group["instances"].as_array() {
                    for inst in instances {
                        let name = inst["name"].as_str().unwrap_or("gcp-instance");
                        let zone = key.split('/').next_back().unwrap_or("unknown");
                        let mut tags = json!({});
                        if let Some(labels) = inst["labels"].as_object() {
                            tags = Value::Object(labels.clone());
                        }
                        resources.push(DiscoveredResource {
                            cloud_resource_id: inst["id"].as_str().unwrap_or(name).to_string(),
                            resource_name: name.to_string(),
                            resource_type: "instance".into(),
                            region: Some(zone.trim_end_matches(|c: char| c.is_ascii_digit()).to_string()),
                            tags,
                            meta: json!({
                                "machine_type": inst["machineType"].as_str().unwrap_or(""),
                                "status": inst["status"].as_str().unwrap_or(""),
                                "zone": zone,
                            }),
                        });
                    }
                }
            }
        }

        Ok(resources)
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        let url = format!(
            "https://compute.googleapis.com/compute/v1/projects/{}/regions?maxResults=200",
            self.project_id
        );
        let body = self.get(&url).await?;
        let regions = body["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|r| r["name"].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        Ok(regions)
    }
}

impl Default for GcpAdapter {
    fn default() -> Self {
        GcpAdapter {
            access_token: String::new(),
            project_id: String::new(),
            default_region: "us-central1".into(),
        }
    }
}
