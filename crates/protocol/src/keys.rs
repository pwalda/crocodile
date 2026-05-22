//! Cryptographic identity and signature types.
//!
//! Two key roles, both ed25519:
//!
//! - **Identity key** — long-lived per user. Signs device keys to bind them
//!   to the user. Verified out-of-band via safety numbers (see `ARCHITECTURE.md`
//!   §3).
//! - **Device key** — per device. Signs all peer-to-peer messages and is
//!   bound to a user by the identity key's signature.
//!
//! The same ed25519 primitive is used for both; the distinction is purely
//! semantic and reflected in the newtype wrappers.

use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey, SIGNATURE_LENGTH};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{Error, Result};
use crate::ids::{DeviceId, ServerId, UserId};

/// Public half of an identity key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityPublicKey(pub [u8; 32]);

/// Public half of a device key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePublicKey(pub [u8; 32]);

/// An ed25519 signature (64 bytes on the wire).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Signature(pub [u8; SIGNATURE_LENGTH]);

impl std::fmt::Debug for Signature {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Signature({}…)", hex::encode(&self.0[..8]))
    }
}

// Manual serde impls so the signature serialises as a single byte sequence
// rather than 64 individual u8 elements (which serde's array derive would
// produce). Postcard encodes byte sequences with a length prefix; that's
// fine and what server-side parsers expect.
impl Serialize for Signature {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for Signature {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Vis;
        impl<'de> serde::de::Visitor<'de> for Vis {
            type Value = Signature;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a 64-byte ed25519 signature")
            }
            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> std::result::Result<Signature, E> {
                let arr: [u8; SIGNATURE_LENGTH] = v
                    .try_into()
                    .map_err(|_| E::invalid_length(v.len(), &self))?;
                Ok(Signature(arr))
            }
        }
        d.deserialize_bytes(Vis)
    }
}

/// Convenience: derives a [`UserId`] from an [`IdentityPublicKey`].
/// `UserId = BLAKE3(identity_public_key_bytes)`.
pub fn user_id_from_public_key(pk: &IdentityPublicKey) -> UserId {
    let hash = blake3::hash(&pk.0);
    UserId::from_bytes(*hash.as_bytes())
}

/// Convenience: derives a [`DeviceId`] from a [`DevicePublicKey`].
pub fn device_id_from_public_key(pk: &DevicePublicKey) -> DeviceId {
    let hash = blake3::hash(&pk.0);
    DeviceId::from_bytes(*hash.as_bytes())
}

/// Convenience: derives a [`ServerId`] from a server's [`IdentityPublicKey`].
/// `ServerId = BLAKE3(identity_public_key_bytes)` — same derivation as
/// [`UserId`], differing only in the wrapper newtype.
pub fn server_id_from_public_key(pk: &IdentityPublicKey) -> ServerId {
    let hash = blake3::hash(&pk.0);
    ServerId::from_bytes(*hash.as_bytes())
}

/// A keypair used as an identity key. Wraps an ed25519 signing key.
#[derive(Debug)]
pub struct IdentityKeypair(SigningKey);

impl IdentityKeypair {
    /// Generates a fresh identity keypair from a cryptographic RNG.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        Self(SigningKey::generate(rng))
    }

    /// Reconstruct from raw 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }

    /// Returns the public half.
    pub fn public_key(&self) -> IdentityPublicKey {
        IdentityPublicKey(self.0.verifying_key().to_bytes())
    }

    /// Signs an arbitrary byte payload (usually a serialised device-binding
    /// statement or other identity-attestation message).
    pub fn sign(&self, message: &[u8]) -> Signature {
        Signature(self.0.sign(message).to_bytes())
    }
}

/// A keypair used as a device key.
#[derive(Debug)]
pub struct DeviceKeypair(SigningKey);

impl DeviceKeypair {
    /// Generates a fresh device keypair.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        Self(SigningKey::generate(rng))
    }

    /// Reconstruct from raw 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self(SigningKey::from_bytes(&seed))
    }

    /// Returns the public half.
    pub fn public_key(&self) -> DevicePublicKey {
        DevicePublicKey(self.0.verifying_key().to_bytes())
    }

    /// Signs an arbitrary byte payload.
    pub fn sign(&self, message: &[u8]) -> Signature {
        Signature(self.0.sign(message).to_bytes())
    }
}

/// Verifies a signature over `message` using an identity public key.
pub fn verify_identity_signature(
    pk: &IdentityPublicKey,
    message: &[u8],
    signature: &Signature,
) -> Result<()> {
    let vk = VerifyingKey::from_bytes(&pk.0)?;
    let sig = ed25519_dalek::Signature::from_bytes(&signature.0);
    vk.verify(message, &sig).map_err(|_| Error::InvalidSignature)
}

/// Verifies a signature over `message` using a device public key.
pub fn verify_device_signature(
    pk: &DevicePublicKey,
    message: &[u8],
    signature: &Signature,
) -> Result<()> {
    let vk = VerifyingKey::from_bytes(&pk.0)?;
    let sig = ed25519_dalek::Signature::from_bytes(&signature.0);
    vk.verify(message, &sig).map_err(|_| Error::InvalidSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    #[test]
    fn identity_sign_and_verify_roundtrips() {
        let kp = IdentityKeypair::generate(&mut OsRng);
        let msg = b"hello crocodile";
        let sig = kp.sign(msg);
        verify_identity_signature(&kp.public_key(), msg, &sig).unwrap();
    }

    #[test]
    fn device_sign_and_verify_roundtrips() {
        let kp = DeviceKeypair::generate(&mut OsRng);
        let msg = b"device statement";
        let sig = kp.sign(msg);
        verify_device_signature(&kp.public_key(), msg, &sig).unwrap();
    }

    #[test]
    fn tampered_message_fails_verification() {
        let kp = IdentityKeypair::generate(&mut OsRng);
        let sig = kp.sign(b"original");
        let result = verify_identity_signature(&kp.public_key(), b"tampered", &sig);
        assert!(matches!(result, Err(Error::InvalidSignature)));
    }

    #[test]
    fn user_id_is_blake3_of_public_key() {
        let pk = IdentityPublicKey([42; 32]);
        let expected = blake3::hash(&pk.0);
        let derived = user_id_from_public_key(&pk);
        assert_eq!(derived.as_bytes(), expected.as_bytes());
    }

    #[test]
    fn signatures_roundtrip_through_postcard() {
        let kp = DeviceKeypair::generate(&mut OsRng);
        let sig = kp.sign(b"x");
        let bytes = postcard::to_stdvec(&sig).unwrap();
        let decoded: Signature = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(sig, decoded);
    }
}
