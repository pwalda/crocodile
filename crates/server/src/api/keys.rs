//! Keystore endpoints: publish a device key, fetch a user's device set.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::ids::UserId;
use crocodile_protocol::keys::{verify_identity_signature, DevicePublicKey, Signature};
use crocodile_protocol::signaling::CacheableServerStatement;

use crate::api::auth_extract::AuthSession;
use crate::domain::statement;
use crate::error::{ApiError, ApiResult};
use crate::storage::{accounts, devices};
use crate::AppState;

/// POST /v1/devices request.
#[derive(Debug, Deserialize)]
pub struct PublishDeviceKeyRequest {
    /// Hex-encoded 32-byte device public key.
    pub device_public_key_hex: String,
    /// Hex-encoded 64-byte identity-key signature over
    /// `(user_id || device_public_key)`.
    pub identity_signature_hex: String,
}

/// POST /v1/devices response.
#[derive(Debug, Serialize)]
pub struct PublishDeviceKeyResponse {
    /// The derived [`crocodile_protocol::ids::DeviceId`], hex.
    pub device_id_hex: String,
}

pub async fn publish_device_key(
    State(state): State<AppState>,
    auth: AuthSession,
    Json(req): Json<PublishDeviceKeyRequest>,
) -> ApiResult<(StatusCode, Json<PublishDeviceKeyResponse>)> {
    // Authenticated session → resolve account → fetch identity_pk so we
    // can verify the signature before persisting anything.
    let device_pk = parse_device_public_key(&req.device_public_key_hex)?;
    let signature = parse_signature(&req.identity_signature_hex)?;

    let account = accounts::by_id(state.storage.db(), auth.account_id)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    let signing_input = signing_input_for_binding(account.user_id_typed(), &device_pk);
    verify_identity_signature(&account.identity_pk_typed(), &signing_input, &signature)
        .map_err(|_| ApiError::BadRequest("identity_signature does not verify".into()))?;

    let device_id = devices::upsert(state.storage.db(), account.id, &device_pk, &signature)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(ref db) if db.is_unique_violation() => {
                ApiError::Conflict("device key already bound to another account".into())
            }
            other => other.into(),
        })?;

    Ok((
        StatusCode::CREATED,
        Json(PublishDeviceKeyResponse {
            device_id_hex: hex::encode(device_id.as_bytes()),
        }),
    ))
}

/// GET /v1/users/{user_id_hex}/keys
///
/// Returns a [`SignedServerStatement<CacheableServerStatement::UserKeys>`]
/// — clients cache the response and trust it for up to 48h.
///
/// The response body is the postcard-encoded statement (raw bytes,
/// content-type `application/octet-stream`) so clients use the same
/// serializer the protocol crate defines, rather than re-serialising
/// through JSON.
pub async fn get_user_keys(
    State(state): State<AppState>,
    Path(user_id_hex): Path<String>,
) -> ApiResult<Vec<u8>> {
    let user_id = parse_user_id(&user_id_hex)?;
    let account = accounts::by_user_id(state.storage.db(), user_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let bindings = devices::list_for_account(state.storage.db(), account.id).await?;

    let payload = CacheableServerStatement::UserKeys {
        user: user_id,
        devices: bindings,
    };

    let signed: SignedServerStatement<CacheableServerStatement> =
        statement::sign(&state.identity, payload, state.config.statement_ttl_secs)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("statement signing error: {e}")))?;

    let bytes = postcard::to_stdvec(&signed)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("postcard error: {e}")))?;
    Ok(bytes)
}

/// GET /v1/users/by-username/{name}
///
/// Returns the hex-encoded user id for a username, or 404 if not
/// found. Intentionally unauthenticated so peers can resolve
/// usernames as part of the out-of-band introduction flow.
pub async fn lookup_by_username(
    State(state): State<AppState>,
    axum::extract::Path(username): axum::extract::Path<String>,
) -> ApiResult<axum::Json<UsernameLookupResponse>> {
    let row = accounts::by_username(state.storage.db(), &username)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(axum::Json(UsernameLookupResponse {
        user_id_hex: hex::encode(row.user_id),
    }))
}

/// Response shape for `lookup_by_username`.
#[derive(Debug, Serialize)]
pub struct UsernameLookupResponse {
    /// Hex-encoded user id.
    pub user_id_hex: String,
}

/// Canonical byte string a user's identity key signs to bind a device
/// public key to that user.
///
/// Defined as the simple concatenation `user_id || device_public_key`
/// (32 + 32 bytes = 64 bytes). Documented here so clients implement
/// the exact same string.
pub fn signing_input_for_binding(user: UserId, device_pk: &DevicePublicKey) -> Vec<u8> {
    let mut v = Vec::with_capacity(64);
    v.extend_from_slice(user.as_bytes());
    v.extend_from_slice(&device_pk.0);
    v
}

fn parse_device_public_key(s: &str) -> Result<DevicePublicKey, ApiError> {
    let bytes = hex::decode(s)
        .map_err(|_| ApiError::BadRequest("device_public_key_hex is not hex".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!(
            "device_public_key_hex must be 32 bytes, got {}",
            v.len()
        ))
    })?;
    Ok(DevicePublicKey(arr))
}

fn parse_signature(s: &str) -> Result<Signature, ApiError> {
    let bytes = hex::decode(s)
        .map_err(|_| ApiError::BadRequest("identity_signature_hex is not hex".into()))?;
    let arr: [u8; 64] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!(
            "identity_signature_hex must be 64 bytes, got {}",
            v.len()
        ))
    })?;
    Ok(Signature(arr))
}

fn parse_user_id(s: &str) -> Result<UserId, ApiError> {
    let bytes = hex::decode(s).map_err(|_| ApiError::BadRequest("user_id is not hex".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!("user_id must be 32 bytes, got {}", v.len()))
    })?;
    Ok(UserId::from_bytes(arr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::keys::{user_id_from_public_key, IdentityPublicKey};

    #[test]
    fn binding_signing_input_is_concat() {
        let ipk = IdentityPublicKey([7; 32]);
        let user = user_id_from_public_key(&ipk);
        let dpk = DevicePublicKey([9; 32]);
        let v = signing_input_for_binding(user, &dpk);
        assert_eq!(v.len(), 64);
        assert_eq!(&v[..32], user.as_bytes());
        assert_eq!(&v[32..], &dpk.0);
    }
}
