use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

// ─── Cost Centers ─────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCostCenterRequest {
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<Uuid>,
    pub owner_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateCostCenterRequest {
    pub code: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub parent_id: Option<Uuid>,
    pub owner_id: Option<Uuid>,
}

// ─── Query params ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ExpenseQuery {
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    pub pool_id: Option<Uuid>,
    pub resource_type: Option<String>,
    pub cloud_region: Option<String>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}

// ─── Summary ──────────────────────────────────────────────────────────────────

/// Aggregated cost summary for a time window.
#[derive(Debug, Serialize, ToSchema)]
pub struct ExpenseSummaryResponse {
    pub total_cost: f64,
    pub currency: String,
    pub period_days: i32,
    pub resource_count: i64,
    pub by_service: Vec<ServiceCost>,
    pub by_region: Vec<RegionCost>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ServiceCost {
    pub service_name: String,
    pub cost: f64,
    pub percentage: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RegionCost {
    pub region: String,
    pub cost: f64,
    pub percentage: f64,
}

// ─── Trend / top-resources ────────────────────────────────────────────────────

#[derive(Debug, Serialize, ToSchema)]
pub struct TrendPoint {
    pub date: String,
    pub cost: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TopResourceEntry {
    pub cloud_resource_id: String,
    pub resource_name: Option<String>,
    pub resource_type: String,
    pub total_cost: f64,
    pub pool_name: Option<String>,
}

// ─── Forecast ─────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ForecastQuery {
    /// Number of days to forecast (default 30, max 90)
    pub days: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ForecastPoint {
    pub date: String,
    pub predicted_cost: f64,
    pub lower: f64,
    pub upper: f64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ForecastSummary {
    pub projected_monthly: f64,
    pub trend_direction: String,
    pub change_percent: f64,
}

// ─── Anomaly ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct AnomalyQuery {
    /// Recent window for anomaly detection in days (default 7)
    pub days: Option<i64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AnomalyEntry {
    pub date: String,
    pub cloud_resource_id: String,
    pub resource_name: Option<String>,
    pub resource_type: String,
    pub cost: f64,
    pub mean_cost: f64,
    pub z_score: f64,
    pub deviation_pct: f64,
}

// ─── RI/SP Coverage ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, ToSchema)]
pub struct RiCoverageResponse {
    pub ri_count: i64,
    pub sp_count: i64,
    pub total_instances: i64,
    pub coverage_pct: f64,
    pub on_demand_cost: f64,
    pub commitment_cost: f64,
    pub potential_savings: f64,
}

// ─── Pools ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreatePoolRequest {
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<Uuid>,
    pub pool_type: String,
    pub owner_id: Option<Uuid>,
    pub monthly_budget: Option<f64>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdatePoolRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub owner_id: Option<Uuid>,
    pub monthly_budget: Option<f64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PoolResponse {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    pub pool_type: String,
    pub owner_id: Option<Uuid>,
    pub monthly_budget: Option<f64>,
    pub created_at: DateTime<Utc>,
}

impl From<super::models::Pool> for PoolResponse {
    fn from(p: super::models::Pool) -> Self {
        PoolResponse {
            id: p.id,
            organization_id: p.organization_id,
            parent_id: p.parent_id,
            name: p.name,
            description: p.description,
            pool_type: p.pool_type,
            owner_id: p.owner_id,
            monthly_budget: p.monthly_budget,
            created_at: p.created_at,
        }
    }
}
