use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub app_name:           String,
    pub app_env:            String,
    pub host:               String,
    pub port:               u16,
    pub database_url:       String,
    pub db_max_connections: u32,
    pub db_min_connections: u32,
    pub db_idle_timeout_secs: u64,
    pub db_max_lifetime_secs: u64,
    pub db_acquire_timeout_secs: u64,
    pub jwt_secret:         String,
    pub jwt_access_expiry:  u64,
    pub jwt_refresh_expiry: u64,
    pub encryption_key:     String,
    pub scheduler_enabled:  bool,
    pub scheduler_tick:     u64,
    pub cloud_mock_enabled: bool,
    pub cors_origins:           Vec<String>,
    pub metrics_enabled:        bool,
    pub rate_limit_max_requests: u32,
    pub rate_limit_window_secs:  u64,
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub smtp_from: Option<String>,
    pub ai_enabled: bool,
    pub openai_api_key: Option<String>,
    pub openai_model: String,
    pub openai_embedding_model: String,
    pub sentry_dsn: Option<String>,
    pub redis_url: Option<String>,
    pub app_url: Option<String>,
    pub retention_months: i64,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Ok(Config {
            app_name: env_str("APP_NAME", "CloudAtlas"),
            app_env:  env_str("APP_ENV",  "development"),
            host:     env_str("APP_HOST", "0.0.0.0"),
            port:     env_u16("APP_PORT", 8080)?,

            database_url:       require_env("DATABASE_URL")
                .context("DATABASE_URL is required")?,
            db_max_connections: env_u32("DATABASE_MAX_CONNECTIONS", 20),
            db_min_connections: env_u32("DATABASE_MIN_CONNECTIONS", 2),
            db_idle_timeout_secs: env_u64("DATABASE_IDLE_TIMEOUT_SECS", 300),
            db_max_lifetime_secs: env_u64("DATABASE_MAX_LIFETIME_SECS", 1800),
            db_acquire_timeout_secs: env_u64("DATABASE_ACQUIRE_TIMEOUT_SECS", 30),

            jwt_secret:         require_env("JWT_SECRET")
                .context("JWT_SECRET is required")?,
            jwt_access_expiry:  env_u64("JWT_ACCESS_TOKEN_EXPIRY_SECS", 3600),
            jwt_refresh_expiry: env_u64("JWT_REFRESH_TOKEN_EXPIRY_SECS", 2_592_000),

            encryption_key: env_str(
                "ENCRYPTION_KEY",
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),

            scheduler_enabled: env_bool("SCHEDULER_ENABLED", true),
            scheduler_tick:    env_u64("SCHEDULER_TICK_SECS", 60),

            cloud_mock_enabled: env_bool("CLOUD_MOCK_ENABLED", false),

            cors_origins: env_str("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173")
                .split(',')
                .map(str::trim)
                .map(String::from)
                .collect(),

            metrics_enabled: env_bool("METRICS_ENABLED", true),

            rate_limit_max_requests: env_u32("RATE_LIMIT_MAX_REQUESTS", 120),
            rate_limit_window_secs:  env_u64("RATE_LIMIT_WINDOW_SECS", 60),

            smtp_host: opt_env("SMTP_HOST"),
            smtp_port: env_u16("SMTP_PORT", 587)?,
            smtp_username: opt_env("SMTP_USERNAME"),
            smtp_password: opt_env("SMTP_PASSWORD"),
            smtp_from: opt_env("SMTP_FROM"),

            ai_enabled: env_bool("AI_ENABLED", false),
            openai_api_key: opt_env("OPENAI_API_KEY"),
            openai_model: env_str("OPENAI_MODEL", "gpt-4o-mini"),
            openai_embedding_model: env_str("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),

            sentry_dsn: opt_env("SENTRY_DSN"),
            redis_url: opt_env("REDIS_URL"),
            app_url: opt_env("APP_URL"),
            retention_months: env_i64("RETENTION_MONTHS", 24),
            oidc_issuer: opt_env("OIDC_ISSUER"),
            oidc_client_id: opt_env("OIDC_CLIENT_ID"),
            oidc_client_secret: opt_env("OIDC_CLIENT_SECRET"),
            oidc_redirect_url: opt_env("OIDC_REDIRECT_URL"),
        })
    }
}

fn require_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn opt_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_u16(key: &str, default: u16) -> Result<u16> {
    match std::env::var(key) {
        Ok(v) => v.parse().with_context(|| format!("{key} must be a valid u16")),
        Err(_) => Ok(default),
    }
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_i64(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| matches!(v.to_lowercase().as_str(), "true" | "1" | "yes"))
        .unwrap_or(default)
}
