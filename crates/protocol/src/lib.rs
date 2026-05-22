//! Crocodile shared protocol crate.
//!
//! Defines the wire types, signed envelopes, peer-to-peer control messages,
//! voice and text frame formats, host-election quality vectors, hash-chained
//! text history, and the MLS backend interface that both the coordination
//! server and clients depend on.
//!
//! See `ARCHITECTURE.md` at the workspace root for the design context.
//!
//! ## Module map
//!
//! - [`version`]: protocol version constant and envelope.
//! - [`ids`]: typed identifiers (users, devices, rooms, servers).
//! - [`keys`]: identity and device cryptographic keys, signatures.
//! - [`time`]: monotonic-ish unix timestamps and cache TTLs.
//! - [`envelope`]: signed wire envelopes (server-signed for cache TTL,
//!   peer-signed for room messages).
//! - [`signaling`]: client ↔ coordination-server wire messages.
//! - [`peer`]: peer ↔ peer control-plane messages.
//! - [`voice`]: voice frame format.
//! - [`text`]: text message format.
//! - [`election`]: quality vectors and host-election function.
//! - [`history`]: hash-chained text history log.
//! - [`mls`]: MLS backend trait and opaque types (implementation lives
//!   in a separate crate; see milestone 4).
//! - [`error`]: shared error types.

#![forbid(unsafe_code)]
#![warn(
    missing_docs,
    missing_debug_implementations,
    rust_2018_idioms,
    unreachable_pub
)]

pub mod election;
pub mod envelope;
pub mod error;
pub mod history;
pub mod ids;
pub mod keys;
pub mod mls;
pub mod peer;
pub mod signaling;
pub mod text;
pub mod time;
pub mod version;
pub mod voice;

pub use error::{Error, Result};
pub use version::{ProtocolVersion, PROTOCOL_VERSION};
