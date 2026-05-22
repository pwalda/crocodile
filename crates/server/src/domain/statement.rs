//! Helpers for constructing [`SignedServerStatement`] values.
//!
//! Centralised here so every cacheable response goes through the same
//! signing path and ttl handling — clients depend on `expires_at`
//! arithmetic being consistent.

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::keys::Signature;
use crocodile_protocol::time::UnixSeconds;

use crate::server_identity::ServerIdentity;

/// Sign a payload with the server's identity and produce a
/// [`SignedServerStatement`] wrapped with an explicit expiry.
///
/// `ttl_seconds` is added to "now" to compute `expires_at`. Pass the
/// configured statement TTL (default 48h per spec).
pub fn sign<T>(
    identity: &ServerIdentity,
    payload: T,
    ttl_seconds: i64,
) -> Result<SignedServerStatement<T>, crocodile_protocol::Error>
where
    T: serde::Serialize,
{
    sign_at(identity, payload, UnixSeconds::now(), ttl_seconds)
}

/// Like [`sign`] but takes an explicit `issued_at`. Used by tests so
/// timestamps are deterministic.
pub fn sign_at<T>(
    identity: &ServerIdentity,
    payload: T,
    issued_at: UnixSeconds,
    ttl_seconds: i64,
) -> Result<SignedServerStatement<T>, crocodile_protocol::Error>
where
    T: serde::Serialize,
{
    let expires_at = issued_at.plus_seconds(ttl_seconds);
    let mut stmt = SignedServerStatement {
        server_id: identity.server_id(),
        issued_at,
        expires_at,
        payload,
        signature: Signature([0; 64]),
    };
    let input = stmt.signing_input()?;
    stmt.signature = identity.sign(&input);
    Ok(stmt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::keys::IdentityPublicKey;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    struct Toy(u32, String);

    #[test]
    fn sign_at_produces_verifiable_statement() {
        let identity = ServerIdentity::from_seed([0xAA; 32]);
        let stmt = sign_at(&identity, Toy(42, "hi".into()), UnixSeconds(100), 60).unwrap();
        assert_eq!(stmt.issued_at, UnixSeconds(100));
        assert_eq!(stmt.expires_at, UnixSeconds(160));
        // Server's public key verifies the signature; we expose it via
        // ServerIdentity::public_key.
        let server_pk: IdentityPublicKey = identity.public_key();
        stmt.verify(&server_pk, UnixSeconds(120)).unwrap();
    }

    #[test]
    fn sign_rolls_expiry_forward_from_issue_time() {
        let identity = ServerIdentity::from_seed([0xBB; 32]);
        let stmt = sign_at(&identity, 1u32, UnixSeconds(1000), 48 * 3600).unwrap();
        assert_eq!(stmt.expires_at, UnixSeconds(1000 + 48 * 3600));
    }
}
