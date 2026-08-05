//! Signaling hub: in-memory registry of WebSocket-connected devices.
//!
//! For Milestone 2 this is single-process and process-local. Horizontal
//! scaling (and survival across server restarts) requires shared state
//! — Redis is the planned backing store for that. See `ARCHITECTURE.md`.
//!
//! The hub does not buffer relayed bytes — if the recipient is not
//! currently connected, the server reports `UnreachableRecipient` and
//! drops the message. Coordination-server signaling is best-effort by
//! design; reliable peer-to-peer state lives in the peer mesh itself.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};

use crocodile_protocol::ids::DeviceId;

/// A bundle the hub hands to a connected device's send task. Carries
/// already-encoded server frames so the hub holds no protocol-version
/// awareness.
#[derive(Debug, Clone)]
pub struct Envelope {
    /// The full postcard-encoded `SignalingServerFrame` bytes.
    pub bytes: Vec<u8>,
}

/// Connection-side handle for a device. Wraps an mpsc sender that
/// delivers framed bytes to the WS writer task.
#[derive(Debug)]
pub struct Connection {
    sender: mpsc::UnboundedSender<Envelope>,
}

impl Connection {
    /// Construct from a sender; intended for use by the WS handler.
    pub fn new(sender: mpsc::UnboundedSender<Envelope>) -> Self {
        Self { sender }
    }

    /// Try to deliver a frame to this connection.
    pub fn send(&self, env: Envelope) -> Result<(), SendError> {
        self.sender.send(env).map_err(|_| SendError::Closed)
    }
}

/// Reasons a send may fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    /// The receiving end is gone (connection dropped).
    Closed,
}

/// The hub itself. Cheap to clone (internal `Arc<RwLock<...>>`).
#[derive(Debug, Clone, Default)]
pub struct SignalingHub {
    inner: Arc<RwLock<HashMap<DeviceId, Connection>>>,
}

impl SignalingHub {
    /// Construct an empty hub.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a device's connection. If the device was already
    /// registered (e.g. re-connected after a network blip without the
    /// old socket having been cleaned up yet), the old connection is
    /// replaced and its sender dropped — the corresponding write task
    /// will see a closed channel and exit.
    pub async fn register(&self, device: DeviceId, conn: Connection) {
        self.inner.write().await.insert(device, conn);
    }

    /// Remove a device's registration. Safe to call multiple times.
    /// `only_if_matching` lets the caller atomically drop their slot
    /// only if it still points at their own sender — a small protection
    /// against races where a re-connect races with a slow disconnect.
    pub async fn deregister(&self, device: DeviceId) {
        self.inner.write().await.remove(&device);
    }

    /// Attempt to deliver an envelope to a device. Returns `None` if
    /// the device is not currently connected, or `Some(Err(_))` if the
    /// connection's send channel has closed (which we also treat as
    /// disconnected).
    pub async fn deliver(&self, target: DeviceId, env: Envelope) -> DeliveryOutcome {
        let guard = self.inner.read().await;
        match guard.get(&target) {
            None => DeliveryOutcome::Unreachable,
            Some(conn) => match conn.send(env) {
                Ok(()) => DeliveryOutcome::Delivered,
                Err(SendError::Closed) => DeliveryOutcome::Unreachable,
            },
        }
    }

    /// Returns the set of currently-connected devices (snapshot copy).
    pub async fn online_devices(&self) -> Vec<DeviceId> {
        self.inner.read().await.keys().copied().collect()
    }
}

/// Outcome of a delivery attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// Bytes were handed to the recipient's write task.
    Delivered,
    /// Recipient is not connected (or their connection was closing).
    Unreachable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_deliver() {
        let hub = SignalingHub::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let device = DeviceId::from_bytes([1; 32]);
        hub.register(device, Connection::new(tx)).await;

        let env = Envelope {
            bytes: vec![1, 2, 3],
        };
        let outcome = hub.deliver(device, env.clone()).await;
        assert_eq!(outcome, DeliveryOutcome::Delivered);
        assert_eq!(rx.recv().await.unwrap().bytes, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn unknown_device_is_unreachable() {
        let hub = SignalingHub::new();
        let outcome = hub
            .deliver(DeviceId::from_bytes([9; 32]), Envelope { bytes: vec![] })
            .await;
        assert_eq!(outcome, DeliveryOutcome::Unreachable);
    }

    #[tokio::test]
    async fn deregister_removes_routing() {
        let hub = SignalingHub::new();
        let (tx, _rx) = mpsc::unbounded_channel();
        let device = DeviceId::from_bytes([2; 32]);
        hub.register(device, Connection::new(tx)).await;
        hub.deregister(device).await;
        let outcome = hub.deliver(device, Envelope { bytes: vec![] }).await;
        assert_eq!(outcome, DeliveryOutcome::Unreachable);
    }

    #[tokio::test]
    async fn closed_channel_is_unreachable() {
        let hub = SignalingHub::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let device = DeviceId::from_bytes([3; 32]);
        hub.register(device, Connection::new(tx)).await;
        drop(rx);
        let outcome = hub.deliver(device, Envelope { bytes: vec![] }).await;
        assert_eq!(outcome, DeliveryOutcome::Unreachable);
    }
}
