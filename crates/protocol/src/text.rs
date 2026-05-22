//! Text message wire format.
//!
//! Text messages are MLS-encrypted under the current group epoch, chain
//! via a BLAKE3 hash to a previous message (forming the room's history
//! log), and travel over reliable QUIC streams from the sender to the
//! current host for fan-out.
//!
//! The hash chain is computed over the *ciphertext* and the previous
//! hash, so peers can verify chain integrity without decrypting (useful
//! for fan-out validation by the host, and for fast history sync of
//! ciphertext-only blocks).

use serde::{Deserialize, Serialize};

use crate::history::MessageHash;
use crate::mls::{GroupEpoch, MlsCiphertext};

/// A text message on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextMessage {
    /// MLS epoch the payload was encrypted under.
    pub epoch: GroupEpoch,
    /// Hash of the previous message in this room's history, or `None`
    /// for the very first message.
    pub prev: Option<MessageHash>,
    /// MLS-encrypted UTF-8 payload.
    pub ciphertext: MlsCiphertext,
}

impl TextMessage {
    /// Computes this message's hash for use as the `prev` of subsequent
    /// messages. Hashes the postcard-encoded form so the chain is
    /// well-defined and independent of in-memory layout.
    ///
    /// Encoding cost: low (a few KB at most). Callers can cache.
    pub fn hash(&self) -> MessageHash {
        // Errors here would mean a serializer bug; treat as panic-worthy
        // since the type is fully owned by us and contains only known-
        // serializable fields.
        let bytes = postcard::to_stdvec(self).expect("text message must be serialisable");
        MessageHash::of(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_message_roundtrips() {
        let m = TextMessage {
            epoch: GroupEpoch(1),
            prev: None,
            ciphertext: MlsCiphertext(b"opaque".to_vec()),
        };
        let bytes = postcard::to_stdvec(&m).unwrap();
        let decoded: TextMessage = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(m, decoded);
    }

    #[test]
    fn hash_is_deterministic_and_sensitive() {
        let m1 = TextMessage {
            epoch: GroupEpoch(1),
            prev: None,
            ciphertext: MlsCiphertext(vec![1, 2, 3]),
        };
        let m2 = TextMessage {
            epoch: GroupEpoch(1),
            prev: None,
            ciphertext: MlsCiphertext(vec![1, 2, 4]),
        };
        assert_eq!(m1.hash(), m1.hash());
        assert_ne!(m1.hash(), m2.hash());
    }
}
