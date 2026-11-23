//! Unauthenticated endpoints: health, metrics, and authentication entry points.

use crate::metrics::metrics_handler;
use crate::{
    modules::{auth, health},
    state::AppState,
};
use axum::{
    routing::{get, post},
    Router,
};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health::liveness))
        .route("/health/ready", get(health::readiness))
        .route("/metrics", get(metrics_handler))
        .route("/api/v1/auth/register", post(auth::handlers::register))
        .route("/api/v1/auth/login", post(auth::handlers::login))
        .route("/api/v1/auth/refresh", post(auth::handlers::refresh_token))
        .route(
            "/api/v1/auth/forgot-password",
            post(auth::handlers::forgot_password),
        )
        .route(
            "/api/v1/auth/reset-password",
            post(auth::handlers::reset_password),
        )
        .route(
            "/api/v1/auth/verify-email",
            post(auth::handlers::verify_email),
        )
        .route("/api/v1/auth/oidc/config", get(auth::oidc::oidc_config))
        .route("/api/v1/auth/oidc/start", get(auth::oidc::oidc_start))
        .route("/api/v1/auth/oidc/callback", get(auth::oidc::oidc_callback))
        .route(
            "/api/v1/auth/oidc/session",
            post(auth::oidc::oidc_session).delete(auth::oidc::end_oidc_session),
        )
}
