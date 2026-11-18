//! OIDC SSO (product gap I4) — authorization-code flow against any
//! OpenID Connect provider (Keycloak, Auth0, Google, Entra…).
//!
//! Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
//! `OIDC_REDIRECT_URL`. Serve the callback on the same public host as the SPA.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use rand::TryRng;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    config::Config,
    error::{AppError, AppResult},
    modules::auth::service::{hash_password, Claims},
    state::AppState,
};

const LOGIN_COOKIE: &str = "__Host-cloudatlas-oidc-login";
const SESSION_COOKIE: &str = "__Host-cloudatlas-oidc-session";
const LOGIN_LIFETIME_SECS: u64 = 600;

/// GET /auth/oidc/config — whether SSO is enabled (no secrets).
pub async fn oidc_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "data": {
            "enabled": Provider::from_config(&state.config).is_ok(),
            "client_id": state.config.oidc_client_id.clone().unwrap_or_default(),
            "redirect_url": state.config.oidc_redirect_url.clone().unwrap_or_default(),
        }
    }))
}

/// GET /auth/oidc/start — redirect to the provider's authorization endpoint.
pub async fn oidc_start(State(state): State<AppState>) -> AppResult<Response> {
    let provider = Provider::from_config(&state.config)?;
    let discovery = fetch_discovery(provider.issuer).await?;
    let auth_endpoint = discovery["authorization_endpoint"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC issuer missing authorization_endpoint".into()))?;
    let mut url = Url::parse(auth_endpoint)
        .map_err(|_| AppError::Cloud("Invalid OIDC authorization endpoint".into()))?;

    let login_state = random_secret()?;
    let browser_binding = random_secret()?;
    let code_verifier = random_secret()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", provider.client_id),
        ("redirect_uri", provider.redirect_url),
        ("scope", "openid email profile"),
        ("state", &login_state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);

    sqlx::query("DELETE FROM oidc_login_transactions WHERE expires_at <= NOW()")
        .execute(&state.db)
        .await?;
    sqlx::query(
        "INSERT INTO oidc_login_transactions (state_hash, browser_binding_hash, code_verifier, expires_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(secret_hash(&login_state))
    .bind(secret_hash(&browser_binding))
    .bind(code_verifier)
    .bind(Utc::now() + Duration::seconds(LOGIN_LIFETIME_SECS as i64))
    .execute(&state.db)
    .await?;

    let mut response = Redirect::temporary(url.as_str()).into_response();
    set_cookie(
        &mut response,
        LOGIN_COOKIE,
        &browser_binding,
        LOGIN_LIFETIME_SECS,
    )?;
    Ok(no_store(response))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: String,
    state: String,
}

/// Exchange the authorization code and establish a browser session.
pub async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CallbackQuery>,
) -> AppResult<Response> {
    let provider = Provider::from_config(&state.config)?;
    let browser_binding = cookie(&headers, LOGIN_COOKIE)
        .ok_or_else(|| AppError::Unauthorized("Invalid OIDC login transaction".into()))?;
    // Claim the transaction before exchanging the code, including under concurrent callbacks.
    let code_verifier = sqlx::query_scalar::<_, String>(
        "DELETE FROM oidc_login_transactions
         WHERE state_hash = $1 AND browser_binding_hash = $2 AND expires_at > clock_timestamp()
         RETURNING code_verifier",
    )
    .bind(secret_hash(&params.state))
    .bind(secret_hash(browser_binding))
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Unauthorized("Invalid or expired OIDC login transaction".into()))?;

    let discovery = fetch_discovery(provider.issuer).await?;
    let token_endpoint = discovery["token_endpoint"]
        .as_str()
        .ok_or_else(|| AppError::Cloud("OIDC issuer missing token_endpoint".into()))?;

    // Exchange code for tokens.
    let client = reqwest::Client::new();
    let token_resp = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", params.code.as_str()),
            ("redirect_uri", provider.redirect_url),
            ("client_id", provider.client_id),
            ("client_secret", provider.client_secret),
            ("code_verifier", code_verifier.as_str()),
        ])
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
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
        .and_then(reqwest::Response::error_for_status)
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

    let mut tx = state.db.begin().await?;
    let lookup = "SELECT id, is_active FROM users WHERE email = $1";
    let existing = sqlx::query_as::<_, (Uuid, bool)>(lookup)
        .bind(email)
        .fetch_optional(&mut *tx)
        .await?;

    let (user_id, active) = match existing {
        Some(user) => user,
        None => {
            sqlx::query(
                "INSERT INTO users (email, display_name, password_hash, is_active, email_verified)
                 VALUES ($1, $2, $3, true, true) ON CONFLICT (email) DO NOTHING",
            )
            .bind(email)
            .bind(display_name)
            .bind(hash_password(&random_secret()?)?)
            .execute(&mut *tx)
            .await?;
            sqlx::query_as::<_, (Uuid, bool)>(lookup)
                .bind(email)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    if !active {
        return Err(AppError::Unauthorized("Account is deactivated".into()));
    }

    let session_secret = random_secret()?;
    let max_age = state.config.jwt_refresh_expiry;
    // Reuse the session lifetime and revocation columns. Store only a digest of
    // the browser credential in the existing refresh-token slot.
    sqlx::query("INSERT INTO sessions (user_id, refresh_token, expires_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(secret_hash(&session_secret))
        .bind(Utc::now() + Duration::seconds(max_age as i64))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let mut response = Redirect::to(provider.completion_url.as_str()).into_response();
    set_cookie(&mut response, SESSION_COOKIE, &session_secret, max_age)?;
    set_cookie(&mut response, LOGIN_COOKIE, "", 0)?;
    Ok(no_store(response))
}

#[derive(Deserialize, ToSchema)]
pub struct OidcSessionRequest {
    /// The session already held by the tab. Omit only when completing sign-in.
    session_id: Option<Uuid>,
}

#[utoipa::path(
    post,
    path = "/api/v1/auth/oidc/session",
    request_body = OidcSessionRequest,
    responses(
        (status = 200, description = "Bearer access token for the browser session"),
        (status = 401, description = "Missing, expired, revoked or mismatched session"),
        (status = 403, description = "Cross-origin browser request"),
    ),
    tag = "auth"
)]
pub async fn oidc_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<OidcSessionRequest>,
) -> AppResult<Response> {
    ensure_same_origin(&headers)?;
    let unauthorized = || AppError::Unauthorized("SSO session is unavailable".into());
    let secret = cookie(&headers, SESSION_COOKIE).ok_or_else(unauthorized)?;
    let (session_id, user_id, email) = sqlx::query_as::<_, (Uuid, Uuid, String)>(
        "SELECT s.id, u.id, u.email FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.refresh_token = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
           AND ($2::uuid IS NULL OR s.id = $2) AND u.is_active",
    )
    .bind(secret_hash(secret))
    .bind(request.session_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(unauthorized)?;

    let expires_in = state.config.jwt_access_expiry;
    let access_token =
        Claims::new_access(user_id, &email, expires_in).encode_token(&state.config.jwt_secret)?;
    Ok(no_store(Json(json!({
        "data": { "session_id": session_id, "access_token": access_token, "expires_in": expires_in },
    })).into_response()))
}

#[derive(Deserialize, ToSchema)]
pub struct EndOidcSessionRequest {
    session_id: Uuid,
}

#[utoipa::path(
    delete,
    path = "/api/v1/auth/oidc/session",
    request_body = EndOidcSessionRequest,
    responses(
        (status = 204, description = "Browser session ended"),
        (status = 403, description = "Cross-origin browser request"),
    ),
    tag = "auth"
)]
pub async fn end_oidc_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<EndOidcSessionRequest>,
) -> AppResult<Response> {
    ensure_same_origin(&headers)?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Some(secret) = cookie(&headers, SESSION_COOKIE) {
        let updated = sqlx::query(
            "UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW())
             WHERE id = $1 AND refresh_token = $2",
        )
        .bind(request.session_id)
        .bind(secret_hash(secret))
        .execute(&state.db)
        .await?;
        // A tab for an older login cannot revoke or clear a newer login's cookie.
        if updated.rows_affected() != 0 {
            set_cookie(&mut response, SESSION_COOKIE, "", 0)?;
        }
    }
    Ok(no_store(response))
}

struct Provider<'a> {
    issuer: &'a str,
    client_id: &'a str,
    client_secret: &'a str,
    redirect_url: &'a str,
    completion_url: Url,
}

impl<'a> Provider<'a> {
    fn from_config(config: &'a Config) -> AppResult<Self> {
        let issuer = config
            .oidc_issuer
            .as_deref()
            .ok_or_else(|| AppError::Validation("OIDC is not configured".into()))?;
        let client_id = config
            .oidc_client_id
            .as_deref()
            .ok_or_else(|| AppError::Validation("OIDC_CLIENT_ID not set".into()))?;
        let client_secret = config
            .oidc_client_secret
            .as_deref()
            .ok_or_else(|| AppError::Validation("OIDC_CLIENT_SECRET not set".into()))?;
        let redirect_url = config
            .oidc_redirect_url
            .as_deref()
            .ok_or_else(|| AppError::Validation("OIDC_REDIRECT_URL not set".into()))?;
        let callback = Url::parse(redirect_url).map_err(|_| {
            AppError::Validation("OIDC_REDIRECT_URL must be an absolute URL".into())
        })?;
        let mut app_url = match config.app_url.as_deref() {
            Some(value) => Url::parse(value)
                .map_err(|_| AppError::Validation("APP_URL must be an absolute URL".into()))?,
            None => callback.clone(),
        };
        let loopback = app_url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if app_url.host_str().is_none()
            || app_url.host_str() != callback.host_str()
            || app_url.scheme() != callback.scheme()
            || (app_url.scheme() != "https" && !(app_url.scheme() == "http" && loopback))
        {
            return Err(AppError::Validation(
                "OIDC callback and app must share a public HTTPS host (HTTP allowed on loopback)"
                    .into(),
            ));
        }
        app_url.set_path("/auth/oidc/complete");
        app_url.set_query(None);
        app_url.set_fragment(None);
        Ok(Self {
            issuer,
            client_id,
            client_secret,
            redirect_url,
            completion_url: app_url,
        })
    }
}

fn random_secret() -> AppResult<String> {
    let mut bytes = [0; 32];
    rand::rng().try_fill_bytes(&mut bytes).map_err(|error| {
        AppError::Internal(anyhow::anyhow!("OIDC randomness unavailable: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn secret_hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find_map(|(key, value)| (key == name && !value.is_empty()).then_some(value))
}

fn set_cookie(response: &mut Response, name: &str, secret: &str, max_age: u64) -> AppResult<()> {
    let cookie =
        format!("{name}={secret}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax");
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|error| AppError::Internal(error.into()))?,
    );
    Ok(())
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn ensure_same_origin(headers: &HeaderMap) -> AppResult<()> {
    // The cookie endpoints require JSON and CORS does not allow credentials.
    // Fetch Metadata also rejects requests from browser siblings on the same site.
    if headers
        .get("sec-fetch-site")
        .is_some_and(|site| site != "same-origin")
    {
        return Err(AppError::Forbidden(
            "Cross-origin OIDC session request".into(),
        ));
    }
    Ok(())
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
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| AppError::Cloud(format!("OIDC discovery failed: {e}")))?;
    resp.json()
        .await
        .map_err(|e| AppError::Cloud(format!("OIDC discovery parse failed: {e}")))
}
