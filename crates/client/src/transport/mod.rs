//! Peer transport: QUIC over UDP plus NAT-traversal primitives.
//!
//! This module covers the minimum surface needed for milestone 3:
//!
//! - [`quic`]: a QUIC endpoint (listen + dial) using `quinn`, with
//!   self-signed certificates whose subject public key is
//!   independently verified by the peer against the device key we
//!   already trust via the keystore.
//! - [`stun`]: a minimal STUN client that returns the local socket's
//!   reflexive address.
//!
//! Full ICE candidate gathering / TURN integration lands in later
//! milestones; the QUIC endpoint here is happy to accept any peer
//! address the caller hands it.

pub mod quic;
pub mod stun;
