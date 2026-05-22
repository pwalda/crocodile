//! Axum extractor for an authenticated session.
//!
//! Reads `Authorization: Bearer <token>`, hashes the token, looks up
//! the session, returns the resolved account ID. Side effect: bumps
//! `last_seen_at`.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::Uuid;

use crate::auth::session::SessionToken;
use crate::error::ApiError;
use crate::storage::sessions;
use crate::AppState;

/// Represents a verified, currently-active session.
#[derive(Debug, Clone)]
pub struct AuthSession {
    /// Account ID owning the session.
    pub account_id: Uuid,
    /// SHA-256 of the presented token. Lets handlers act on the
    /// specific session (e.g. logout) without re-parsing the header.
    pub token_hash: [u8; 32],
}

impl FromRequestParts<AppState> for AuthSession {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .ok_or(ApiError::Unauthorized)?;
        let raw = header.to_str().map_err(|_| ApiError::Unauthorized)?;
        let token_str = raw
            .strip_prefix("Bearer ")
            .ok_or(ApiError::Unauthorized)?
            .trim();
        let token = SessionToken::parse(token_str).ok_or(ApiError::Unauthorized)?;
        let token_hash = token.hash();
        let account_id = sessions::touch_and_resolve(state.storage.pool(), &token_hash)
            .await?
            .ok_or(ApiError::Unauthorized)?;
        Ok(AuthSession {
            account_id,
            token_hash,
        })
    }
}
