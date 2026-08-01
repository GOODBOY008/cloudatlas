use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RecommendationResponse {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub rec_type: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub potential_savings: f64,
    pub currency: String,
    pub resource_id: Option<String>,
    pub cloud_provider: Option<String>,
    pub cloud_region: Option<String>,
    pub cloud_account_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RecommendationSummaryResponse {
    pub total: i64,
    pub open: i64,
    pub dismissed: i64,
    pub total_potential_savings: f64,
    pub currency: String,
}

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct RecommendationListQuery {
    pub status: Option<String>,
    pub rec_type: Option<String>,
    pub search: Option<String>,
    #[serde(flatten)]
    pub page: crate::utils::pagination::PageQuery,
}
