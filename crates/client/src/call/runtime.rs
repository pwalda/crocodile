//! Call runtime: composes [`super::ElectionState`] and
//! [`super::FailoverDetector`] into a single state machine the
//! eventual N-peer binary speaks to.
//!
//! Side-effect free. The caller pushes inputs (received quality
//! vectors, keepalives, complaints, tick events) and gets back a
//! list of [`RuntimeAction`]s describing what the data plane and
//! signaling layer should do. The runtime *never* touches the
//! network on its own — making it fully unit-testable.
//!
//! State the runtime owns that doesn't fit naturally into either
//! sub-module:
//!
//! - **Self's logical clock**: when `self` is host, the clock the
//!   runtime advances on each handover or initial promotion.
//! - **Last gossip-emit time**: throttling regular vector broadcasts
//!   to the configured interval.
//! - **Pending-handover bookkeeping**: when election wants to swap
//!   host but we're acting as that host today, we owe peers a
//!   `HostHandover` frame before the switch.

use std::collections::HashSet;
use std::time::Duration;

use crocodile_protocol::election::QualityVector;
use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::peer::ComplaintReason;
use crocodile_protocol::time::UnixSeconds;

use super::election::{ChangeReason, ElectionEvent, ElectionState};
use super::failover::{FailoverDetector, FailoverTrigger};

/// Default gossip-broadcast interval. Aligns with the spec's 10 s
/// quality-vector cadence.
pub const DEFAULT_GOSSIP_INTERVAL: Duration = Duration::from_secs(10);

/// Default keepalive emission interval (only when `self` is host).
/// 200 ms matches the architecture's failover budget.
pub const DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_millis(200);

/// Default handover switchover delay. Peers continue sending to the
/// old host for this long before flipping their target to the new one.
pub const DEFAULT_HANDOVER_SWITCH_DELAY: Duration = Duration::from_millis(500);

/// Number of rounds an offender is excluded after a complaint-forced
/// re-election.
pub const COMPLAINT_EXCLUSION_ROUNDS: u32 = 3;

/// What the runtime wants the surrounding system to do next.
///
/// Emitted by [`CallRuntime::tick`] and other input methods.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeAction {
    /// Broadcast a quality vector. Caller signs + sends to all peers.
    BroadcastQualityVector,
    /// Emit a keepalive frame from `self` (only when `self` is host).
    EmitKeepalive {
        /// Current host clock.
        clock: u64,
    },
    /// Announce a host handover. When `self` is the *new* host, we
    /// broadcast this so peers retarget their voice send target.
    BroadcastHandover {
        /// New host's logical clock.
        new_clock: u64,
        /// How long peers should still send to the previous host
        /// before retargeting.
        switch_in: Duration,
    },
    /// `self` should transition into the host role at `clock`.
    BecomeHost {
        /// Clock value the new host should use going forward.
        clock: u64,
    },
    /// `self` should transition into the shadow role.
    BecomeShadow,
    /// `self` should drop into a regular member role.
    BecomeMember,
    /// Notify the data plane that the host seat moved to `new`.
    /// Peers must retarget voice sends to `new` and accept fan-out
    /// from `new` rather than the old host.
    HostMoved {
        /// New host (might be `self` if also accompanied by
        /// `BecomeHost`).
        new: DeviceId,
        /// New host's logical clock.
        new_clock: u64,
    },
    /// Notify the data plane that the shadow seat moved.
    ShadowMoved {
        /// New shadow.
        new: DeviceId,
    },
    /// Election cannot find a viable host. Caller should display a
    /// "no failover available" hint and (eventually) fall back to a
    /// project relay.
    NoViableHost,
    /// Self has observed enough degradation from the current host
    /// to emit a complaint.
    EmitComplaint {
        /// Host being complained about.
        against: DeviceId,
        /// Their logical clock.
        host_clock: u64,
        /// Why.
        reason: ComplaintReason,
    },
}

/// Configuration for [`CallRuntime`].
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// How often to broadcast a fresh quality vector.
    pub gossip_interval: Duration,
    /// How often to emit a keepalive when `self` is host.
    pub keepalive_interval: Duration,
    /// Pre-announce window for handover.
    pub handover_switch_delay: Duration,
    /// Rounds to exclude a complaint-forced ex-host.
    pub exclusion_rounds: u32,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            gossip_interval: DEFAULT_GOSSIP_INTERVAL,
            keepalive_interval: DEFAULT_KEEPALIVE_INTERVAL,
            handover_switch_delay: DEFAULT_HANDOVER_SWITCH_DELAY,
            exclusion_rounds: COMPLAINT_EXCLUSION_ROUNDS,
        }
    }
}

/// The composed runtime.
#[derive(Debug)]
pub struct CallRuntime {
    self_id: DeviceId,
    election: ElectionState,
    failover: FailoverDetector,
    config: RuntimeConfig,
    /// Current logical clock of `self` when acting as host. Bumped on
    /// every transition into the host seat (initial promotion,
    /// emergency, complaint-forced).
    self_host_clock: u64,
    /// Last time we emitted a gossip broadcast.
    last_gossip_at: Option<UnixSeconds>,
    /// Last time we emitted a keepalive (when host).
    last_keepalive_at: Option<UnixSeconds>,
    /// Membership: device ids of currently-known room peers. Lets the
    /// failover detector compute the complaint fraction correctly.
    members: HashSet<DeviceId>,
}

impl CallRuntime {
    /// Construct a new runtime for `self_id`.
    pub fn new(self_id: DeviceId) -> Self {
        let mut members = HashSet::new();
        members.insert(self_id);
        Self {
            self_id,
            election: ElectionState::new(self_id),
            failover: FailoverDetector::new(),
            config: RuntimeConfig::default(),
            self_host_clock: 0,
            last_gossip_at: None,
            last_keepalive_at: None,
            members,
        }
    }

    /// Replace runtime config.
    pub fn with_config(mut self, config: RuntimeConfig) -> Self {
        self.config = config;
        self
    }

    /// Replace the election state (e.g. for tighter test windows).
    pub fn with_election(mut self, election: ElectionState) -> Self {
        self.election = election;
        self
    }

    /// Replace the failover detector.
    pub fn with_failover(mut self, failover: FailoverDetector) -> Self {
        self.failover = failover;
        self
    }

    /// Current host according to election state.
    pub fn current_host(&self) -> Option<DeviceId> {
        self.election.current_host()
    }

    /// Current shadow.
    pub fn current_shadow(&self) -> Option<DeviceId> {
        self.election.current_shadow()
    }

    /// True if `self` is currently the host.
    pub fn is_host(&self) -> bool {
        self.current_host() == Some(self.self_id)
    }

    /// True if `self` is currently the shadow.
    pub fn is_shadow(&self) -> bool {
        self.current_shadow() == Some(self.self_id)
    }

    /// Record (or update) a room member's device id. Idempotent.
    pub fn add_member(&mut self, device: DeviceId) {
        self.members.insert(device);
    }

    /// Drop a member (e.g. they left or were removed from the room).
    pub fn remove_member(&mut self, device: DeviceId) {
        self.members.remove(&device);
    }

    /// Number of room members including `self`.
    pub fn member_count(&self) -> usize {
        self.members.len()
    }

    // ---- Input methods ----

    /// Ingest a quality vector received from a peer.
    pub fn record_quality_vector(&mut self, vector: QualityVector, now: UnixSeconds) {
        self.add_member(vector.device);
        self.election.record_vector(vector, now);
    }

    /// Ingest a keepalive from the (claimed) host.
    pub fn record_keepalive(&mut self, from: DeviceId, clock: u64, now: UnixSeconds) {
        self.failover.record_keepalive(from, clock, now);
    }

    /// Ingest a complaint from another peer.
    pub fn record_complaint(
        &mut self,
        from: DeviceId,
        against_clock: u64,
        reason: ComplaintReason,
    ) {
        self.failover.record_complaint(from, against_clock, reason);
    }

    // ---- The tick ----

    /// Periodic tick. Drives the election + failover detector, decides
    /// what gossip / keepalives to emit, and returns the action list.
    ///
    /// `now` is the caller's monotonic-ish unix-seconds clock.
    pub fn tick(&mut self, now: UnixSeconds) -> Vec<RuntimeAction> {
        let mut actions = Vec::new();

        // 1. Failover check first — keepalive timeout / complaint
        // threshold get priority because they're emergencies.
        // Only meaningful when self is NOT the host (otherwise we'd
        // be monitoring ourselves and would fire spurious alerts
        // before our own keepalive emission interval).
        if !self.is_host() {
            let total = self.member_count();
            let trigger = self.failover.check(now, total);
            match trigger {
                Some(FailoverTrigger::KeepaliveTimeout { .. }) => {
                    if let Some(ev) = self.election.promote_shadow() {
                        self.apply_election_event(ev, now, &mut actions);
                    }
                }
                Some(FailoverTrigger::ComplaintThresholdReached { .. }) => {
                    let events = self
                        .election
                        .force_reelection_excluding_current_host(self.config.exclusion_rounds);
                    for ev in events {
                        self.apply_election_event(ev, now, &mut actions);
                    }
                }
                None => {}
            }
        }

        // 2. Election tick.
        let events = self.election.tick(now);
        for ev in events {
            self.apply_election_event(ev, now, &mut actions);
        }

        // 3. Periodic emissions.
        if self.is_due(self.last_gossip_at, self.config.gossip_interval, now) {
            actions.push(RuntimeAction::BroadcastQualityVector);
            self.last_gossip_at = Some(now);
        }
        if self.is_host()
            && self.is_due(self.last_keepalive_at, self.config.keepalive_interval, now)
        {
            actions.push(RuntimeAction::EmitKeepalive {
                clock: self.self_host_clock,
            });
            self.last_keepalive_at = Some(now);
        }

        actions
    }

    fn apply_election_event(
        &mut self,
        ev: ElectionEvent,
        now: UnixSeconds,
        actions: &mut Vec<RuntimeAction>,
    ) {
        match ev {
            ElectionEvent::HostChanged { from, to, reason } => {
                let new_clock = self.advance_clock_for_change(from, to, reason);
                self.failover.host_changed(to, new_clock, now);

                actions.push(RuntimeAction::HostMoved {
                    new: to,
                    new_clock,
                });

                if to == self.self_id {
                    actions.push(RuntimeAction::BecomeHost { clock: new_clock });
                    self.self_host_clock = new_clock;
                    // Re-broadcast a fresh handover so peers retarget us.
                    actions.push(RuntimeAction::BroadcastHandover {
                        new_clock,
                        switch_in: self.config.handover_switch_delay,
                    });
                    // Reset keepalive emission so the first one fires
                    // immediately on the next tick.
                    self.last_keepalive_at = None;
                } else if from == Some(self.self_id) {
                    // We stepped down.
                    if self.election.current_shadow() == Some(self.self_id) {
                        actions.push(RuntimeAction::BecomeShadow);
                    } else {
                        actions.push(RuntimeAction::BecomeMember);
                    }
                }
            }
            ElectionEvent::ShadowChanged { from, to, .. } => {
                actions.push(RuntimeAction::ShadowMoved { new: to });
                if to == self.self_id {
                    actions.push(RuntimeAction::BecomeShadow);
                } else if from == Some(self.self_id)
                    && self.election.current_host() != Some(self.self_id)
                {
                    actions.push(RuntimeAction::BecomeMember);
                }
            }
            ElectionEvent::NoViableHost => {
                actions.push(RuntimeAction::NoViableHost);
                self.failover.host_cleared();
            }
        }
    }

    fn advance_clock_for_change(
        &mut self,
        _from: Option<DeviceId>,
        to: DeviceId,
        _reason: ChangeReason,
    ) -> u64 {
        // The new host owns the next clock. If `self` is the new
        // host, bump our own clock; otherwise we don't track theirs
        // beyond what they tell us via keepalives. Use the current
        // tracker as the floor.
        let floor = self.failover.current_host_clock().unwrap_or(0);
        let next = floor.saturating_add(1);
        if to == self.self_id {
            self.self_host_clock = next;
        }
        next
    }

    fn is_due(&self, last: Option<UnixSeconds>, interval: Duration, now: UnixSeconds) -> bool {
        match last {
            None => true,
            Some(last) => {
                let elapsed = now.get().saturating_sub(last.get()).max(0) as u64;
                Duration::from_secs(elapsed) >= interval
            }
        }
    }
}

// Add a small public accessor on FailoverDetector for runtime use.
// Kept here as an inherent impl block so the runtime module owns the
// extension point.
impl FailoverDetector {
    /// Returns the current host's tracked logical clock, if any.
    pub fn current_host_clock(&self) -> Option<u64> {
        self.clock_snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::election::NatType;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    fn qv(device: DeviceId, upload: u32, at: i64) -> QualityVector {
        QualityVector {
            device,
            measured_at: UnixSeconds(at),
            upload_kbps: upload,
            download_kbps: upload,
            median_rtt_ms: 50,
            nat: NatType::Open,
            link_stable_secs: 3600,
            willing_host: true,
            willing_shadow: true,
        }
    }

    fn fast_config() -> RuntimeConfig {
        RuntimeConfig {
            gossip_interval: Duration::from_secs(1),
            keepalive_interval: Duration::from_secs(1),
            handover_switch_delay: Duration::from_millis(500),
            exclusion_rounds: 2,
        }
    }

    #[test]
    fn first_tick_broadcasts_gossip() {
        let me = device(1);
        let mut rt = CallRuntime::new(me).with_config(fast_config());
        let actions = rt.tick(UnixSeconds(0));
        assert!(actions.contains(&RuntimeAction::BroadcastQualityVector));
    }

    #[test]
    fn initial_election_emits_host_moved_and_become_role() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let mut rt = CallRuntime::new(me).with_config(fast_config());
        rt.record_quality_vector(qv(alice, 30_000, 100), UnixSeconds(100));
        rt.record_quality_vector(qv(bob, 10_000, 100), UnixSeconds(100));

        let actions = rt.tick(UnixSeconds(100));
        // Alice is host → I (me) should receive HostMoved + BecomeMember
        let host_moved = actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::HostMoved { new, .. } if *new == alice));
        let shadow_moved = actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::ShadowMoved { new, .. } if *new == bob));
        assert!(host_moved);
        assert!(shadow_moved);
        // I'm a regular member.
        assert!(!rt.is_host());
        assert!(!rt.is_shadow());
    }

    #[test]
    fn becoming_host_emits_keepalives() {
        let me = device(1);
        let alice = device(2);
        let mut rt = CallRuntime::new(me).with_config(fast_config());
        // Only me + alice; I have higher upload → I'm host.
        rt.record_quality_vector(qv(me, 30_000, 100), UnixSeconds(100));
        rt.record_quality_vector(qv(alice, 10_000, 100), UnixSeconds(100));
        let _ = rt.tick(UnixSeconds(100));
        assert!(rt.is_host());

        // After becoming host, the next tick (1s later) should emit a keepalive.
        let actions = rt.tick(UnixSeconds(101));
        let has_keepalive = actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::EmitKeepalive { .. }));
        assert!(has_keepalive);
    }

    #[test]
    fn host_silence_triggers_promotion_via_runtime() {
        let me = device(0);
        let alice = device(1);
        let bob = device(2);

        let mut rt = CallRuntime::new(me)
            .with_config(fast_config())
            .with_failover(FailoverDetector::new().with_keepalive_timeout(Duration::from_secs(2)));

        rt.record_quality_vector(qv(alice, 30_000, 100), UnixSeconds(100));
        rt.record_quality_vector(qv(bob, 10_000, 100), UnixSeconds(100));
        let _ = rt.tick(UnixSeconds(100));
        assert_eq!(rt.current_host(), Some(alice));
        assert_eq!(rt.current_shadow(), Some(bob));

        // 3s pass with no keepalive → next tick promotes shadow.
        let actions = rt.tick(UnixSeconds(103));
        assert!(actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::HostMoved { new, .. } if *new == bob)));
        assert_eq!(rt.current_host(), Some(bob));
    }

    #[test]
    fn handover_broadcast_when_self_becomes_host() {
        let me = device(1);
        let alice = device(2);
        let mut rt = CallRuntime::new(me).with_config(fast_config());
        rt.record_quality_vector(qv(me, 30_000, 100), UnixSeconds(100));
        rt.record_quality_vector(qv(alice, 10_000, 100), UnixSeconds(100));
        let actions = rt.tick(UnixSeconds(100));
        assert!(actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::BroadcastHandover { .. })));
        assert!(actions
            .iter()
            .any(|a| matches!(a, RuntimeAction::BecomeHost { .. })));
    }

    #[test]
    fn member_count_grows_on_vector_receipt() {
        let me = device(0);
        let mut rt = CallRuntime::new(me);
        assert_eq!(rt.member_count(), 1);
        rt.record_quality_vector(qv(device(1), 1000, 0), UnixSeconds(0));
        rt.record_quality_vector(qv(device(2), 1000, 0), UnixSeconds(0));
        assert_eq!(rt.member_count(), 3);
    }
}
