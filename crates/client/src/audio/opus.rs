//! Opus encoder/decoder wrappers.
//!
//! Configured for 48 kHz mono VoIP, 32 kbps. Frame sizes are fixed at
//! [`super::SAMPLES_PER_FRAME`] (960 samples = 20 ms). The wrappers
//! accept i16 PCM (the format Opus actually consumes); conversion
//! from cpal's f32 happens at the call site.

use opus::{Application, Channels, Decoder, Encoder};

use crate::error::{ClientError, Result};

use super::{CHANNELS, SAMPLES_PER_FRAME, SAMPLE_RATE_HZ};

/// Target bitrate in bits per second. 32 kbps is high-quality voice;
/// the host election budget (see `ARCHITECTURE.md` §4) is sized for
/// this number.
pub const TARGET_BITRATE_BPS: i32 = 32_000;

/// Wraps an [`opus::Encoder`] with our pinned configuration.
pub struct OpusEncoder {
    inner: Encoder,
}

impl std::fmt::Debug for OpusEncoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpusEncoder")
            .field("sample_rate_hz", &SAMPLE_RATE_HZ)
            .field("channels", &CHANNELS)
            .finish()
    }
}

impl OpusEncoder {
    /// Create a new encoder.
    pub fn new() -> Result<Self> {
        let mut inner =
            Encoder::new(SAMPLE_RATE_HZ, channels_const(), Application::Voip).map_err(opus_err)?;
        inner
            .set_bitrate(opus::Bitrate::Bits(TARGET_BITRATE_BPS))
            .map_err(opus_err)?;
        Ok(Self { inner })
    }

    /// Encode exactly one frame of i16 PCM samples. `pcm.len()` must
    /// equal [`super::SAMPLES_PER_FRAME`].
    pub fn encode_frame(&mut self, pcm: &[i16]) -> Result<Vec<u8>> {
        if pcm.len() != SAMPLES_PER_FRAME {
            return Err(ClientError::Other(anyhow::anyhow!(
                "expected {SAMPLES_PER_FRAME}-sample frame, got {}",
                pcm.len()
            )));
        }
        // Generous output buffer; actual encoded sizes are ~80 bytes
        // at 32 kbps but Opus can spike during transients.
        let mut out = vec![0u8; 4000];
        let n = self.inner.encode(pcm, &mut out).map_err(opus_err)?;
        out.truncate(n);
        Ok(out)
    }
}

/// Wraps an [`opus::Decoder`] with our pinned configuration.
pub struct OpusDecoder {
    inner: Decoder,
}

impl std::fmt::Debug for OpusDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpusDecoder").finish()
    }
}

impl OpusDecoder {
    /// Create a new decoder.
    pub fn new() -> Result<Self> {
        let inner = Decoder::new(SAMPLE_RATE_HZ, channels_const()).map_err(opus_err)?;
        Ok(Self { inner })
    }

    /// Decode one frame into exactly [`super::SAMPLES_PER_FRAME`]
    /// samples of i16 PCM. Passing `None` invokes Opus's packet-loss
    /// concealment (PLC) to fabricate a frame for missing audio.
    pub fn decode_frame(&mut self, encoded: Option<&[u8]>) -> Result<Vec<i16>> {
        let mut pcm = vec![0i16; SAMPLES_PER_FRAME];
        let n = self
            .inner
            .decode(encoded.unwrap_or(&[]), &mut pcm, false)
            .map_err(opus_err)?;
        pcm.truncate(n);
        Ok(pcm)
    }
}

fn channels_const() -> Channels {
    // We pin CHANNELS = 1 (mono). If that ever changes, this match
    // grows.
    match CHANNELS {
        1 => Channels::Mono,
        2 => Channels::Stereo,
        n => panic!("unsupported channel count {n}"),
    }
}

fn opus_err(e: opus::Error) -> ClientError {
    ClientError::Other(anyhow::anyhow!("opus: {e}"))
}

/// Convert f32 PCM in `[-1.0, 1.0]` to i16. Clamps on overflow.
pub fn f32_to_i16(pcm: &[f32]) -> Vec<i16> {
    pcm.iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
        .collect()
}

/// Convert i16 PCM back to f32 in `[-1.0, 1.0]`.
pub fn i16_to_f32(pcm: &[i16]) -> Vec<f32> {
    pcm.iter().map(|&s| s as f32 / i16::MAX as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silent_frame() -> Vec<i16> {
        vec![0i16; SAMPLES_PER_FRAME]
    }

    fn sine_frame(freq_hz: f32) -> Vec<i16> {
        (0..SAMPLES_PER_FRAME)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE_HZ as f32;
                let s = (2.0 * std::f32::consts::PI * freq_hz * t).sin();
                (s * (i16::MAX as f32) * 0.5) as i16
            })
            .collect()
    }

    #[test]
    fn encode_silence_is_short() {
        let mut enc = OpusEncoder::new().unwrap();
        let encoded = enc.encode_frame(&silent_frame()).unwrap();
        // Silence compresses very well; expect well under 50 bytes.
        assert!(
            encoded.len() <= 50,
            "silence frame was {} bytes",
            encoded.len()
        );
    }

    #[test]
    fn encode_decode_roundtrip_preserves_shape() {
        let mut enc = OpusEncoder::new().unwrap();
        let mut dec = OpusDecoder::new().unwrap();

        let pcm = sine_frame(440.0);
        let encoded = enc.encode_frame(&pcm).unwrap();
        let decoded = dec.decode_frame(Some(&encoded)).unwrap();

        assert_eq!(decoded.len(), SAMPLES_PER_FRAME);
        // Opus is lossy; we don't expect exact equality, but the
        // decoded signal should have similar energy to the input.
        let in_energy: i64 = pcm.iter().map(|&s| (s as i64).pow(2)).sum();
        let out_energy: i64 = decoded.iter().map(|&s| (s as i64).pow(2)).sum();
        let ratio = out_energy as f64 / in_energy as f64;
        assert!(
            (0.3..3.0).contains(&ratio),
            "decoded energy ratio {ratio} outside reasonable bounds"
        );
    }

    #[test]
    fn decode_none_invokes_plc() {
        let mut dec = OpusDecoder::new().unwrap();
        // Without any prior context Opus PLC produces silence.
        // Any frame returned is fine; we just want the call to succeed.
        let frame = dec.decode_frame(None).unwrap();
        assert_eq!(frame.len(), SAMPLES_PER_FRAME);
    }

    #[test]
    fn encode_rejects_wrong_frame_size() {
        let mut enc = OpusEncoder::new().unwrap();
        let too_short = vec![0i16; SAMPLES_PER_FRAME - 1];
        assert!(enc.encode_frame(&too_short).is_err());
    }

    #[test]
    fn f32_i16_roundtrip() {
        let f = vec![0.0, 0.5, -0.5, 1.0, -1.0, 2.0 /* clamps */];
        let i = f32_to_i16(&f);
        // Spot-check the bounds.
        assert_eq!(i[0], 0);
        assert!(i[3] >= i16::MAX - 1); // 1.0 → ~max
        assert!(i[4] <= -(i16::MAX - 1)); // -1.0 → ~min
        assert_eq!(i[5], i16::MAX); // clamped

        let f2 = i16_to_f32(&i);
        // Roundtrip within 1/i16::MAX precision.
        assert!((f2[1] - 0.5).abs() < 1e-3);
    }
}
