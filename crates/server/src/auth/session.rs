//! Session token issuance and validation.
//!
//! Tokens are 32 random bytes, base64url-encoded for transport. The DB
//! stores only `SHA-256(token)`, so even a full DB read does not
//! disclose any valid token. Lookup is by hash.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Length of the underlying random token in bytes (before encoding).
pub const TOKEN_BYTES: usize = 32;

/// An opaque, base64url-encoded session token. The exact string sent
/// to and received from clients.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToken(pub String);

impl SessionToken {
    /// Generate a fresh random token.
    pub fn generate() -> Self {
        let mut bytes = [0u8; TOKEN_BYTES];
        OsRng.fill_bytes(&mut bytes);
        Self(URL_SAFE_NO_PAD.encode(bytes))
    }

    /// Returns the SHA-256 hash of the encoded token, suitable for the
    /// `sessions.token_hash` column.
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.0.as_bytes());
        hasher.finalize().into()
    }

    /// Parses a token from a string. Currently a thin wrapper; left as
    /// a function so future validation (length, charset) can be added
    /// in one place.
    pub fn parse(s: &str) -> Option<Self> {
        // Decoded length will be ~TOKEN_BYTES (base64url-no-pad of 32
        // bytes is 43 chars). Accept any non-empty string for now; the
        // hash-match check is the real authority.
        if s.is_empty() {
            None
        } else {
            Some(Self(s.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_produces_distinct_tokens() {
        let a = SessionToken::generate();
        let b = SessionToken::generate();
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_deterministic() {
        let t = SessionToken("fixed-string".into());
        assert_eq!(t.hash(), t.hash());
    }

    #[test]
    fn parse_rejects_empty() {
        assert!(SessionToken::parse("").is_none());
    }
}
