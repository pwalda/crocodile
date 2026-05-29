//! Stateful helpers for sending and receiving text messages in a
//! room: tracks sender sequence + prev-hash bookkeeping, computes
//! own-hash chain identities, and encodes / decodes the wire
//! envelopes. Doesn't touch MLS or QUIC — the caller does that.
//!
//! Typical use:
//!
//! ```ignore
//! let mut sender = TextSender::new(room, my_device, my_local_head_hash);
//! let (wire, stored, payload_bytes) =
//!     sender.compose(group_epoch, "hello", None, mls_provider, mls_identity, mut group);
//! // 1. send `wire` over QUIC reliable stream
//! // 2. history.store(&stored) locally
//! // 3. MLS encryption happens inside compose() via the supplied closure
//! ```
//!
//! Decoupled from MLS so this module remains pure: the caller
//! supplies the encrypted ciphertext bytes (or, on the receive side,
//! the decrypted plaintext bytes).

use crocodile_protocol::history::MessageHash;
use crocodile_protocol::ids::{DeviceId, RoomId};
use crocodile_protocol::mls::{GroupEpoch, MlsCiphertext};
use crocodile_protocol::text::{TextMessage, TextPayload};
use crocodile_protocol::time::UnixSeconds;

use crate::error::{ClientError, Result};
use crate::history::StoredTextMessage;

/// Encoder for outbound text. One per (room, sender_device).
#[derive(Debug, Clone)]
pub struct TextSender {
    room: RoomId,
    sender_device: DeviceId,
    /// Last own-hash we emitted; threaded as the `prev` of the next.
    /// Initialised from the room's local head when constructed.
    next_prev: Option<MessageHash>,
    /// Monotonic per-sender sequence. Persisted by the caller across
    /// runs if they want sequence continuity.
    next_seq: u64,
}

impl TextSender {
    /// Construct a new sender. `local_head` is the room's current
    /// head as observed by this device — pass `None` for a fresh
    /// room.
    pub fn new(room: RoomId, sender_device: DeviceId, local_head: Option<MessageHash>) -> Self {
        Self {
            room,
            sender_device,
            next_prev: local_head,
            next_seq: 0,
        }
    }

    /// Override the starting sequence (e.g. when reloading from a
    /// persisted counter).
    pub fn with_starting_seq(mut self, seq: u64) -> Self {
        self.next_seq = seq;
        self
    }

    /// The hash that the *next* composed message will reference as
    /// `prev`. Useful when persisting sender state.
    pub fn next_prev(&self) -> Option<MessageHash> {
        self.next_prev
    }

    /// The sequence value of the next message.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Encode a text payload into the bytes the caller will MLS-encrypt
    /// and the [`StoredTextMessage`] template the caller will fill in
    /// after the wire is committed.
    ///
    /// Two-step so the caller controls when MLS state advances:
    ///
    /// 1. [`Self::encode_payload`] returns postcard bytes ready for
    ///    MLS encryption.
    /// 2. [`Self::finalize`] takes the produced ciphertext + epoch and
    ///    returns the wire [`TextMessage`] + the [`StoredTextMessage`]
    ///    to hand to local persistence.
    pub fn encode_payload(
        &self,
        body: impl Into<String>,
        sent_at: UnixSeconds,
        in_reply_to: Option<MessageHash>,
    ) -> Result<Vec<u8>> {
        let payload = TextPayload {
            sender_device: self.sender_device,
            sent_at,
            body: body.into(),
            in_reply_to,
        };
        postcard::to_stdvec(&payload).map_err(ClientError::from)
    }

    /// Finalise an outbound message after MLS encryption. Bumps the
    /// internal sequence + prev-hash.
    pub fn finalize(
        &mut self,
        epoch: GroupEpoch,
        ciphertext: MlsCiphertext,
        sent_at: UnixSeconds,
        in_reply_to: Option<MessageHash>,
        body_for_local_store: String,
    ) -> (TextMessage, StoredTextMessage) {
        let wire = TextMessage {
            epoch,
            prev: self.next_prev,
            ciphertext,
        };
        let own_hash = wire.hash();

        let stored = StoredTextMessage {
            room: self.room,
            sender_device: self.sender_device,
            sender_seq: self.next_seq,
            sent_at,
            received_at: sent_at, // we are the sender; received_at == sent_at
            prev_hash: self.next_prev,
            own_hash,
            in_reply_to,
            body: body_for_local_store,
        };

        self.next_prev = Some(own_hash);
        self.next_seq = self.next_seq.saturating_add(1);

        (wire, stored)
    }
}

/// Decoder for inbound text. Stateless — callers create it once per
/// room.
#[derive(Debug, Clone, Copy)]
pub struct TextReceiver {
    room: RoomId,
}

impl TextReceiver {
    /// Construct.
    pub fn new(room: RoomId) -> Self {
        Self { room }
    }

    /// Given a received [`TextMessage`] and its already-decrypted
    /// plaintext bytes, decode to a [`StoredTextMessage`] ready for
    /// persistence.
    ///
    /// `received_at` is the local wall-clock when we accepted the
    /// message.
    ///
    /// The caller must compute `sender_seq` by counting messages
    /// previously received from `sender_device` (callers typically
    /// look up `count_for_room` scoped to that sender).
    pub fn decode(
        &self,
        wire: &TextMessage,
        plaintext_bytes: &[u8],
        sender_seq: u64,
        received_at: UnixSeconds,
    ) -> Result<StoredTextMessage> {
        let payload: TextPayload =
            postcard::from_bytes(plaintext_bytes).map_err(ClientError::from)?;

        Ok(StoredTextMessage {
            room: self.room,
            sender_device: payload.sender_device,
            sender_seq,
            sent_at: payload.sent_at,
            received_at,
            prev_hash: wire.prev,
            own_hash: wire.hash(),
            in_reply_to: payload.in_reply_to,
            body: payload.body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    fn room(byte: u8) -> RoomId {
        RoomId::from_bytes([byte; 32])
    }

    #[test]
    fn sender_encode_decode_roundtrips() {
        let mut sender = TextSender::new(room(1), device(2), None);
        let bytes = sender
            .encode_payload("hello", UnixSeconds(100), None)
            .unwrap();
        // Pretend MLS happened: treat the plaintext as the ciphertext for
        // round-trip testing.
        let ct = MlsCiphertext(bytes.clone());
        let (wire, stored) = sender.finalize(
            GroupEpoch(0),
            ct,
            UnixSeconds(100),
            None,
            "hello".to_string(),
        );

        // First message has prev=None and seq=0.
        assert!(wire.prev.is_none());
        assert_eq!(stored.sender_seq, 0);
        assert_eq!(stored.body, "hello");

        // Next message chains.
        let bytes2 = sender
            .encode_payload("world", UnixSeconds(101), None)
            .unwrap();
        let ct2 = MlsCiphertext(bytes2);
        let (wire2, stored2) = sender.finalize(
            GroupEpoch(0),
            ct2,
            UnixSeconds(101),
            None,
            "world".to_string(),
        );
        assert_eq!(wire2.prev, Some(stored.own_hash));
        assert_eq!(stored2.sender_seq, 1);
        assert_eq!(stored2.prev_hash, Some(stored.own_hash));
    }

    #[test]
    fn receiver_decode_matches_sender() {
        let mut sender = TextSender::new(room(1), device(2), None);
        let bytes = sender
            .encode_payload("greetings", UnixSeconds(500), None)
            .unwrap();
        let ct = MlsCiphertext(bytes.clone());
        let (wire, sender_stored) = sender.finalize(
            GroupEpoch(0),
            ct,
            UnixSeconds(500),
            None,
            "greetings".to_string(),
        );

        let recv = TextReceiver::new(room(1));
        let stored = recv
            .decode(&wire, &bytes, 0, UnixSeconds(501))
            .unwrap();

        // Wire identity matches; received_at differs.
        assert_eq!(stored.own_hash, sender_stored.own_hash);
        assert_eq!(stored.body, "greetings");
        assert_eq!(stored.sender_device, device(2));
        assert_eq!(stored.received_at, UnixSeconds(501));
    }

    #[test]
    fn sender_starts_with_supplied_head() {
        let head = MessageHash([9; 32]);
        let mut sender = TextSender::new(room(1), device(2), Some(head));
        let bytes = sender.encode_payload("x", UnixSeconds(0), None).unwrap();
        let (wire, _) = sender.finalize(
            GroupEpoch(0),
            MlsCiphertext(bytes),
            UnixSeconds(0),
            None,
            "x".to_string(),
        );
        assert_eq!(wire.prev, Some(head));
    }

    #[test]
    fn in_reply_to_propagates() {
        let target = MessageHash([5; 32]);
        let mut sender = TextSender::new(room(1), device(2), None);
        let bytes = sender
            .encode_payload("reply", UnixSeconds(0), Some(target))
            .unwrap();
        let (wire, stored) = sender.finalize(
            GroupEpoch(0),
            MlsCiphertext(bytes.clone()),
            UnixSeconds(0),
            Some(target),
            "reply".to_string(),
        );

        let recv = TextReceiver::new(room(1));
        let on_other_side = recv.decode(&wire, &bytes, 0, UnixSeconds(1)).unwrap();
        assert_eq!(on_other_side.in_reply_to, Some(target));
        assert_eq!(stored.in_reply_to, Some(target));
    }
}
