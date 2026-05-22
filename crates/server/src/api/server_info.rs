//! `GET /v1/server/info` — server identity discovery.
//!
//! Clients hit this on first contact to TOFU-trust the server's
//! identity public key. Subsequent verifications of cached
//! `SignedServerStatement`s use the cached pubkey.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub server_id_hex: String,
    pub identity_public_key_hex: String,
    /// Protocol version this build speaks.
    pub protocol_version: u16,
    /// TTL applied to all signed statements this server issues.
    pub statement_ttl_secs: i64,
}

pub async fn server_info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        server_id_hex: hex::encode(state.identity.server_id().as_bytes()),
        identity_public_key_hex: hex::encode(state.identity.public_key().0),
        protocol_version: crocodile_protocol::PROTOCOL_VERSION.get(),
        statement_ttl_secs: state.config.statement_ttl_secs,
    })
}
