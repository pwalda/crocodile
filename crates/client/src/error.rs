//! Shared error types for the client.

use thiserror::Error;

/// Convenient result alias.
pub type Result<T, E = ClientError> = std::result::Result<T, E>;

/// Errors raised by client operations.
#[derive(Debug, Error)]
pub enum ClientError {
    /// The cache layer could not be opened or queried.
    #[error("cache error: {0}")]
    Cache(#[from] CacheError),

    /// HTTP transport failure.
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    /// The coordination server returned a non-success status.
    #[error("coordination server error: {status} {body}")]
    ServerStatus {
        /// HTTP status code.
        status: u16,
        /// Response body for diagnostics (truncated).
        body: String,
    },

    /// Decoding a signed-statement response failed.
    #[error("wire format: {0}")]
    Wire(#[from] postcard::Error),

    /// Signature verification failed or the statement was expired.
    #[error("protocol error: {0}")]
    Protocol(#[from] crocodile_protocol::Error),

    /// WebSocket protocol failure. Boxed because tungstenite's error
    /// type is large (~136 bytes) and we don't want every `Result` in
    /// the crate to inherit that on its hot path. The `From` impl
    /// below auto-boxes so callers can still use `?` on a raw
    /// tungstenite error.
    #[error("ws error: {0}")]
    Ws(Box<tokio_tungstenite::tungstenite::Error>),

    /// QUIC transport failure (connect/listen/stream).
    #[error("quic error: {0}")]
    Quic(String),

    /// STUN binding failed.
    #[error("stun error: {0}")]
    Stun(String),

    /// I/O error.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Anything else from anyhow.
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl From<tokio_tungstenite::tungstenite::Error> for ClientError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        ClientError::Ws(Box::new(e))
    }
}

/// Errors specific to the local cache.
#[derive(Debug, Error)]
pub enum CacheError {
    /// SQL backend failure.
    #[error("sqlite: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// Wire-format error encoding or decoding cached blobs.
    #[error("wire: {0}")]
    Wire(#[from] postcard::Error),

    /// Migrations failed at open time.
    #[error("migration: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
}
