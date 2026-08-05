//! Call orchestration: election state machine and failover detection.
//!
//! These are pure data-flow modules. They take quality vectors, keep-
//! alives, and complaints as input and emit events the surrounding
//! runtime should act on. They do not own QUIC connections, audio,
//! or anything else with side effects — that wiring lands in a later
//! milestone.
//!
//! See `ARCHITECTURE.md` §4 for the design.

pub mod election;
pub mod failover;
pub mod quality;
pub mod runtime;

pub use election::{ChangeReason, ElectionEvent, ElectionState};
pub use failover::{ComplaintTracker, FailoverDetector, FailoverTrigger};
pub use quality::{QualityBuilder, QualityConfig};
pub use runtime::{CallRuntime, RuntimeAction, RuntimeConfig};

#[cfg(test)]
mod integration_tests {
    //! Cross-module tests that compose election + failover detector
    //! into runtime-shaped scenarios. Each is fully deterministic.
    use super::*;
    use crocodile_protocol::election::{NatType, QualityVector};
    use crocodile_protocol::ids::DeviceId;
    use crocodile_protocol::peer::ComplaintReason;
    use crocodile_protocol::time::UnixSeconds;
    use std::time::Duration;

    fn device(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    fn qv_at(d: DeviceId, upload: u32, at: i64) -> QualityVector {
        QualityVector {
            device: d,
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

    #[test]
    fn host_disappears_shadow_takes_over_then_new_shadow_elected() {
        let me = device(0);
        let alice = device(1);
        let bob = device(2);
        let carol = device(3);

        // Tight staleness window so alice's old vector ages out
        // within the test's elapsed seconds.
        let mut election = ElectionState::new(me).with_stale_after(Duration::from_secs(5));
        let mut fd = FailoverDetector::new().with_keepalive_timeout(Duration::from_secs(2));

        // T=100: everyone reports. Alice has best upload.
        election.record_vector(qv_at(alice, 30_000, 100), UnixSeconds(100));
        election.record_vector(qv_at(bob, 20_000, 100), UnixSeconds(100));
        election.record_vector(qv_at(carol, 10_000, 100), UnixSeconds(100));
        let events = election.tick(UnixSeconds(100));

        assert_eq!(election.current_host(), Some(alice));
        assert_eq!(election.current_shadow(), Some(bob));

        // Runtime applies the events to the failover detector.
        for ev in events {
            if let ElectionEvent::HostChanged { to, .. } = ev {
                fd.host_changed(to, 1, UnixSeconds(100));
            }
        }

        // T=101: alice emits a keepalive; all good.
        fd.record_keepalive(alice, 1, UnixSeconds(101));
        assert!(fd.check(UnixSeconds(101), 4).is_none());

        // T=103: silence for 2s → keepalive timeout.
        let trigger = fd.check(UnixSeconds(103), 4);
        assert!(matches!(
            trigger,
            Some(FailoverTrigger::KeepaliveTimeout { .. })
        ));

        // Runtime reacts: emergency-promote shadow.
        let promotion = election.promote_shadow().expect("shadow must promote");
        assert!(matches!(promotion, ElectionEvent::HostChanged { to, .. } if to == bob));
        assert_eq!(election.current_host(), Some(bob));
        assert_eq!(election.current_shadow(), None);

        // Runtime tells the failover detector about the new host /
        // clock so it stops alarming about alice.
        fd.host_changed(bob, 2, UnixSeconds(103));

        // T=110: bob's been a stable host. Election runs again and
        // promotes a new shadow from the remaining bench.
        election.record_vector(qv_at(bob, 20_000, 110), UnixSeconds(110));
        election.record_vector(qv_at(carol, 10_000, 110), UnixSeconds(110));
        // Alice is "gone"; her vector goes stale on its own. The next
        // tick must re-elect a shadow (was None after promotion).
        let events = election.tick(UnixSeconds(110));
        let shadow_assigned = events
            .iter()
            .any(|e| matches!(e, ElectionEvent::ShadowChanged { to, .. } if *to == carol));
        assert!(shadow_assigned, "carol should become shadow");
        assert_eq!(election.current_shadow(), Some(carol));
    }

    #[test]
    fn complaints_force_reelection_and_offender_stays_out() {
        let me = device(0);
        let alice = device(1);
        let bob = device(2);
        let carol = device(3);
        let dave = device(4);

        let mut election = ElectionState::new(me).with_stale_after(Duration::from_secs(120));
        let mut fd = FailoverDetector::new()
            .with_keepalive_timeout(Duration::from_secs(3600)) // disable keepalive trigger
            .with_complaint_threshold(0.3);

        // T=100: alice is host, bob shadow.
        election.record_vector(qv_at(alice, 30_000, 100), UnixSeconds(100));
        election.record_vector(qv_at(bob, 20_000, 100), UnixSeconds(100));
        election.record_vector(qv_at(carol, 10_000, 100), UnixSeconds(100));
        election.record_vector(qv_at(dave, 5_000, 100), UnixSeconds(100));
        let _ = election.tick(UnixSeconds(100));
        assert_eq!(election.current_host(), Some(alice));

        for ev in [election.tick(UnixSeconds(100))].iter().flatten() {
            if let ElectionEvent::HostChanged { to, .. } = ev {
                fd.host_changed(*to, 1, UnixSeconds(100));
            }
        }
        fd.host_changed(alice, 1, UnixSeconds(100));

        // T=101: bob, carol, dave all complain about alice (3 of 4 = 75%).
        for d in [bob, carol, dave] {
            fd.record_complaint(d, 1, ComplaintReason::Loss);
        }
        let trigger = fd.check(UnixSeconds(101), 4);
        assert!(matches!(
            trigger,
            Some(FailoverTrigger::ComplaintThresholdReached { .. })
        ));

        // Runtime acts: force re-election excluding alice. With alice
        // out, bob should win.
        let events = election.force_reelection_excluding_current_host(3);
        assert!(events.iter().any(|e| matches!(
            e,
            ElectionEvent::HostChanged {
                to,
                reason: ChangeReason::ComplaintForced,
                ..
            } if *to == bob
        )));

        // Update fd to track the new host.
        fd.host_changed(bob, 2, UnixSeconds(101));

        // Even with alice's resurgent (still-fresh, still high-score)
        // vector, the exclusion keeps her out of the race for the
        // next several ticks.
        for t in [105i64, 110, 115] {
            election.record_vector(qv_at(alice, 100_000, t), UnixSeconds(t));
            election.record_vector(qv_at(bob, 20_000, t), UnixSeconds(t));
            let _ = election.tick(UnixSeconds(t));
            assert_eq!(
                election.current_host(),
                Some(bob),
                "bob should hold at t={t}"
            );
        }
    }
}
