//! Integrations HTTP endpoints. Authentication is applied once by the parent router.

use crate::{
    modules::{integrations, webhook},
    state::AppState,
};
use axum::{
    routing::{delete, get, post, put},
    Router,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/orgs/{org_id}/webhooks",
            get(webhook::handlers::list_webhooks),
        )
        .route(
            "/api/v1/orgs/{org_id}/webhooks",
            post(webhook::handlers::create_webhook),
        )
        .route(
            "/api/v1/orgs/{org_id}/webhooks/{id}",
            put(webhook::handlers::update_webhook),
        )
        .route(
            "/api/v1/orgs/{org_id}/webhooks/{id}",
            delete(webhook::handlers::delete_webhook),
        )
        .route(
            "/api/v1/orgs/{org_id}/webhook-events",
            get(webhook::handlers::list_webhook_events),
        )
        .route(
            "/api/v1/orgs/{org_id}/integrations",
            get(integrations::handlers::list_integrations)
                .post(integrations::handlers::create_integration),
        )
        .route(
            "/api/v1/orgs/{org_id}/integrations/{id}",
            put(integrations::handlers::update_integration)
                .delete(integrations::handlers::delete_integration),
        )
        .route(
            "/api/v1/orgs/{org_id}/integrations/{id}/test",
            post(integrations::handlers::test_integration),
        )
}
