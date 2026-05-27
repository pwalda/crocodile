//! Error types for the MLS wrapper.

use thiserror::Error;

/// Result alias.
pub type Result<T, E = MlsError> = std::result::Result<T, E>;

/// Errors produced by the MLS wrapper.
#[derive(Debug, Error)]
pub enum MlsError {
    /// Underlying openmls operation failed. The string carries the
    /// upstream message; we don't preserve the typed error because
    /// openmls's error types are many and shift across releases.
    #[error("openmls error: {0}")]
    OpenMls(String),

    /// TLS-codec encode/decode failure (openmls wire formats use the
    /// TLS presentation language).
    #[error("tls codec: {0}")]
    TlsCodec(String),

    /// Wrong wire framing — e.g. application message expected but a
    /// handshake message arrived.
    #[error("unexpected message kind: {0}")]
    UnexpectedMessage(&'static str),

    /// The signing identity isn't loaded in the provider's storage.
    #[error("identity not loaded")]
    IdentityMissing,
}

impl<E: std::fmt::Display> From<openmls::group::AddMembersError<E>> for MlsError {
    fn from(e: openmls::group::AddMembersError<E>) -> Self {
        MlsError::OpenMls(e.to_string())
    }
}
