//! Minimal STUN client (RFC 5389 Binding Request).
//!
//! Sends a Binding Request to a STUN server over UDP and parses the
//! `XOR-MAPPED-ADDRESS` attribute out of the response, yielding the
//! reflexive (server-observed) address of the local socket.
//!
//! Scope limits — explicit to stay honest about what we implement:
//!
//! - Only the Binding method (no authentication / message-integrity).
//! - Only the `XOR-MAPPED-ADDRESS` attribute is parsed; legacy
//!   `MAPPED-ADDRESS` from very old servers is ignored.
//! - No retransmission scheduler; a single request with a caller-
//!   supplied timeout is sufficient for our use case (we re-query
//!   periodically anyway as part of peer-hint refresh).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use rand::Rng;
use tokio::net::UdpSocket;
use tokio::time::timeout;

use crate::error::{ClientError, Result};

/// STUN magic cookie — present in every STUN message header
/// (RFC 5389 §6).
const MAGIC_COOKIE: u32 = 0x2112_A442;

/// Class + Method nibbles for a Binding Request.
const BINDING_REQUEST: u16 = 0x0001;
/// Method bits for a successful Binding Response.
const BINDING_SUCCESS_RESPONSE: u16 = 0x0101;

/// Attribute type for XOR-MAPPED-ADDRESS.
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Query `stun_server` over UDP and return the reflexive address of
/// the local socket.
pub async fn discover_reflexive(
    stun_server: SocketAddr,
    request_timeout: Duration,
) -> Result<SocketAddr> {
    let local_bind: SocketAddr = if stun_server.is_ipv6() {
        "[::]:0".parse().unwrap()
    } else {
        "0.0.0.0:0".parse().unwrap()
    };
    let socket = UdpSocket::bind(local_bind).await?;
    discover_via_socket(&socket, stun_server, request_timeout).await
}

/// Like [`discover_reflexive`] but reuses an already-bound socket.
/// Important when you want the *peer transport*'s socket to be the
/// one observed by the STUN server, so the reflexive address is
/// usable for incoming peer connections.
pub async fn discover_via_socket(
    socket: &UdpSocket,
    stun_server: SocketAddr,
    request_timeout: Duration,
) -> Result<SocketAddr> {
    let txid = random_transaction_id();
    let request = build_binding_request(&txid);

    socket
        .send_to(&request, stun_server)
        .await
        .map_err(ClientError::from)?;

    let mut buf = vec![0u8; 1500];
    let n = timeout(request_timeout, socket.recv(&mut buf))
        .await
        .map_err(|_| ClientError::Stun("timed out waiting for STUN response".into()))?
        .map_err(ClientError::from)?;
    buf.truncate(n);

    parse_binding_response(&buf, &txid)
}

fn random_transaction_id() -> [u8; 12] {
    let mut txid = [0u8; 12];
    rand::thread_rng().fill(&mut txid);
    txid
}

fn build_binding_request(txid: &[u8; 12]) -> Vec<u8> {
    let mut v = Vec::with_capacity(20);
    v.extend_from_slice(&BINDING_REQUEST.to_be_bytes()); // message type
    v.extend_from_slice(&0u16.to_be_bytes()); // message length (no attributes)
    v.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    v.extend_from_slice(txid);
    v
}

fn parse_binding_response(buf: &[u8], expected_txid: &[u8; 12]) -> Result<SocketAddr> {
    if buf.len() < 20 {
        return Err(ClientError::Stun("response too short".into()));
    }
    let msg_type = u16::from_be_bytes([buf[0], buf[1]]);
    if msg_type != BINDING_SUCCESS_RESPONSE {
        return Err(ClientError::Stun(format!(
            "unexpected message type {msg_type:#06x}"
        )));
    }
    let msg_len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let cookie = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    if cookie != MAGIC_COOKIE {
        return Err(ClientError::Stun("magic cookie mismatch".into()));
    }
    let txid = &buf[8..20];
    if txid != expected_txid {
        return Err(ClientError::Stun("transaction id mismatch".into()));
    }
    if buf.len() < 20 + msg_len {
        return Err(ClientError::Stun("truncated attribute block".into()));
    }

    let mut i = 20usize;
    let end = 20 + msg_len;
    while i + 4 <= end {
        let attr_type = u16::from_be_bytes([buf[i], buf[i + 1]]);
        let attr_len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        i += 4;
        if i + attr_len > end {
            return Err(ClientError::Stun("attribute extends past message".into()));
        }
        let attr_value = &buf[i..i + attr_len];
        if attr_type == ATTR_XOR_MAPPED_ADDRESS {
            return parse_xor_mapped_address(attr_value, expected_txid);
        }
        // Attributes are padded to 4-byte boundaries.
        let pad = (4 - attr_len % 4) % 4;
        i += attr_len + pad;
    }

    Err(ClientError::Stun(
        "no XOR-MAPPED-ADDRESS attribute in response".into(),
    ))
}

fn parse_xor_mapped_address(value: &[u8], txid: &[u8; 12]) -> Result<SocketAddr> {
    if value.len() < 4 {
        return Err(ClientError::Stun("XOR-MAPPED-ADDRESS too short".into()));
    }
    let family = value[1];
    let xport = u16::from_be_bytes([value[2], value[3]]);
    let port = xport ^ ((MAGIC_COOKIE >> 16) as u16);

    match family {
        // IPv4
        0x01 => {
            if value.len() < 8 {
                return Err(ClientError::Stun("v4 XOR-MAPPED-ADDRESS too short".into()));
            }
            let xaddr = u32::from_be_bytes([value[4], value[5], value[6], value[7]]);
            let addr = xaddr ^ MAGIC_COOKIE;
            Ok(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::from(addr.to_be_bytes())),
                port,
            ))
        }
        // IPv6
        0x02 => {
            if value.len() < 20 {
                return Err(ClientError::Stun("v6 XOR-MAPPED-ADDRESS too short".into()));
            }
            let mut x = [0u8; 16];
            x.copy_from_slice(&value[4..20]);
            // XOR with magic cookie || transaction id
            let mut key = [0u8; 16];
            key[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
            key[4..].copy_from_slice(txid);
            for i in 0..16 {
                x[i] ^= key[i];
            }
            Ok(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(x)), port))
        }
        other => Err(ClientError::Stun(format!(
            "unknown address family {other:#04x}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// XOR-MAPPED-ADDRESS round-trip using a known-good test vector
    /// (RFC 5769 §2.1 — STUN Binding Request).
    ///
    /// The IPv4 reflexive address is 192.0.2.1:32853. We construct the
    /// XOR'd form and confirm we parse it back to the same address.
    #[test]
    fn xor_mapped_v4_roundtrip() {
        let txid = [0u8; 12];
        let port = 32853u16;
        let xport = port ^ ((MAGIC_COOKIE >> 16) as u16);
        let addr = u32::from_be_bytes([192, 0, 2, 1]);
        let xaddr = addr ^ MAGIC_COOKIE;
        let mut attr = vec![0u8, 0x01, 0, 0, 0, 0, 0, 0];
        attr[2..4].copy_from_slice(&xport.to_be_bytes());
        attr[4..8].copy_from_slice(&xaddr.to_be_bytes());
        let parsed = parse_xor_mapped_address(&attr, &txid).unwrap();
        assert_eq!(parsed, "192.0.2.1:32853".parse().unwrap());
    }

    /// End-to-end: build a response that parses cleanly.
    #[test]
    fn parses_synthesised_response() {
        let txid = random_transaction_id();
        let mut response = Vec::new();
        // Header: success response, will-fill-in length, cookie, txid
        response.extend_from_slice(&BINDING_SUCCESS_RESPONSE.to_be_bytes());
        let len_placeholder = response.len();
        response.extend_from_slice(&0u16.to_be_bytes()); // placeholder
        response.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        response.extend_from_slice(&txid);

        // XOR-MAPPED-ADDRESS: v4, 1.2.3.4:5678
        let port = 5678u16;
        let xport = port ^ ((MAGIC_COOKIE >> 16) as u16);
        let addr = u32::from_be_bytes([1, 2, 3, 4]);
        let xaddr = addr ^ MAGIC_COOKIE;

        response.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        response.extend_from_slice(&8u16.to_be_bytes());
        response.push(0);
        response.push(0x01);
        response.extend_from_slice(&xport.to_be_bytes());
        response.extend_from_slice(&xaddr.to_be_bytes());

        let attrs_len = (response.len() - 20) as u16;
        response[len_placeholder..len_placeholder + 2].copy_from_slice(&attrs_len.to_be_bytes());

        let parsed = parse_binding_response(&response, &txid).unwrap();
        assert_eq!(parsed, "1.2.3.4:5678".parse().unwrap());
    }

    #[test]
    fn rejects_wrong_txid() {
        let txid = [0u8; 12];
        let bad = [0xff; 12];

        let mut response = Vec::new();
        response.extend_from_slice(&BINDING_SUCCESS_RESPONSE.to_be_bytes());
        response.extend_from_slice(&0u16.to_be_bytes());
        response.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        response.extend_from_slice(&bad);

        let result = parse_binding_response(&response, &txid);
        assert!(result.is_err());
    }
}
