use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;
use uuid::Uuid;

// ─── CI Types ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, ToSchema)]
pub struct CiTypeResponse {
    pub id: Uuid,
    pub organization_id: Option<Uuid>,
    pub classification_id: Option<Uuid>,
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub cloud_provider: Option<String>,
    pub is_builtin: bool,
    pub is_abstract: bool,
    pub parent_type_id: Option<Uuid>,
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCiTypeRequest {
    pub name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub classification_id: Option<Uuid>,
    pub parent_type_id: Option<Uuid>,
    pub cloud_provider: Option<String>,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateCiTypeRequest {
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
}

// ─── CIs ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct CiQuery {
    pub ci_type_id: Option<Uuid>,
    pub lifecycle_state: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    pub cloud_provider: Option<String>,
    pub search: Option<String>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCiRequest {
    pub ci_type_id: Uuid,
    pub name: String,
    pub display_name: Option<String>,
    pub cloud_resource_id: Option<String>,
    pub cloud_provider: Option<String>,
    pub cloud_region: Option<String>,
    pub meta: Option<Value>,
    pub tags: Option<Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateCiRequest {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub meta: Option<Value>,
    pub tags: Option<Value>,
    pub lifecycle_state: Option<String>,
    pub pool_id: Option<Uuid>,
    /// Reparent the CI (cycle-checked against the parent chain, T11).
    pub parent_ci_id: Option<Uuid>,
    /// Clear the parent (serde cannot distinguish null vs absent for
    /// `parent_ci_id`, so un-parenting uses this explicit flag).
    pub remove_parent: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PatchCiTagsRequest {
    /// Full replacement of the CI's tags JSONB object. Must be a flat object
    /// whose values are strings (e.g. `{"env": "prod", "team": "platform"}`).
    pub tags: Value,
}

/// Full CI detail including the human-readable CI type name.
#[derive(Debug, Serialize, ToSchema)]
pub struct CiResponse {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub ci_type_id: Uuid,
    pub ci_type_name: String,
    pub cloud_account_id: Option<Uuid>,
    pub cloud_resource_id: Option<String>,
    pub cloud_provider: Option<String>,
    pub cloud_region: Option<String>,
    pub name: String,
    pub display_name: Option<String>,
    pub meta: Value,
    pub tags: Value,
    pub lifecycle_state: String,
    pub parent_ci_id: Option<Uuid>,
    pub pool_id: Option<Uuid>,
    pub discovered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// ─── Associations ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAssociationRequest {
    pub object_association_id: Uuid,
    pub dst_ci_id: Uuid,
    pub meta: Option<Value>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AssociationResponse {
    pub id: Uuid,
    pub src_ci_id: Uuid,
    pub src_ci_name: String,
    pub association_kind_name: String,
    pub dst_ci_id: Uuid,
    pub dst_ci_name: String,
    pub meta: Value,
    pub created_at: DateTime<Utc>,
}

// ─── Audit logs ───────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct TopologyQuery {
    /// Maximum depth for recursive traversal (default 10, max 20)
    pub max_depth: Option<i32>,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ImpactQuery {
    /// Maximum hop depth for BFS impact traversal (default 3, max 10).
    pub max_depth: Option<i32>,
    /// Direction to traverse: "outgoing" (downstream), "incoming" (upstream), "both" (default: "both").
    pub direction: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuditLogResponse {
    pub id: Uuid,
    pub operation: String,
    pub field_changes: Option<Value>,
    pub source: String,
    pub user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

// ─── Conversions ──────────────────────────────────────────────────────────────

impl From<super::models::CiType> for CiTypeResponse {
    fn from(t: super::models::CiType) -> Self {
        CiTypeResponse {
            id: t.id,
            organization_id: t.organization_id,
            classification_id: t.classification_id,
            name: t.name,
            display_name: t.display_name,
            description: t.description,
            icon: t.icon,
            cloud_provider: t.cloud_provider,
            is_builtin: t.is_builtin,
            is_abstract: t.is_abstract,
            parent_type_id: t.parent_type_id,
            sort_order: t.sort_order,
            created_at: t.created_at,
            updated_at: t.updated_at,
        }
    }
}

impl From<super::models::CiAuditLog> for AuditLogResponse {
    fn from(l: super::models::CiAuditLog) -> Self {
        AuditLogResponse {
            id: l.id,
            operation: l.operation,
            field_changes: l.field_changes,
            source: l.source,
            user_id: l.user_id,
            created_at: l.created_at,
        }
    }
}
