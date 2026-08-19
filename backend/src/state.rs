use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::metrics::Metrics;
use crate::middleware::rate_limit::RateLimiter;

#[derive(Clone, Debug)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub rate_limiter: RateLimiter,
    pub metrics: Metrics,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        let mut rate_limiter = RateLimiter::new(
            config.rate_limit_max_requests,
            std::time::Duration::from_secs(config.rate_limit_window_secs),
        );
        if let Some(redis_url) = &config.redis_url {
            rate_limiter = rate_limiter.with_redis(redis_url);
        }
        AppState {
            db,
            config: Arc::new(config),
            rate_limiter,
            metrics: Metrics::new(),
        }
    }
}
