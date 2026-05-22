//! Hash-chained text history.
//!
//! Each text message hashes to a [`MessageHash`] that the next message
//! references via its `prev` field, forming a chain. The current tail
//! of the chain is the room's [`HistoryHead`] — that's the value the
//! coordination server keeps (signed by the posting device) without
//! seeing any content.
//!
//! See `ARCHITECTURE.md` §6.

use serde::{Deserialize, Serialize};

use crate::ids::{DeviceId, RoomId};
use crate::keys::Signature;
use crate::time::UnixSeconds;

/// 32-byte BLAKE3 message hash.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(transparent)]
pub struct MessageHash(pub [u8; 32]);

impl MessageHash {
    /// Hashes an arbitrary byte buffer with BLAKE3.
    pub fn of(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    /// Borrow the raw bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for MessageHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MessageHash({})", hex::encode(&self.0[..8]))
    }
}

impl std::fmt::Display for MessageHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

/// Posted by a member to advertise "this is the newest message hash I
/// have for this room." The coordination server stores the most recent
/// [`HistoryHead`] per room (or per branch if there's an unresolved
/// fork). Server never sees message contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryHead {
    /// The room.
    pub room: RoomId,
    /// The hash of the newest message.
    pub head: MessageHash,
    /// Total message count seen by the poster (monotonic; helps the
    /// server pick the freshest of multiple claims).
    pub message_count: u64,
    /// When the poster computed this head.
    pub posted_at: UnixSeconds,
    /// Posting device.
    pub posted_by: DeviceId,
    /// Device signature over `(room, head, message_count, posted_at, posted_by)`.
    pub signature: Signature,
}

impl HistoryHead {
    /// Canonical signing input.
    pub fn signing_input(&self) -> Result<Vec<u8>, postcard::Error> {
        postcard::to_stdvec(&(
            &self.room,
            &self.head,
            self.message_count,
            self.posted_at,
            &self.posted_by,
        ))
    }
}

/// Compares two [`HistoryHead`]s for "freshness." Higher message count
/// wins; ties broken by later `posted_at`; remaining ties by lexical
/// hash to keep things deterministic.
///
/// Returns [`std::cmp::Ordering::Greater`] when `a` is fresher than `b`.
pub fn freshness_cmp(a: &HistoryHead, b: &HistoryHead) -> std::cmp::Ordering {
    a.message_count
        .cmp(&b.message_count)
        .then(a.posted_at.get().cmp(&b.posted_at.get()))
        .then(a.head.as_bytes().cmp(b.head.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_blake3() {
        let data = b"hello";
        assert_eq!(
            MessageHash::of(data).as_bytes(),
            blake3::hash(data).as_bytes()
        );
    }

    #[test]
    fn freshness_prefers_higher_count() {
        let a = HistoryHead {
            room: RoomId::from_bytes([1; 32]),
            head: MessageHash([1; 32]),
            message_count: 10,
            posted_at: UnixSeconds(100),
            posted_by: DeviceId::from_bytes([1; 32]),
            signature: Signature([0; 64]),
        };
        let mut b = a.clone();
        b.message_count = 5;
        b.posted_at = UnixSeconds(200);

        assert_eq!(freshness_cmp(&a, &b), std::cmp::Ordering::Greater);
    }

    #[test]
    fn freshness_falls_back_to_time_then_hash() {
        let mut a = HistoryHead {
            room: RoomId::from_bytes([1; 32]),
            head: MessageHash([1; 32]),
            message_count: 10,
            posted_at: UnixSeconds(100),
            posted_by: DeviceId::from_bytes([1; 32]),
            signature: Signature([0; 64]),
        };
        let mut b = a.clone();
        b.posted_at = UnixSeconds(200);
        assert_eq!(freshness_cmp(&a, &b), std::cmp::Ordering::Less);

        // Same count + time: hash decides.
        b.posted_at = a.posted_at;
        a.head = MessageHash([2; 32]);
        b.head = MessageHash([1; 32]);
        assert_eq!(freshness_cmp(&a, &b), std::cmp::Ordering::Greater);
    }
}
