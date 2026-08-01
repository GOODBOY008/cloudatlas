use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;

// ─── Requests ────────────────────────────────────────────────────────────────

fn empty_object() -> Value {
    serde_json::json!({})
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCloudAccountRequest {
    pub name: String,
    pub provider: String,
    /// Raw credentials JSON — encrypted at rest (AES-256-GCM).
    /// Optional: mock/local accounts can be created without credentials;
    /// real providers require them (validated by the adapter).
    #[serde(default = "empty_object")]
    pub credentials: Value,
    #[serde(default = "empty_object")]
    pub config: Value,
    /// Billing currency for this account (default: USD, alibaba→CNY).
    pub currency: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateCloudAccountRequest {
    pub name: Option<String>,
    pub config: Option<Value>,
    #[serde(default)]
    pub sync_interval_hours: Option<i32>,
    /// Billing currency for this account (3-letter code).
    pub currency: Option<String>,
    /// Write-only credentials rotation. Non-empty object → validate + replace;
    /// literal string "__CLEAR__" → clear; absent/null/empty → unchanged.
    #[serde(default)]
    pub credentials: Option<Value>,
}

// ─── Responses ───────────────────────────────────────────────────────────────

/// Cloud account details — credentials are intentionally omitted; the
/// `has_credentials` flag is derived from the encrypted blob at rest.
#[derive(Debug, Serialize, ToSchema)]
pub struct CloudAccountResponse {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub name: String,
    pub provider: String,
    pub config: Value,
    pub is_active: bool,
    pub currency: String,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub last_sync_status: Option<String>,
    pub resource_count: i32,
    pub has_credentials: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SyncJobResponse {
    pub id: Uuid,
    pub cloud_account_id: Uuid,
    pub organization_id: Uuid,
    pub status: String,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub resources_discovered: Option<i32>,
    pub resources_created: Option<i32>,
    pub resources_updated: Option<i32>,
    pub resources_deleted: Option<i32>,
    pub error_message: Option<String>,
    pub triggered_by: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ConnectionTestResponse {
    pub success: bool,
    pub message: String,
    pub region_count: Option<i32>,
}

// ─── Conversions ─────────────────────────────────────────────────────────────

impl CloudAccountResponse {
    /// Build the response from a persisted account. `has_credentials` is
    /// derived from the encrypted blob — credentials are never returned.
    pub fn from_account(a: super::models::CloudAccount, has_credentials: bool) -> Self {
        CloudAccountResponse {
            id: a.id,
            organization_id: a.organization_id,
            name: a.name,
            provider: a.provider,
            config: a.config,
            is_active: a.is_active,
            currency: a.currency,
            last_sync_at: a.last_sync_at,
            last_sync_status: a.last_sync_status,
            resource_count: a.resource_count,
            has_credentials,
            created_at: a.created_at,
            updated_at: a.updated_at,
        }
    }
}

impl From<super::models::SyncJob> for SyncJobResponse {
    fn from(j: super::models::SyncJob) -> Self {
        SyncJobResponse {
            id: j.id,
            cloud_account_id: j.cloud_account_id,
            organization_id: j.organization_id,
            status: j.status,
            started_at: j.started_at,
            completed_at: j.completed_at,
            resources_discovered: j.resources_discovered,
            resources_created: j.resources_created,
            resources_updated: j.resources_updated,
            resources_deleted: j.resources_deleted,
            error_message: j.error_message,
            triggered_by: j.triggered_by,
            created_at: j.created_at,
        }
    }
}
