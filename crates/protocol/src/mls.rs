//! MLS backend interface.
//!
//! This crate **does not** depend on `openmls` directly — that
//! integration lives in a separate crate (`crocodile-mls`, added in
//! milestone 4 when the two-peer voice call needs real round-trip
//! encryption). What lives here is:
//!
//! 1. The opaque wire types (`MlsCiphertext`, `MlsWelcome`,
//!    `MlsCommit`, `GroupEpoch`) — these appear in voice/text frames
//!    and peer control messages and must have stable wire formats.
//! 2. The [`MlsBackend`] trait that the rest of the codebase uses,
//!    plus the [`GroupState`] handle.
//!
//! Keeping the trait here means the server, client, and any test
//! harness can be written against a stable interface, with the
//! concrete openmls integration plugged in later. A stub
//! implementation is provided behind `cfg(test)` for unit-testing
//! consumers without pulling MLS in.

use serde::{Deserialize, Serialize};

use crate::ids::DeviceId;

/// Monotonic MLS group epoch. Bumped on every commit (add, remove,
/// rekey). Receivers retain keys for recent epochs so in-flight
/// frames during a rekey can still decrypt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[repr(transparent)]
pub struct GroupEpoch(pub u64);

/// Opaque MLS-encrypted application payload. The exact framing depends
/// on the openmls version we integrate against; from the protocol
/// crate's perspective it's a byte blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MlsCiphertext(pub Vec<u8>);

/// Opaque MLS welcome message used to admit a new member into a group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MlsWelcome(pub Vec<u8>);

/// Opaque MLS commit message used to advance group state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MlsCommit(pub Vec<u8>);

/// Handle for an MLS group held by the local device. The actual MLS
/// state machine is owned by the backend; this trait just gives a
/// minimal surface that callers can program against.
pub trait GroupState: Send {
    /// Current group epoch.
    fn epoch(&self) -> GroupEpoch;

    /// Returns the device IDs of the current member set, sorted.
    fn members(&self) -> Vec<DeviceId>;
}

/// MLS backend trait.
///
/// Methods are intentionally minimal: enough to support v1's voice +
/// text flows. The trait will grow in milestone 4 with proposal /
/// commit machinery and in milestone 8 with explicit application-
/// purpose tagging.
pub trait MlsBackend {
    /// Encrypts an application payload for the current group epoch.
    fn encrypt(&mut self, group: &mut dyn GroupState, payload: &[u8]) -> MlsCiphertext;

    /// Decrypts an application payload received for a given epoch.
    ///
    /// Returns `None` if the receiver does not retain keys for that
    /// epoch (i.e. message arrived too late after a rekey).
    fn decrypt(
        &mut self,
        group: &mut dyn GroupState,
        epoch: GroupEpoch,
        ciphertext: &MlsCiphertext,
    ) -> Option<Vec<u8>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_types_roundtrip() {
        let c = MlsCiphertext(vec![1, 2, 3]);
        let bytes = postcard::to_stdvec(&c).unwrap();
        let decoded: MlsCiphertext = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(c, decoded);

        let e = GroupEpoch(99);
        let bytes = postcard::to_stdvec(&e).unwrap();
        let decoded: GroupEpoch = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(e, decoded);
    }

    #[test]
    fn epoch_orders_naturally() {
        assert!(GroupEpoch(1) < GroupEpoch(2));
    }
}
