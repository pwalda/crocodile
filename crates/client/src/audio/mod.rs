//! Audio capture, encoding, decoding, playback, and jitter buffering
//! for real-time voice.
//!
//! The pipeline is split into small, testable units:
//!
//! - [`opus`]: pure Opus encoder/decoder wrappers (no audio I/O).
//! - [`jitter`]: receiver-side jitter buffer that orders incoming
//!   frames by sequence number and yields the next-expected frame or
//!   `None` (caller plays silence to fill the gap).
//! - [`capture`]: cpal-based microphone capture. Streams raw PCM into
//!   a callback.
//! - [`playback`]: cpal-based speaker playback. Pulls PCM from a
//!   callback the audio thread invokes.
//!
//! The actual voice call assembles these in `examples/two_peer_call.rs`.
//! Keeping the assembly there (rather than offering a one-shot
//! `AudioPipeline::start_call(...)` helper) reflects how few callers
//! we have today; an abstraction over a single use site is premature.

pub mod capture;
pub mod controls;
pub mod jitter;
pub mod opus;
pub mod playback;

pub use controls::AudioControls;

/// Sample rate we standardise on across capture, codec, and playback.
/// 48 kHz is Opus's native rate and what virtually all consumer audio
/// hardware supports.
pub const SAMPLE_RATE_HZ: u32 = 48_000;

/// Mono only for v1. Stereo doubles bandwidth without meaningfully
/// helping voice intelligibility.
pub const CHANNELS: u16 = 1;

/// Frame duration. 20ms is the Opus sweet spot for voice: good
/// quality, low latency overhead, supported on every Opus stack.
pub const FRAME_DURATION_MS: u32 = 20;

/// Samples per Opus frame at our rate: 48_000 * 20 / 1000 = 960.
pub const SAMPLES_PER_FRAME: usize = (SAMPLE_RATE_HZ as usize * FRAME_DURATION_MS as usize) / 1000;
