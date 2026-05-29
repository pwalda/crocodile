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
use crate::ids::DeviceId;
use crate::mls::{GroupEpoch, MlsCiphertext};
use crate::time::UnixSeconds;

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

/// Plaintext payload inside the MLS-encrypted `TextMessage`. This is
/// what each peer sees after decryption. The wire `TextMessage` carries
/// just an opaque ciphertext; this type defines what that ciphertext
/// encodes (postcard).
///
/// The wire `TextMessage` already carries a `prev` hash on the
/// envelope, but the plaintext also embeds sender metadata so the
/// recipient can attribute and timestamp without needing to peek at
/// the outer envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPayload {
    /// Device that sent this text message.
    pub sender_device: DeviceId,
    /// Sender's wall-clock at send time. Used for display ordering;
    /// not security-critical (the server-side hash chain is the
    /// authoritative ordering for forks).
    pub sent_at: UnixSeconds,
    /// UTF-8 message body. No structural / markup constraints at this
    /// layer; rendering is the UI's problem.
    pub body: String,
    /// Optional: if non-None, hash of the message this one is a
    /// reply to. Lets clients render threading without a separate
    /// in-reply-to relation in the server schema. The referenced
    /// hash need not be the immediately preceding message.
    ///
    /// Encoded as `Option<MessageHash>` — postcard writes a 1-byte
    /// discriminant; `skip_serializing_if` is not used because
    /// postcard's fixed wire shape needs every field present.
    pub in_reply_to: Option<MessageHash>,
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

    #[test]
    fn text_payload_roundtrips() {
        let p = TextPayload {
            sender_device: DeviceId::from_bytes([7; 32]),
            sent_at: UnixSeconds(1_000_000),
            body: "hello, world".to_string(),
            in_reply_to: Some(MessageHash([3; 32])),
        };
        let bytes = postcard::to_stdvec(&p).unwrap();
        let decoded: TextPayload = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(p, decoded);
    }

    #[test]
    fn text_payload_skips_in_reply_to_when_none() {
        let p = TextPayload {
            sender_device: DeviceId::from_bytes([0; 32]),
            sent_at: UnixSeconds(0),
            body: "x".to_string(),
            in_reply_to: None,
        };
        let bytes = postcard::to_stdvec(&p).unwrap();
        let decoded: TextPayload = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(decoded, p);
    }
}
