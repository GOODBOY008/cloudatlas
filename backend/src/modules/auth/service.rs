use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,        // user_id
    pub jti: String,        // unique token ID (prevents duplicate sessions)
    pub email: String,
    pub exp: usize,
    pub iat: usize,
    pub token_type: String, // "access" or "refresh"
}

impl Claims {
    pub fn new_access(user_id: Uuid, email: &str, expiry_secs: u64) -> Self {
        let now = Utc::now();
        Claims {
            sub: user_id.to_string(),
            jti: Uuid::new_v4().to_string(),
            email: email.to_string(),
            iat: now.timestamp() as usize,
            exp: (now + Duration::seconds(expiry_secs as i64)).timestamp() as usize,
            token_type: "access".into(),
        }
    }

    pub fn new_refresh(user_id: Uuid, email: &str, expiry_secs: u64) -> Self {
        let now = Utc::now();
        Claims {
            sub: user_id.to_string(),
            jti: Uuid::new_v4().to_string(),
            email: email.to_string(),
            iat: now.timestamp() as usize,
            exp: (now + Duration::seconds(expiry_secs as i64)).timestamp() as usize,
            token_type: "refresh".into(),
        }
    }

    pub fn encode_token(&self, secret: &str) -> AppResult<String> {
        encode(
            &Header::default(),
            self,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .map_err(AppError::from)
    }

    /// Verify an access token and return its claims.
    pub fn verify(token: &str, secret: &str) -> AppResult<Self> {
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &Validation::new(Algorithm::HS256),
        )?;
        if data.claims.token_type != "access" {
            return Err(AppError::Unauthorized("Invalid token type".into()));
        }
        Ok(data.claims)
    }

    /// Verify a refresh token and return its claims.
    pub fn verify_refresh(token: &str, secret: &str) -> AppResult<Self> {
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &Validation::new(Algorithm::HS256),
        )?;
        if data.claims.token_type != "refresh" {
            return Err(AppError::Unauthorized("Invalid token type".into()));
        }
        Ok(data.claims)
    }

    pub fn user_id(&self) -> AppResult<Uuid> {
        Uuid::parse_str(&self.sub)
            .map_err(|_| AppError::Unauthorized("Invalid user_id in token".into()))
    }
}

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Password hashing failed: {e}")))
}

pub fn verify_password(password: &str, hash: &str) -> AppResult<bool> {
    let parsed = PasswordHash::new(hash)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Invalid password hash: {e}")))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// Convert a human-readable name into a URL-safe slug.
/// e.g. "My Cool Org!" → "my-cool-org"
pub fn make_slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}
