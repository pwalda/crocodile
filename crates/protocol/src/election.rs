//! Host election: quality vectors and the deterministic election function.
//!
//! Each member periodically broadcasts a [`QualityVector`] describing
//! their fitness as host and as shadow. All peers run the same
//! [`elect`] function on the same set of vectors and converge on the
//! same ordered candidate list, headed by the next host and shadow.
//!
//! Score weights are deliberately conservative and can be tuned without
//! a wire format change; only the *inputs* to the score are part of
//! the wire contract.

use serde::{Deserialize, Serialize};

use crate::ids::DeviceId;
use crate::time::UnixSeconds;

/// A peer's self-reported quality measurements at a point in time.
///
/// All bandwidth numbers are sustained, *not* peak. NAT type and link
/// stability are coarse on purpose — fine-grained categories invite
/// gaming.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualityVector {
    /// Reporting device.
    pub device: DeviceId,
    /// Wall-clock at the time of measurement.
    pub measured_at: UnixSeconds,
    /// Sustained upload bandwidth in kbps.
    pub upload_kbps: u32,
    /// Sustained download bandwidth in kbps.
    pub download_kbps: u32,
    /// Median round-trip latency in milliseconds to other room members
    /// observed in the last measurement window.
    pub median_rtt_ms: u32,
    /// NAT classification.
    pub nat: NatType,
    /// Seconds the current network link has been stable.
    pub link_stable_secs: u32,
    /// User opted in to host duty.
    pub willing_host: bool,
    /// User opted in to shadow duty.
    pub willing_shadow: bool,
}

/// Coarse NAT classification. The election function favours more
/// permissive NATs because they are reachable by a wider set of peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NatType {
    /// Open / full-cone NAT or public IP — best case.
    Open,
    /// Restricted-cone or port-restricted NAT — usually traversable.
    Moderate,
    /// Symmetric NAT — typically not traversable without a relay.
    Symmetric,
    /// Probe failed or status is unknown.
    Unknown,
}

/// Output of [`elect`]: an ordered candidate list with named primary
/// and shadow roles.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Election {
    /// Primary host candidate (highest host-score).
    pub host: Option<DeviceId>,
    /// Hot-standby shadow (highest shadow-score, excluding the host).
    pub shadow: Option<DeviceId>,
    /// Remaining candidates in descending score order. Promoted in turn
    /// if both host and shadow fail.
    pub bench: Vec<DeviceId>,
}

/// Sticky bonus, expressed as a multiplier on the incumbent's host
/// score, that prevents flapping when candidates score closely. 1.15 =
/// 15% boost. Tuned in concert with the score-gap threshold used by
/// the live election loop (not modelled here).
pub const HOST_STICKY_MULTIPLIER: f64 = 1.15;

/// Same idea for the shadow seat.
pub const SHADOW_STICKY_MULTIPLIER: f64 = 1.10;

/// Computes the ordered candidate list given the latest known quality
/// vector from each room member.
///
/// `current_host` and `current_shadow` are taken into account for the
/// sticky bonus — pass `None` if there is no incumbent yet (room is
/// freshly forming).
///
/// Determinism: any two peers with identical inputs (including
/// incumbent identities) produce the same output. Tiebreaks fall back
/// to device-id lexical ordering so two peers never disagree on the
/// outcome even if scores are perfectly equal.
pub fn elect(
    vectors: &[QualityVector],
    current_host: Option<DeviceId>,
    current_shadow: Option<DeviceId>,
) -> Election {
    // Score for the host role: weighted by upload, NAT, stability,
    // latency. Unwilling candidates score 0.
    let host_scored: Vec<(DeviceId, f64)> = vectors
        .iter()
        .map(|v| {
            let mut s = if v.willing_host { host_score(v) } else { 0.0 };
            if Some(v.device) == current_host {
                s *= HOST_STICKY_MULTIPLIER;
            }
            (v.device, s)
        })
        .collect();

    let host = pick_highest(&host_scored);

    // Score for shadow: weighted by download (it receives fan-out but
    // doesn't forward), NAT, stability, latency. Exclude the host from
    // the shadow race.
    let shadow_scored: Vec<(DeviceId, f64)> = vectors
        .iter()
        .filter(|v| Some(v.device) != host)
        .map(|v| {
            let mut s = if v.willing_shadow {
                shadow_score(v)
            } else {
                0.0
            };
            if Some(v.device) == current_shadow {
                s *= SHADOW_STICKY_MULTIPLIER;
            }
            (v.device, s)
        })
        .collect();

    let shadow = pick_highest(&shadow_scored);

    // Bench: everyone else, ordered by shadow score (any failover hits
    // a peer that needs to start receiving fan-out before forwarding).
    let mut bench: Vec<(DeviceId, f64)> = shadow_scored
        .into_iter()
        .filter(|(d, _)| Some(*d) != shadow)
        .collect();
    bench.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.as_bytes().cmp(b.0.as_bytes()))
    });
    let bench: Vec<DeviceId> = bench.into_iter().map(|(d, _)| d).collect();

    Election {
        host,
        shadow,
        bench,
    }
}

fn host_score(v: &QualityVector) -> f64 {
    // NAT is multiplicative, not additive: if peers can't reach you,
    // your upload doesn't matter. Symmetric-NAT peers therefore score
    // near zero regardless of how much upload they advertise.
    let upload = (v.upload_kbps as f64).min(50_000.0) / 50_000.0;
    let latency = latency_factor(v.median_rtt_ms);
    let stability = stability_factor(v.link_stable_secs);
    let nat = nat_factor(v.nat);
    // Weights (within the reachable component): upload 0.65, latency 0.20, stability 0.15.
    nat * (0.65 * upload + 0.20 * latency + 0.15 * stability)
}

fn shadow_score(v: &QualityVector) -> f64 {
    // Same multiplicative-NAT shape, with download replacing upload —
    // the shadow receives fan-out but does not forward.
    let download = (v.download_kbps as f64).min(100_000.0) / 100_000.0;
    let latency = latency_factor(v.median_rtt_ms);
    let stability = stability_factor(v.link_stable_secs);
    let nat = nat_factor(v.nat);
    nat * (0.65 * download + 0.20 * latency + 0.15 * stability)
}

fn latency_factor(rtt_ms: u32) -> f64 {
    // 0ms → 1.0, 200ms → ~0.5, 500ms+ → ~0.0. Smooth not stepped.
    let rtt = rtt_ms as f64;
    1.0 / (1.0 + rtt / 200.0)
}

fn nat_factor(nat: NatType) -> f64 {
    match nat {
        NatType::Open => 1.0,
        NatType::Moderate => 0.7,
        NatType::Symmetric => 0.1, // very poor host; usable as shadow only
        NatType::Unknown => 0.3,
    }
}

fn stability_factor(secs: u32) -> f64 {
    // 0s → 0.0, ~10min → ~0.9, asymptotes to 1.0. Discourages flapping
    // to a peer that just joined.
    let s = secs as f64;
    s / (s + 600.0)
}

fn pick_highest(scored: &[(DeviceId, f64)]) -> Option<DeviceId> {
    scored
        .iter()
        .filter(|(_, s)| *s > 0.0)
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                // Tiebreak on device-id bytes for determinism.
                .then(b.0.as_bytes().cmp(a.0.as_bytes()))
        })
        .map(|(d, _)| *d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qv(id: u8, ul: u32, dl: u32, rtt: u32, nat: NatType, stable: u32) -> QualityVector {
        QualityVector {
            device: DeviceId::from_bytes([id; 32]),
            measured_at: UnixSeconds(0),
            upload_kbps: ul,
            download_kbps: dl,
            median_rtt_ms: rtt,
            nat,
            link_stable_secs: stable,
            willing_host: true,
            willing_shadow: true,
        }
    }

    #[test]
    fn highest_upload_wins_host() {
        let vs = vec![
            qv(1, 1_000, 10_000, 50, NatType::Open, 3600),
            qv(2, 20_000, 50_000, 50, NatType::Open, 3600),
            qv(3, 5_000, 30_000, 50, NatType::Open, 3600),
        ];
        let e = elect(&vs, None, None);
        assert_eq!(e.host, Some(DeviceId::from_bytes([2; 32])));
    }

    #[test]
    fn symmetric_nat_loses_to_open() {
        let vs = vec![
            qv(1, 100_000, 100_000, 30, NatType::Symmetric, 9999),
            qv(2, 5_000, 5_000, 30, NatType::Open, 9999),
        ];
        let e = elect(&vs, None, None);
        // Symmetric is heavily penalised; the open-NAT peer should win
        // unless the open peer's upload is *very* low.
        assert_eq!(e.host, Some(DeviceId::from_bytes([2; 32])));
    }

    #[test]
    fn shadow_excludes_host() {
        let vs = vec![
            qv(1, 50_000, 50_000, 50, NatType::Open, 3600),
            qv(2, 10_000, 50_000, 50, NatType::Open, 3600),
            qv(3, 5_000, 30_000, 50, NatType::Open, 3600),
        ];
        let e = elect(&vs, None, None);
        assert_eq!(e.host, Some(DeviceId::from_bytes([1; 32])));
        assert_ne!(e.shadow, e.host);
        assert_eq!(e.shadow, Some(DeviceId::from_bytes([2; 32])));
    }

    #[test]
    fn sticky_bonus_keeps_incumbent_when_close() {
        let challenger = qv(1, 10_000, 10_000, 50, NatType::Open, 3600);
        let incumbent = qv(2, 9_500, 10_000, 50, NatType::Open, 3600);
        let vs = vec![challenger, incumbent];

        // Without sticky: challenger wins.
        let fresh = elect(&vs, None, None);
        assert_eq!(fresh.host, Some(DeviceId::from_bytes([1; 32])));

        // With incumbent: incumbent keeps the seat.
        let with_incumbent = elect(&vs, Some(DeviceId::from_bytes([2; 32])), None);
        assert_eq!(with_incumbent.host, Some(DeviceId::from_bytes([2; 32])));
    }

    #[test]
    fn unwilling_host_never_wins() {
        let mut a = qv(1, 50_000, 50_000, 50, NatType::Open, 3600);
        a.willing_host = false;
        let b = qv(2, 1_000, 1_000, 200, NatType::Moderate, 60);
        let e = elect(&[a, b], None, None);
        assert_eq!(e.host, Some(DeviceId::from_bytes([2; 32])));
    }

    #[test]
    fn empty_input_yields_no_host() {
        let e = elect(&[], None, None);
        assert_eq!(e.host, None);
        assert_eq!(e.shadow, None);
        assert!(e.bench.is_empty());
    }

    #[test]
    fn deterministic_under_exact_tie() {
        let vs = vec![
            qv(1, 10_000, 10_000, 50, NatType::Open, 3600),
            qv(2, 10_000, 10_000, 50, NatType::Open, 3600),
            qv(3, 10_000, 10_000, 50, NatType::Open, 3600),
        ];
        let a = elect(&vs, None, None);
        let b = elect(&vs, None, None);
        assert_eq!(a, b);
    }
}
