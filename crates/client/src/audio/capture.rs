//! Microphone capture via cpal.
//!
//! Opens the device using **its own supported configuration** rather
//! than forcing one. An earlier version hardcoded 48 kHz mono for every
//! device; hardware that only offers stereo silently produced wrong or
//! absent audio, because CoreAudio accepts a mismatched channel count
//! without returning an error. We now read the device's config, then
//! downmix to the mono the Opus pipeline expects.
//!
//! The cpal `Stream` is not `Send` on all platforms, so [`CaptureStream`]
//! must be held on the thread that created it.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use tokio::sync::mpsc::UnboundedSender;

use crate::error::{ClientError, Result};

use super::controls::{peak, AudioControls};
use super::SAMPLE_RATE_HZ;

/// Live capture stream. Drop to stop.
pub struct CaptureStream {
    _stream: cpal::Stream,
    /// The configuration actually negotiated with the device, for
    /// display and diagnostics.
    config: NegotiatedConfig,
}

/// What we actually opened, after negotiating with the hardware.
#[derive(Debug, Clone)]
pub struct NegotiatedConfig {
    /// Device name as reported by the OS.
    pub device_name: String,
    /// Channel count the device is delivering.
    pub channels: u16,
    /// Sample rate in Hz.
    pub sample_rate: u32,
}

impl std::fmt::Debug for CaptureStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptureStream")
            .field("config", &self.config)
            .finish()
    }
}

impl CaptureStream {
    /// The configuration negotiated with the device.
    pub fn config(&self) -> &NegotiatedConfig {
        &self.config
    }
}

/// Names of all available input devices.
pub fn list_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|ds| ds.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// Open the default input device.
pub fn open_default(
    sink: UnboundedSender<Vec<f32>>,
    controls: Arc<AudioControls>,
) -> Result<CaptureStream> {
    open_by_name(None, sink, controls)
}

/// Open an input device by name, falling back to the default when
/// `name` is `None` or no device matches.
pub fn open_by_name(
    name: Option<&str>,
    sink: UnboundedSender<Vec<f32>>,
    controls: Arc<AudioControls>,
) -> Result<CaptureStream> {
    let host = cpal::default_host();
    let device = match name {
        Some(want) => host
            .input_devices()
            .ok()
            .and_then(|mut ds| ds.find(|d| d.name().map(|n| n == want).unwrap_or(false)))
            .or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    }
    .ok_or_else(|| {
        ClientError::Other(anyhow::anyhow!(
            "no microphone available. On macOS also check \
             System Settings > Privacy & Security > Microphone."
        ))
    })?;
    open_on_device(&device, sink, controls)
}

/// Open a specific device, negotiating its supported configuration.
pub fn open_on_device(
    device: &Device,
    sink: UnboundedSender<Vec<f32>>,
    controls: Arc<AudioControls>,
) -> Result<CaptureStream> {
    let supported = device
        .default_input_config()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("reading input config: {e}")))?;

    let device_name = device.name().unwrap_or_else(|_| "?".to_string());
    let format = supported.sample_format();
    // Take the device's own channel count and rate. Forcing our own was
    // the bug; we adapt in software instead.
    let channels = supported.channels();
    let sample_rate = supported.sample_rate().0;

    if sample_rate != SAMPLE_RATE_HZ {
        // Opus needs 48 kHz here and we do not ship a resampler yet.
        // Fail loudly rather than emit chipmunk audio.
        return Err(ClientError::Other(anyhow::anyhow!(
            "microphone '{device_name}' runs at {sample_rate} Hz but {SAMPLE_RATE_HZ} Hz is \
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
        "opening capture stream"
    );

    let err_fn = |e| tracing::warn!("input stream error: {e}");
    let ch = channels as usize;

    // Each arm converts the device's native sample format to f32, then
    // downmixes to mono and forwards.
    macro_rules! build {
        ($sample:ty, $to_f32:expr) => {{
            let sink = sink.clone();
            let controls = controls.clone();
            device.build_input_stream(
                &config,
                move |data: &[$sample], _: &cpal::InputCallbackInfo| {
                    let converted: Vec<f32> = data.iter().copied().map($to_f32).collect();
                    let mono = downmix_to_mono(&converted, ch);
                    controls.input_level.set(peak(&mono));
                    // Mute replaces the signal with silence so nothing
                    // intelligible is encoded or transmitted.
                    let out = if controls.is_muted() {
                        vec![0.0; mono.len()]
                    } else {
                        mono
                    };
                    let _ = sink.send(out);
                },
                err_fn,
                None,
            )
        }};
    }

    let stream = match format {
        SampleFormat::F32 => build!(f32, |s| s),
        SampleFormat::I16 => build!(i16, |s| s as f32 / i16::MAX as f32),
        SampleFormat::U16 => build!(u16, |s| (s as f32 - 32768.0) / 32768.0),
        other => {
            return Err(ClientError::Other(anyhow::anyhow!(
                "unsupported input sample format {other:?}"
            )))
        }
    }
    .map_err(|e| ClientError::Other(anyhow::anyhow!("opening microphone: {e}")))?;

    stream
        .play()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("starting microphone: {e}")))?;

    Ok(CaptureStream {
        _stream: stream,
        config: NegotiatedConfig {
            device_name,
            channels,
            sample_rate,
        },
    })
}

/// Average interleaved `channels`-channel audio down to mono.
///
/// Averaging (rather than taking channel 0) keeps signal from a source
/// panned hard to one side.
pub(crate) fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_passthrough_is_unchanged() {
        let input = vec![0.1, 0.2, 0.3];
        assert_eq!(downmix_to_mono(&input, 1), input);
    }

    #[test]
    fn stereo_averages_channel_pairs() {
        // Frames: (1.0, 0.0) (0.5, 0.5) (-1.0, 1.0)
        let input = vec![1.0, 0.0, 0.5, 0.5, -1.0, 1.0];
        let mono = downmix_to_mono(&input, 2);
        assert_eq!(mono, vec![0.5, 0.5, 0.0]);
    }

    #[test]
    fn hard_panned_source_survives_downmix() {
        // Signal only in the right channel must not vanish.
        let input = vec![0.0, 0.8, 0.0, 0.6];
        let mono = downmix_to_mono(&input, 2);
        assert!(mono.iter().all(|&s| s > 0.0), "got {mono:?}");
    }

    #[test]
    fn partial_trailing_frame_is_dropped() {
        // chunks_exact ignores a trailing partial frame rather than
        // emitting a misaligned sample.
        let input = vec![1.0, 1.0, 0.5];
        assert_eq!(downmix_to_mono(&input, 2), vec![1.0]);
    }
}
