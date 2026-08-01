use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// CI type definition (schema/class for configuration items).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CiType {
    pub id: Uuid,
    pub organization_id: Option<Uuid>,
    pub classification_id: Option<Uuid>,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    /// PostgreSQL `cloud_provider` enum, returned as text via SQL cast.
    pub cloud_provider: Option<String>,
    pub is_builtin: bool,
    pub is_abstract: bool,
    pub parent_type_id: Option<Uuid>,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Configuration Item — a discovered or manually-created asset.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Ci {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub ci_type_id: Uuid,
    pub cloud_account_id: Option<Uuid>,
    pub cloud_resource_id: Option<String>,
    /// PostgreSQL `cloud_provider` enum, returned as text via SQL cast.
    pub cloud_provider: Option<String>,
    pub cloud_region: Option<String>,
    pub name: String,
    pub display_name: Option<String>,
    pub meta: serde_json::Value,
    pub tags: serde_json::Value,
    /// PostgreSQL `ci_lifecycle_state` enum, returned as text via SQL cast.
    pub lifecycle_state: String,
    pub parent_ci_id: Option<Uuid>,
    pub pool_id: Option<Uuid>,
    pub discovered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Defines a named kind of relationship between CI types.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CiAssociationKind {
    pub id: Uuid,
    pub organization_id: Option<Uuid>,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub is_directional: bool,
    pub is_builtin: bool,
    pub created_at: DateTime<Utc>,
}

/// A concrete relationship instance between two CIs.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CiInstanceAssociation {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub src_ci_id: Uuid,
    pub object_association_id: Uuid,
    pub dst_ci_id: Uuid,
    pub meta: serde_json::Value,
    pub created_by: Option<Uuid>,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

/// Immutable audit trail entry for CI create / update / delete events.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct CiAuditLog {
    pub id: Uuid,
    pub ci_id: Uuid,
    pub organization_id: Uuid,
    pub user_id: Option<Uuid>,
    pub operation: String,
    pub field_changes: Option<serde_json::Value>,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

/// Projection used by `list_associations` (JOIN across multiple tables).
#[derive(Debug, Clone, FromRow)]
pub struct AssociationRow {
    pub id: Uuid,
    pub src_ci_id: Uuid,
    pub src_ci_name: String,
    pub association_kind_name: String,
    pub dst_ci_id: Uuid,
    pub dst_ci_name: String,
    pub meta: serde_json::Value,
    pub created_at: DateTime<Utc>,
}
