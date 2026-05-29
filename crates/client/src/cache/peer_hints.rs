//! In-memory peer-hints registry.
//!
//! Holds the freshest known [`SignedPeerHint`] per (room, device) pair
//! plus a per-room cap to bound memory. Used both to seed reconnect
//! attempts when the coordination server is offline and to gossip
//! freshness to other room members.
//!
//! No I/O. Persistence (storing hints in the SQLite cache) is the
//! responsibility of the wrapper around this registry — keeping the
//! pure data structure separate makes the gossip / freshness
//! semantics independently testable.

use std::collections::HashMap;
use std::time::Duration;

use crocodile_protocol::error::Result as ProtocolResult;
use crocodile_protocol::ids::{DeviceId, RoomId};
use crocodile_protocol::keys::DevicePublicKey;
use crocodile_protocol::signaling::SignedPeerHint;
use crocodile_protocol::time::UnixSeconds;

/// Default per-room hint cap. Once exceeded, the stalest hint is
/// evicted to make room for the new one.
pub const DEFAULT_MAX_PER_ROOM: usize = 8;

/// Default hint lifetime. After this much wall-clock with no refresh,
/// a hint is dropped. Aligned with the 48 h offline-cache rule but
/// shorter — a peer's address staleness is a more local concern than
/// the broader cache window.
pub const DEFAULT_MAX_AGE_SECS: i64 = 6 * 60 * 60; // 6 h

/// A single hint with bookkeeping.
///
/// `received_at` is the time *we* observed this hint locally, distinct
/// from `signed.hint.last_seen` (when the originating party last saw
/// the device reachable). Tracked separately because gossip
/// loop-prevention will need it — if a peer re-broadcasts a hint we
/// already have, we want to recognise it as redundant without
/// re-storing.
#[derive(Debug, Clone)]
struct TrackedHint {
    signed: SignedPeerHint,
    received_at: UnixSeconds,
}

impl TrackedHint {
    fn received_at(&self) -> UnixSeconds {
        self.received_at
    }
}

/// In-memory peer-hints registry.
#[derive(Debug)]
pub struct PeerHintsRegistry {
    rooms: HashMap<RoomId, HashMap<DeviceId, TrackedHint>>,
    max_per_room: usize,
    max_age: Duration,
}

impl Default for PeerHintsRegistry {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PER_ROOM, Duration::from_secs(DEFAULT_MAX_AGE_SECS as u64))
    }
}

impl PeerHintsRegistry {
    /// Construct a registry with explicit limits.
    pub fn new(max_per_room: usize, max_age: Duration) -> Self {
        Self {
            rooms: HashMap::new(),
            max_per_room,
            max_age,
        }
    }

    /// Ingest a signed hint received from a peer. Verifies the
    /// signature against the supplied device public key; accepts the
    /// hint if it is strictly newer than what we already have for
    /// that (room, device). Enforces the per-room cap by evicting
    /// the stalest entry.
    ///
    /// Returns whether the hint was stored.
    pub fn ingest(
        &mut self,
        signed: SignedPeerHint,
        device_pk: &DevicePublicKey,
        now: UnixSeconds,
    ) -> ProtocolResult<bool> {
        // Sanity check: the hint's device must match the public key
        // we're asked to verify with. We don't enforce that the
        // device id is derived from the public key here because that
        // mapping is the caller's responsibility — but we do enforce
        // that the signature is good for the supplied key.
        signed.verify(device_pk)?;

        let room = signed.room;
        let device = signed.hint.device;
        let candidate_last_seen = signed.hint.last_seen.get();

        let room_map = self.rooms.entry(room).or_default();

        if let Some(existing) = room_map.get(&device) {
            if existing.signed.hint.last_seen.get() >= candidate_last_seen {
                return Ok(false);
            }
        }

        room_map.insert(
            device,
            TrackedHint {
                signed,
                received_at: now,
            },
        );

        // Enforce per-room cap. Evict the entry with the oldest
        // `last_seen` (not `received_at`) — caller's clock is more
        // meaningful than ours when deciding which hint is freshest.
        if room_map.len() > self.max_per_room {
            if let Some((stalest, _)) = room_map
                .iter()
                .min_by_key(|(_, h)| h.signed.hint.last_seen.get())
                .map(|(d, h)| (*d, h.signed.hint.last_seen.get()))
            {
                room_map.remove(&stalest);
            }
        }

        Ok(true)
    }

    /// List the freshest-known hints for `room`, freshest first.
    /// Excludes stale entries against `now`.
    pub fn list_for_room(&self, room: RoomId, now: UnixSeconds) -> Vec<&SignedPeerHint> {
        let Some(map) = self.rooms.get(&room) else {
            return Vec::new();
        };
        let cutoff = now.get() - self.max_age.as_secs() as i64;
        let mut entries: Vec<&TrackedHint> = map
            .values()
            .filter(|t| t.signed.hint.last_seen.get() >= cutoff)
            .collect();
        entries.sort_by_key(|t| std::cmp::Reverse(t.signed.hint.last_seen.get()));
        entries.into_iter().map(|t| &t.signed).collect()
    }

    /// Periodically drop stale entries across all rooms.
    pub fn sweep_stale(&mut self, now: UnixSeconds) -> usize {
        let cutoff = now.get() - self.max_age.as_secs() as i64;
        let mut removed = 0;
        for (_room, map) in self.rooms.iter_mut() {
            let to_drop: Vec<DeviceId> = map
                .iter()
                .filter(|(_, h)| h.signed.hint.last_seen.get() < cutoff)
                .map(|(d, _)| *d)
                .collect();
            for d in to_drop {
                map.remove(&d);
                removed += 1;
            }
        }
        // Drop empty rooms.
        self.rooms.retain(|_, m| !m.is_empty());
        removed
    }

    /// Returns the number of rooms we have any hints for.
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    /// Returns the number of hints stored for a room.
    pub fn count_for_room(&self, room: RoomId) -> usize {
        self.rooms.get(&room).map(|m| m.len()).unwrap_or(0)
    }

    /// Returns the wall-clock time we received our currently-stored
    /// hint for `(room, device)`, if any. Used by the gossip layer
    /// to debounce re-broadcasts.
    pub fn received_at_for(&self, room: RoomId, device: DeviceId) -> Option<UnixSeconds> {
        self.rooms
            .get(&room)
            .and_then(|m| m.get(&device))
            .map(TrackedHint::received_at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::keys::{
        device_id_from_public_key, DeviceKeypair, IdentityPublicKey, Signature,
    };
    use crocodile_protocol::signaling::{PeerHint, SocketAddrBytes};
    use rand::rngs::OsRng;

    fn fake_addr() -> SocketAddrBytes {
        SocketAddrBytes {
            is_v6: false,
            addr: vec![10, 0, 0, 1],
            port: 7000,
        }
    }

    fn sign_hint(
        kp: &DeviceKeypair,
        room: RoomId,
        last_seen: UnixSeconds,
    ) -> SignedPeerHint {
        let device = device_id_from_public_key(&kp.public_key());
        let hint = PeerHint {
            device,
            reflexive_addr: fake_addr(),
            last_seen,
        };
        let mut signed = SignedPeerHint {
            room,
            hint,
            signature: Signature([0; 64]),
        };
        let input = signed.signing_input().unwrap();
        signed.signature = kp.sign(&input);
        signed
    }

    fn room(byte: u8) -> RoomId {
        RoomId::from_bytes([byte; 32])
    }

    #[test]
    fn ingest_stores_fresh_hint() {
        let mut reg = PeerHintsRegistry::default();
        let kp = DeviceKeypair::generate(&mut OsRng);
        let signed = sign_hint(&kp, room(1), UnixSeconds(1000));

        let stored = reg.ingest(signed, &kp.public_key(), UnixSeconds(1000)).unwrap();
        assert!(stored);
        assert_eq!(reg.count_for_room(room(1)), 1);
    }

    #[test]
    fn ingest_rejects_bad_signature() {
        let mut reg = PeerHintsRegistry::default();
        let alice = DeviceKeypair::generate(&mut OsRng);
        let bob = DeviceKeypair::generate(&mut OsRng);
        // Sign with alice but claim to verify with bob.
        let signed = sign_hint(&alice, room(1), UnixSeconds(1000));
        let result = reg.ingest(signed, &bob.public_key(), UnixSeconds(1000));
        assert!(result.is_err());
    }

    #[test]
    fn ingest_drops_older_hint_for_same_device() {
        let mut reg = PeerHintsRegistry::default();
        let kp = DeviceKeypair::generate(&mut OsRng);

        let newer = sign_hint(&kp, room(1), UnixSeconds(2000));
        let older = sign_hint(&kp, room(1), UnixSeconds(1000));

        reg.ingest(newer, &kp.public_key(), UnixSeconds(2000)).unwrap();
        let stored = reg.ingest(older, &kp.public_key(), UnixSeconds(2000)).unwrap();
        assert!(!stored);
        assert_eq!(reg.count_for_room(room(1)), 1);
        // Freshest entry should be 2000.
        let listed = reg.list_for_room(room(1), UnixSeconds(2000));
        assert_eq!(listed[0].hint.last_seen.get(), 2000);
    }

    #[test]
    fn cap_evicts_stalest_when_exceeded() {
        let mut reg = PeerHintsRegistry::new(3, Duration::from_secs(86_400));
        // Add 4 distinct devices with increasing last_seen.
        for i in 0..4u8 {
            let kp = DeviceKeypair::generate(&mut OsRng);
            let signed = sign_hint(&kp, room(1), UnixSeconds(1000 + i as i64 * 10));
            reg.ingest(signed, &kp.public_key(), UnixSeconds(1100)).unwrap();
        }
        assert_eq!(reg.count_for_room(room(1)), 3);
        let listed = reg.list_for_room(room(1), UnixSeconds(1100));
        // The stalest (last_seen=1000) should have been evicted.
        for hint in &listed {
            assert!(hint.hint.last_seen.get() > 1000);
        }
    }

    #[test]
    fn rooms_are_isolated() {
        let mut reg = PeerHintsRegistry::default();
        let kp = DeviceKeypair::generate(&mut OsRng);
        reg.ingest(
            sign_hint(&kp, room(1), UnixSeconds(1000)),
            &kp.public_key(),
            UnixSeconds(1000),
        )
        .unwrap();
        reg.ingest(
            sign_hint(&kp, room(2), UnixSeconds(1000)),
            &kp.public_key(),
            UnixSeconds(1000),
        )
        .unwrap();
        assert_eq!(reg.count_for_room(room(1)), 1);
        assert_eq!(reg.count_for_room(room(2)), 1);
        assert_eq!(reg.room_count(), 2);
    }

    #[test]
    fn list_orders_freshest_first() {
        let mut reg = PeerHintsRegistry::new(8, Duration::from_secs(86_400));
        let mut kps = Vec::new();
        for _ in 0..3 {
            kps.push(DeviceKeypair::generate(&mut OsRng));
        }
        // Insert in arbitrary order.
        for (i, kp) in kps.iter().enumerate() {
            let last_seen = UnixSeconds(1000 + i as i64 * 100);
            reg.ingest(sign_hint(kp, room(1), last_seen), &kp.public_key(), last_seen)
                .unwrap();
        }
        let listed = reg.list_for_room(room(1), UnixSeconds(1500));
        assert_eq!(listed.len(), 3);
        // freshest first
        assert_eq!(listed[0].hint.last_seen.get(), 1200);
        assert_eq!(listed[1].hint.last_seen.get(), 1100);
        assert_eq!(listed[2].hint.last_seen.get(), 1000);
    }

    #[test]
    fn sweep_drops_stale_and_empty_rooms() {
        let mut reg = PeerHintsRegistry::new(8, Duration::from_secs(60));
        let kp = DeviceKeypair::generate(&mut OsRng);
        reg.ingest(
            sign_hint(&kp, room(1), UnixSeconds(1000)),
            &kp.public_key(),
            UnixSeconds(1000),
        )
        .unwrap();
        assert_eq!(reg.room_count(), 1);

        // 120 s later: hint is past max_age.
        let removed = reg.sweep_stale(UnixSeconds(1120));
        assert_eq!(removed, 1);
        assert_eq!(reg.room_count(), 0);
    }

    #[test]
    fn list_excludes_stale_without_sweep() {
        let mut reg = PeerHintsRegistry::new(8, Duration::from_secs(60));
        let kp = DeviceKeypair::generate(&mut OsRng);
        reg.ingest(
            sign_hint(&kp, room(1), UnixSeconds(1000)),
            &kp.public_key(),
            UnixSeconds(1000),
        )
        .unwrap();
        let listed = reg.list_for_room(room(1), UnixSeconds(1200));
        assert!(listed.is_empty());
        // The entry still occupies storage — that's the sweep's job.
        assert_eq!(reg.count_for_room(room(1)), 1);
        let _ = IdentityPublicKey([0; 32]); // silence unused import in non-debug builds
    }
}
