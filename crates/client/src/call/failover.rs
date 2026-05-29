//! Failover detection: keepalive timeouts and complaint accounting.
//!
//! Owns no state about the election seats themselves — it only signals
//! "something is wrong with the host" and lets the surrounding runtime
//! call into [`super::election::ElectionState`] to act.
//!
//! Two trigger paths:
//!
//! 1. **Keepalive timeout.** Hosts emit
//!    [`crocodile_protocol::peer::PeerMessage::HostKeepalive`] every
//!    200 ms; after [`DEFAULT_KEEPALIVE_TIMEOUT`] of silence we trigger
//!    immediate shadow promotion.
//! 2. **Complaint threshold.** Members observing degraded service
//!    from the current host (loss / latency / silence) emit a
//!    [`crocodile_protocol::peer::PeerMessage::HostComplaint`]. When
//!    `threshold_fraction` of the room has complained against the
//!    current host's logical clock, we force re-election with the
//!    host excluded.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::peer::ComplaintReason;
use crocodile_protocol::time::UnixSeconds;

/// Default time without a host keepalive before we promote the shadow.
/// Two missed beats at 200 ms each; balance reaction speed vs. false
/// positives on jittery links.
pub const DEFAULT_KEEPALIVE_TIMEOUT: Duration = Duration::from_millis(400);

/// Fraction of members that must complain about the current host
/// before we force re-election. 0.30 = 30%. Tuned together with the
/// per-peer complaint hysteresis (not modelled here; complaints arrive
/// pre-debounced by the senders).
pub const DEFAULT_COMPLAINT_THRESHOLD: f64 = 0.30;

/// Reason a failover was triggered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailoverTrigger {
    /// No keepalive from the current host for `timeout`. Caller should
    /// invoke [`super::election::ElectionState::promote_shadow`].
    KeepaliveTimeout {
        /// Host whose silence triggered this.
        host: DeviceId,
        /// Time of the last received keepalive (or registration time
        /// if none was ever received).
        last_keepalive_at: UnixSeconds,
    },
    /// Enough members complained about the current host to force a
    /// re-election that excludes them. Caller should invoke
    /// [`super::election::ElectionState::force_reelection_excluding_current_host`].
    ComplaintThresholdReached {
        /// Host being voted out.
        host: DeviceId,
        /// Number of distinct complainants observed.
        complaint_count: usize,
        /// Total members the threshold was measured against.
        total_members: usize,
    },
}

/// Tracks complaints against a particular host clock.
#[derive(Debug, Default, Clone)]
pub struct ComplaintTracker {
    /// `host_clock` → set of complaining device ids.
    by_clock: HashMap<u64, HashSet<DeviceId>>,
}

impl ComplaintTracker {
    /// Construct an empty tracker.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a complaint from `complainant` against the host at
    /// `host_clock`. Idempotent — repeat complaints from the same
    /// device against the same clock count once.
    pub fn record(&mut self, complainant: DeviceId, host_clock: u64, _reason: ComplaintReason) {
        self.by_clock
            .entry(host_clock)
            .or_default()
            .insert(complainant);
    }

    /// Number of distinct complainants against `host_clock`.
    pub fn count_for(&self, host_clock: u64) -> usize {
        self.by_clock
            .get(&host_clock)
            .map(|s| s.len())
            .unwrap_or(0)
    }

    /// Forget complaints for clocks ≤ `up_to_clock` (called after a
    /// successful host change so stale complaints don't linger).
    pub fn forget_up_to(&mut self, up_to_clock: u64) {
        self.by_clock.retain(|c, _| *c > up_to_clock);
    }
}

/// Failover detector. Owns:
///
/// - `current_host` and `current_host_clock` (set by the runtime when
///   the election state machine moves the host seat).
/// - last keepalive timestamp.
/// - complaint tracker.
///
/// Stateless across host changes for complaints: when the host moves,
/// the tracker is cleared for the old clock.
#[derive(Debug)]
pub struct FailoverDetector {
    current_host: Option<DeviceId>,
    current_host_clock: Option<u64>,
    /// Timestamp of last received keepalive, or the time we adopted
    /// this host (so the timeout doesn't fire spuriously right after
    /// promotion).
    last_keepalive_at: Option<UnixSeconds>,
    keepalive_timeout: Duration,
    complaints: ComplaintTracker,
    complaint_threshold: f64,
}

impl Default for FailoverDetector {
    fn default() -> Self {
        Self {
            current_host: None,
            current_host_clock: None,
            last_keepalive_at: None,
            keepalive_timeout: DEFAULT_KEEPALIVE_TIMEOUT,
            complaints: ComplaintTracker::new(),
            complaint_threshold: DEFAULT_COMPLAINT_THRESHOLD,
        }
    }
}

impl FailoverDetector {
    /// Fresh detector with defaults.
    pub fn new() -> Self {
        Self::default()
    }

    /// Override the keepalive timeout. Mostly for tests.
    pub fn with_keepalive_timeout(mut self, timeout: Duration) -> Self {
        self.keepalive_timeout = timeout;
        self
    }

    /// Override the complaint threshold fraction.
    pub fn with_complaint_threshold(mut self, fraction: f64) -> Self {
        self.complaint_threshold = fraction;
        self
    }

    /// Borrow the underlying complaint tracker (mostly for tests).
    pub fn complaints(&self) -> &ComplaintTracker {
        &self.complaints
    }

    /// Update the currently-tracked host (called when the runtime
    /// applies an election event).
    pub fn host_changed(&mut self, new_host: DeviceId, new_clock: u64, now: UnixSeconds) {
        if let Some(prev_clock) = self.current_host_clock {
            self.complaints.forget_up_to(prev_clock);
        }
        self.current_host = Some(new_host);
        self.current_host_clock = Some(new_clock);
        self.last_keepalive_at = Some(now);
    }

    /// Clear current host (called when the runtime can't elect one).
    pub fn host_cleared(&mut self) {
        if let Some(prev_clock) = self.current_host_clock {
            self.complaints.forget_up_to(prev_clock);
        }
        self.current_host = None;
        self.current_host_clock = None;
        self.last_keepalive_at = None;
    }

    /// Record a keepalive from `host` at logical clock `clock`. Stale
    /// clocks (older than current) are ignored — that defeats split-
    /// brain where a deposed host keeps shouting.
    pub fn record_keepalive(&mut self, host: DeviceId, clock: u64, now: UnixSeconds) {
        if Some(host) != self.current_host {
            return;
        }
        match self.current_host_clock {
            Some(curr) if clock < curr => return,
            _ => {}
        }
        // If the keepalive carries a *newer* clock, update — this
        // happens when the host emits a HostHandover and ratchets the
        // clock; the surrounding runtime will also push the new clock
        // via host_changed, but we accept either order.
        self.current_host_clock = Some(clock);
        self.last_keepalive_at = Some(now);
    }

    /// Record a complaint from `from` against the currently-tracked
    /// host's clock. Complaints against any other clock are dropped
    /// silently (the complainant is behind).
    pub fn record_complaint(
        &mut self,
        from: DeviceId,
        against_clock: u64,
        reason: ComplaintReason,
    ) {
        if Some(against_clock) != self.current_host_clock {
            return;
        }
        self.complaints.record(from, against_clock, reason);
    }

    /// Periodic check. Returns a trigger if the keepalive has timed
    /// out OR if the complaint threshold has been reached.
    ///
    /// `total_members` is used for the complaint-fraction
    /// computation; pass the room's current member count.
    pub fn check(
        &mut self,
        now: UnixSeconds,
        total_members: usize,
    ) -> Option<FailoverTrigger> {
        let host = self.current_host?;
        let host_clock = self.current_host_clock?;

        // Keepalive timeout first — it's the more decisive signal.
        if let Some(last) = self.last_keepalive_at {
            let elapsed = now
                .get()
                .saturating_sub(last.get())
                .max(0);
            // UnixSeconds is at second resolution; treat any non-zero
            // difference past the second cutoff as elapsed. Sub-second
            // resolution would need a finer clock — out of scope here.
            if Duration::from_secs(elapsed as u64) >= self.keepalive_timeout {
                return Some(FailoverTrigger::KeepaliveTimeout {
                    host,
                    last_keepalive_at: last,
                });
            }
        }

        // Complaint threshold.
        let n = self.complaints.count_for(host_clock);
        if total_members > 0 {
            let fraction = n as f64 / total_members as f64;
            if fraction >= self.complaint_threshold {
                return Some(FailoverTrigger::ComplaintThresholdReached {
                    host,
                    complaint_count: n,
                    total_members,
                });
            }
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    #[test]
    fn keepalive_silence_triggers_timeout() {
        let host = device(1);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(2));
        fd.host_changed(host, 1, UnixSeconds(100));

        // 1 s later: still within window.
        assert!(fd.check(UnixSeconds(101), 3).is_none());

        // 2 s later: timeout fires.
        let trigger = fd.check(UnixSeconds(102), 3);
        assert!(matches!(trigger, Some(FailoverTrigger::KeepaliveTimeout { .. })));
    }

    #[test]
    fn keepalive_arrival_resets_timer() {
        let host = device(1);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(2));
        fd.host_changed(host, 1, UnixSeconds(100));

        // Keepalive at t=101 keeps us alive.
        fd.record_keepalive(host, 1, UnixSeconds(101));
        assert!(fd.check(UnixSeconds(102), 3).is_none());

        // Now silence — fires at t=103 (101 + 2s).
        let trigger = fd.check(UnixSeconds(103), 3);
        assert!(matches!(trigger, Some(FailoverTrigger::KeepaliveTimeout { .. })));
    }

    #[test]
    fn stale_keepalive_is_ignored() {
        let host = device(1);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(2));
        fd.host_changed(host, 5, UnixSeconds(100));

        // Deposed host shouts with old clock — must not extend our
        // patience.
        fd.record_keepalive(host, 3, UnixSeconds(101));
        let trigger = fd.check(UnixSeconds(102), 3);
        assert!(matches!(trigger, Some(FailoverTrigger::KeepaliveTimeout { .. })));
    }

    #[test]
    fn complaint_threshold_triggers() {
        let host = device(1);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(3600)) // disable keepalive trigger
            .with_complaint_threshold(0.3);
        fd.host_changed(host, 1, UnixSeconds(100));

        // 3 distinct complainants, 10-member room → 30% exactly = threshold.
        for byte in 2..=4 {
            fd.record_complaint(device(byte), 1, ComplaintReason::Loss);
        }
        let trigger = fd.check(UnixSeconds(101), 10);
        assert!(matches!(
            trigger,
            Some(FailoverTrigger::ComplaintThresholdReached { complaint_count: 3, .. })
        ));
    }

    #[test]
    fn duplicate_complaints_count_once() {
        let host = device(1);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(3600))
            .with_complaint_threshold(0.5);
        fd.host_changed(host, 1, UnixSeconds(100));

        // Same complainant 3 times — counts as 1.
        for _ in 0..3 {
            fd.record_complaint(device(2), 1, ComplaintReason::Loss);
        }
        assert_eq!(fd.complaints().count_for(1), 1);
    }

    #[test]
    fn complaints_against_other_clock_dropped() {
        let host = device(1);
        let mut fd = FailoverDetector::new();
        fd.host_changed(host, 5, UnixSeconds(100));

        fd.record_complaint(device(2), 3, ComplaintReason::Loss);
        fd.record_complaint(device(2), 5, ComplaintReason::Loss);
        assert_eq!(fd.complaints().count_for(3), 0);
        assert_eq!(fd.complaints().count_for(5), 1);
    }

    #[test]
    fn host_change_clears_old_complaints() {
        let host_a = device(1);
        let host_b = device(2);
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(3600));
        fd.host_changed(host_a, 1, UnixSeconds(100));

        fd.record_complaint(device(3), 1, ComplaintReason::Loss);
        fd.record_complaint(device(4), 1, ComplaintReason::Loss);
        assert_eq!(fd.complaints().count_for(1), 2);

        fd.host_changed(host_b, 2, UnixSeconds(101));
        assert_eq!(fd.complaints().count_for(1), 0);
    }
}
