//! Crocodile client foundation.
//!
//! Modules:
//!
//! - [`cache`]: persistent, TTL-enforced cache for
//!   `SignedServerStatement<T>` values. Backs the 48h offline-cache
//!   rule.
//! - [`server_client`]: HTTP client for the coordination server.
//!   Fetches signed statements, verifies them, and stores them in the
//!   cache.
//! - [`signaling_client`]: WebSocket client for `/v1/signaling`.
//! - [`transport`]: QUIC peer transport and supporting NAT-traversal
//!   primitives (STUN today; ICE/TURN to follow).
//! - [`error`]: shared error types.
//!
//! This crate intentionally does *not* yet include audio I/O, MLS
//! integration, or the host-election runtime — those compose on top of
//! this foundation in milestones 4 and 5.

#![forbid(unsafe_code)]
#![warn(rust_2018_idioms, unreachable_pub)]

pub mod audio;
pub mod cache;
pub mod error;
pub mod server_client;
pub mod signaling_client;
pub mod transport;

pub use error::{ClientError, Result};
