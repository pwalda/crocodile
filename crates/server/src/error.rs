//! HTTP-layer error type used by axum handlers.
//!
//! Server-internal errors (e.g. sqlx failures) are mapped to 500;
//! caller-driven errors (auth, validation, conflict) get appropriate
//! 4xx codes. Response bodies are tiny JSON `{ "error": "..." }`
//! payloads — clients shouldn't be doing case-analysis on the string.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// API-layer error.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Caller-supplied input was malformed or violates a constraint.
    #[error("bad request: {0}")]
    BadRequest(String),

    /// Request lacked or carried invalid auth credentials.
    #[error("unauthorized")]
    Unauthorized,

    /// Resource not found.
    #[error("not found")]
    NotFound,

    /// A uniqueness or state conflict (e.g. username taken).
    #[error("conflict: {0}")]
    Conflict(String),

    /// Internal server error — sqlx, IO, etc. Inner is logged but not
    /// surfaced to the client.
    #[error("internal error")]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, public_message) = match &self {
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".into()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".into()),
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            ApiError::Internal(e) => {
                tracing::error!(error = %e, "internal server error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
            }
        };
        (
            status,
            Json(ErrorBody {
                error: public_message,
            }),
        )
            .into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // Treat unique-constraint violations as 409 Conflict for ergonomics;
        // every other sqlx error is internal.
        if let sqlx::Error::Database(ref db) = e {
            if db.is_unique_violation() {
                return ApiError::Conflict(db.message().to_string());
            }
        }
        ApiError::Internal(e.into())
    }
}

/// Convenient Result alias for handlers.
pub type ApiResult<T> = std::result::Result<T, ApiError>;
