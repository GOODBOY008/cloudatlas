use axum::{
    extract::{Extension, State},
    Json,
};
use chrono::{Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use super::{
    dto::{AuthResponse, LoginRequest, RefreshRequest, RegisterRequest, UserResponse},
    models::User,
    service::{hash_password, make_slug, verify_password, Claims},
};

// ─── Register ────────────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/auth/register",
    request_body = RegisterRequest,
    responses(
        (status = 201, description = "User registered successfully", body = AuthResponse),
        (status = 409, description = "Email already registered"),
        (status = 422, description = "Validation error"),
    ),
    tag = "auth"
)]
pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> AppResult<(axum::http::StatusCode, Json<Value>)> {
    // Basic validation
    crate::utils::validate::email(&body.email).map_err(AppError::Validation)?;
    crate::utils::validate::password(&body.password).map_err(AppError::Validation)?;
    crate::utils::validate::name(&body.display_name, 100, "Display name").map_err(AppError::Validation)?;

    // Guard against duplicate email
    let existing = sqlx::query("SELECT id FROM users WHERE email = $1")
        .bind(&body.email)
        .fetch_optional(&state.db)
        .await?;

    if existing.is_some() {
        return Err(AppError::Conflict("Email already registered".into()));
    }

    let password_hash = hash_password(&body.password)?;
    let user_id = Uuid::new_v4();
    let now = Utc::now();
    let display_name = body.display_name.trim().to_string();

    let user = sqlx::query_as::<_, User>(
        r#"
        INSERT INTO users
            (id, email, display_name, password_hash, is_active, email_verified, created_at, updated_at)
        VALUES ($1, $2, $3, $4, true, false, $5, $5)
        RETURNING
            id, email, display_name, password_hash,
            is_active, email_verified, last_login_at,
            created_at, updated_at
        "#,
    )
    .bind(user_id)
    .bind(&body.email)
    .bind(&display_name)
    .bind(&password_hash)
    .bind(now)
    .fetch_one(&state.db)
    .await?;

    // Optionally bootstrap an organization for the new user
    if let Some(org_name) = body.organization_name.as_deref().filter(|s| !s.trim().is_empty()) {
        let org_id = Uuid::new_v4();
        let slug = make_slug(org_name);

        sqlx::query(
            r#"
            INSERT INTO organizations (id, name, slug, description, settings, created_at, updated_at)
            VALUES ($1, $2, $3, NULL, '{}'::jsonb, $4, $4)
            "#,
        )
        .bind(org_id)
        .bind(org_name.trim())
        .bind(&slug)
        .bind(now)
        .execute(&state.db)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO organization_members (id, organization_id, user_id, joined_at)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(org_id)
        .bind(user_id)
        .bind(now)
        .execute(&state.db)
        .await?;
    }

    let (access_token, refresh_token, expires_at) =
        issue_token_pair(&user.id, &user.email, &state)?;

    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, refresh_token, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(&refresh_token)
    .bind(expires_at)
    .bind(now)
    .execute(&state.db)
    .await?;

    let response = build_auth_response(&user, access_token, refresh_token, &state);
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "data": response })),
    ))
}

// ─── Login ────────────────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/auth/login",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Login successful", body = AuthResponse),
        (status = 401, description = "Invalid credentials"),
    ),
    tag = "auth"
)]
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> AppResult<Json<Value>> {
    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT id, email, display_name, password_hash,
               is_active, email_verified, last_login_at,
               created_at, updated_at
        FROM users
        WHERE email = $1
        "#,
    )
    .bind(&body.email)
    .fetch_optional(&state.db)
    .await?
    // Use a generic message to avoid user enumeration
    .ok_or_else(|| AppError::Unauthorized("Invalid email or password".into()))?;

    if !user.is_active {
        return Err(AppError::Unauthorized("Account is deactivated".into()));
    }

    if !verify_password(&body.password, &user.password_hash)? {
        return Err(AppError::Unauthorized("Invalid email or password".into()));
    }

    // TOTP two-factor (I5): when enabled, the code is mandatory.
    let totp_secret: Option<String> = sqlx::query_scalar(
        "SELECT totp_secret FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(None);
    if let Some(secret) = totp_secret.filter(|s| !s.is_empty()) {
        let code = body.totp_code.as_deref().unwrap_or("");
        if !crate::modules::auth::totp::verify_code(
            &secret,
            code,
            chrono::Utc::now().timestamp() as u64,
        ) {
            return Err(AppError::Unauthorized(
                "Two-factor code is required or invalid".into(),
            ));
        }
    }

    let now = Utc::now();

    sqlx::query("UPDATE users SET last_login_at = $1, updated_at = $1 WHERE id = $2")
        .bind(now)
        .bind(user.id)
        .execute(&state.db)
        .await?;

    let (access_token, refresh_token, expires_at) =
        issue_token_pair(&user.id, &user.email, &state)?;

    sqlx::query(
        r#"
        INSERT INTO sessions (id, user_id, refresh_token, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(&refresh_token)
    .bind(expires_at)
    .bind(now)
    .execute(&state.db)
    .await?;

    let response = build_auth_response(&user, access_token, refresh_token, &state);
    Ok(Json(json!({ "data": response })))
}

// ─── Me ──────────────────────────────────────────────────────────────────────

#[utoipa::path(
    get,
    path = "/api/v1/auth/me",
    responses(
        (status = 200, description = "Current user profile", body = UserResponse),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "auth"
)]
pub async fn me(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    let user = sqlx::query_as::<_, User>(
        r#"
        SELECT id, email, display_name, password_hash,
               is_active, email_verified, last_login_at,
               created_at, updated_at
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("User not found".into()))?;

    let response = UserResponse {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        created_at: user.created_at,
    };
    Ok(Json(json!({ "data": response })))
}

// ─── Refresh token ───────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/auth/refresh",
    request_body = RefreshRequest,
    responses(
        (status = 200, description = "New access token issued"),
        (status = 401, description = "Invalid, expired, or revoked refresh token"),
    ),
    tag = "auth"
)]
pub async fn refresh_token(
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> AppResult<Json<Value>> {
    // Cryptographically verify the JWT first
    let claims = Claims::verify_refresh(&body.refresh_token, &state.config.jwt_secret)?;

    // Confirm the session is valid (not revoked, not expired) in the database
    let session_exists = sqlx::query(
        r#"
        SELECT id FROM sessions
        WHERE refresh_token = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()
        "#,
    )
    .bind(&body.refresh_token)
    .fetch_optional(&state.db)
    .await?;

    if session_exists.is_none() {
        return Err(AppError::Unauthorized(
            "Refresh token is invalid, expired, or revoked".into(),
        ));
    }

    let user_id = claims.user_id()?;
    let access_claims =
        Claims::new_access(user_id, &claims.email, state.config.jwt_access_expiry);
    let access_token = access_claims.encode_token(&state.config.jwt_secret)?;

    Ok(Json(json!({
        "data": {
            "access_token": access_token,
            "token_type":   "Bearer",
            "expires_in":   state.config.jwt_access_expiry,
        }
    })))
}

// ─── Logout ──────────────────────────────────────────────────────────────────

#[utoipa::path(
    post,
    path = "/api/v1/auth/logout",
    request_body = RefreshRequest,
    responses(
        (status = 200, description = "Logged out successfully"),
        (status = 401, description = "Unauthorized"),
    ),
    security(("bearer_auth" = [])),
    tag = "auth"
)]
pub async fn logout(
    Extension(claims): Extension<Claims>,
    State(state): State<AppState>,
    Json(body): Json<RefreshRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;

    // Revoke only if the token actually belongs to this user
    sqlx::query(
        r#"
        UPDATE sessions
        SET revoked_at = NOW()
        WHERE refresh_token = $1
          AND user_id = $2
          AND revoked_at IS NULL
        "#,
    )
    .bind(&body.refresh_token)
    .bind(user_id)
    .execute(&state.db)
    .await?;

    Ok(Json(json!({ "data": { "message": "Logged out successfully" } })))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Mint a fresh access/refresh token pair. Returns (access_token, refresh_token, refresh_expires_at).
pub fn issue_token_pair(
    user_id: &Uuid,
    email: &str,
    state: &AppState,
) -> AppResult<(String, String, chrono::DateTime<Utc>)> {
    let access_claims =
        Claims::new_access(*user_id, email, state.config.jwt_access_expiry);
    let refresh_claims =
        Claims::new_refresh(*user_id, email, state.config.jwt_refresh_expiry);

    let access_token = access_claims.encode_token(&state.config.jwt_secret)?;
    let refresh_token = refresh_claims.encode_token(&state.config.jwt_secret)?;
    let expires_at = Utc::now() + Duration::seconds(state.config.jwt_refresh_expiry as i64);

    Ok((access_token, refresh_token, expires_at))
}

fn build_auth_response(
    user: &User,
    access_token: String,
    refresh_token: String,
    state: &AppState,
) -> AuthResponse {
    AuthResponse {
        access_token,
        refresh_token,
        token_type: "Bearer".into(),
        expires_in: state.config.jwt_access_expiry,
        user: UserResponse {
            id: user.id,
            email: user.email.clone(),
            display_name: user.display_name.clone(),
            created_at: user.created_at,
        },
    }
}

// ─── Password reset + email verification (product gap I3) ────────────────────

#[derive(Deserialize)]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct VerifyEmailRequest {
    pub token: String,
}

fn generate_auth_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash_auth_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

/// POST /auth/forgot-password — issue a reset token and email it (best-effort).
pub async fn forgot_password(
    State(state): State<AppState>,
    Json(req): Json<ForgotPasswordRequest>,
) -> AppResult<Json<Value>> {
    // Always 200 — do not leak which emails exist.
    let row = sqlx::query_as::<_, (uuid::Uuid, String)>(
        "SELECT id, email FROM users WHERE email = $1 AND is_active = true",
    )
    .bind(&req.email)
    .fetch_optional(&state.db)
    .await?;

    if let Some((user_id, email)) = row {
        let token = generate_auth_token();
        let _ = sqlx::query(
            r#"INSERT INTO password_resets (user_id, kind, token_hash, expires_at)
               VALUES ($1, 'password', $2, NOW() + INTERVAL '1 hour')"#,
        )
        .bind(user_id)
        .bind(hash_auth_token(&token))
        .execute(&state.db)
        .await;

        let _ = crate::utils::email::send_email(
            &state,
            &email,
            "CloudAtlas password reset",
            &format!(
                "Reset your CloudAtlas password with this link:\n\n{}/reset-password?token={}\n\nIt expires in 1 hour.",
                state.config.app_url.as_deref().unwrap_or("http://localhost:5173"),
                token
            ),
        )
        .await;
    }

    Ok(Json(json!({ "data": { "message": "If that email exists, a reset link has been sent" } })))
}

/// POST /auth/reset-password — validate token, set the new password.
pub async fn reset_password(
    State(state): State<AppState>,
    Json(req): Json<ResetPasswordRequest>,
) -> AppResult<Json<Value>> {
    crate::utils::validate::password(&req.password).map_err(AppError::Validation)?;

    let token_hash = hash_auth_token(&req.token);
    let row = sqlx::query(
        r#"SELECT id, user_id FROM password_resets
           WHERE token_hash = $1 AND kind = 'password' AND used_at IS NULL
             AND expires_at > NOW()"#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Validation("Reset token is invalid or expired".into()))?;

    let reset_id: uuid::Uuid = row.get("id");
    let user_id: uuid::Uuid = row.get("user_id");

    let new_hash = crate::modules::auth::service::hash_password(&req.password)?;
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(new_hash)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE password_resets SET used_at = NOW() WHERE id = $1")
        .bind(reset_id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "data": { "message": "Password updated" } })))
}

/// POST /auth/verify-email — confirm the email address.
pub async fn verify_email(
    State(state): State<AppState>,
    Json(req): Json<VerifyEmailRequest>,
) -> AppResult<Json<Value>> {
    let token_hash = hash_auth_token(&req.token);
    let row = sqlx::query(
        r#"SELECT id, user_id FROM password_resets
           WHERE token_hash = $1 AND kind = 'email_verify' AND used_at IS NULL
             AND expires_at > NOW()"#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::Validation("Verification token is invalid or expired".into()))?;

    let reset_id: uuid::Uuid = row.get("id");
    let user_id: uuid::Uuid = row.get("user_id");

    sqlx::query("UPDATE users SET email_verified = true WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE password_resets SET used_at = NOW() WHERE id = $1")
        .bind(reset_id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "data": { "message": "Email verified" } })))
}

/// POST /auth/send-verification — (re)issue an email verification token.
pub async fn send_verification_email(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(_): Json<serde_json::Value>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT email FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let token = generate_auth_token();
    let _ = sqlx::query(
        r#"INSERT INTO password_resets (user_id, kind, token_hash, expires_at)
           VALUES ($1, 'email_verify', $2, NOW() + INTERVAL '24 hours')"#,
    )
    .bind(user_id)
    .bind(hash_auth_token(&token))
    .execute(&state.db)
    .await;

    let _ = crate::utils::email::send_email(
        &state,
        &row.0,
        "Verify your CloudAtlas email",
        &format!(
            "Confirm your email with this link:\n\n{}/verify-email?token={}",
            state.config.app_url.as_deref().unwrap_or("http://localhost:5173"),
            token
        ),
    )
    .await;

    Ok(Json(json!({ "data": { "message": "Verification email sent" } })))
}

// ─── TOTP two-factor (product gap I5) ────────────────────────────────────────

#[derive(Deserialize)]
pub struct TwoFactorRequest {
    pub password: Option<String>,
    pub code: Option<String>,
}

/// POST /auth/2fa/enroll — generate a TOTP secret (password required).
pub async fn enroll_2fa(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<TwoFactorRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    verify_user_password(&state, user_id, req.password.as_deref().unwrap_or("")).await?;

    let row = sqlx::query_as::<_, (String,)>(
        "SELECT email FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let secret = crate::modules::auth::totp::generate_secret();
    let uri = crate::modules::auth::totp::otpauth_uri(&secret, &row.0, "CloudAtlas");

    Ok(Json(json!({
        "data": {
            "secret": secret,
            "otpauth_url": uri,
            "message": "Scan with an authenticator app, then verify with POST /auth/2fa/verify",
        }
    })))
}

/// POST /auth/2fa/verify — activate TOTP after confirming a valid code.
pub async fn verify_2fa(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<TwoFactorRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    let secret = req
        .password
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation("Secret is required (from enroll)".into()))?;

    let code = req.code.as_deref().unwrap_or("");
    if !crate::modules::auth::totp::verify_code(secret, code, chrono::Utc::now().timestamp() as u64) {
        return Err(AppError::Validation("Invalid TOTP code".into()));
    }

    sqlx::query("UPDATE users SET totp_secret = $2 WHERE id = $1")
        .bind(user_id)
        .bind(secret)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "data": { "message": "Two-factor authentication enabled" } })))
}

/// POST /auth/2fa/disable — turn TOTP off (password required).
pub async fn disable_2fa(
    State(state): State<AppState>,
    Extension(claims): Extension<Claims>,
    Json(req): Json<TwoFactorRequest>,
) -> AppResult<Json<Value>> {
    let user_id = claims.user_id()?;
    verify_user_password(&state, user_id, req.password.as_deref().unwrap_or("")).await?;

    sqlx::query("UPDATE users SET totp_secret = NULL WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;

    Ok(Json(json!({ "data": { "message": "Two-factor authentication disabled" } })))
}

async fn verify_user_password(state: &AppState, user_id: uuid::Uuid, password: &str) -> AppResult<()> {
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT password_hash FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    if !crate::modules::auth::service::verify_password(password, &row.0)? {
        return Err(AppError::Validation("Password is incorrect".into()));
    }
    Ok(())
}
