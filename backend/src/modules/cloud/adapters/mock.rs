use serde_json::json;

use super::{CloudAdapter, DiscoveredResource};
use crate::error::AppResult;

/// Deterministic mock that returns realistic-looking fake cloud resources.
/// Used when `cloud_mock_enabled = true` or provider = "mock".
#[derive(Debug, Clone, Default)]
pub struct MockAdapter;

impl MockAdapter {
    pub fn new() -> Self {
        MockAdapter
    }
}

impl CloudAdapter for MockAdapter {
    async fn test_connection(&self) -> AppResult<(bool, String, i32)> {
        Ok((true, "Connection successful (mock)".to_string(), 3))
    }

    async fn discover_resources(&self, _region: Option<&str>) -> AppResult<Vec<DiscoveredResource>> {
        Ok(vec![
            DiscoveredResource {
                cloud_resource_id: "i-0abc123def456789a".to_string(),
                resource_name: "web-server-01".to_string(),
                resource_type: "instance".to_string(),
                region: Some("us-east-1".to_string()),
                tags: json!({"env": "prod", "team": "backend"}),
                meta: json!({
                    "instance_type": "t3.medium",
                    "state": "running",
                    "vcpus": 2,
                    "memory_gb": 4
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "i-0def456abc789012b".to_string(),
                resource_name: "app-server-02".to_string(),
                resource_type: "instance".to_string(),
                region: Some("us-east-1".to_string()),
                tags: json!({"env": "prod", "team": "backend"}),
                meta: json!({
                    "instance_type": "t3.large",
                    "state": "running",
                    "vcpus": 2,
                    "memory_gb": 8
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "vol-0abc123def456789c".to_string(),
                resource_name: "data-volume-01".to_string(),
                resource_type: "volume".to_string(),
                region: Some("us-east-1".to_string()),
                tags: json!({"env": "prod"}),
                meta: json!({
                    "size_gb": 100,
                    "volume_type": "gp3",
                    "state": "in-use"
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "vol-0xyz789abc123456d".to_string(),
                resource_name: "backup-volume-02".to_string(),
                resource_type: "volume".to_string(),
                region: Some("us-west-2".to_string()),
                tags: json!({"env": "staging"}),
                meta: json!({
                    "size_gb": 500,
                    "volume_type": "gp2",
                    "state": "available"
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "db-mysql-prod-01e".to_string(),
                resource_name: "mysql-prod-01".to_string(),
                resource_type: "rds_instance".to_string(),
                region: Some("us-east-1".to_string()),
                tags: json!({"env": "prod", "engine": "mysql"}),
                meta: json!({
                    "instance_class": "db.t3.medium",
                    "engine": "mysql",
                    "engine_version": "8.0",
                    "storage_gb": 100
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "s3-prod-assets-bucket-f".to_string(),
                resource_name: "prod-assets-bucket".to_string(),
                resource_type: "bucket".to_string(),
                region: Some("us-east-1".to_string()),
                tags: json!({"env": "prod", "type": "assets"}),
                meta: json!({
                    "versioning_enabled": true,
                    "size_gb": 25,
                    "object_count": 15000
                }),
            },
            DiscoveredResource {
                cloud_resource_id: "eip-0abc123xyz789g".to_string(),
                resource_name: "prod-nat-ip".to_string(),
                resource_type: "ip_address".to_string(),
                region: Some("eu-west-1".to_string()),
                tags: json!({"env": "prod"}),
                meta: json!({
                    "allocation_id": "eipalloc-0abc123xyz789g",
                    "associated": false
                }),
            },
        ])
    }

    async fn list_regions(&self) -> AppResult<Vec<String>> {
        Ok(vec![
            "us-east-1".to_string(),
            "us-west-2".to_string(),
            "eu-west-1".to_string(),
        ])
    }

    async fn start_resource(&self, _resource_id: &str) -> AppResult<()> {
        Ok(())
    }

    async fn stop_resource(&self, _resource_id: &str) -> AppResult<()> {
        Ok(())
    }
}
