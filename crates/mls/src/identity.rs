//! A device's MLS-side identity: credential + signature keypair.
//!
//! Conceptually separate from the protocol-layer device key. The
//! protocol layer's device key signs *our* messages (peer signatures,
//! key-binding attestations). The MLS signature key signs *MLS's*
//! messages (handshake / framed plaintexts) inside the group. They
//! can share an algorithm (Ed25519) but are independent key material.
//!
//! v1 binding: each MLS credential carries the device id (32 bytes)
//! as its identity payload. So when openmls hands us a list of group
//! members, we can map them back to [`DeviceId`].

use openmls::prelude::{CredentialWithKey, SignatureScheme};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

use crocodile_protocol::ids::DeviceId;

use crate::error::{MlsError, Result};
use crate::CIPHERSUITE;

/// An MLS identity owned by a single device.
///
/// Wraps the openmls `SignatureKeyPair` plus the device id used as
/// the credential payload. The signature key is stored in the
/// provider's storage so subsequent operations on the same provider
/// can find it.
#[derive(Debug)]
pub struct Identity {
    pub(crate) device_id: DeviceId,
    pub(crate) signature_keys: SignatureKeyPair,
}

impl Identity {
    /// Generate a fresh MLS identity for a device and persist its
    /// signature key into the provider.
    pub fn generate(device_id: DeviceId, provider: &OpenMlsRustCrypto) -> Result<Self> {
        let signature_scheme: SignatureScheme = CIPHERSUITE.signature_algorithm();
        let signature_keys = SignatureKeyPair::new(signature_scheme)
            .map_err(|e| MlsError::OpenMls(format!("signature keypair gen: {e:?}")))?;
        signature_keys
            .store(provider.storage())
            .map_err(|e| MlsError::OpenMls(format!("store signature keys: {e:?}")))?;
        Ok(Self {
            device_id,
            signature_keys,
        })
    }

    /// The device this identity belongs to.
    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// Build a `CredentialWithKey` for use in openmls APIs.
    pub(crate) fn credential_with_key(&self) -> CredentialWithKey {
        use openmls::credentials::BasicCredential;
        let credential = BasicCredential::new(self.device_id.as_bytes().to_vec());
        CredentialWithKey {
            credential: credential.into(),
            signature_key: self.signature_keys.public().into(),
        }
    }
}
