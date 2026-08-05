//! Signed wire envelopes.
//!
//! Two envelope shapes:
//!
//! - [`VersionedEnvelope`] — wraps any wire payload with the current
//!   protocol version. Used at the outermost layer of all wire messages.
//! - [`SignedServerStatement`] — coordination-server-signed payload with
//!   an explicit `expires_at`. Clients cache these and continue trusting
//!   them up to expiry (default 48h). See `ARCHITECTURE.md` §8.
//! - [`SignedPeerMessage`] — sender-device-signed payload exchanged between
//!   peers in a room. Carries sequence number + timestamp for replay /
//!   reorder defence.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::ids::{DeviceId, ServerId};
use crate::keys::{
    verify_device_signature, verify_identity_signature, DevicePublicKey, IdentityPublicKey,
    Signature,
};
use crate::time::{check_fresh, UnixSeconds};
use crate::version::{ProtocolVersion, PROTOCOL_VERSION};

/// Wire envelope that tags every message with the protocol version.
///
/// Encoded as `(version, payload)` by postcard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionedEnvelope<T> {
    /// Protocol version of the encoded payload.
    pub version: ProtocolVersion,
    /// The wire payload.
    pub payload: T,
}

impl<T> VersionedEnvelope<T> {
    /// Wraps a payload with the current protocol version.
    pub fn new(payload: T) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            payload,
        }
    }

    /// Returns the payload if the version matches this build's
    /// [`PROTOCOL_VERSION`], otherwise [`Error::UnsupportedVersion`].
    pub fn into_payload(self) -> Result<T> {
        if self.version == PROTOCOL_VERSION {
            Ok(self.payload)
        } else {
            Err(Error::UnsupportedVersion {
                got: self.version,
                supported: PROTOCOL_VERSION,
            })
        }
    }
}

/// A statement signed by a coordination server. Carries an explicit
/// expiry so clients can keep operating against cached copies for the
/// 48h offline window.
///
/// The signature covers the postcard-encoded `(server_id, issued_at,
/// expires_at, payload)` tuple. Constructing one requires the server's
/// signing key (held only on the server); this crate just defines the
/// wire shape and the verification path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedServerStatement<T> {
    /// Server that issued this statement.
    pub server_id: ServerId,
    /// Unix-seconds the statement was issued at.
    pub issued_at: UnixSeconds,
    /// Unix-seconds after which clients must refuse to use this.
    pub expires_at: UnixSeconds,
    /// The signed payload.
    pub payload: T,
    /// Server signature over `signing_input()`.
    pub signature: Signature,
}

impl<T: Serialize> SignedServerStatement<T> {
    /// Returns the canonical signing input (postcard-encoded tuple
    /// `(server_id, issued_at, expires_at, payload)`). Used both when
    /// signing on the server and verifying on clients.
    pub fn signing_input(&self) -> Result<Vec<u8>> {
        Ok(postcard::to_stdvec(&(
            &self.server_id,
            self.issued_at,
            self.expires_at,
            &self.payload,
        ))?)
    }

    /// Verifies the server signature and freshness. The caller supplies
    /// the server's identity public key (looked up by `server_id` out of
    /// band) and the current time.
    pub fn verify(&self, server_pk: &IdentityPublicKey, now: UnixSeconds) -> Result<()> {
        check_fresh(now, self.expires_at)?;
        let input = self.signing_input()?;
        verify_identity_signature(server_pk, &input, &self.signature)
    }
}

/// A peer-to-peer message signed by the sender's device key.
///
/// Includes a strictly increasing per-sender sequence number plus a
/// timestamp; receivers reject messages with sequence numbers <= the
/// last one accepted from that sender, defeating naive replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedPeerMessage<T> {
    /// Sending device.
    pub sender: DeviceId,
    /// Strictly increasing per-sender sequence number.
    pub seq: u64,
    /// Sender clock at send time (informational; receivers do not trust it
    /// for ordering — sequence number is authoritative).
    pub timestamp: UnixSeconds,
    /// The signed payload.
    pub payload: T,
    /// Device signature over `signing_input()`.
    pub signature: Signature,
}

impl<T: Serialize> SignedPeerMessage<T> {
    /// Canonical signing input.
    pub fn signing_input(&self) -> Result<Vec<u8>> {
        Ok(postcard::to_stdvec(&(
            &self.sender,
            self.seq,
            self.timestamp,
            &self.payload,
        ))?)
    }

    /// Verifies the device signature.
    pub fn verify(&self, sender_pk: &DevicePublicKey) -> Result<()> {
        let input = self.signing_input()?;
        verify_device_signature(sender_pk, &input, &self.signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{DeviceKeypair, IdentityKeypair};
    use rand::rngs::OsRng;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    struct DummyPayload {
        n: u32,
        s: String,
    }

    #[test]
    fn versioned_envelope_roundtrip() {
        let env = VersionedEnvelope::new(DummyPayload {
            n: 7,
            s: "hi".into(),
        });
        let bytes = postcard::to_stdvec(&env).unwrap();
        let decoded: VersionedEnvelope<DummyPayload> = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(env, decoded);
        assert_eq!(decoded.into_payload().unwrap().n, 7);
    }

    #[test]
    fn versioned_envelope_rejects_other_versions() {
        let env = VersionedEnvelope {
            version: ProtocolVersion(999),
            payload: 0u32,
        };
        match env.into_payload().unwrap_err() {
            Error::UnsupportedVersion { got, supported } => {
                assert_eq!(got, ProtocolVersion(999));
                assert_eq!(supported, PROTOCOL_VERSION);
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn signed_server_statement_verifies_in_window() {
        let server = IdentityKeypair::generate(&mut OsRng);
        let issued_at = UnixSeconds(1_000_000);
        let expires_at = UnixSeconds(1_000_000 + 48 * 3600);

        let payload = DummyPayload {
            n: 1,
            s: "ok".into(),
        };
        let mut stmt = SignedServerStatement {
            server_id: ServerId::from_bytes([1; 32]),
            issued_at,
            expires_at,
            payload,
            signature: Signature([0; 64]),
        };
        stmt.signature = server.sign(&stmt.signing_input().unwrap());

        // Within the window: ok.
        stmt.verify(&server.public_key(), UnixSeconds(1_000_100))
            .unwrap();
        // At exact expiry: still ok.
        stmt.verify(&server.public_key(), expires_at).unwrap();
        // Past expiry: rejected.
        let result = stmt.verify(&server.public_key(), expires_at.plus_seconds(1));
        assert!(matches!(result, Err(Error::Expired { .. })));
    }

    #[test]
    fn signed_server_statement_rejects_tampering() {
        let server = IdentityKeypair::generate(&mut OsRng);
        let mut stmt = SignedServerStatement {
            server_id: ServerId::from_bytes([2; 32]),
            issued_at: UnixSeconds(0),
            expires_at: UnixSeconds(i64::MAX / 2),
            payload: DummyPayload {
                n: 1,
                s: "a".into(),
            },
            signature: Signature([0; 64]),
        };
        stmt.signature = server.sign(&stmt.signing_input().unwrap());

        // Tamper after signing.
        stmt.payload.n = 2;
        let result = stmt.verify(&server.public_key(), UnixSeconds(1));
        assert!(matches!(result, Err(Error::InvalidSignature)));
    }

    #[test]
    fn signed_peer_message_roundtrip() {
        let device = DeviceKeypair::generate(&mut OsRng);
        let mut msg = SignedPeerMessage {
            sender: DeviceId::from_bytes([3; 32]),
            seq: 42,
            timestamp: UnixSeconds(123),
            payload: DummyPayload {
                n: 9,
                s: "peer".into(),
            },
            signature: Signature([0; 64]),
        };
        msg.signature = device.sign(&msg.signing_input().unwrap());

        msg.verify(&device.public_key()).unwrap();

        // Tamper.
        let mut tampered = msg.clone();
        tampered.seq = 99;
        assert!(matches!(
            tampered.verify(&device.public_key()),
            Err(Error::InvalidSignature)
        ));
    }
}
