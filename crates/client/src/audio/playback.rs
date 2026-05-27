//! Speaker playback via cpal.
//!
//! Symmetrical to [`super::capture`]: holds a cpal output `Stream`
//! and pulls f32 PCM samples from a caller-supplied source on each
//! audio callback.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};

use crate::error::{ClientError, Result};

use super::{CHANNELS, SAMPLE_RATE_HZ};

/// Live playback stream. Drop to stop.
pub struct PlaybackStream {
    _stream: cpal::Stream,
}

impl std::fmt::Debug for PlaybackStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlaybackStream").finish()
    }
}

/// Shared FIFO of f32 PCM samples drained by the playback callback.
///
/// Lock-free would be nicer here but a Mutex around a Vec is plenty
/// fast for monaural voice at 48 kHz (samples flow through in chunks
/// of ~960 every 20 ms). If this ever becomes a bottleneck we'd switch
/// to a SPSC ringbuffer.
#[derive(Debug, Default, Clone)]
pub struct PlaybackQueue {
    inner: Arc<Mutex<Vec<f32>>>,
}

impl PlaybackQueue {
    /// Construct an empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append samples to the end of the queue. Cheap; callers can
    /// invoke this from any context.
    pub fn push(&self, samples: &[f32]) {
        let mut g = self.inner.lock().unwrap();
        g.extend_from_slice(samples);
    }

    /// Drain up to `out.len()` samples into `out`. Returns how many
    /// were written; remaining slots are left untouched (caller should
    /// zero-fill before calling for clean silence on underrun).
    pub fn pop_into(&self, out: &mut [f32]) -> usize {
        let mut g = self.inner.lock().unwrap();
        let n = out.len().min(g.len());
        for (dst, src) in out[..n].iter_mut().zip(g.drain(..n)) {
            *dst = src;
        }
        n
    }

    /// Current number of buffered samples (for diagnostics).
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// True if the queue is empty.
    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().is_empty()
    }
}

/// Open the default output device at 48 kHz mono, pulling samples
/// from `queue` on each audio callback.
pub fn open_default(queue: PlaybackQueue) -> Result<PlaybackStream> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| ClientError::Other(anyhow::anyhow!("no default output device")))?;
    open_on_device(&device, queue)
}

/// Like [`open_default`] but on a specific device.
pub fn open_on_device(device: &Device, queue: PlaybackQueue) -> Result<PlaybackStream> {
    let supported = device
        .default_output_config()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("default_output_config: {e}")))?;
    let format = supported.sample_format();
    let config = StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(SAMPLE_RATE_HZ),
        buffer_size: cpal::BufferSize::Default,
    };

    tracing::info!(
        device = %device.name().unwrap_or_else(|_| "?".to_string()),
        ?format,
        sample_rate_hz = SAMPLE_RATE_HZ,
        channels = CHANNELS,
        "opening playback stream",
    );

    let err_fn = |e| tracing::warn!("output stream error: {e}");

    let stream = match format {
        SampleFormat::F32 => {
            let queue = queue.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    // Zero-fill first so any unwritten slots play
                    // silence rather than uninitialised memory noise.
                    for s in data.iter_mut() {
                        *s = 0.0;
                    }
                    queue.pop_into(data);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let queue = queue.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    let mut f = vec![0.0f32; data.len()];
                    queue.pop_into(&mut f);
                    for (dst, src) in data.iter_mut().zip(f) {
                        *dst = (src.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                    }
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let queue = queue.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                    let mut f = vec![0.0f32; data.len()];
                    queue.pop_into(&mut f);
                    for (dst, src) in data.iter_mut().zip(f) {
                        *dst = ((src.clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16;
                    }
                },
                err_fn,
                None,
            )
        }
        other => {
            return Err(ClientError::Other(anyhow::anyhow!(
                "unsupported output sample format {other:?}"
            )))
        }
    }
    .map_err(|e| ClientError::Other(anyhow::anyhow!("build_output_stream: {e}")))?;

    stream
        .play()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("output stream play: {e}")))?;

    Ok(PlaybackStream { _stream: stream })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_round_trips() {
        let q = PlaybackQueue::new();
        q.push(&[1.0, 2.0, 3.0]);
        let mut buf = [0.0f32; 5];
        let n = q.pop_into(&mut buf);
        assert_eq!(n, 3);
        assert_eq!(&buf[..3], &[1.0, 2.0, 3.0]);
    }

    #[test]
    fn queue_partial_drain_keeps_remainder() {
        let q = PlaybackQueue::new();
        q.push(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        let mut buf = [0.0f32; 2];
        let n = q.pop_into(&mut buf);
        assert_eq!(n, 2);
        assert_eq!(&buf, &[1.0, 2.0]);
        // Remaining 3 still queued.
        assert_eq!(q.len(), 3);
    }
}
