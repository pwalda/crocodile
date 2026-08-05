//! Login (issue session token) and logout (revoke token).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::auth_extract::AuthSession;
use crate::auth::{password, session::SessionToken};
use crate::error::{ApiError, ApiResult};
use crate::storage::{accounts, sessions};
use crate::AppState;

/// POST /v1/sessions request.
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    /// Username chosen at signup.
    pub username: String,
    /// Plaintext password (over TLS only).
    pub password: String,
}

/// POST /v1/sessions response.
#[derive(Debug, Serialize)]
pub struct LoginResponse {
    /// Opaque bearer token. Present in `Authorization: Bearer <token>`
    /// on subsequent requests.
    pub session_token: String,
    /// Convenience: the user_id, hex-encoded.
    pub user_id_hex: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<(StatusCode, Json<LoginResponse>)> {
    let account = accounts::by_username(state.storage.db(), &req.username)
        .await?
        // Same error for "no such user" and "wrong password" to avoid
        // a username-enumeration oracle.
        .ok_or(ApiError::Unauthorized)?;

    let ok = password::verify(&req.password, &account.password_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("argon2 verify error: {e}")))?;
    if !ok {
        return Err(ApiError::Unauthorized);
    }

    let token = SessionToken::generate();
    sessions::insert(state.storage.db(), &token.hash(), account.id).await?;

    Ok((
        StatusCode::CREATED,
        Json(LoginResponse {
            session_token: token.0.clone(),
            user_id_hex: hex::encode(account.user_id),
        }),
    ))
}

pub async fn logout(State(state): State<AppState>, auth: AuthSession) -> ApiResult<StatusCode> {
    sessions::delete(state.storage.db(), &auth.token_hash).await?;
    Ok(StatusCode::NO_CONTENT)
}
