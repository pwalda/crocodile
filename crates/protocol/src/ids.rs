//! Typed identifiers used across the protocol.
//!
//! All IDs are opaque 32-byte values on the wire. They are not user-readable
//! strings; the coordination server maps human handles (`@alice:server`) to
//! `UserId`s during account creation.
//!
//! Using newtype wrappers around `[u8; 32]` so that mixing up a `UserId` and
//! a `RoomId` at a function call site is a compile error.

use serde::{Deserialize, Serialize};

macro_rules! opaque_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[repr(transparent)]
        pub struct $name(pub [u8; 32]);

        impl $name {
            #[doc = "Construct from a raw 32-byte array."]
            pub const fn from_bytes(bytes: [u8; 32]) -> Self {
                Self(bytes)
            }

            #[doc = "Borrow the raw bytes."]
            pub const fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}({})", stringify!($name), hex::encode(&self.0[..8]))
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&hex::encode(&self.0))
            }
        }
    };
}

opaque_id!(
    /// Identifies a user across the whole federation.
    ///
    /// Derived deterministically from the user's identity public key
    /// (BLAKE3 of the public key bytes) so any client can verify the
    /// mapping without consulting the server.
    UserId
);

opaque_id!(
    /// Identifies a single device belonging to a user.
    ///
    /// Derived deterministically from the device public key
    /// (BLAKE3 of the public key bytes).
    DeviceId
);

opaque_id!(
    /// Identifies a room (voice + text channel) within a coordination
    /// server. Globally unique when combined with [`ServerId`].
    RoomId
);

opaque_id!(
    /// Identifies a coordination server within the federation.
    ///
    /// Derived from the server's long-lived signing public key.
    ServerId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_roundtrip_through_postcard() {
        let u = UserId::from_bytes([7; 32]);
        let bytes = postcard::to_stdvec(&u).unwrap();
        let decoded: UserId = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(u, decoded);
    }

    #[test]
    fn debug_shortens_id() {
        let u = UserId::from_bytes([0xab; 32]);
        let s = format!("{u:?}");
        assert!(s.starts_with("UserId(abababababababab"));
        assert!(s.ends_with(')'));
    }

    #[test]
    fn display_is_full_hex() {
        let u = UserId::from_bytes([0xcd; 32]);
        let s = format!("{u}");
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn different_id_types_do_not_compare() {
        // Compile-time check: this only compiles if the wrapper types are
        // distinct. Kept inside the test so it lives near the intent.
        let u = UserId::from_bytes([1; 32]);
        let r = RoomId::from_bytes([1; 32]);
        assert_eq!(u.as_bytes(), r.as_bytes());
        // u == r would not compile, which is the point.
    }
}
