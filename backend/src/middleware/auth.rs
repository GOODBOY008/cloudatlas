use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};

use crate::{error::AppError, modules::auth::service::Claims, state::AppState};

pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    // API-key requests are authenticated by api_key_middleware (claims injected).
    if req.extensions().get::<Claims>().is_some() {
        return Ok(next.run(req).await);
    }

    let token = extract_bearer_token(req.headers())
        .ok_or_else(|| AppError::Unauthorized("Missing Authorization header".into()))?;

    let claims = Claims::verify(&token, &state.config.jwt_secret)?;

    // Inject claims into request extensions for handlers
    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}

fn extract_bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(String::from)
}
