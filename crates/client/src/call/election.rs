//! Election state machine.
//!
//! Wraps [`crocodile_protocol::election::elect`] with the runtime
//! plumbing the architecture spec calls out:
//!
//! - Per-device receipt timestamps so stale quality vectors are
//!   excluded from each round's election.
//! - Hysteresis: a swap-eligible challenger must persist for several
//!   consecutive tick rounds before we actually move the seat, so
//!   small score wobbles don't cause oscillation.
//! - Emergency promotion: the runtime can short-circuit hysteresis
//!   when the failover detector signals the host is gone, jumping
//!   the shadow straight into the host seat.
//! - Forced re-election: when complaints push out an adversarial
//!   host, we can re-elect with the current host excluded from
//!   contention.
//!
//! This module never reads a clock on its own; callers pass an
//! explicit `now: UnixSeconds`. Lets tests be fully deterministic.

use std::collections::HashMap;
use std::time::Duration;

use crocodile_protocol::election::{elect, QualityVector};
use crocodile_protocol::ids::DeviceId;
use crocodile_protocol::time::UnixSeconds;

/// How many consecutive election rounds a challenger must lead before
/// taking the seat from an incumbent. With the 10 s gossip interval in
/// the spec, the default of 3 means ~30 s of sustained lead is needed
/// to swap.
pub const DEFAULT_ROUNDS_TO_SWAP: u32 = 3;

/// Quality vectors older than this are dropped from election input.
/// Defaults to 30 s — three normal gossip intervals. Past this, the
/// device is treated as having disappeared.
pub const DEFAULT_STALE_AFTER_SECS: i64 = 30;

/// One peer's most recent quality vector, plus when we received it.
#[derive(Debug, Clone)]
pub struct ReceivedVector {
    /// The signed quality vector itself.
    pub vector: QualityVector,
    /// When this vector was received locally.
    pub received_at: UnixSeconds,
}

/// Reason a host or shadow change happened. Surfaces in events for
/// telemetry / logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeReason {
    /// No prior incumbent; this is the initial assignment.
    InitialAssignment,
    /// Quality-driven swap after the hysteresis window cleared.
    QualitySwap,
    /// Caller invoked [`ElectionState::promote_shadow`] — host failed.
    EmergencyPromotion,
    /// Forced re-election that excluded the previous host
    /// (e.g. complaint threshold reached).
    ComplaintForced,
    /// The incumbent's vector went stale; we re-elected without them.
    IncumbentExpired,
}

/// Outcome events emitted by [`ElectionState::tick`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElectionEvent {
    /// A new device should take the host seat.
    HostChanged {
        /// Previous host (if any).
        from: Option<DeviceId>,
        /// New host.
        to: DeviceId,
        /// Why the change happened.
        reason: ChangeReason,
    },
    /// A new device should take the shadow seat.
    ShadowChanged {
        /// Previous shadow (if any).
        from: Option<DeviceId>,
        /// New shadow.
        to: DeviceId,
        /// Why the change happened.
        reason: ChangeReason,
    },
    /// No viable host candidate exists right now (e.g. only members
    /// behind symmetric NAT remain). Caller should fall back to the
    /// project relay or surface "no failover available."
    NoViableHost,
}

/// Inner tracking state for a pending seat swap.
#[derive(Debug, Clone, Default)]
struct PendingSwap {
    target: Option<DeviceId>,
    consecutive_rounds: u32,
}

impl PendingSwap {
    fn observe(&mut self, candidate: Option<DeviceId>) {
        if candidate.is_none() {
            self.target = None;
            self.consecutive_rounds = 0;
            return;
        }
        if self.target == candidate {
            self.consecutive_rounds = self.consecutive_rounds.saturating_add(1);
        } else {
            self.target = candidate;
            self.consecutive_rounds = 1;
        }
    }

    fn reset(&mut self) {
        self.target = None;
        self.consecutive_rounds = 0;
    }
}

/// Election state machine.
#[derive(Debug)]
pub struct ElectionState {
    self_id: DeviceId,
    vectors: HashMap<DeviceId, ReceivedVector>,
    current_host: Option<DeviceId>,
    current_shadow: Option<DeviceId>,
    pending_host_swap: PendingSwap,
    pending_shadow_swap: PendingSwap,
    /// Devices to *exclude* from the host race for the next several
    /// rounds. Used after a complaint-forced re-election so the
    /// offender doesn't bounce back immediately.
    excluded_hosts: HashMap<DeviceId, u32>,
    stale_after: Duration,
    rounds_to_swap: u32,
}

impl ElectionState {
    /// Construct a fresh state machine for `self_id` (the local device).
    pub fn new(self_id: DeviceId) -> Self {
        Self {
            self_id,
            vectors: HashMap::new(),
            current_host: None,
            current_shadow: None,
            pending_host_swap: PendingSwap::default(),
            pending_shadow_swap: PendingSwap::default(),
            excluded_hosts: HashMap::new(),
            stale_after: Duration::from_secs(DEFAULT_STALE_AFTER_SECS as u64),
            rounds_to_swap: DEFAULT_ROUNDS_TO_SWAP,
        }
    }

    /// Override the staleness window. Mostly useful in tests.
    pub fn with_stale_after(mut self, stale_after: Duration) -> Self {
        self.stale_after = stale_after;
        self
    }

    /// Override the hysteresis depth.
    pub fn with_rounds_to_swap(mut self, rounds: u32) -> Self {
        self.rounds_to_swap = rounds;
        self
    }

    /// Record (or refresh) a peer's quality vector. The hash table
    /// keeps the most recent one per device.
    pub fn record_vector(&mut self, vector: QualityVector, now: UnixSeconds) {
        self.vectors.insert(
            vector.device,
            ReceivedVector {
                vector,
                received_at: now,
            },
        );
    }

    /// Snapshot of the currently-designated host.
    pub fn current_host(&self) -> Option<DeviceId> {
        self.current_host
    }

    /// Snapshot of the currently-designated shadow.
    pub fn current_shadow(&self) -> Option<DeviceId> {
        self.current_shadow
    }

    /// Snapshot of the local device id.
    pub fn self_id(&self) -> DeviceId {
        self.self_id
    }

    /// Periodic tick: prune stale vectors, run a fresh election, and
    /// emit events for any seat changes the hysteresis policy allows.
    ///
    /// Call on the same cadence as the gossip interval (e.g. every
    /// 10 s). Returns zero or more events to act on.
    pub fn tick(&mut self, now: UnixSeconds) -> Vec<ElectionEvent> {
        self.prune_stale(now);
        self.decrement_exclusions();

        let inputs = self.active_vectors_excluding_excluded();
        let result = elect(&inputs, self.current_host, self.current_shadow);

        let mut events = Vec::new();
        events.extend(self.apply_host_result(result.host));
        events.extend(self.apply_shadow_result(result.shadow));
        events
    }

    /// Emergency promotion: the failover detector says the current
    /// host is gone. Promote the shadow to host immediately
    /// (bypassing hysteresis) and pick a new shadow on the next tick.
    pub fn promote_shadow(&mut self) -> Option<ElectionEvent> {
        let shadow = self.current_shadow?;
        let from = self.current_host;
        self.current_host = Some(shadow);
        self.current_shadow = None;
        self.pending_host_swap.reset();
        self.pending_shadow_swap.reset();
        Some(ElectionEvent::HostChanged {
            from,
            to: shadow,
            reason: ChangeReason::EmergencyPromotion,
        })
    }

    /// Force a re-election that excludes the current host. The host
    /// stays excluded for `exclusion_rounds` ticks so they don't
    /// bounce back immediately after a complaint-forced swap.
    pub fn force_reelection_excluding_current_host(
        &mut self,
        exclusion_rounds: u32,
    ) -> Vec<ElectionEvent> {
        if let Some(host) = self.current_host {
            self.excluded_hosts.insert(host, exclusion_rounds.max(1));
        }
        self.current_host = None;
        self.pending_host_swap.reset();

        let inputs = self.active_vectors_excluding_excluded();
        let result = elect(&inputs, None, self.current_shadow);

        let mut events = Vec::new();
        if let Some(new_host) = result.host {
            self.current_host = Some(new_host);
            events.push(ElectionEvent::HostChanged {
                from: None, // we already cleared above
                to: new_host,
                reason: ChangeReason::ComplaintForced,
            });
        } else {
            events.push(ElectionEvent::NoViableHost);
        }
        // Recompute shadow now that host may have changed.
        events.extend(self.apply_shadow_result(result.shadow));
        events
    }

    // ---- internals ----

    fn prune_stale(&mut self, now: UnixSeconds) {
        let cutoff = now.get() - self.stale_after.as_secs() as i64;
        let to_remove: Vec<DeviceId> = self
            .vectors
            .iter()
            .filter(|(_, rv)| rv.received_at.get() < cutoff)
            .map(|(d, _)| *d)
            .collect();
        for d in to_remove {
            self.vectors.remove(&d);
        }
    }

    fn decrement_exclusions(&mut self) {
        self.excluded_hosts.retain(|_, rounds| {
            *rounds = rounds.saturating_sub(1);
            *rounds > 0
        });
    }

    fn active_vectors_excluding_excluded(&self) -> Vec<QualityVector> {
        self.vectors
            .values()
            .filter(|rv| !self.excluded_hosts.contains_key(&rv.vector.device))
            .map(|rv| rv.vector.clone())
            .collect()
    }

    fn apply_host_result(&mut self, computed: Option<DeviceId>) -> Vec<ElectionEvent> {
        // Initial assignment: take the first computed host with no
        // hysteresis (there's no seat to defend yet).
        if self.current_host.is_none() {
            return match computed {
                Some(d) => {
                    self.current_host = Some(d);
                    self.pending_host_swap.reset();
                    vec![ElectionEvent::HostChanged {
                        from: None,
                        to: d,
                        reason: ChangeReason::InitialAssignment,
                    }]
                }
                None => vec![ElectionEvent::NoViableHost],
            };
        }

        // Incumbent exists. If the computed result equals the
        // incumbent, we're stable.
        let incumbent = self.current_host;
        if computed == incumbent {
            self.pending_host_swap.reset();
            return Vec::new();
        }

        // Incumbent's vector has gone stale (we no longer have them in
        // the active set). Swap right away with no hysteresis — they
        // are functionally gone.
        let incumbent_present = incumbent
            .as_ref()
            .map(|id| self.vectors.contains_key(id) && !self.excluded_hosts.contains_key(id))
            .unwrap_or(false);
        if !incumbent_present {
            self.pending_host_swap.reset();
            return match computed {
                Some(d) => {
                    self.current_host = Some(d);
                    vec![ElectionEvent::HostChanged {
                        from: incumbent,
                        to: d,
                        reason: ChangeReason::IncumbentExpired,
                    }]
                }
                None => {
                    self.current_host = None;
                    vec![ElectionEvent::NoViableHost]
                }
            };
        }

        // Hysteresis: accumulate until the same challenger wins
        // `rounds_to_swap` consecutive ticks, then commit.
        self.pending_host_swap.observe(computed);
        if self.pending_host_swap.consecutive_rounds >= self.rounds_to_swap {
            if let Some(new) = self.pending_host_swap.target {
                self.current_host = Some(new);
                self.pending_host_swap.reset();
                return vec![ElectionEvent::HostChanged {
                    from: incumbent,
                    to: new,
                    reason: ChangeReason::QualitySwap,
                }];
            }
        }
        Vec::new()
    }

    fn apply_shadow_result(&mut self, computed: Option<DeviceId>) -> Vec<ElectionEvent> {
        // Same shape as host but without "no viable shadow" being an
        // alarm (it's normal in small rooms).
        if self.current_shadow.is_none() {
            return match computed {
                Some(d) => {
                    self.current_shadow = Some(d);
                    self.pending_shadow_swap.reset();
                    vec![ElectionEvent::ShadowChanged {
                        from: None,
                        to: d,
                        reason: ChangeReason::InitialAssignment,
                    }]
                }
                None => Vec::new(),
            };
        }

        let incumbent = self.current_shadow;
        if computed == incumbent {
            self.pending_shadow_swap.reset();
            return Vec::new();
        }

        let incumbent_present = incumbent
            .as_ref()
            .map(|id| self.vectors.contains_key(id))
            .unwrap_or(false);
        if !incumbent_present {
            self.pending_shadow_swap.reset();
            self.current_shadow = computed;
            return match computed {
                Some(d) => vec![ElectionEvent::ShadowChanged {
                    from: incumbent,
                    to: d,
                    reason: ChangeReason::IncumbentExpired,
                }],
                None => Vec::new(),
            };
        }

        self.pending_shadow_swap.observe(computed);
        if self.pending_shadow_swap.consecutive_rounds >= self.rounds_to_swap {
            if let Some(new) = self.pending_shadow_swap.target {
                self.current_shadow = Some(new);
                self.pending_shadow_swap.reset();
                return vec![ElectionEvent::ShadowChanged {
                    from: incumbent,
                    to: new,
                    reason: ChangeReason::QualitySwap,
                }];
            }
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::election::NatType;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    fn qv(
        device: DeviceId,
        upload: u32,
        download: u32,
        rtt: u32,
        nat: NatType,
        stable_secs: u32,
        measured_at: i64,
    ) -> QualityVector {
        QualityVector {
            device,
            measured_at: UnixSeconds(measured_at),
            upload_kbps: upload,
            download_kbps: download,
            median_rtt_ms: rtt,
            nat,
            link_stable_secs: stable_secs,
            willing_host: true,
            willing_shadow: true,
        }
    }

    #[test]
    fn initial_assignment_picks_a_host() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let mut st = ElectionState::new(me);

        st.record_vector(
            qv(alice, 20_000, 20_000, 50, NatType::Open, 3600, 100),
            UnixSeconds(100),
        );
        st.record_vector(
            qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 100),
            UnixSeconds(100),
        );

        let events = st.tick(UnixSeconds(100));
        // Alice has the better upload → host. Bob → shadow.
        assert!(events.contains(&ElectionEvent::HostChanged {
            from: None,
            to: alice,
            reason: ChangeReason::InitialAssignment,
        }));
        assert!(events.contains(&ElectionEvent::ShadowChanged {
            from: None,
            to: bob,
            reason: ChangeReason::InitialAssignment,
        }));
        assert_eq!(st.current_host(), Some(alice));
        assert_eq!(st.current_shadow(), Some(bob));
    }

    #[test]
    fn hysteresis_delays_swap() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let mut st = ElectionState::new(me).with_rounds_to_swap(3);

        // Round 0: alice is host.
        st.record_vector(qv(alice, 20_000, 20_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        let _ = st.tick(UnixSeconds(100));

        // Bob's quality jumps; he should challenge but not win immediately.
        st.record_vector(qv(bob, 30_000, 30_000, 50, NatType::Open, 3600, 110), UnixSeconds(110));

        // Round 1: challenger present, no swap yet.
        let events = st.tick(UnixSeconds(110));
        assert!(!events.iter().any(|e| matches!(e, ElectionEvent::HostChanged { .. })));
        assert_eq!(st.current_host(), Some(alice));

        // Round 2: still no swap.
        st.record_vector(qv(bob, 30_000, 30_000, 50, NatType::Open, 3600, 120), UnixSeconds(120));
        let events = st.tick(UnixSeconds(120));
        assert!(!events.iter().any(|e| matches!(e, ElectionEvent::HostChanged { .. })));

        // Round 3: swap commits.
        st.record_vector(qv(bob, 30_000, 30_000, 50, NatType::Open, 3600, 130), UnixSeconds(130));
        let events = st.tick(UnixSeconds(130));
        assert!(events.iter().any(|e| matches!(
            e,
            ElectionEvent::HostChanged {
                reason: ChangeReason::QualitySwap,
                ..
            }
        )));
        assert_eq!(st.current_host(), Some(bob));
    }

    #[test]
    fn challenger_flapping_resets_counter() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let carol = device(4);
        let mut st = ElectionState::new(me).with_rounds_to_swap(3);

        st.record_vector(qv(alice, 20_000, 20_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(carol, 5_000, 5_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        let _ = st.tick(UnixSeconds(100));
        assert_eq!(st.current_host(), Some(alice));

        // Round 1: bob has the lead.
        st.record_vector(qv(bob, 30_000, 30_000, 50, NatType::Open, 3600, 110), UnixSeconds(110));
        let _ = st.tick(UnixSeconds(110));

        // Round 2: carol leads (different challenger) — bob's counter resets.
        st.record_vector(qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 120), UnixSeconds(120));
        st.record_vector(qv(carol, 30_000, 30_000, 50, NatType::Open, 3600, 120), UnixSeconds(120));
        let _ = st.tick(UnixSeconds(120));

        // Round 3: alice still on top because no challenger has held lead long enough.
        st.record_vector(qv(carol, 5_000, 5_000, 50, NatType::Open, 3600, 130), UnixSeconds(130));
        let _ = st.tick(UnixSeconds(130));

        assert_eq!(st.current_host(), Some(alice));
    }

    #[test]
    fn stale_incumbent_swaps_immediately() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        // Generous staleness window for determinism.
        let mut st = ElectionState::new(me).with_stale_after(Duration::from_secs(30));

        st.record_vector(qv(alice, 20_000, 20_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        let _ = st.tick(UnixSeconds(100));
        assert_eq!(st.current_host(), Some(alice));

        // 60 s later, alice's vector is stale; only bob remains active.
        st.record_vector(qv(bob, 5_000, 5_000, 50, NatType::Open, 3600, 160), UnixSeconds(160));
        let events = st.tick(UnixSeconds(160));

        assert!(events.iter().any(|e| matches!(
            e,
            ElectionEvent::HostChanged {
                reason: ChangeReason::IncumbentExpired,
                ..
            }
        )));
        assert_eq!(st.current_host(), Some(bob));
    }

    #[test]
    fn emergency_promotion_moves_shadow_to_host() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let mut st = ElectionState::new(me);
        st.record_vector(qv(alice, 20_000, 20_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(bob, 10_000, 30_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        let _ = st.tick(UnixSeconds(100));
        assert_eq!(st.current_host(), Some(alice));
        assert_eq!(st.current_shadow(), Some(bob));

        let event = st.promote_shadow().expect("must promote");
        assert_eq!(
            event,
            ElectionEvent::HostChanged {
                from: Some(alice),
                to: bob,
                reason: ChangeReason::EmergencyPromotion,
            }
        );
        assert_eq!(st.current_host(), Some(bob));
        assert_eq!(st.current_shadow(), None);
    }

    #[test]
    fn force_reelection_excludes_offender() {
        let me = device(1);
        let alice = device(2);
        let bob = device(3);
        let carol = device(4);
        let mut st = ElectionState::new(me).with_stale_after(Duration::from_secs(120));

        st.record_vector(qv(alice, 30_000, 30_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(bob, 10_000, 10_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        st.record_vector(qv(carol, 5_000, 5_000, 50, NatType::Open, 3600, 100), UnixSeconds(100));
        let _ = st.tick(UnixSeconds(100));
        assert_eq!(st.current_host(), Some(alice));

        let events = st.force_reelection_excluding_current_host(2);
        // Alice excluded → bob wins.
        assert!(events.iter().any(|e| matches!(
            e,
            ElectionEvent::HostChanged {
                reason: ChangeReason::ComplaintForced,
                ..
            }
        )));
        assert_eq!(st.current_host(), Some(bob));

        // Next two ticks: alice still excluded even though her quality
        // would otherwise restore her.
        let _ = st.tick(UnixSeconds(105));
        assert_eq!(st.current_host(), Some(bob));
        let _ = st.tick(UnixSeconds(110));
        assert_eq!(st.current_host(), Some(bob));

        // Round after exclusion expires, the hysteresis on alice's
        // resurgent run still needs to elapse — but the exclusion
        // itself is gone.
        assert!(!st.excluded_hosts.contains_key(&alice));
    }

    #[test]
    fn no_viable_host_when_no_willing_candidate() {
        // The current elect() will return Some for any willing peer,
        // even a symmetric-NAT one whose score is tiny — so we test
        // the "no candidates at all" path. The "viability threshold"
        // that distinguishes "elected but unreachable" from "no host
        // possible" belongs at the TURN-fallback layer in milestone 6;
        // marked here so we remember.
        let me = device(1);
        let alice = device(2);
        let mut vector = qv(alice, 100_000, 100_000, 50, NatType::Open, 3600, 100);
        vector.willing_host = false;
        vector.willing_shadow = false;

        let mut st = ElectionState::new(me);
        st.record_vector(vector, UnixSeconds(100));
        let events = st.tick(UnixSeconds(100));

        assert!(events.iter().any(|e| matches!(e, ElectionEvent::NoViableHost)));
        assert_eq!(st.current_host(), None);
    }
}
