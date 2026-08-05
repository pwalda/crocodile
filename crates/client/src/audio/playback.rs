//! Speaker playback via cpal.
//!
//! Mirror of [`super::capture`]: opens the device with **its own**
//! configuration and adapts in software. The pipeline produces mono;
//! most output hardware (e.g. built-in Mac speakers) only supports
//! stereo, so mono frames are duplicated across the device's channels.
//!
//! Forcing a mono stream on a stereo-only device does not raise an
//! error on CoreAudio — it just fails to produce correct sound, which
//! is why this needed explicit handling rather than trusting the
//! absence of an error.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};

use crate::error::{ClientError, Result};

use super::capture::NegotiatedConfig;
use super::controls::{peak, AudioControls};
use super::SAMPLE_RATE_HZ;

/// Live playback stream. Drop to stop.
pub struct PlaybackStream {
    _stream: cpal::Stream,
    config: NegotiatedConfig,
}

impl std::fmt::Debug for PlaybackStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlaybackStream")
            .field("config", &self.config)
            .finish()
    }
}

impl PlaybackStream {
    /// The configuration negotiated with the device.
    pub fn config(&self) -> &NegotiatedConfig {
        &self.config
    }
}

/// Shared FIFO of **mono** f32 PCM samples drained by the playback
/// callback.
///
/// A mutex around a `Vec` is fast enough for monaural voice at 48 kHz
/// (≈960 samples every 20 ms). A lock-free SPSC ring would be the next
/// step if this ever shows up in profiles.
#[derive(Debug, Default, Clone)]
pub struct PlaybackQueue {
    inner: Arc<Mutex<Vec<f32>>>,
}

impl PlaybackQueue {
    /// Construct an empty queue.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append mono samples to the end of the queue.
    pub fn push(&self, samples: &[f32]) {
        let mut g = self.inner.lock().unwrap();
        g.extend_from_slice(samples);
    }

    /// Drain up to `out.len()` mono samples into `out`. Returns how many
    /// were written; the rest of `out` is left untouched.
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

/// Names of all available output devices.
pub fn list_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|ds| ds.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// Open the default output device.
pub fn open_default(queue: PlaybackQueue, controls: Arc<AudioControls>) -> Result<PlaybackStream> {
    open_by_name(None, queue, controls)
}

/// Open an output device by name, falling back to the default.
pub fn open_by_name(
    name: Option<&str>,
    queue: PlaybackQueue,
    controls: Arc<AudioControls>,
) -> Result<PlaybackStream> {
    let host = cpal::default_host();
    let device = match name {
        Some(want) => host
            .output_devices()
            .ok()
            .and_then(|mut ds| ds.find(|d| d.name().map(|n| n == want).unwrap_or(false)))
            .or_else(|| host.default_output_device()),
        None => host.default_output_device(),
    }
    .ok_or_else(|| ClientError::Other(anyhow::anyhow!("no speakers/headphones available")))?;
    open_on_device(&device, queue, controls)
}

/// Open a specific device, negotiating its supported configuration.
pub fn open_on_device(
    device: &Device,
    queue: PlaybackQueue,
    controls: Arc<AudioControls>,
) -> Result<PlaybackStream> {
    let supported = device
        .default_output_config()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("reading output config: {e}")))?;

    let device_name = device.name().unwrap_or_else(|_| "?".to_string());
    let format = supported.sample_format();
    let channels = supported.channels();
    let sample_rate = supported.sample_rate().0;

    if sample_rate != SAMPLE_RATE_HZ {
        return Err(ClientError::Other(anyhow::anyhow!(
            "output '{device_name}' runs at {sample_rate} Hz but {SAMPLE_RATE_HZ} Hz is \
             required. Set it to 48000 Hz in Audio MIDI Setup (macOS) or your sound settings."
        )));
    }

    let config = StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    tracing::info!(
        device = %device_name,
        ?format,
        channels,
        sample_rate,
        "opening playback stream"
    );

    let err_fn = |e| tracing::warn!("output stream error: {e}");
    let ch = channels as usize;

    // Each arm pulls mono samples, expands them across the device's
    // channels, and converts to the device's native sample format.
    macro_rules! build {
        ($sample:ty, $from_f32:expr, $silence:expr) => {{
            let queue = queue.clone();
            let controls = controls.clone();
            device.build_output_stream(
                &config,
                move |data: &mut [$sample], _: &cpal::OutputCallbackInfo| {
                    let frames = data.len() / ch;
                    let mut mono = vec![0.0f32; frames];
                    let got = queue.pop_into(&mut mono);
                    // Anything we could not fill stays silent, so an
                    // underrun is quiet rather than noisy.
                    for s in mono.iter_mut().skip(got) {
                        *s = 0.0;
                    }
                    controls.output_level.set(peak(&mono[..got]));
                    for (frame_idx, frame) in data.chunks_mut(ch).enumerate() {
                        let v = mono.get(frame_idx).copied().unwrap_or(0.0);
                        for slot in frame.iter_mut() {
                            *slot = $from_f32(v);
                        }
                    }
                    let _ = $silence;
                },
                err_fn,
                None,
            )
        }};
    }

    let stream = match format {
        SampleFormat::F32 => build!(f32, |v: f32| v, 0.0f32),
        SampleFormat::I16 => build!(
            i16,
            |v: f32| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16,
            0i16
        ),
        SampleFormat::U16 => build!(
            u16,
            |v: f32| ((v.clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16,
            32768u16
        ),
        other => {
            return Err(ClientError::Other(anyhow::anyhow!(
                "unsupported output sample format {other:?}"
            )))
        }
    }
    .map_err(|e| ClientError::Other(anyhow::anyhow!("opening speakers: {e}")))?;

    stream
        .play()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("starting speakers: {e}")))?;

    Ok(PlaybackStream {
        _stream: stream,
        config: NegotiatedConfig {
            device_name,
            channels,
            sample_rate,
        },
    })
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
        assert_eq!(q.len(), 3);
    }

    /// The stereo-expansion logic that the mono-only version got wrong:
    /// one mono sample must land in *every* channel of its frame.
    #[test]
    fn mono_expands_across_stereo_frames() {
        let mono = [0.25f32, -0.5, 0.75];
        let ch = 2usize;
        let mut out = vec![0.0f32; mono.len() * ch];
        for (i, frame) in out.chunks_mut(ch).enumerate() {
            let v = mono.get(i).copied().unwrap_or(0.0);
            for slot in frame.iter_mut() {
                *slot = v;
            }
        }
        assert_eq!(out, vec![0.25, 0.25, -0.5, -0.5, 0.75, 0.75]);
    }

    #[test]
    fn underrun_fills_silence_not_garbage() {
        let q = PlaybackQueue::new();
        q.push(&[1.0]); // only one sample for a three-frame buffer
        let frames = 3;
        let mut mono = vec![0.0f32; frames];
        let got = q.pop_into(&mut mono);
        for s in mono.iter_mut().skip(got) {
            *s = 0.0;
        }
        assert_eq!(got, 1);
        assert_eq!(mono, vec![1.0, 0.0, 0.0]);
    }
}
