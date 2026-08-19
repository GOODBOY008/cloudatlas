//! Microsoft Azure adapter — REST-based discovery via the Azure Resource
//! Manager API with a service-principal client-credentials token.
//!
//! Credentials: `{"client_id", "client_secret", "tenant_id", "subscription_id"}`.

use serde_json::{json, Value};

use super::{CloudAdapter, DiscoveredResource};
use crate::error::{AppError, AppResult};

pub struct AzureAdapter {
    client_id: String,
    client_secret: String,
    tenant_id: String,
    subscription_id: String,
    default_region: String,
}

impl AzureAdapter {
    pub fn from_credentials(creds: &Value, config: &Value) -> AppResult<Self> {
        let client_id = creds["client_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Azure credentials missing 'client_id'".into()))?
            .to_string();
        let client_secret = creds["client_secret"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation("Azure credentials missing 'client_secret'".into())
            })?
            .to_string();
        let tenant_id = creds["tenant_id"]
            .as_str()
            .ok_or_else(|| AppError::Validation("Azure credentials missing 'tenant_id'".into()))?
            .to_string();
        let subscription_id = creds["subscription_id"]
            .as_str()
            .ok_or_else(|| {
                AppError::Validation("Azure credentials missing 'subscription_id'".into())
            })?
            .to_string();
        let default_region = config
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or("eastus")
            .to_string();

        Ok(Self {
            client_id,
            client_secret,
            tenant_id,
            subscription_id,
            default_region,
        })
    }

    /// OAuth2 client-credentials token for the management API.
    async fn acquire_token(&self) -> AppResult<String> {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!(
                "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                self.tenant_id
            ))
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("scope", "https://management.azure.com/.default"),
                ("grant_type", "client_credentials"),
            ])
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| AppError::Cloud(format!("Azure token request failed: {e}")))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Cloud(format!("Azure token parse failed: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Cloud(format!(
                "Azure token error (HTTP {status}): {}",
                body["error_description"].as_str().unwrap_or("unknown")
            )));
        }
        body["access_token"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| AppError::Cloud("Azure token response missing access_token".into()))
    }

    async fn get_management(&self, path: &str) -> AppResult<Value> {
        let token = self.acquire_token().await?;
        let client = reqwest::Client::new();
        let url = format!("https://management.azure.com{path}");
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| AppError::Cloud(format!("Azure API request failed: {e}")))?;

        let status = resp.status();
        let body: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Cloud(format!("Azure API parse failed: {e}")))?;

        if !status.is_success() {
            return Err(AppError::Cloud(format!(
                "Azure API error (HTTP {status}): {}",
                body["error"]["message"].as_str().unwrap_or("unknown")
            )));
        }
        Ok(body)
    }
}

impl CloudAdapter for AzureAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        let path = format!(
            "/subscriptions/{}?api-version=2020-01-01",
            self.subscription_id
        );
        match self.get_management(&path).await {
            Ok(_) => Ok((true, "Azure subscription reachable".into(), 1)),
            Err(AppError::Cloud(msg)) => Ok((false, msg, 0)),
            Err(e) => Err(e),
        }
    }

    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        let region = region
            .map(String::from)
            .or_else(|| Some(self.default_region.clone()));
        let filter = region
            .map(|r| format!("&$filter=location eq '{}'", r))
            .unwrap_or_default();
        let path = format!(
            "/subscriptions/{}/resources?api-version=2021-04-01{}",
            self.subscription_id, filter
        );
        let body = self.get_management(&path).await?;

        let mut resources = Vec::new();
        if let Some(items) = body["value"].as_array() {
            for item in items {
                let name = item["name"].as_str().unwrap_or("azure-resource");
                let resource_type = item["type"].as_str().unwrap_or("");
                let kind = match resource_type {
                    t if t.contains("virtualMachines") => "instance",
                    t if t.contains("storageAccounts") => "storage",
                    t if t.contains("disks") => "volume",
                    _ => "instance",
                };
                resources.push(DiscoveredResource {
                    cloud_resource_id: item["id"].as_str().unwrap_or(name).to_string(),
                    resource_name: name.to_string(),
                    resource_type: kind.into(),
                    region: item["location"].as_str().map(String::from),
                    tags: item["tags"].clone(),
                    meta: json!({
                        "azure_type": resource_type,
                        "sku": item["sku"]["name"].as_str().unwrap_or(""),
                    }),
                });
            }
        }

        Ok(resources)
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        let path = format!(
            "/subscriptions/{}/locations?api-version=2020-01-01",
            self.subscription_id
        );
        let body = self.get_management(&path).await?;
        let regions = body["value"]
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

impl Default for AzureAdapter {
    fn default() -> Self {
        AzureAdapter {
            client_id: String::new(),
            client_secret: String::new(),
            tenant_id: String::new(),
            subscription_id: String::new(),
            default_region: "eastus".into(),
        }
    }
}
