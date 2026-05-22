//! Protocol version handling.
//!
//! Every wire message is wrapped in an [`envelope::VersionedEnvelope`] that
//! carries a [`ProtocolVersion`]. Receivers that don't recognise the version
//! must refuse the message rather than attempting partial parsing.

use serde::{Deserialize, Serialize};

/// Wire protocol version. Bumped on any breaking change to message formats,
/// signature schemes, hashing, or the MLS interface.
///
/// Increment on:
/// - Any change that alters bytes on the wire for an existing message kind.
/// - Removing a message kind.
/// - Changing semantics in a way that older peers would misinterpret.
///
/// Adding a new message kind under an existing version is permitted *iff*
/// older peers will reject it as unknown rather than misinterpret it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(transparent)]
pub struct ProtocolVersion(pub u16);

impl ProtocolVersion {
    /// Returns the raw version number.
    pub const fn get(self) -> u16 {
        self.0
    }
}

/// Current protocol version. v1 is pre-stability — breaking changes may
/// occur without version bumps until the first tagged release.
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion(1);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_one() {
        assert_eq!(PROTOCOL_VERSION.get(), 1);
    }

    #[test]
    fn version_roundtrips_through_postcard() {
        let v = ProtocolVersion(42);
        let bytes = postcard::to_stdvec(&v).unwrap();
        let decoded: ProtocolVersion = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(v, decoded);
    }
}
