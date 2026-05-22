//! Shared error types for the protocol crate.

use thiserror::Error;

use crate::version::ProtocolVersion;

/// Result alias used throughout the crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Errors produced by protocol operations: serialisation, signature
/// verification, version checks, and structural validation.
#[derive(Debug, Error)]
pub enum Error {
    /// A versioned envelope carried a version this build doesn't speak.
    #[error("unsupported protocol version: got {got:?}, this build speaks {supported:?}")]
    UnsupportedVersion {
        /// Version that was received on the wire.
        got: ProtocolVersion,
        /// Version this build expects.
        supported: ProtocolVersion,
    },

    /// A signature failed verification.
    #[error("invalid signature")]
    InvalidSignature,

    /// A signed response or cached server statement has passed its
    /// expiry. See `ARCHITECTURE.md` §8 for the 48h cache rule.
    #[error("signed statement is expired: expired at {expired_at_unix_secs}, now {now_unix_secs}")]
    Expired {
        /// Unix seconds the statement expired at.
        expired_at_unix_secs: i64,
        /// Unix seconds at the time of the check.
        now_unix_secs: i64,
    },

    /// Postcard serialisation or deserialisation failed.
    #[error("wire format error: {0}")]
    Wire(#[from] postcard::Error),

    /// An ed25519 operation failed (key parsing, signing, verifying).
    #[error("ed25519 error: {0}")]
    Ed25519(#[from] ed25519_dalek::SignatureError),

    /// A structural invariant was violated (e.g. empty member list,
    /// chain hash mismatch, out-of-order sequence number).
    #[error("invalid structure: {0}")]
    InvalidStructure(&'static str),
}
