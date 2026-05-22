//! Client ↔ coordination-server wire messages.
//!
//! All client requests carry the user's authenticated session (a token
//! issued at login, not modelled at this layer). Server responses that
//! clients are expected to cache and reuse during the 48h offline window
//! are wrapped in [`crate::envelope::SignedServerStatement`].
//!
//! v1 surface area, intentionally minimal:
//!
//! - registration / login (out of scope here; left for the auth crate)
//! - keystore publish + fetch
//! - room directory lookups
//! - peer signaling relay (ICE candidates, MLS welcomes)
//! - history-head commitment posting
//!
//! Concrete message kinds will grow as later milestones land; the
//! envelope shape and the cacheable-vs-ephemeral split are the parts
//! locked in here.

use serde::{Deserialize, Serialize};

use crate::history::HistoryHead;
use crate::ids::{DeviceId, RoomId, ServerId, UserId};
use crate::keys::{DevicePublicKey, IdentityPublicKey, Signature};
use crate::time::UnixSeconds;

/// Client → server requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum ClientRequest {
    /// Look up a user's published device keys.
    GetUserKeys {
        /// The user to look up.
        user: UserId,
    },
    /// Publish (or update) one of the caller's device keys. The signature
    /// is from the caller's identity key, binding the device key to the
    /// user.
    PublishDeviceKey {
        /// The new or rotated device key.
        device_public_key: DevicePublicKey,
        /// Identity-key signature over the canonical
        /// `(user_id, device_public_key)` tuple.
        identity_signature: Signature,
    },
    /// Look up a room's current state (members, admins, current head
    /// commitment, currently-online members).
    GetRoomState {
        /// The room to look up.
        room: RoomId,
    },
    /// Post a new history-head commitment for a room. Caller must be a
    /// current member; the host is the usual poster, but any member
    /// may post.
    PostHistoryHead {
        /// The room being updated.
        room: RoomId,
        /// The new head (signed by the posting device — outer envelope
        /// carries the device signature).
        head: HistoryHead,
    },
    /// Relay a signaling blob to another peer. Server forwards opaquely.
    RelaySignaling {
        /// Intended recipient device.
        to: DeviceId,
        /// Opaque payload (e.g. ICE candidates, MLS welcome bytes).
        payload: Vec<u8>,
    },
}

/// Server → client responses (the *ephemeral* ones — cacheable responses
/// are returned as [`crate::envelope::SignedServerStatement`] over one of
/// the payloads in [`CacheableServerStatement`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum EphemeralServerResponse {
    /// Acknowledgement with no payload.
    Ack,
    /// A signaling blob was relayed from another peer.
    SignalingDelivered {
        /// Sending device.
        from: DeviceId,
        /// Opaque payload.
        payload: Vec<u8>,
    },
    /// The request failed; reason is informational.
    Error {
        /// Human-readable diagnostic. Not for programmatic decisions.
        message: String,
    },
}

/// Server responses that clients should cache. These are always wrapped
/// in [`crate::envelope::SignedServerStatement`] so the cache TTL and
/// signature travel with them.
//
// The size disparity between variants is intentional: a client holds at
// most tens of these (one per cached room state / user keystore), and
// each instance is short-lived (decoded from wire, used, dropped). The
// memory cost is negligible and boxing would force an indirection on
// every field access in the common case.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum CacheableServerStatement {
    /// The set of currently-registered device keys for a user.
    UserKeys {
        /// The subject user.
        user: UserId,
        /// Devices known to the server, each with its identity-signed
        /// binding signature.
        devices: Vec<DeviceBinding>,
    },
    /// A room's authoritative state at issue time.
    RoomState {
        /// The room.
        room: RoomId,
        /// Member device IDs and their roles.
        members: Vec<RoomMember>,
        /// Current head commitment as known to the server.
        head: Option<HistoryHead>,
        /// Endpoint hints for currently-online members (peer hints).
        peer_hints: Vec<PeerHint>,
    },
}

/// Binding of a device key to a user, signed by the user's identity key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceBinding {
    /// The device's public key.
    pub device_public_key: DevicePublicKey,
    /// Identity-key signature over `(user_id, device_public_key)`.
    pub identity_signature: Signature,
}

/// Membership entry inside a [`CacheableServerStatement::RoomState`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomMember {
    /// The owning user.
    pub user: UserId,
    /// The user's identity public key (so clients can verify device
    /// bindings without a separate keystore round-trip).
    pub identity_public_key: IdentityPublicKey,
    /// Role of this user in the room.
    pub role: RoomRole,
}

/// Role of a user within a room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoomRole {
    /// Regular participant.
    Member,
    /// Can kick / ban other members and change room settings.
    Admin,
    /// Created the room. Cannot be removed.
    Owner,
}

/// Hint about how to reach a peer without server round-trips. Refreshed
/// during normal operation and gossiped peer-to-peer too, so the offline
/// cache stays useful.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerHint {
    /// The device this hint is for.
    pub device: DeviceId,
    /// Reflexive (server-observed) socket address. Stored as bytes
    /// because we don't want to mix `std::net` types into the wire
    /// format (encoding of `SocketAddr` is not stable across releases).
    pub reflexive_addr: SocketAddrBytes,
    /// Last time the server observed this device as reachable.
    pub last_seen: crate::time::UnixSeconds,
}

/// A socket address on the wire: `(is_v6, bytes, port)`.
/// `bytes` is 4 or 16 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SocketAddrBytes {
    /// True if v6, false if v4.
    pub is_v6: bool,
    /// Raw address bytes (4 for v4, 16 for v6).
    pub addr: Vec<u8>,
    /// UDP port.
    pub port: u16,
}

/// Frames a client sends over the signaling WebSocket. Postcard-encoded
/// as binary WS frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SignalingClientFrame {
    /// First frame after connect: claim which of the caller's devices
    /// this connection represents. Subsequent relays use this device
    /// as the `from` field.
    Identify {
        /// The device this connection represents.
        device_id: DeviceId,
    },
    /// Relay an opaque payload to another device. The server forwards
    /// the bytes unchanged.
    Relay {
        /// Recipient device.
        to: DeviceId,
        /// Opaque payload.
        payload: Vec<u8>,
    },
}

/// Frames the signaling server sends back. Postcard-encoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SignalingServerFrame {
    /// First frame the server sends after accepting an Identify. The
    /// `server_id` lets the client cross-check that the WS endpoint
    /// belongs to the expected coordination server (TOFU on first
    /// contact).
    Welcome {
        /// Identity of the coordination server.
        server_id: ServerId,
        /// Wall-clock when the welcome was issued. Clients use this to
        /// detect grossly skewed servers.
        server_time: UnixSeconds,
    },
    /// A relayed payload from another device.
    Delivered {
        /// Sending device.
        from: DeviceId,
        /// Opaque payload.
        payload: Vec<u8>,
    },
    /// Recipient was not reachable; the relay was dropped.
    UnreachableRecipient {
        /// Device that could not be reached.
        target: DeviceId,
    },
    /// Server-side error scoped to this connection.
    Error {
        /// Diagnostic message; not for programmatic decisions.
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_request_roundtrips() {
        let req = ClientRequest::GetUserKeys {
            user: UserId::from_bytes([5; 32]),
        };
        let bytes = postcard::to_stdvec(&req).unwrap();
        let decoded: ClientRequest = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(req, decoded);
    }

    #[test]
    fn room_state_roundtrips() {
        let stmt = CacheableServerStatement::RoomState {
            room: RoomId::from_bytes([8; 32]),
            members: vec![RoomMember {
                user: UserId::from_bytes([1; 32]),
                identity_public_key: IdentityPublicKey([2; 32]),
                role: RoomRole::Owner,
            }],
            head: None,
            peer_hints: vec![],
        };
        let bytes = postcard::to_stdvec(&stmt).unwrap();
        let decoded: CacheableServerStatement = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(stmt, decoded);
    }
}
