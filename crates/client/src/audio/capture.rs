//! Microphone capture via cpal.
//!
//! Holds a live cpal input `Stream` and forwards PCM samples to a
//! caller-provided sink. The stream is not Send-safe on all platforms,
//! so the [`CaptureStream`] handle is held wherever it was created —
//! typically the main thread.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use tokio::sync::mpsc::UnboundedSender;

use crate::error::{ClientError, Result};

use super::{CHANNELS, SAMPLE_RATE_HZ};

/// Live capture stream. Drop to stop.
pub struct CaptureStream {
    _stream: cpal::Stream,
}

impl std::fmt::Debug for CaptureStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptureStream").finish()
    }
}

/// Open the default input device at 48 kHz mono, forwarding f32 PCM
/// samples to `sink` as they're delivered by the OS.
///
/// `sink` is invoked from the cpal audio thread. Sending via a
/// tokio `UnboundedSender` is safe from any thread.
pub fn open_default(sink: UnboundedSender<Vec<f32>>) -> Result<CaptureStream> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| ClientError::Other(anyhow::anyhow!("no default input device")))?;
    open_on_device(&device, sink)
}

/// Like [`open_default`] but lets the caller pick a specific device.
pub fn open_on_device(device: &Device, sink: UnboundedSender<Vec<f32>>) -> Result<CaptureStream> {
    let supported = device
        .default_input_config()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("default_input_config: {e}")))?;
    // We want 48 kHz mono. The device's default may not be exactly
    // that — clamp here, and if it can't honour we fall through to an
    // explicit StreamConfig with our values.
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
        "opening capture stream",
    );

    let sink_clone = Arc::new(sink);
    let err_fn = |e| tracing::warn!("input stream error: {e}");

    let stream = match format {
        SampleFormat::F32 => {
            let sink = sink_clone.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let _ = sink.send(data.to_vec());
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let sink = sink_clone.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    // Convert i16 → f32 in [-1, 1].
                    let f: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    let _ = sink.send(f);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let sink = sink_clone.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let f: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .collect();
                    let _ = sink.send(f);
                },
                err_fn,
                None,
            )
        }
        other => {
            return Err(ClientError::Other(anyhow::anyhow!(
                "unsupported input sample format {other:?}"
            )))
        }
    }
    .map_err(|e| ClientError::Other(anyhow::anyhow!("build_input_stream: {e}")))?;

    stream
        .play()
        .map_err(|e| ClientError::Other(anyhow::anyhow!("input stream play: {e}")))?;

    Ok(CaptureStream { _stream: stream })
}
