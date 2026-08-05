//! HTTP client for the coordination server.
//!
//! Wraps `reqwest::Client`. Surfaces typed methods for the v1 server
//! API and integrates with the [`Cache`] so cacheable responses are
//! verified, stored, and reused.
//!
//! Verification posture: every `SignedServerStatement` is verified
//! against the pinned [`crocodile_protocol::keys::IdentityPublicKey`]
//! the caller passes in (resolved on first contact via the
//! `/v1/server/info` endpoint and stored client-side TOFU).

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::ids::{RoomId, UserId};
use crocodile_protocol::keys::IdentityPublicKey;
use crocodile_protocol::signaling::CacheableServerStatement;
use crocodile_protocol::time::UnixSeconds;

use crate::cache::{kind, Cache};
use crate::error::{ClientError, Result};

/// HTTP client bound to a single coordination server.
#[derive(Debug, Clone)]
pub struct CoordinationClient {
    base_url: String,
    http: reqwest::Client,
    cache: Cache,
    server_pubkey: Arc<IdentityPublicKey>,
}

impl CoordinationClient {
    /// Construct a new client.
    ///
    /// `base_url` should NOT end with `/` (e.g. `http://example.com`).
    /// `server_pubkey` is the pinned identity public key — typically
    /// obtained from `/v1/server/info` on first contact and stored.
    pub fn new(
        base_url: impl Into<String>,
        cache: Cache,
        server_pubkey: IdentityPublicKey,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
            cache,
            server_pubkey: Arc::new(server_pubkey),
        }
    }

    /// Returns the coordination server's base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Returns the server's pinned identity public key.
    pub fn pinned_pubkey(&self) -> &IdentityPublicKey {
        &self.server_pubkey
    }

    /// Fetch `/v1/server/info`. Not cached (it's metadata about caching).
    pub async fn server_info(base_url: &str) -> Result<ServerInfo> {
        let resp = reqwest::Client::new()
            .get(format!("{base_url}/v1/server/info"))
            .send()
            .await?;
        let resp = check_status(resp).await?;
        Ok(resp.json().await?)
    }

    /// Sign up a new account. Returns the derived user id (hex).
    pub async fn create_account(
        &self,
        username: &str,
        password: &str,
        identity_public_key: &IdentityPublicKey,
    ) -> Result<String> {
        let resp = self
            .http
            .post(format!("{}/v1/accounts", self.base_url))
            .json(&json!({
                "username": username,
                "password": password,
                "identity_public_key_hex": hex::encode(identity_public_key.0),
            }))
            .send()
            .await?;
        let resp = check_status(resp).await?;
        #[derive(Deserialize)]
        struct R {
            user_id_hex: String,
        }
        let body: R = resp.json().await?;
        Ok(body.user_id_hex)
    }

    /// Look up a username → user_id mapping. Used by the demo binary's
    /// `--invite-username` flow so peers don't have to swap 64-char hex
    /// strings out of band.
    pub async fn lookup_username(&self, username: &str) -> Result<String> {
        let resp = self
            .http
            .get(format!("{}/v1/users/by-username/{username}", self.base_url))
            .send()
            .await?;
        let resp = check_status(resp).await?;
        #[derive(Deserialize)]
        struct R {
            user_id_hex: String,
        }
        let body: R = resp.json().await?;
        Ok(body.user_id_hex)
    }

    /// List the rooms the authenticated caller belongs to. Lets the UI
    /// present a pick-list instead of asking users to paste room ids.
    pub async fn list_my_rooms(&self, session_token: &str) -> Result<Vec<MyRoom>> {
        let resp = self
            .http
            .get(format!("{}/v1/rooms", self.base_url))
            .bearer_auth(session_token)
            .send()
            .await?;
        let resp = check_status(resp).await?;
        Ok(resp.json().await?)
    }

    /// Delete a room you own, or leave one you're merely a member of.
    /// Rooms are created per call, so without this they accumulate in
    /// every member's list indefinitely.
    pub async fn delete_or_leave_room(&self, room_id_hex: &str, session_token: &str) -> Result<()> {
        let resp = self
            .http
            .delete(format!("{}/v1/rooms/{room_id_hex}", self.base_url))
            .bearer_auth(session_token)
            .send()
            .await?;
        check_status(resp).await?;
        Ok(())
    }

    /// Log in. Returns the session token and the derived user id (hex).
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginOutput> {
        let resp = self
            .http
            .post(format!("{}/v1/sessions", self.base_url))
            .json(&json!({"username": username, "password": password}))
            .send()
            .await?;
        let resp = check_status(resp).await?;
        Ok(resp.json().await?)
    }

    /// Fetch a user's device keystore. Cache-first: returns the cached
    /// copy if present and unexpired, otherwise fetches, verifies,
    /// caches, returns.
    pub async fn user_keys(
        &self,
        user: UserId,
        now: UnixSeconds,
    ) -> Result<SignedServerStatement<CacheableServerStatement>> {
        let key = hex::encode(user.as_bytes());
        if let Some(stmt) = self
            .cache
            .get::<CacheableServerStatement>(kind::USER_KEYS, &key, now)
            .await?
        {
            return Ok(stmt);
        }
        let bytes = self
            .fetch_bytes(&format!("/v1/users/{key}/keys"), None)
            .await?;
        let stmt: SignedServerStatement<CacheableServerStatement> = postcard::from_bytes(&bytes)?;
        stmt.verify(&self.server_pubkey, now)?;
        self.cache.put(kind::USER_KEYS, &key, &stmt).await?;
        Ok(stmt)
    }

    /// Fetch a room's state. Same cache-first semantics as
    /// [`Self::user_keys`].
    pub async fn room_state(
        &self,
        room: RoomId,
        session_token: &str,
        now: UnixSeconds,
    ) -> Result<SignedServerStatement<CacheableServerStatement>> {
        let key = hex::encode(room.as_bytes());
        if let Some(stmt) = self
            .cache
            .get::<CacheableServerStatement>(kind::ROOM_STATE, &key, now)
            .await?
        {
            return Ok(stmt);
        }
        let bytes = self
            .fetch_bytes(&format!("/v1/rooms/{key}"), Some(session_token))
            .await?;
        let stmt: SignedServerStatement<CacheableServerStatement> = postcard::from_bytes(&bytes)?;
        stmt.verify(&self.server_pubkey, now)?;
        self.cache.put(kind::ROOM_STATE, &key, &stmt).await?;
        Ok(stmt)
    }

    async fn fetch_bytes(&self, path: &str, bearer: Option<&str>) -> Result<Vec<u8>> {
        let mut req = self.http.get(format!("{}{path}", self.base_url));
        if let Some(token) = bearer {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await?;
        let resp = check_status(resp).await?;
        Ok(resp.bytes().await?.to_vec())
    }
}

/// Result of a successful login.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginOutput {
    /// Bearer token to send as `Authorization: Bearer ...`.
    pub session_token: String,
    /// Hex-encoded user id of the logged-in account.
    pub user_id_hex: String,
}

/// One room the caller belongs to (from [`CoordinationClient::list_my_rooms`]).
#[derive(Debug, Clone, Deserialize)]
pub struct MyRoom {
    /// Room id, hex-encoded.
    pub room_id_hex: String,
    /// Human-readable room name.
    pub name: String,
    /// The caller's role: "owner", "admin", or "member".
    pub role: String,
}

/// Response of `/v1/server/info`.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerInfo {
    pub server_id_hex: String,
    pub identity_public_key_hex: String,
    pub protocol_version: u16,
    pub statement_ttl_secs: i64,
}

/// On success returns the response for the caller to consume; on a
/// non-2xx status consumes the response to read the body (the server
/// returns `{"error":"..."}` diagnostics there) and surfaces it in the
/// error so failures are actually explainable.
async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let raw = resp.text().await.unwrap_or_default();
    // Prefer the `error` field of the server's JSON body; fall back to
    // the raw text.
    let body = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or(raw);
    Err(ClientError::ServerStatus {
        status: status.as_u16(),
        body,
    })
}
