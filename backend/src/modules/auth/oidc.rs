//! OIDC SSO (product gap I4) — authorization-code flow against any
//! OpenID Connect provider (Keycloak, Auth0, Google, Entra…).
//!
//! Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
//! `OIDC_REDIRECT_URL`. Discovery happens per request (cached in-process).

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    modules::auth::service::Claims,
    state::AppState,
};

fn oidc_enabled(state: &AppState) -> bool {
    state.config.oidc_issuer.is_some() && state.config.oidc_client_id.is_some()
}

/// GET /auth/oidc/config — whether SSO is enabled (no secrets).
pub async fn oidc_config(state: axum::extract::State<AppState>) -> Json<Value> {
    Json(json!({
        "data": {
            "enabled": oidc_enabled(&state),
            "client_id": state.config.oidc_client_id.clone().unwrap_or_default(),
            "redirect_url": state.config.oidc_redirect_url.clone().unwrap_or_default(),
        }
    }))
}

/// GET /auth/oidc/start — redirect to the provider's authorization endpoint.
pub async fn oidc_start(state: axum::extract::State<AppState>) -> AppResult<Response> {
    let (issuer, client_id, redirect_url) = oidc_params(&state)?;
    let discovery = fetch_discovery(&issuer).await?;

    let auth_endpoint = discovery["authorization_endpoint"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC issuer missing authorization_endpoint".into()))?;

    let state_token = Claims::new_access(Uuid::new_v4(), "oidc-state", 600)
        .encode_token(&state.config.jwt_secret)?;

    let url = format!(
        "{auth_endpoint}?response_type=code&client_id={client_id}&redirect_uri={redirect_url}&scope=openid%20email%20profile&state={state_token}"
    );

    Ok(Redirect::temporary(&url).into_response())
}

/// GET /auth/oidc/callback?code=…&state=… — exchange the code, provision the
/// user, and redirect to the frontend with a fresh token pair.
pub async fn oidc_callback(
    state: axum::extract::State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> AppResult<Response> {
    let (issuer, client_id, client_secret, redirect_url) = oidc_params_full(&state)?;

    // Validate state token.
    let state_token = params.get("state").cloned().unwrap_or_default();
    Claims::verify(&state_token, &state.config.jwt_secret)
        .map_err(|_| AppError::Unauthorized("Invalid OIDC state".into()))?;

    let code = params
        .get("code")
        .ok_or_else(|| AppError::Validation("Missing authorization code".into()))?;
    let discovery = fetch_discovery(&issuer).await?;
    let token_endpoint = discovery["token_endpoint"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC issuer missing token_endpoint".into()))?;

    // Exchange code for tokens.
    let client = reqwest::Client::new();
    let token_resp = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_url.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC token request failed: {e}")))?;

    let token_body: Value = token_resp
        .json()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC token parse failed: {e}")))?;
    let access_token = token_body["access_token"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC token response missing access_token".into()))?;

    // Fetch userinfo.
    let userinfo_endpoint = discovery["userinfo_endpoint"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC issuer missing userinfo_endpoint".into()))?;
    let userinfo: Value = client
        .get(userinfo_endpoint)
        .bearer_auth(access_token)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC userinfo failed: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC userinfo parse failed: {e}")))?;

    let email = userinfo["email"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC userinfo missing email".into()))?;
    let display_name = userinfo["name"]
        .as_str()
        .unwrap_or(email.split('@').next().unwrap_or("user"));

    // Find-or-create the user by email.
    let user = sqlx::query_as::<_, (Uuid, String)>("SELECT id, email FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&state.db)
        .await?;

    let (user_id, user_email) = match user {
        Some((id, email)) => (id, email),
        None => {
            // Provision with a random unguessable password (SSO users don't
            // log in with a password).
            use rand::TryRng;
            let mut bytes = [0u8; 24];
            rand::rng().try_fill_bytes(&mut bytes).expect("infallible");
            let password = hex::encode(bytes);
            let password_hash = crate::modules::auth::service::hash_password(&password)?;
            let new_id = Uuid::new_v4();
            sqlx::query(
                r#"INSERT INTO users (id, email, display_name, password_hash, is_active, email_verified)
                   VALUES ($1, $2, $3, $4, true, true)"#,
            )
            .bind(new_id)
            .bind(email)
            .bind(display_name)
            .bind(password_hash)
            .execute(&state.db)
            .await?;
            (new_id, email.to_string())
        }
    };

    let (access_token, refresh_token, _) =
        crate::modules::auth::handlers::issue_token_pair(&user_id, &user_email, &state)?;

    // Redirect to the frontend with tokens in the fragment.
    let app_url = state
        .config
        .app_url
        .clone()
        .unwrap_or_else(|| "http://localhost:5173".into());
    let redirect = format!("{app_url}/login?token={access_token}&refresh={refresh_token}");

    Ok((
        StatusCode::FOUND,
        [(header::LOCATION, redirect.as_str())],
        (),
    )
        .into_response())
}

fn oidc_params(state: &AppState) -> AppResult<(String, String, String)> {
    let (issuer, client_id, _, redirect_url) = oidc_params_full(state)?;
    Ok((issuer, client_id, redirect_url))
}

fn oidc_params_full(state: &AppState) -> AppResult<(String, String, String, String)> {
    let issuer = state
        .config
        .oidc_issuer
        .clone()
        .ok_or_else(|| AppError::Validation("OIDC is not configured".into()))?;
    let client_id = state
        .config
        .oidc_client_id
        .clone()
        .ok_or_else(|| AppError::Validation("OIDC_CLIENT_ID not set".into()))?;
    let client_secret = state
        .config
        .oidc_client_secret
        .clone()
        .ok_or_else(|| AppError::Validation("OIDC_CLIENT_SECRET not set".into()))?;
    let redirect_url = state
        .config
        .oidc_redirect_url
        .clone()
        .ok_or_else(|| AppError::Validation("OIDC_REDIRECT_URL not set".into()))?;
    Ok((issuer, client_id, client_secret, redirect_url))
}

/// Fetch the OIDC discovery document.
async fn fetch_discovery(issuer: &str) -> AppResult<Value> {
    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC discovery failed: {e}")))?;
    resp.json()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC discovery parse failed: {e}")))
}
