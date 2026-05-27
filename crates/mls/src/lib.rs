//! MLS integration for Crocodile.
//!
//! Wraps `openmls` to expose a small, focused API that the rest of the
//! codebase can call without learning the entire `openmls` surface.
//! Concrete types are deliberately *not* hidden behind a trait yet —
//! there is exactly one backend (openmls), and pre-trait-ing an
//! abstraction that has never been exercised by a second
//! implementation tends to bake in the wrong shape.
//!
//! What's covered in milestone 4 (the only consumer at this point):
//!
//! - [`Identity`]: an MLS credential + signature keypair held by a
//!   single device. Generated once per device.
//! - [`KeyPackage`]: a publishable key-package that lets others add us
//!   to their groups.
//! - [`Group`]: a created or joined group; supports add_member,
//!   process_commit, encrypt, decrypt.
//!
//! Membership changes (remove, rekey) and durable state persistence
//! land in later milestones. The current state uses openmls's in-
//! memory provider — process restart loses MLS state. That's fine for
//! milestone 4 (two-peer in-process demo) and will be replaced before
//! milestone 7 (server-offline operation).

#![forbid(unsafe_code)]
#![warn(rust_2018_idioms, unreachable_pub)]

pub mod error;
pub mod group;
pub mod identity;
pub mod key_package;

pub use error::{MlsError, Result};
pub use group::Group;
pub use identity::Identity;
pub use key_package::KeyPackage;

use openmls::prelude::Ciphersuite;

/// The single ciphersuite Crocodile uses. Choosing one and pinning it
/// for v1 keeps the protocol simple; cross-suite negotiation can come
/// later if we ever need to. This suite aligns with our ed25519 device
/// keys at the protocol layer.
pub const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
