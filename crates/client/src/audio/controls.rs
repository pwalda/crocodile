//! Shared, lock-free audio controls and telemetry.
//!
//! The audio callbacks run on a realtime OS thread; the UI reads these
//! values every frame. Atomics keep both sides non-blocking — a mutex
//! here risks priority inversion and audible glitches.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

/// Peak level of a recent audio buffer, in `[0.0, 1.0]`.
///
/// Stored as the bit pattern of an `f32` so it can live in an
/// `AtomicU32` (there is no stable `AtomicF32`).
#[derive(Debug, Default)]
pub struct Level(AtomicU32);

impl Level {
    /// Record a new peak.
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }

    /// Read the most recent peak.
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }
}

/// Controls and telemetry shared between the audio threads and the UI.
#[derive(Debug, Default)]
pub struct AudioControls {
    /// When set, captured audio is replaced with silence before
    /// encoding, so nothing intelligible leaves the machine.
    pub muted: AtomicBool,
    /// Peak level of the most recent captured buffer. Drives the input
    /// meter — the quickest way for a user to tell whether the mic is
    /// actually working.
    pub input_level: Level,
    /// Peak level of the most recent played buffer.
    pub output_level: Level,
}

impl AudioControls {
    /// Create a fresh, unmuted control block.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// True if the microphone is muted.
    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    /// Set the muted state.
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    /// Flip the muted state, returning the new value.
    pub fn toggle_muted(&self) -> bool {
        let next = !self.is_muted();
        self.set_muted(next);
        next
    }
}

/// Peak absolute value of a sample buffer.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_roundtrips_through_bits() {
        let l = Level::default();
        assert_eq!(l.get(), 0.0);
        l.set(0.75);
        assert!((l.get() - 0.75).abs() < f32::EPSILON);
    }

    #[test]
    fn mute_toggles() {
        let c = AudioControls::new();
        assert!(!c.is_muted());
        assert!(c.toggle_muted());
        assert!(c.is_muted());
        assert!(!c.toggle_muted());
        assert!(!c.is_muted());
    }

    #[test]
    fn peak_finds_max_absolute() {
        assert_eq!(peak(&[0.1, -0.9, 0.3]), 0.9);
        assert_eq!(peak(&[]), 0.0);
    }
}
