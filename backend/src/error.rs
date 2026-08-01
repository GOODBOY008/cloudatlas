use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    /// Conflict carrying a structured `details` payload (e.g. the id of the
    /// already-active job when a duplicate trigger is rejected).
    #[error("Conflict: {0}")]
    ConflictWithDetails(String, serde_json::Value),

    /// Fully structured error with a custom machine-readable code (e.g.
    /// `ERR_VALIDATION`, `ERR_INVALID_TRANSITION`, `ERR_DUPLICATE`) and a
    /// `details` payload. Used by CMDB validation paths whose callers need
    /// per-attribute / per-constraint diagnostics.
    #[error("{2}: {1}")]
    Structured(axum::http::StatusCode, String, String, serde_json::Value),

    #[error("Too many requests: {0}")]
    TooManyRequests(String),

    #[error("Cloud provider error: {0}")]
    Cloud(String),

    #[error("Not supported: {0}")]
    Unsupported(String),

    #[error("Database error")]
    Database(#[from] sqlx::Error),

    #[error("Internal error")]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Structured error logging: 5xx at ERROR, 4xx at WARN — every error is
        // traceable via the request_id attached to the active tracing span.
        let (status, code, message) = match &self {
            AppError::NotFound(msg) => {
                tracing::warn!(error = %msg, code = "NOT_FOUND", "request failed");
                (StatusCode::NOT_FOUND, "NOT_FOUND", msg.clone())
            }
            AppError::Unauthorized(msg) => {
                tracing::warn!(error = %msg, code = "UNAUTHORIZED", "request failed");
                (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", msg.clone())
            }
            AppError::Forbidden(msg) => {
                tracing::warn!(error = %msg, code = "FORBIDDEN", "request failed");
                (StatusCode::FORBIDDEN, "FORBIDDEN", msg.clone())
            }
            AppError::Validation(msg) => {
                tracing::warn!(error = %msg, code = "VALIDATION", "request failed");
                (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION", msg.clone())
            }
            AppError::Conflict(msg) => {
                tracing::warn!(error = %msg, code = "CONFLICT", "request failed");
                (StatusCode::CONFLICT, "CONFLICT", msg.clone())
            }
            AppError::ConflictWithDetails(msg, details) => {
                tracing::warn!(error = %msg, code = "CONFLICT", "request failed");
                return (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "error": {
                            "code":    "CONFLICT",
                            "message": msg,
                            "details": details,
                        }
                    })),
                )
                    .into_response();
            }
            AppError::Structured(status, code, msg, details) => {
                tracing::warn!(error = %msg, code = %code, "request failed");
                return (
                    *status,
                    Json(json!({
                        "error": {
                            "code":    code,
                            "message": msg,
                            "details": details,
                        }
                    })),
                )
                    .into_response();
            }
            AppError::TooManyRequests(msg) => {
                tracing::warn!(error = %msg, code = "TOO_MANY_REQUESTS", "request failed");
                (StatusCode::TOO_MANY_REQUESTS, "TOO_MANY_REQUESTS", msg.clone())
            }
            AppError::Cloud(msg) => {
                tracing::warn!(error = %msg, code = "CLOUD_ERROR", "cloud provider request failed");
                (StatusCode::BAD_GATEWAY, "CLOUD_ERROR", msg.clone())
            }
            AppError::Unsupported(msg) => {
                tracing::warn!(error = %msg, code = "UNSUPPORTED", "request failed");
                (StatusCode::NOT_IMPLEMENTED, "UNSUPPORTED", msg.clone())
            }
            AppError::Database(e) => {
                tracing::error!(error = %e, code = "DATABASE_ERROR", "request failed");
                sentry::capture_message(&format!("Database error: {e}"), sentry::Level::Error);
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", "A database error occurred".into())
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, code = "INTERNAL_ERROR", "request failed");
                sentry::capture_message(&format!("Internal error: {e}"), sentry::Level::Error);
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "An internal error occurred".into())
            }
        };

        (
            status,
            Json(json!({
                "error": {
                    "code":    code,
                    "message": message
                }
            })),
        )
            .into_response()
    }
}

// Convenience conversions
impl From<jsonwebtoken::errors::Error> for AppError {
    fn from(e: jsonwebtoken::errors::Error) -> Self {
        AppError::Unauthorized(format!("Invalid token: {e}"))
    }
}
