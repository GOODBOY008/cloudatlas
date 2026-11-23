//! Ai HTTP endpoints. Authentication is applied once by the parent router.

use crate::{modules::ai, state::AppState};
use axum::{
    routing::{delete, get, post},
    Router,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/orgs/{org_id}/ai/settings",
            get(ai::handlers::get_ai_settings).put(ai::handlers::update_ai_settings),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/provider",
            get(ai::handlers::get_ai_provider).put(ai::handlers::update_ai_provider),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/provider/test",
            post(ai::handlers::test_ai_provider),
        )
        .route("/api/v1/orgs/{org_id}/ai/chat", post(ai::handlers::chat))
        .route(
            "/api/v1/orgs/{org_id}/ai/explain/{rec_id}",
            post(ai::handlers::explain_recommendation),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/forecast",
            post(ai::handlers::forecast),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/anomalies",
            post(ai::handlers::anomalies),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/notes",
            get(ai::handlers::list_notes).post(ai::handlers::create_note),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/notes/search",
            post(ai::handlers::search_notes),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/copilot/chat",
            post(ai::handlers::chat_copilot),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/conversations",
            get(ai::handlers::list_conversations).post(ai::handlers::create_conversation),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/conversations/{conv_id}",
            delete(ai::handlers::delete_conversation),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/conversations/{conv_id}/messages",
            get(ai::handlers::list_conversation_messages),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/anomalies/{event_id}/explain",
            post(ai::handlers::explain_anomaly),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/analysis-runs",
            get(ai::handlers::list_analysis_runs),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/resources/embed",
            post(ai::handlers::embed_resources),
        )
        .route(
            "/api/v1/orgs/{org_id}/ai/resources/search",
            get(ai::handlers::search_resources),
        )
}
