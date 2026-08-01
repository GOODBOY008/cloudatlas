use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;

use crate::state::AppState;

/// GET /health — liveness
#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, description = "Service alive"))
)]
pub async fn liveness() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}

/// GET /health/ready — readiness (checks DB)
#[utoipa::path(
    get,
    path = "/health/ready",
    responses(
        (status = 200, description = "Service ready"),
        (status = 503, description = "Service not ready")
    )
)]
pub async fn readiness(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(json!({"status": "ready", "db": "connected"})),
        ),
        Err(e) => (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status": "not_ready", "db": format!("{e}")})),
        ),
    }
}
