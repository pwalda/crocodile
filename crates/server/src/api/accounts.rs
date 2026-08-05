//! Account creation endpoint.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crocodile_protocol::ids::UserId;
use crocodile_protocol::keys::{user_id_from_public_key, IdentityPublicKey};

use crate::auth::password;
use crate::error::{ApiError, ApiResult};
use crate::storage::accounts;
use crate::AppState;

/// POST /v1/accounts request body.
#[derive(Debug, Deserialize)]
pub struct CreateAccountRequest {
    /// Human-facing handle. Must be unique server-wide.
    pub username: String,
    /// Plain password. Hashed server-side with Argon2 before storage.
    /// Never persisted in plaintext, never logged.
    pub password: String,
    /// User's identity public key (hex-encoded 32 bytes), generated
    /// client-side at first launch.
    pub identity_public_key_hex: String,
}

/// POST /v1/accounts response.
#[derive(Debug, Serialize)]
pub struct CreateAccountResponse {
    /// The derived [`UserId`] (`BLAKE3(identity_public_key)`), hex.
    pub user_id_hex: String,
}

const MIN_USERNAME_LEN: usize = 3;
const MAX_USERNAME_LEN: usize = 64;
const MIN_PASSWORD_LEN: usize = 8;

pub async fn create_account(
    State(state): State<AppState>,
    Json(req): Json<CreateAccountRequest>,
) -> ApiResult<(StatusCode, Json<CreateAccountResponse>)> {
    validate_username(&req.username)?;
    validate_password(&req.password)?;
    let ipk = parse_identity_public_key(&req.identity_public_key_hex)?;

    let hash = password::hash(&req.password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("argon2 error: {e}")))?;

    accounts::insert(state.storage.pool(), &req.username, &hash, &ipk).await?;

    let user_id: UserId = user_id_from_public_key(&ipk);

    Ok((
        StatusCode::CREATED,
        Json(CreateAccountResponse {
            user_id_hex: hex::encode(user_id.as_bytes()),
        }),
    ))
}

fn validate_username(s: &str) -> Result<(), ApiError> {
    if s.len() < MIN_USERNAME_LEN || s.len() > MAX_USERNAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "username must be {MIN_USERNAME_LEN}..={MAX_USERNAME_LEN} characters"
        )));
    }
    // Conservative charset: ASCII alphanumerics + `_-.` Avoids
    // Unicode-confusable-handle issues for v1; can be widened later.
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(ApiError::BadRequest(
            "username may contain ASCII letters, digits, '_', '-', '.'".into(),
        ));
    }
    Ok(())
}

fn validate_password(s: &str) -> Result<(), ApiError> {
    if s.len() < MIN_PASSWORD_LEN {
        return Err(ApiError::BadRequest(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    Ok(())
}

fn parse_identity_public_key(s: &str) -> Result<IdentityPublicKey, ApiError> {
    let bytes = hex::decode(s)
        .map_err(|_| ApiError::BadRequest("identity_public_key_hex is not hex".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!(
            "identity_public_key_hex must be 32 bytes, got {}",
            v.len()
        ))
    })?;
    Ok(IdentityPublicKey(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_validates() {
        assert!(validate_username("alice").is_ok());
        assert!(validate_username("a.b-c_d").is_ok());
        assert!(validate_username("ab").is_err()); // too short
        assert!(validate_username(&"a".repeat(100)).is_err()); // too long
        assert!(validate_username("space here").is_err());
    }

    #[test]
    fn password_validates() {
        assert!(validate_password("longenough").is_ok());
        assert!(validate_password("short").is_err());
    }

    #[test]
    fn ipk_parses() {
        let hex32 = "00".repeat(32);
        assert!(parse_identity_public_key(&hex32).is_ok());
        assert!(parse_identity_public_key("ff").is_err());
        assert!(parse_identity_public_key("not-hex-at-all").is_err());
    }
}
