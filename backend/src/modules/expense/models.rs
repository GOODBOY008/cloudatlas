use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Aggregated cost line item (one row per resource per day).
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Expense {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub cloud_account_id: Uuid,
    pub cloud_resource_id: String,
    pub resource_name: Option<String>,
    /// PostgreSQL `resource_type` enum, returned as text via SQL cast.
    pub resource_type: String,
    pub cloud_region: Option<String>,
    pub service_name: Option<String>,
    pub date: NaiveDate,
    pub cost: f64,
    pub currency: String,
    pub pool_id: Option<Uuid>,
    pub owner_id: Option<Uuid>,
    pub tags: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Hierarchical cost pool / cost-centre.
#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Pool {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    pub pool_type: String,
    pub owner_id: Option<Uuid>,
    pub monthly_budget: Option<f64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Projection returned by cost-summary GROUP-BY queries.
#[derive(Debug, Clone, FromRow)]
pub struct ExpenseSummaryRow {
    pub cloud_resource_id: String,
    pub resource_name: Option<String>,
    /// PostgreSQL `resource_type` enum, returned as text via SQL cast.
    pub resource_type: String,
    pub total_cost: f64,
}
