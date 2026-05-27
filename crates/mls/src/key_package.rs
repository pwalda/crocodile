//! Key packages — the unit of "I am willing to be added to a group."
//!
//! A peer publishes a key package; another peer fetches it and uses
//! it to add the publisher to a group, which produces an `MlsWelcome`
//! that returns to the publisher to actually instantiate group state.

use openmls::framing::MlsMessageOut;
use openmls::key_packages::{KeyPackage as OpenMlsKeyPackage, KeyPackageBundle, KeyPackageIn};
use openmls::versions::ProtocolVersion;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};

use crocodile_protocol::mls::MlsWelcome;

use crate::error::{MlsError, Result};
use crate::identity::Identity;
use crate::CIPHERSUITE;

/// A serializable key package ready to publish.
#[derive(Debug, Clone)]
pub struct KeyPackage {
    pub(crate) bytes: Vec<u8>,
}

impl KeyPackage {
    /// Generate a fresh key package for `identity`. The bundle's
    /// private state is persisted in `provider`'s storage so that
    /// when a Welcome comes back referencing this key package, we
    /// can join the group.
    pub fn generate(identity: &Identity, provider: &OpenMlsRustCrypto) -> Result<Self> {
        let bundle: KeyPackageBundle = OpenMlsKeyPackage::builder()
            .build(
                CIPHERSUITE,
                provider,
                &identity.signature_keys,
                identity.credential_with_key(),
            )
            .map_err(|e| MlsError::OpenMls(format!("build key package: {e:?}")))?;
        let kp: OpenMlsKeyPackage = bundle.key_package().clone();
        let bytes = kp
            .tls_serialize_detached()
            .map_err(|e| MlsError::TlsCodec(format!("kp serialize: {e:?}")))?;
        Ok(Self { bytes })
    }

    /// Raw bytes — what you'd hand to another peer over signaling.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Construct from bytes received from a peer. Validates the
    /// signature now (rather than at use time) so misuse surfaces
    /// where it happens.
    pub fn from_bytes(bytes: &[u8], provider: &OpenMlsRustCrypto) -> Result<Self> {
        let kp_in = KeyPackageIn::tls_deserialize(&mut &bytes[..])
            .map_err(|e| MlsError::TlsCodec(format!("kp parse: {e:?}")))?;
        let _: OpenMlsKeyPackage = kp_in
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("kp validate: {e:?}")))?;
        Ok(Self {
            bytes: bytes.to_vec(),
        })
    }

    /// Decode and re-validate, returning the live openmls type. Used
    /// internally when handing to `add_members`.
    pub(crate) fn into_openmls(self, provider: &OpenMlsRustCrypto) -> Result<OpenMlsKeyPackage> {
        let kp_in = KeyPackageIn::tls_deserialize(&mut &self.bytes[..])
            .map_err(|e| MlsError::TlsCodec(format!("kp parse: {e:?}")))?;
        kp_in
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| MlsError::OpenMls(format!("kp validate: {e:?}")))
    }
}

/// Serialize an MlsMessageOut (Welcome) into our protocol wire type.
pub(crate) fn welcome_to_protocol(msg: MlsMessageOut) -> Result<MlsWelcome> {
    let bytes = msg
        .to_bytes()
        .map_err(|e| MlsError::TlsCodec(format!("welcome serialize: {e:?}")))?;
    Ok(MlsWelcome(bytes))
}
