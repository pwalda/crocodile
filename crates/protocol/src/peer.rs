//! Peer ↔ peer control-plane messages.
//!
//! These flow over QUIC streams between room members (whether directly
//! or via the current host's fan-out). All carry a
//! [`crate::envelope::SignedPeerMessage`] envelope at transport time.
//!
//! Voice and text *payloads* are defined in their own modules
//! ([`crate::voice`], [`crate::text`]); this module covers everything
//! that is not user-visible content: presence, election gossip, MLS
//! welcomes/commits, and peer-hint exchange.

use serde::{Deserialize, Serialize};

use crate::election::QualityVector;
use crate::history::HistoryHead;
use crate::mls::{MlsCiphertext, MlsCommit, MlsWelcome};
use crate::signaling::PeerHint;

/// Top-level peer-to-peer control message kind. Voice and text frames
/// travel through this enum as well so a single signed-envelope path
/// covers everything; the per-kind payload types live in their own
/// modules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum PeerMessage {
    /// A voice frame (Opus payload wrapped in MLS).
    Voice(crate::voice::VoiceFrame),
    /// A text message (UTF-8 payload wrapped in MLS).
    Text(crate::text::TextMessage),
    /// A periodic quality-vector gossip used by the election.
    QualityVector(QualityVector),
    /// "I am still alive" — keepalive from the current host. Sent every
    /// 200ms; 400ms of silence triggers shadow promotion.
    HostKeepalive {
        /// Logical clock used to detect split-brain. Receivers reject
        /// keepalives with a lower clock than they've already accepted.
        logical_clock: u64,
    },
    /// "I am taking over as host at the given clock." Pre-announces a
    /// migration so peers can switch their send target.
    HostHandover {
        /// The new host's logical clock; must exceed the prior host's.
        new_logical_clock: u64,
        /// Milliseconds until peers should switch send targets.
        switch_in_millis: u32,
    },
    /// MLS welcome message bringing a new joiner into the group.
    MlsWelcome(MlsWelcome),
    /// MLS commit message advancing the group epoch.
    MlsCommit(MlsCommit),
    /// MLS application message (already covered by Voice/Text but kept
    /// for protocol completeness — e.g. group metadata changes).
    MlsApplication(MlsCiphertext),
    /// Updated peer-hint advertised by a member. Receivers add to their
    /// local cache and gossip onward if newer than what they hold.
    PeerHintUpdate(PeerHint),
    /// "I observe this host as misbehaving" — counts toward the M-of-N
    /// complaint threshold that forces re-election.
    HostComplaint {
        /// Logical clock of the host being complained about.
        host_logical_clock: u64,
        /// Optional brief reason code (for future telemetry).
        reason: ComplaintReason,
    },
    /// Posting of a new history-head commitment to peers so they can
    /// independently validate that the server's view matches.
    HistoryHeadUpdate(HistoryHead),
}

/// Reason a peer is complaining about the current host's data-plane
/// behaviour. Kept coarse on purpose — fine-grained reasons leak
/// implementation details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum ComplaintReason {
    /// Excessive packet loss observed from host.
    Loss,
    /// Latency from host above acceptable threshold.
    Latency,
    /// Host appears to have stopped forwarding to this peer.
    Silence,
}

/// Sender-side rules for ordering peer messages. Voice frames go on
/// unreliable QUIC datagrams; everything else goes on reliable streams.
/// This type captures the routing decision in one place so it can be
/// referenced consistently from networking code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryClass {
    /// Datagrams: unreliable, latency-sensitive.
    Unreliable,
    /// Reliable QUIC stream.
    Reliable,
}

impl PeerMessage {
    /// Returns the appropriate [`DeliveryClass`] for this message.
    pub fn delivery_class(&self) -> DeliveryClass {
        match self {
            // Voice tolerates loss; latency dominates.
            PeerMessage::Voice(_) => DeliveryClass::Unreliable,
            // Keepalives are cheap to drop and frequent; latency matters.
            PeerMessage::HostKeepalive { .. } => DeliveryClass::Unreliable,
            // Quality gossip is cheap and frequent; loss is fine.
            PeerMessage::QualityVector(_) => DeliveryClass::Unreliable,
            // Everything else needs reliability.
            PeerMessage::Text(_)
            | PeerMessage::HostHandover { .. }
            | PeerMessage::MlsWelcome(_)
            | PeerMessage::MlsCommit(_)
            | PeerMessage::MlsApplication(_)
            | PeerMessage::PeerHintUpdate(_)
            | PeerMessage::HostComplaint { .. }
            | PeerMessage::HistoryHeadUpdate(_) => DeliveryClass::Reliable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepalive_is_unreliable() {
        let m = PeerMessage::HostKeepalive { logical_clock: 1 };
        assert_eq!(m.delivery_class(), DeliveryClass::Unreliable);
    }

    #[test]
    fn handover_is_reliable() {
        let m = PeerMessage::HostHandover {
            new_logical_clock: 2,
            switch_in_millis: 500,
        };
        assert_eq!(m.delivery_class(), DeliveryClass::Reliable);
    }

    #[test]
    fn peer_message_roundtrips() {
        let m = PeerMessage::HostKeepalive { logical_clock: 9 };
        let bytes = postcard::to_stdvec(&m).unwrap();
        let decoded: PeerMessage = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(m, decoded);
    }

    // Compile-time guard: ensure all reasons are exhaustively classified
    // in delivery_class. If a new PeerMessage variant is added without
    // updating delivery_class, this test will not catch it (since the
    // match is on PeerMessage, not on the new variant) — but the compiler
    // will, because of #[non_exhaustive]'s "wildcard required" rule. The
    // wildcard happens to be absent here because we want the compiler to
    // bark on new variants.
}
