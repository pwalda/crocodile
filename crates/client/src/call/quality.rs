//! Build [`QualityVector`]s from observed network conditions.
//!
//! This module is pure: it accepts samples (bytes counters, RTT
//! observations, NAT class, link uptime) and produces a quality
//! vector ready to be signed and gossiped. It does no I/O of its own
//! — the runtime is responsible for collecting samples (via QUIC
//! datagram round-trips, STUN classification, etc.) and feeding them
//! in.
//!
//! Keeping the aggregation here lets us unit-test the rolling window
//! arithmetic without involving any network.

use std::collections::VecDeque;
use std::time::Duration;

use crocodile_protocol::election::{NatType, QualityVector};
use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::time::UnixSeconds;

/// Configuration knobs the user controls.
#[derive(Debug, Clone)]
pub struct QualityConfig {
    /// User opted in to host duty.
    pub willing_host: bool,
    /// User opted in to shadow duty.
    pub willing_shadow: bool,
    /// Window over which bandwidth samples are averaged. Defaults to
    /// 5 s — enough to smooth out single-frame bursts without lagging
    /// the election unnecessarily.
    pub bandwidth_window: Duration,
}

impl Default for QualityConfig {
    fn default() -> Self {
        Self {
            willing_host: true,
            willing_shadow: true,
            bandwidth_window: Duration::from_secs(5),
        }
    }
}

/// One bandwidth sample: cumulative bytes counter at a moment in time.
#[derive(Debug, Clone, Copy)]
struct BandwidthSample {
    at: UnixSeconds,
    sent_bytes: u64,
    received_bytes: u64,
}

/// Quality vector builder. Cheap to construct; mutable.
#[derive(Debug)]
pub struct QualityBuilder {
    self_id: DeviceId,
    config: QualityConfig,
    /// Bandwidth samples kept within the rolling window.
    samples: VecDeque<BandwidthSample>,
    /// Recent RTT observations in ms. Bounded.
    rtt_samples: VecDeque<u32>,
    /// Last reported NAT class. Defaults to Unknown until a probe
    /// runs.
    nat: NatType,
    /// Wall-clock seconds the current link has been continuously
    /// stable. Caller resets this when the local socket re-binds or
    /// the OS reports a network change.
    link_stable_secs: u32,
}

impl QualityBuilder {
    /// Construct with the given device id and config.
    pub fn new(self_id: DeviceId, config: QualityConfig) -> Self {
        Self {
            self_id,
            config,
            samples: VecDeque::new(),
            rtt_samples: VecDeque::with_capacity(32),
            nat: NatType::Unknown,
            link_stable_secs: 0,
        }
    }

    /// Record cumulative byte counters at a given time. The runtime
    /// should call this every second or so with the values it reads
    /// from the QUIC connection stats.
    pub fn record_traffic(&mut self, at: UnixSeconds, sent_bytes: u64, received_bytes: u64) {
        self.samples.push_back(BandwidthSample {
            at,
            sent_bytes,
            received_bytes,
        });
        self.evict_old_samples(at);
    }

    /// Record one RTT observation in milliseconds. Keeps a bounded
    /// window of recent values.
    pub fn record_rtt_ms(&mut self, rtt_ms: u32) {
        const MAX_RTT_SAMPLES: usize = 32;
        if self.rtt_samples.len() == MAX_RTT_SAMPLES {
            self.rtt_samples.pop_front();
        }
        self.rtt_samples.push_back(rtt_ms);
    }

    /// Update the NAT classification (typically from a STUN probe).
    pub fn set_nat(&mut self, nat: NatType) {
        self.nat = nat;
    }

    /// Set the link stability counter. Runtime is responsible for
    /// resetting to 0 on network changes.
    pub fn set_link_stable_secs(&mut self, secs: u32) {
        self.link_stable_secs = secs;
    }

    /// Build a quality vector reflecting the most recent measurements.
    /// `now` becomes the `measured_at` field of the result.
    pub fn build(&self, now: UnixSeconds) -> QualityVector {
        let (upload_kbps, download_kbps) = self.bandwidth_kbps();
        QualityVector {
            device: self.self_id,
            measured_at: now,
            upload_kbps,
            download_kbps,
            median_rtt_ms: self.median_rtt_ms(),
            nat: self.nat,
            link_stable_secs: self.link_stable_secs,
            willing_host: self.config.willing_host,
            willing_shadow: self.config.willing_shadow,
        }
    }

    fn evict_old_samples(&mut self, now: UnixSeconds) {
        let cutoff = now.get() - self.config.bandwidth_window.as_secs() as i64;
        while let Some(front) = self.samples.front() {
            if front.at.get() < cutoff {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    fn bandwidth_kbps(&self) -> (u32, u32) {
        if self.samples.len() < 2 {
            return (0, 0);
        }
        let first = *self.samples.front().unwrap();
        let last = *self.samples.back().unwrap();
        let secs = (last.at.get() - first.at.get()).max(1) as u64;
        let sent_delta = last.sent_bytes.saturating_sub(first.sent_bytes);
        let recv_delta = last.received_bytes.saturating_sub(first.received_bytes);
        // bytes/sec → bits/sec → kbps
        let up_kbps = (sent_delta * 8 / secs / 1000) as u32;
        let down_kbps = (recv_delta * 8 / secs / 1000) as u32;
        (up_kbps, down_kbps)
    }

    fn median_rtt_ms(&self) -> u32 {
        if self.rtt_samples.is_empty() {
            return 0;
        }
        let mut sorted: Vec<u32> = self.rtt_samples.iter().copied().collect();
        sorted.sort_unstable();
        sorted[sorted.len() / 2]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    #[test]
    fn bandwidth_zero_until_two_samples() {
        let mut qb = QualityBuilder::new(device(1), QualityConfig::default());
        let v = qb.build(UnixSeconds(0));
        assert_eq!(v.upload_kbps, 0);

        qb.record_traffic(UnixSeconds(0), 0, 0);
        let v = qb.build(UnixSeconds(0));
        assert_eq!(v.upload_kbps, 0);
    }

    #[test]
    fn bandwidth_averages_over_window() {
        let mut qb = QualityBuilder::new(device(1), QualityConfig::default());
        // 10 KB/s sustained for 5 s = 80 kbps.
        for sec in 0..=5 {
            qb.record_traffic(UnixSeconds(sec), (sec as u64) * 10_000, 0);
        }
        let v = qb.build(UnixSeconds(5));
        // 5s * 10000 bytes = 50000 bytes = 400000 bits → 80 kbps over 5s.
        assert_eq!(v.upload_kbps, 80);
    }

    #[test]
    fn samples_older_than_window_are_evicted() {
        let mut qb = QualityBuilder::new(
            device(1),
            QualityConfig {
                bandwidth_window: Duration::from_secs(3),
                ..Default::default()
            },
        );
        for sec in 0..=10 {
            qb.record_traffic(UnixSeconds(sec), (sec as u64) * 1_000, 0);
        }
        // After eviction we should only retain samples newer than 7 (10-3).
        let oldest = qb.samples.front().unwrap().at.get();
        assert!(oldest >= 7);
    }

    #[test]
    fn rtt_median_correct() {
        let mut qb = QualityBuilder::new(device(1), QualityConfig::default());
        for r in [40, 60, 200, 20, 80] {
            qb.record_rtt_ms(r);
        }
        let v = qb.build(UnixSeconds(0));
        // Sorted: 20, 40, 60, 80, 200 — median 60.
        assert_eq!(v.median_rtt_ms, 60);
    }

    #[test]
    fn rtt_window_bounded() {
        let mut qb = QualityBuilder::new(device(1), QualityConfig::default());
        for r in 0..200u32 {
            qb.record_rtt_ms(r);
        }
        assert!(qb.rtt_samples.len() <= 32);
    }

    #[test]
    fn nat_starts_unknown() {
        let qb = QualityBuilder::new(device(1), QualityConfig::default());
        let v = qb.build(UnixSeconds(0));
        assert!(matches!(v.nat, NatType::Unknown));
    }

    #[test]
    fn willing_flags_propagate() {
        let cfg = QualityConfig {
            willing_host: false,
            willing_shadow: true,
            ..Default::default()
        };
        let qb = QualityBuilder::new(device(1), cfg);
        let v = qb.build(UnixSeconds(0));
        assert!(!v.willing_host);
        assert!(v.willing_shadow);
    }

    #[test]
    fn link_stable_persists_until_set() {
        let mut qb = QualityBuilder::new(device(1), QualityConfig::default());
        qb.set_link_stable_secs(123);
        assert_eq!(qb.build(UnixSeconds(0)).link_stable_secs, 123);
        qb.set_link_stable_secs(456);
        assert_eq!(qb.build(UnixSeconds(0)).link_stable_secs, 456);
    }
}
