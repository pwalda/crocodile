//! Voice frame wire format.
//!
//! Senders capture audio, encode with Opus, MLS-encrypt the Opus bytes
//! under the current group epoch, and wrap the ciphertext in a
//! [`VoiceFrame`]. Frames travel as QUIC datagrams from the sender to
//! the current host, which fans them out unchanged.
//!
//! No part of this module decrypts or even inspects the ciphertext — the
//! envelope is structural only.

use serde::{Deserialize, Serialize};

use crate::mls::{GroupEpoch, MlsCiphertext};

/// A single voice frame on the wire.
///
/// Sequence numbers are per-sender, monotonic, and used at the receiver
/// for jitter-buffer ordering and duplicate detection. They are
/// independent of the [`crate::envelope::SignedPeerMessage`] envelope's
/// `seq` (which counts *all* peer messages from that sender, not just
/// voice).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceFrame {
    /// MLS epoch the payload was encrypted under. Receivers retain
    /// keys for recent epochs to handle in-flight frames during rekey.
    pub epoch: GroupEpoch,
    /// Per-sender, per-epoch monotonic frame sequence number.
    pub frame_seq: u32,
    /// Sender timestamp in milliseconds relative to call start.
    /// Used by the jitter buffer; not security-critical.
    pub timestamp_ms: u32,
    /// MLS-encrypted Opus payload.
    pub ciphertext: MlsCiphertext,
}

/// Recommended Opus encoder configuration for v1. Documented here so the
/// audio crate and protocol crate agree on assumptions. Not part of the
/// wire format.
pub mod opus_config {
    /// Sample rate clients SHOULD use for Opus encoding.
    pub const SAMPLE_RATE_HZ: u32 = 48_000;
    /// Frame duration in milliseconds. 20ms is the Opus sweet spot for
    /// voice (good quality, low latency overhead, standard).
    pub const FRAME_DURATION_MS: u32 = 20;
    /// Target bitrate in bits per second. 32 kbps is high-quality voice;
    /// 64 kbps would be over-provisioning. The host election scoring
    /// budget assumes this number.
    pub const TARGET_BITRATE_BPS: u32 = 32_000;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_frame_roundtrips() {
        let frame = VoiceFrame {
            epoch: GroupEpoch(42),
            frame_seq: 7,
            timestamp_ms: 140,
            ciphertext: MlsCiphertext(vec![1, 2, 3, 4]),
        };
        let bytes = postcard::to_stdvec(&frame).unwrap();
        let decoded: VoiceFrame = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(frame, decoded);
    }

    // Compile-time sanity checks for opus constants. Using `const`
    // assertions so a future tuning that wanders outside the voice-
    // bitrate envelope is caught at build time, not by a unit test.
    const _: () = {
        assert!(opus_config::SAMPLE_RATE_HZ == 48_000);
        assert!(opus_config::FRAME_DURATION_MS == 20);
        assert!(opus_config::TARGET_BITRATE_BPS >= 16_000);
        assert!(opus_config::TARGET_BITRATE_BPS <= 64_000);
    };
}
