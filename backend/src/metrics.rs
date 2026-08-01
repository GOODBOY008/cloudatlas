//! Lightweight in-process request metrics for observability.
//!
//! Counts total requests, requests per HTTP status class, and errors; exposed
//! at `GET /metrics` (text/plain) when `METRICS_ENABLED=true`. Single-instance
//! in-memory counters — intentional, matching the PostgreSQL-only architecture.

use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

#[derive(Clone, Debug, Default)]
pub struct Metrics {
    inner: Arc<MetricsInner>,
}

#[derive(Debug)]
struct MetricsInner {
    total_requests: AtomicU64,
    total_errors: AtomicU64,
    status_counts: Mutex<HashMap<u16, u64>>,
    started_at: Instant,
}

impl Default for MetricsInner {
    fn default() -> Self {
        Self {
            total_requests: AtomicU64::new(0),
            total_errors: AtomicU64::new(0),
            status_counts: Mutex::new(HashMap::new()),
            started_at: Instant::now(),
        }
    }
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    fn record(&self, status: u16) {
        self.inner.total_requests.fetch_add(1, Ordering::Relaxed);
        if status >= 500 {
            self.inner.total_errors.fetch_add(1, Ordering::Relaxed);
        }
        if let Ok(mut counts) = self.inner.status_counts.lock() {
            *counts.entry(status).or_insert(0) += 1;
        }
    }

    /// Render Prometheus-style text exposition.
    pub fn render(&self) -> String {
        let inner = &self.inner;
        let mut out = String::new();
        out.push_str("# HELP cloudatlas_http_requests_total Total HTTP requests handled\n");
        out.push_str("# TYPE cloudatlas_http_requests_total counter\n");
        out.push_str(&format!(
            "cloudatlas_http_requests_total {}\n",
            inner.total_requests.load(Ordering::Relaxed)
        ));
        out.push_str("# HELP cloudatlas_http_errors_total HTTP 5xx responses\n");
        out.push_str("# TYPE cloudatlas_http_errors_total counter\n");
        out.push_str(&format!(
            "cloudatlas_http_errors_total {}\n",
            inner.total_errors.load(Ordering::Relaxed)
        ));
        out.push_str("# HELP cloudatlas_http_status_count Requests by HTTP status\n");
        out.push_str("# TYPE cloudatlas_http_status_count counter\n");
        if let Ok(counts) = inner.status_counts.lock() {
            let mut sorted: Vec<_> = counts.iter().collect();
            sorted.sort();
            for (status, count) in sorted {
                out.push_str(&format!(
                    "cloudatlas_http_status_count{{code=\"{status}\"}} {count}\n"
                ));
            }
        }
        out.push_str(&format!(
            "# HELP cloudatlas_uptime_seconds Process uptime\n# TYPE cloudatlas_uptime_seconds gauge\ncloudatlas_uptime_seconds {}\n",
            inner.started_at.elapsed().as_secs()
        ));
        out
    }
}

/// Middleware: record every request's response status.
pub async fn metrics_middleware(
    State(metrics): State<Metrics>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let response = next.run(req).await;
    metrics.record(response.status().as_u16());
    response
}

/// `GET /metrics` — plain-text counters. Returns 404 when metrics are disabled.
pub async fn metrics_handler(
    State(state): State<crate::state::AppState>,
) -> Response {
    if !state.config.metrics_enabled {
        return (StatusCode::NOT_FOUND, "metrics disabled").into_response();
    }
    (
        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(),
    )
        .into_response()
}

/// Health payload helper used by /metrics-json (debug convenience).
pub fn metrics_json(metrics: &Metrics) -> serde_json::Value {
    let mut status_counts = serde_json::Map::new();
    if let Ok(counts) = metrics.inner.status_counts.lock() {
        for (k, v) in counts.iter() {
            status_counts.insert(k.to_string(), json!(v));
        }
    }
    json!({
        "total_requests": metrics.inner.total_requests.load(Ordering::Relaxed),
        "total_errors": metrics.inner.total_errors.load(Ordering::Relaxed),
        "status_counts": status_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_accumulate_and_render() {
        let m = Metrics::new();
        m.record(200);
        m.record(200);
        m.record(500);
        m.record(404);

        let text = m.render();
        assert!(text.contains("cloudatlas_http_requests_total 4"));
        assert!(text.contains("cloudatlas_http_errors_total 1"));
        assert!(text.contains("code=\"200\"} 2"));
        assert!(text.contains("code=\"500\"} 1"));
        assert!(text.contains("cloudatlas_uptime_seconds"));
    }
}
