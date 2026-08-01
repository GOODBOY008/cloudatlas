use axum::{
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Fixed-window rate limiter keyed by client IP.
///
/// Default: in-memory window map (single-instance). When `REDIS_URL` is set,
/// counters live in Redis (INCR + EXPIRE) so multiple instances share one
/// limit (roadmap G8).
#[derive(Clone, Debug)]
pub struct RateLimiter {
    state: Arc<Mutex<LimiterState>>,
    window: Duration,
    max_requests: u32,
    redis_url: Option<String>,
}

#[derive(Default, Debug)]
struct LimiterState {
    windows: HashMap<String, (Instant, u32)>,
}

impl RateLimiter {
    pub fn new(max_requests: u32, window: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(LimiterState::default())),
            window,
            max_requests: max_requests.max(1),
            redis_url: None,
        }
    }

    /// Attach a shared Redis store (multi-instance mode, G8).
    pub fn with_redis(mut self, url: &str) -> Self {
        self.redis_url = Some(url.to_string());
        self
    }

    /// Returns true if the key may proceed, false if over the limit.
    pub fn check(&self, key: &str) -> bool {
        if let Some(url) = &self.redis_url {
            return self.check_redis(key, url);
        }
        self.check_memory(key)
    }

    fn check_memory(&self, key: &str) -> bool {
        let mut state = match self.state.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let entry = state.windows.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) > self.window {
            // New window: reset counter and start counting from this request.
            *entry = (now, 1);
            true
        } else if entry.1 >= self.max_requests {
            false
        } else {
            entry.1 += 1;
            true
        }
    }

    /// Redis fixed window: key `rl:<key>` with TTL = window; INCR and check.
    /// Falls back to in-memory when Redis is unreachable (fail-open on infra
    /// errors, still bounded by the local limiter? no — local fallback would
    /// double count; instead log and allow).
    fn check_redis(&self, key: &str, url: &str) -> bool {
        let rt = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return self.check_memory(key),
        };
        let max = self.max_requests;
        let window_secs = self.window.as_secs().max(1);

        rt.block_on(async move {
            let client = match redis::Client::open(url) {
                Ok(c) => c,
                Err(_) => return true,
            };
            let mut conn = match client.get_multiplexed_async_connection().await {
                Ok(c) => c,
                Err(_) => return true,
            };
            let redis_key = format!("rl:{key}");
            let count: i64 = match redis::cmd("INCR").arg(&redis_key).query_async(&mut conn).await {
                Ok(c) => c,
                Err(_) => return true,
            };
            if count == 1 {
                let _: Result<(), _> = redis::cmd("EXPIRE")
                    .arg(&redis_key)
                    .arg(window_secs)
                    .query_async(&mut conn)
                    .await;
            }
            count <= max as i64
        })
    }
}

/// Extract the best-effort client IP from forwarding headers (nginx sets
/// X-Forwarded-For / X-Real-IP). Falls back to "unknown" when absent.
fn client_key(headers: &HeaderMap) -> String {
    if let Some(v) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
    {
        return v.trim().to_string();
    }
    if let Some(v) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        return v.trim().to_string();
    }
    "unknown".to_string()
}

/// Health/metrics endpoints are exempt so monitoring probes and the e2e
/// suites' frequent readiness polls are never throttled.
fn is_rate_limit_exempt(path: &str) -> bool {
    path == "/health" || path == "/health/ready" || path == "/metrics"
}

/// Axum middleware: reject requests over the configured per-IP rate limit
/// with HTTP 429.
pub async fn rate_limit_middleware(
    State(limiter): State<RateLimiter>,
    headers: HeaderMap,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();
    if is_rate_limit_exempt(path) || limiter.check(&client_key(&headers)) {
        next.run(req).await
    } else {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": "rate limit exceeded",
                "message": "Too many requests — slow down and try again later",
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_allows_up_to_max_then_rejects() {
        let limiter = RateLimiter::new(3, Duration::from_secs(60));
        assert!(limiter.check("1.2.3.4"));
        assert!(limiter.check("1.2.3.4"));
        assert!(limiter.check("1.2.3.4"));
        assert!(!limiter.check("1.2.3.4")); // 4th request in window — rejected
        // Different key is unaffected
        assert!(limiter.check("5.6.7.8"));
    }

    #[test]
    fn limiter_resets_after_window() {
        let limiter = RateLimiter::new(2, Duration::from_millis(30));
        assert!(limiter.check("1.2.3.4"));
        assert!(limiter.check("1.2.3.4"));
        assert!(!limiter.check("1.2.3.4"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(limiter.check("1.2.3.4")); // new window
    }

    #[test]
    fn client_key_prefers_forwarded_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        assert_eq!(client_key(&headers), "203.0.113.9");

        let mut headers2 = HeaderMap::new();
        headers2.insert("x-real-ip", "198.51.100.7".parse().unwrap());
        assert_eq!(client_key(&headers2), "198.51.100.7");

        assert_eq!(client_key(&HeaderMap::new()), "unknown");
    }

    #[test]
    fn health_and_metrics_paths_are_exempt() {
        for path in ["/health", "/health/ready", "/metrics"] {
            assert!(is_rate_limit_exempt(path), "{path} should be exempt");
        }
    }

    #[test]
    fn api_and_subpaths_are_not_exempt() {
        // Health lives OUTSIDE /api/v1 — inside it must not be exempt.
        for path in ["/api/v1/health", "/healthx", "/metrics/foo", "/api/v1/cis"] {
            assert!(!is_rate_limit_exempt(path), "{path} should NOT be exempt");
        }
    }
}
