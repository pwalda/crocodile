//! Receiver-side jitter buffer.
//!
//! Holds a fixed-depth window of encoded Opus frames keyed by
//! sequence number. The receiver `push`es frames as they arrive (any
//! order); the playback callback `pop`s the next expected frame in
//! order, or `None` when nothing is available (caller plays silence
//! or invokes PLC).
//!
//! Design choices:
//!
//! - Small bounded depth (default 5 frames = 100 ms). Voice is
//!   loss-tolerant; the cost of delaying playback to wait for late
//!   frames exceeds the benefit beyond ~100 ms.
//! - Sequence numbers are the source of truth. Wraparound is not
//!   handled because u32 at 50 frames/sec gives ~2.7 years before
//!   wrap.
//! - Frames older than the current play head are dropped silently.

use std::collections::BTreeMap;

/// Default buffer depth in frames. With 20 ms frames this is 100 ms
/// of receive-side latency added on top of the network.
pub const DEFAULT_DEPTH_FRAMES: usize = 5;

/// Jitter buffer. Not thread-safe — wrap with a Mutex if shared.
#[derive(Debug)]
pub struct JitterBuffer {
    depth: usize,
    /// Frames available for playback, keyed by frame_seq.
    frames: BTreeMap<u32, Vec<u8>>,
    /// Next frame_seq the consumer expects to play.
    next: Option<u32>,
}

impl Default for JitterBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_DEPTH_FRAMES)
    }
}

impl JitterBuffer {
    /// New empty buffer with the given depth.
    pub fn new(depth: usize) -> Self {
        Self {
            depth,
            frames: BTreeMap::new(),
            next: None,
        }
    }

    /// Insert a received frame. Returns `true` if the frame was
    /// stored, `false` if it was discarded (already-played or way out
    /// of window).
    pub fn push(&mut self, frame_seq: u32, payload: Vec<u8>) -> bool {
        // Discard frames older than the play head.
        if let Some(next) = self.next {
            if frame_seq < next {
                return false;
            }
        }

        self.frames.insert(frame_seq, payload);

        // Cap buffer size: if we exceed depth, drop the *oldest*
        // frames. This trades latency for under-buffering on lossy
        // links — keeping recent frames matters more.
        while self.frames.len() > self.depth {
            if let Some((&old_key, _)) = self.frames.iter().next() {
                self.frames.remove(&old_key);
                // Advance the play head past the dropped frame so we
                // don't expect it back.
                self.next = Some(match self.next {
                    Some(n) => n.max(old_key + 1),
                    None => old_key + 1,
                });
            } else {
                break;
            }
        }

        true
    }

    /// Pop the next frame in order. Returns `None` if the next
    /// expected frame has not arrived (caller plays silence /
    /// concealment).
    ///
    /// After returning a frame, advances the play head by 1. After
    /// returning `None`, *also* advances by 1 — we don't wait
    /// indefinitely; we keep the audio clock moving.
    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let next = match self.next {
            Some(n) => n,
            None => {
                // First pop: align play head to the oldest frame we have.
                let first = *self.frames.iter().next()?.0;
                self.next = Some(first);
                first
            }
        };

        let frame = self.frames.remove(&next);
        self.next = Some(next.wrapping_add(1));
        frame
    }

    /// Number of frames currently buffered.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// True if no frames buffered.
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_order_push_and_pop() {
        let mut jb = JitterBuffer::new(5);
        jb.push(0, vec![1]);
        jb.push(1, vec![2]);
        jb.push(2, vec![3]);

        assert_eq!(jb.pop(), Some(vec![1]));
        assert_eq!(jb.pop(), Some(vec![2]));
        assert_eq!(jb.pop(), Some(vec![3]));
        assert_eq!(jb.pop(), None);
    }

    #[test]
    fn reorders_out_of_order_frames() {
        let mut jb = JitterBuffer::new(5);
        jb.push(2, vec![3]);
        jb.push(0, vec![1]);
        jb.push(1, vec![2]);

        assert_eq!(jb.pop(), Some(vec![1]));
        assert_eq!(jb.pop(), Some(vec![2]));
        assert_eq!(jb.pop(), Some(vec![3]));
    }

    #[test]
    fn returns_none_for_missing_frame_then_continues() {
        let mut jb = JitterBuffer::new(5);
        jb.push(0, vec![1]);
        // frame 1 never arrives
        jb.push(2, vec![3]);

        assert_eq!(jb.pop(), Some(vec![1]));
        // gap at 1 → None
        assert_eq!(jb.pop(), None);
        // frame 2 is still there
        assert_eq!(jb.pop(), Some(vec![3]));
    }

    #[test]
    fn drops_late_frames() {
        let mut jb = JitterBuffer::new(5);
        jb.push(0, vec![1]);
        assert_eq!(jb.pop(), Some(vec![1])); // head advances to 1
                                             // a stragger arrives for already-played slot
        let kept = jb.push(0, vec![99]);
        assert!(!kept);
    }

    #[test]
    fn caps_at_depth_dropping_oldest() {
        let mut jb = JitterBuffer::new(3);
        for i in 0..10 {
            jb.push(i, vec![i as u8]);
        }
        assert_eq!(jb.len(), 3);
        // The retained frames should be the most recent three.
        let popped: Vec<u8> = std::iter::from_fn(|| jb.pop())
            .flat_map(|f| f.into_iter())
            .collect();
        assert_eq!(popped, vec![7, 8, 9]);
    }
}
