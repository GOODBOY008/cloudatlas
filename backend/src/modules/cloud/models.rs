use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Persisted cloud account record. Credentials are stored encrypted.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CloudAccount {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub name: String,
    /// PostgreSQL `cloud_provider` enum, returned as text via SQL cast.
    pub provider: String,
    pub credentials_enc: String,
    pub config: serde_json::Value,
    pub is_active: bool,
    pub currency: String,
    pub last_sync_at: Option<DateTime<Utc>>,
    /// PostgreSQL `sync_status` enum, returned as text via SQL cast.
    pub last_sync_status: Option<String>,
    pub resource_count: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A single cloud-resource discovery run record.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct SyncJob {
    pub id: Uuid,
    pub cloud_account_id: Uuid,
    pub organization_id: Uuid,
    /// PostgreSQL `sync_status` enum, returned as text via SQL cast.
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
