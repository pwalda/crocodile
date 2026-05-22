//! Server identity keypair load/persist.
//!
//! Every coordination server has a long-lived ed25519 keypair. The
//! public half derives the [`ServerId`]; the private half signs every
//! [`SignedServerStatement`] the server emits. Clients store the public
//! key after first contact (TOFU) and use it to verify cached
//! statements during the 48h offline window.
//!
//! The key file format is intentionally trivial — 32 raw bytes of
//! ed25519 seed. The file is created with mode 0600 on first launch.

use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use anyhow::{Context, Result};
use rand::rngs::OsRng;
use rand::RngCore;

use crocodile_protocol::ids::ServerId;
use crocodile_protocol::keys::{
    server_id_from_public_key, IdentityKeypair, IdentityPublicKey, Signature,
};

/// Long-lived server identity.
#[derive(Debug)]
pub struct ServerIdentity {
    keypair: IdentityKeypair,
    server_id: ServerId,
}

impl ServerIdentity {
    /// Loads the identity from `path`. If the file does not exist,
    /// generates a fresh keypair and writes it with mode 0600.
    pub fn load_or_generate(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => {
                let seed: [u8; 32] = bytes
                    .as_slice()
                    .try_into()
                    .with_context(|| format!("server identity at {path:?} is not 32 bytes"))?;
                Ok(Self::from_seed(seed))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::warn!(?path, "no server identity file; generating new keypair");
                let mut seed = [0u8; 32];
                OsRng.fill_bytes(&mut seed);

                if let Some(parent) = path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent).with_context(|| {
                            format!("creating parent dir for server identity {path:?}")
                        })?;
                    }
                }

                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(path)
                    .with_context(|| format!("creating server identity file at {path:?}"))?;
                f.write_all(&seed)
                    .with_context(|| format!("writing server identity to {path:?}"))?;
                Ok(Self::from_seed(seed))
            }
            Err(e) => Err(e).with_context(|| format!("reading server identity at {path:?}")),
        }
    }

    /// Construct from a raw 32-byte seed. Mostly useful in tests.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let keypair = IdentityKeypair::from_seed(seed);
        let server_id = server_id_from_public_key(&keypair.public_key());
        Self {
            keypair,
            server_id,
        }
    }

    /// Server's stable identifier.
    pub fn server_id(&self) -> ServerId {
        self.server_id
    }

    /// Public half of the server identity key.
    pub fn public_key(&self) -> IdentityPublicKey {
        self.keypair.public_key()
    }

    /// Sign an arbitrary byte payload (typically the canonical signing
    /// input of a [`crocodile_protocol::envelope::SignedServerStatement`]).
    pub fn sign(&self, message: &[u8]) -> Signature {
        self.keypair.sign(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generates_and_reloads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity.key");

        let a = ServerIdentity::load_or_generate(&path).unwrap();
        let b = ServerIdentity::load_or_generate(&path).unwrap();
        assert_eq!(a.server_id(), b.server_id());
        assert_eq!(a.public_key(), b.public_key());
    }

    #[test]
    fn rejects_truncated_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity.key");
        std::fs::write(&path, [1u8; 10]).unwrap();
        let result = ServerIdentity::load_or_generate(&path);
        assert!(result.is_err());
    }
}
