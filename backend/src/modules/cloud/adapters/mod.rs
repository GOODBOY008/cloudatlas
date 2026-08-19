pub mod aliyun;
pub mod aws;
pub mod azure;
pub mod gcp;
pub mod kubernetes;
pub mod mock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// A cloud resource discovered during a sync run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredResource {
    pub cloud_resource_id: String,
    pub resource_name: String,
    /// Maps to the `resource_type` PostgreSQL enum values
    /// (e.g. "instance", "volume", "rds_instance", "bucket").
    pub resource_type: String,
    pub region: Option<String>,
    pub tags: Value,
    pub meta: Value,
}

/// Capability contract every cloud adapter must satisfy.
#[allow(async_fn_in_trait)] // RPITIT is intentional; adapters are boxed, not generic
pub trait CloudAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)>;
    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>>;
    async fn list_regions(&self) -> AppResult<Vec<String>>;

    /// Start a resource. Default: not supported by this provider.
    async fn start_resource(&self, _resource_id: &str) -> AppResult<()> {
        Err(AppError::Unsupported(
            "start_resource is not supported by this provider".into(),
        ))
    }

    /// Stop a resource. Default: not supported by this provider.
    async fn stop_resource(&self, _resource_id: &str) -> AppResult<()> {
        Err(AppError::Unsupported(
            "stop_resource is not supported by this provider".into(),
        ))
    }
}

/// Enum wrapper so all adapters can be used through one type without `dyn`.
pub enum AnyAdapter {
    Mock(mock::MockAdapter),
    Aws(aws::AwsAdapter),
    Aliyun(aliyun::AliyunAdapter),
    Gcp(gcp::GcpAdapter),
    Azure(azure::AzureAdapter),
    Kubernetes(kubernetes::KubernetesAdapter),
}

impl AnyAdapter {
    /// Borrow the inner Aliyun adapter, if this is one. Used by the sync worker
    /// to fetch per-cluster kubeconfigs for ACK workload discovery.
    pub fn as_aliyun(&self) -> Option<&aliyun::AliyunAdapter> {
        match self {
            Self::Aliyun(a) => Some(a),
            _ => None,
        }
    }
}

impl CloudAdapter for AnyAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        match self {
            Self::Mock(a) => a.test_connection().await,
            Self::Aws(a) => a.test_connection().await,
            Self::Aliyun(a) => a.test_connection().await,
            Self::Gcp(a) => a.test_connection().await,
            Self::Azure(a) => a.test_connection().await,
            Self::Kubernetes(a) => a.test_connection().await,
        }
    }

    async fn discover_resources(&self, region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        match self {
            Self::Mock(a) => a.discover_resources(region).await,
            Self::Aws(a) => a.discover_resources(region).await,
            Self::Aliyun(a) => a.discover_resources(region).await,
            Self::Gcp(a) => a.discover_resources(region).await,
            Self::Azure(a) => a.discover_resources(region).await,
            Self::Kubernetes(a) => a.discover_resources(region).await,
        }
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        match self {
            Self::Mock(a) => a.list_regions().await,
            Self::Aws(a) => a.list_regions().await,
            Self::Aliyun(a) => a.list_regions().await,
            Self::Gcp(a) => a.list_regions().await,
            Self::Azure(a) => a.list_regions().await,
            Self::Kubernetes(a) => a.list_regions().await,
        }
    }

    async fn start_resource(&self, resource_id: &str) -> AppResult<()> {
        match self {
            Self::Mock(a) => a.start_resource(resource_id).await,
            Self::Aws(a) => a.start_resource(resource_id).await,
            Self::Aliyun(a) => a.start_resource(resource_id).await,
            Self::Gcp(a) => a.start_resource(resource_id).await,
            Self::Azure(a) => a.start_resource(resource_id).await,
            Self::Kubernetes(a) => a.start_resource(resource_id).await,
        }
    }

    async fn stop_resource(&self, resource_id: &str) -> AppResult<()> {
        match self {
            Self::Mock(a) => a.stop_resource(resource_id).await,
            Self::Aws(a) => a.stop_resource(resource_id).await,
            Self::Aliyun(a) => a.stop_resource(resource_id).await,
            Self::Gcp(a) => a.stop_resource(resource_id).await,
            Self::Azure(a) => a.stop_resource(resource_id).await,
            Self::Kubernetes(a) => a.stop_resource(resource_id).await,
        }
    }
}

/// Factory: returns the right adapter for `provider`, falling back to mock when
/// `mock_enabled = true` or the provider is unrecognised.
pub fn create_adapter(
    provider: &str,
    credentials: &Value,
    config: &Value,
    mock_enabled: bool,
) -> AppResult<AnyAdapter> {
    if mock_enabled || provider == "mock" {
        return Ok(AnyAdapter::Mock(mock::MockAdapter::new()));
    }
    match provider {
        "aws" => {
            let adapter = aws::AwsAdapter::from_credentials(credentials, config)?;
            Ok(AnyAdapter::Aws(adapter))
        }
        "alibaba" => {
            let adapter = aliyun::AliyunAdapter::from_credentials(credentials, config)?;
            Ok(AnyAdapter::Aliyun(adapter))
        }
        "gcp" => {
            let adapter = gcp::GcpAdapter::from_credentials(credentials, config)?;
            Ok(AnyAdapter::Gcp(adapter))
        }
        "azure" => {
            let adapter = azure::AzureAdapter::from_credentials(credentials, config)?;
            Ok(AnyAdapter::Azure(adapter))
        }
        "kubernetes" => {
            let adapter = kubernetes::KubernetesAdapter::from_credentials(credentials, config)?;
            Ok(AnyAdapter::Kubernetes(adapter))
        }
        _ => {
            tracing::warn!(
                provider,
                "Unknown cloud provider, falling back to mock adapter"
            );
            Ok(AnyAdapter::Mock(mock::MockAdapter::new()))
        }
    }
}
