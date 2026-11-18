//! Routing contracts exercise the actual Axum composition without a running DB.

use super::{build_router, protected_routes};
use crate::{config::Config, state::AppState};
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use std::collections::BTreeSet;
use tower::ServiceExt;

fn state() -> AppState {
    // Keep the pool lazy: any accidental DB access makes these tests fail rather
    // than silently relying on a developer's running services or credentials.
    let database_url = "postgres://unused:unused@127.0.0.1:1/unused";
    let db = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(100))
        .connect_lazy(database_url)
        .expect("valid test DB URL");
    AppState::new(
        db,
        Config {
            app_name: "CloudAtlas".into(),
            app_env: "test".into(),
            host: "127.0.0.1".into(),
            port: 8080,
            database_url: database_url.into(),
            db_max_connections: 1,
            db_min_connections: 0,
            db_idle_timeout_secs: 30,
            db_max_lifetime_secs: 60,
            db_acquire_timeout_secs: 1,
            jwt_secret: "routing-tests-secret-not-for-production".into(),
            jwt_access_expiry: 3600,
            jwt_refresh_expiry: 86400,
            encryption_key: "0".repeat(64),
            scheduler_enabled: false,
            scheduler_tick: 60,
            cloud_mock_enabled: false,
            cors_origins: vec!["http://localhost:3000".into()],
            metrics_enabled: true,
            rate_limit_max_requests: 1000,
            rate_limit_window_secs: 60,
            smtp_host: None,
            smtp_port: 587,
            smtp_username: None,
            smtp_password: None,
            smtp_from: None,
            ai_enabled: false,
            openai_api_key: None,
            openai_model: "unused".into(),
            openai_embedding_model: "unused".into(),
            sentry_dsn: None,
            redis_url: None,
            app_url: None,
            retention_months: 24,
            oidc_issuer: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_redirect_url: None,
        },
    )
}

async fn request(app: &Router, method: Method, path: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .expect("valid request"),
        )
        .await
        .expect("router responds")
}

#[tokio::test]
async fn all_domains_share_the_authentication_boundary() {
    let app = build_router(state());
    // Cover read/write methods, legacy non-org-prefixed routes, and endpoints
    // supplied by each domain. Requests must stop before handler/DB execution.
    for (method, path) in [
        (Method::GET, "/api/v1/auth/me"),
        (Method::POST, "/api/v1/auth/logout"),
        (Method::GET, "/api/v1/organizations"),
        (Method::PUT, "/api/v1/organizations/test"),
        (Method::GET, "/api/v1/orgs/test/cloud-accounts"),
        (Method::POST, "/api/v1/orgs/test/cloud-accounts/test/sync"),
        (Method::GET, "/api/v1/orgs/test/jobs"),
        (Method::PATCH, "/api/v1/orgs/test/resources/test/tags"),
        (Method::GET, "/api/v1/orgs/test/k8s/summary"),
        (Method::GET, "/api/v1/orgs/test/expenses/summary"),
        (Method::GET, "/api/v1/orgs/test/data-flow"),
        (Method::PATCH, "/api/v1/orgs/test/pools/test/parent"),
        (Method::DELETE, "/api/v1/cost-centers/test"),
        (Method::PUT, "/api/v1/business-capabilities/test"),
        (Method::POST, "/api/v1/orgs/test/billing/import"),
        (Method::GET, "/api/v1/orgs/test/bi-exports"),
        (Method::GET, "/api/v1/orgs/test/cis/search"),
        (Method::POST, "/api/v1/orgs/test/cis/batch-delete"),
        (
            Method::DELETE,
            "/api/v1/orgs/test/field-templates/test/unbind",
        ),
        (Method::POST, "/api/v1/orgs/test/compliance/run"),
        (Method::GET, "/api/v1/orgs/test/external-cmdb/test/logs"),
        (Method::POST, "/api/v1/orgs/test/recommendations/run"),
        (Method::POST, "/api/v1/orgs/test/alerts/evaluate"),
        (Method::GET, "/api/v1/orgs/test/constraints"),
        (Method::POST, "/api/v1/orgs/test/assignment-rules/apply"),
        (
            Method::POST,
            "/api/v1/orgs/test/shared-environments/test/book",
        ),
        (Method::GET, "/api/v1/orgs/test/tagging/coverage"),
        (Method::GET, "/api/v1/orgs/test/webhooks"),
        (Method::POST, "/api/v1/orgs/test/integrations/test/test"),
        (Method::POST, "/api/v1/orgs/test/ai/copilot/chat"),
        (Method::GET, "/api/v1/orgs/test/api-keys"),
        (Method::PATCH, "/api/v1/orgs/test/notifications/test/read"),
    ] {
        let response = request(&app, method.clone(), path).await;
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
}

#[tokio::test]
async fn account_actions_authenticate_before_extracting_claims() {
    let state = state();
    let token = crate::modules::auth::service::Claims::new_access(
        uuid::Uuid::new_v4(),
        "routing-test@example.com",
        60,
    )
    .encode_token(&state.config.jwt_secret)
    .expect("test access token");
    let app = build_router(state);
    for path in [
        "/api/v1/auth/2fa/enroll",
        "/api/v1/auth/2fa/verify",
        "/api/v1/auth/2fa/disable",
        "/api/v1/auth/send-verification",
        "/api/v1/auth/accept-invite",
    ] {
        assert_eq!(
            request(&app, Method::POST, path).await.status(),
            StatusCode::UNAUTHORIZED,
            "missing token: {path}"
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Claims extraction now succeeds. The missing JSON is rejected next,
        // before DB access; a public route would return a missing-extension 500.
        assert_eq!(
            response.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "valid token: {path}"
        );
    }
}

#[tokio::test]
async fn domain_merges_preserve_methods_and_static_route_precedence() {
    // OPTIONS reaches Axum's method fallback without executing any handler.
    // Inspect Allow before global CORS/auth: these layers intentionally answer
    // OPTIONS differently. Static paths must not resolve to an ID route.
    let app = protected_routes().with_state(state());
    for (path, methods) in [
        ("/api/v1/organizations", "GET,HEAD,POST"),
        (
            "/api/v1/orgs/test/cloud-accounts/test",
            "GET,HEAD,PUT,DELETE",
        ),
        ("/api/v1/orgs/test/expenses/summary", "GET,HEAD"),
        ("/api/v1/orgs/test/pools/budget-matrix", "GET,HEAD"),
        ("/api/v1/orgs/test/pools/test", "GET,HEAD,PUT,DELETE"),
        ("/api/v1/orgs/test/cis/search", "GET,HEAD"),
        ("/api/v1/orgs/test/cis/batch-update", "POST"),
        ("/api/v1/orgs/test/cis/test", "GET,HEAD,PUT,DELETE"),
        ("/api/v1/orgs/test/ci-association-kinds", "GET,HEAD,POST"),
        (
            "/api/v1/orgs/test/recommendations/checklist",
            "GET,HEAD,PATCH",
        ),
        ("/api/v1/orgs/test/alerts/evaluate", "POST"),
        ("/api/v1/orgs/test/integrations/test", "PUT,DELETE"),
        ("/api/v1/orgs/test/ai/notes/search", "POST"),
        ("/api/v1/orgs/test/ai/provider", "GET,HEAD,PUT"),
        ("/api/v1/orgs/test/exchange-rates", "GET,HEAD,PUT"),
        ("/api/v1/orgs/test/jobs/test/cancel", "POST"),
    ] {
        let response = request(&app, Method::OPTIONS, path).await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED, "{path}");
        let allowed = response
            .headers()
            .get("allow")
            .expect("Allow header")
            .to_str()
            .unwrap();
        let actual: BTreeSet<_> = allowed.split(',').map(str::trim).collect();
        let expected: BTreeSet<_> = methods.split(',').collect();
        assert_eq!(actual, expected, "{path}");
    }
}

#[tokio::test]
async fn public_health_metrics_and_openapi_remain_accessible() {
    let app = build_router(state());
    for path in ["/health", "/metrics", "/api-docs/openapi.json"] {
        let response = request(&app, Method::GET, path).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    }
    let response = request(&app, Method::GET, "/api-docs/openapi.json").await;
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let doc: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc["info"]["title"], "CloudAtlas API");
    assert!(doc["paths"]["/api/v1/orgs/{org_id}/data-flow"]["get"].is_object());
    assert_eq!(
        request(&app, Method::GET, "/not-an-endpoint")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    // Missing JSON is rejected by the public handler extractor, not by auth.
    assert_eq!(
        request(&app, Method::POST, "/api/v1/auth/login")
            .await
            .status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
}
