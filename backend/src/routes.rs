//! Application composition root: domain routers and cross-cutting middleware.

use axum::{middleware, Router};
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    request_id::{MakeRequestUuid, SetRequestIdLayer},
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{
    metrics::metrics_middleware, middleware::auth::auth_middleware,
    middleware::rate_limit::rate_limit_middleware, middleware::rbac_middleware::rbac_middleware,
    middleware::security_headers::security_headers_middleware, modules::api_keys, state::AppState,
};

use self::openapi::ApiDoc;

mod ai;
mod cmdb;
mod finops;
mod governance;
mod identity;
mod integrations;
mod inventory;
mod openapi;
mod public;

#[cfg(test)]
mod tests;

fn protected_routes() -> Router<AppState> {
    Router::new()
        .merge(identity::router())
        .merge(inventory::router())
        .merge(finops::router())
        .merge(cmdb::router())
        .merge(governance::router())
        .merge(integrations::router())
        .merge(ai::router())
}

pub fn build_router(state: AppState) -> Router {
    // CORS — restricted to the origins configured via CORS_ALLOWED_ORIGINS.
    let origins: Vec<axum::http::HeaderValue> = state
        .config
        .cors_origins
        .iter()
        .filter_map(|o| axum::http::HeaderValue::from_str(o).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(Any)
        .allow_headers(Any);

    let public = public::router();

    // Merge domain routes BEFORE applying the shared security boundary.
    // Domain routers must not install authentication or duplicate global layers.
    let protected = protected_routes()
        // auth runs FIRST (outer), then rbac reads the injected claims (inner).
        // api_key middleware is outermost: it authenticates ca_ tokens and
        // injects claims so auth_middleware passes them through.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rbac_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            api_keys::middleware::api_key_middleware,
        ));

    // OpenAPI docs
    let openapi = Router::new()
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()));

    // Capture state pieces before `state` is moved into the router.
    let rate_limiter = state.rate_limiter.clone();
    let security_state = state.clone();
    let metrics_handle = state.metrics.clone();

    // Request-id is attached BEFORE the trace span is created so the span
    // (and every log line inside it) carries the id end-to-end.
    let trace = TraceLayer::new_for_http().make_span_with(
        |request: &axum::http::Request<axum::body::Body>| {
            let request_id = request
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown");
            tracing::info_span!(
                "http_request",
                method = %request.method(),
                uri = %request.uri(),
                request_id = %request_id,
            )
        },
    );

    Router::new()
        .merge(public)
        .merge(protected)
        .merge(openapi)
        .with_state(state)
        .layer(trace)
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(60),
        ))
        .layer(middleware::from_fn_with_state(
            rate_limiter,
            rate_limit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            security_state,
            security_headers_middleware,
        ))
        // 2 MiB request body ceiling for JSON APIs.
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            metrics_handle,
            metrics_middleware,
        ))
        .layer(cors)
}
