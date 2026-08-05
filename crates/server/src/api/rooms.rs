//! Room CRUD + membership + history-head endpoints.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::history::{freshness_cmp, HistoryHead, MessageHash};
use crocodile_protocol::ids::{DeviceId, RoomId, UserId};
use crocodile_protocol::keys::{verify_device_signature, DevicePublicKey, Signature};
use crocodile_protocol::signaling::{CacheableServerStatement, PeerHint, RoomRole};
use crocodile_protocol::time::UnixSeconds;

use crate::api::auth_extract::AuthSession;
use crate::domain::statement;
use crate::error::{ApiError, ApiResult};
use crate::storage::{accounts, history_heads, rooms};
use crate::AppState;

// ---------- List my rooms ----------

/// One entry in the caller's room list.
#[derive(Debug, Serialize)]
pub struct MyRoomEntry {
    /// Room id, hex-encoded.
    pub room_id_hex: String,
    /// Human-readable room name.
    pub name: String,
    /// The caller's role: "owner", "admin", or "member".
    pub role: String,
}

/// GET /v1/rooms — list the rooms the authenticated caller belongs to.
/// Lets clients present a pick-list instead of making users paste room
/// ids.
pub async fn list_my_rooms(
    State(state): State<AppState>,
    auth: AuthSession,
) -> ApiResult<Json<Vec<MyRoomEntry>>> {
    let rooms = rooms::list_for_account(state.storage.db(), auth.account_id).await?;
    let entries = rooms
        .into_iter()
        .map(|r| MyRoomEntry {
            room_id_hex: hex::encode(r.room.as_bytes()),
            name: r.name,
            role: match r.role {
                RoomRole::Owner => "owner",
                RoomRole::Admin => "admin",
                RoomRole::Member => "member",
            }
            .to_string(),
        })
        .collect();
    Ok(Json(entries))
}

// ---------- Create room ----------

#[derive(Debug, Deserialize)]
pub struct CreateRoomRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Serialize)]
pub struct CreateRoomResponse {
    /// The new room's id, hex-encoded.
    pub room_id_hex: String,
}

const MIN_ROOM_NAME_LEN: usize = 1;
const MAX_ROOM_NAME_LEN: usize = 128;
const MAX_ROOM_DESC_LEN: usize = 1024;

pub async fn create_room(
    State(state): State<AppState>,
    auth: AuthSession,
    Json(req): Json<CreateRoomRequest>,
) -> ApiResult<(StatusCode, Json<CreateRoomResponse>)> {
    if req.name.len() < MIN_ROOM_NAME_LEN || req.name.len() > MAX_ROOM_NAME_LEN {
        return Err(ApiError::BadRequest(format!(
            "room name must be {MIN_ROOM_NAME_LEN}..={MAX_ROOM_NAME_LEN} characters"
        )));
    }
    if req.description.len() > MAX_ROOM_DESC_LEN {
        return Err(ApiError::BadRequest(format!(
            "room description must be at most {MAX_ROOM_DESC_LEN} characters"
        )));
    }

    let room_id = rooms::create(
        state.storage.db(),
        &req.name,
        &req.description,
        auth.account_id,
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreateRoomResponse {
            room_id_hex: hex::encode(room_id.as_bytes()),
        }),
    ))
}

// ---------- Get room state ----------

/// Returns a postcard-encoded `SignedServerStatement<CacheableServerStatement::RoomState>`.
pub async fn get_room_state(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(room_id_hex): Path<String>,
) -> ApiResult<Vec<u8>> {
    let room_id = parse_room_id(&room_id_hex)?;

    if !rooms::exists(state.storage.db(), room_id).await? {
        return Err(ApiError::NotFound);
    }
    if !rooms::is_member(state.storage.db(), room_id, auth.account_id).await? {
        // Hide membership of rooms the caller isn't in by returning the
        // same status as "doesn't exist." Disclosure of room existence
        // to non-members is a metadata leak; this collapses the two
        // cases.
        return Err(ApiError::NotFound);
    }

    let members = rooms::list_members(state.storage.db(), room_id).await?;
    let head = history_heads::get(state.storage.db(), room_id).await?;
    let peer_hints: Vec<PeerHint> = build_peer_hints(&state, room_id).await;

    let payload = CacheableServerStatement::RoomState {
        room: room_id,
        members,
        head,
        peer_hints,
    };
    let signed: SignedServerStatement<CacheableServerStatement> =
        statement::sign(&state.identity, payload, state.config.statement_ttl_secs)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("statement signing error: {e}")))?;

    postcard::to_stdvec(&signed)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("postcard error: {e}")))
}

// Build peer hints for online members of `room_id`. The reflexive
// address discovery is not wired in yet — that needs the server to
// observe the client's source address during the WS handshake, which
// lands properly in a follow-up. For now we return online members with
// a placeholder address so the wire shape is stable.
async fn build_peer_hints(state: &AppState, room_id: RoomId) -> Vec<PeerHint> {
    let online: std::collections::HashSet<DeviceId> =
        state.signaling.online_devices().await.into_iter().collect();
    if online.is_empty() {
        return vec![];
    }

    // For each member of the room, surface their currently-online
    // devices. Membership ↔ devices join: room_members → accounts →
    // devices. We do this cheaply with a single query.
    let query_result = crate::dispatch!(state.storage.db(), |pool| {
        sqlx::query_as::<_, (Vec<u8>,)>(
            r#"SELECT d.device_id
               FROM room_members m
               JOIN devices d ON d.account_id = m.account_id
               WHERE m.room_id = $1"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .fetch_all(pool)
        .await
    });
    let rows: Vec<(Vec<u8>,)> = match query_result {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "peer_hint query failed; returning empty list");
            return vec![];
        }
    };

    rows.into_iter()
        .filter_map(|(d,)| {
            let arr: [u8; 32] = d.try_into().ok()?;
            let dev = DeviceId::from_bytes(arr);
            if !online.contains(&dev) {
                return None;
            }
            Some(PeerHint {
                device: dev,
                // Placeholder until reflexive-address observation is
                // wired in; the structure is here so clients don't
                // have to special-case absence.
                reflexive_addr: crocodile_protocol::signaling::SocketAddrBytes {
                    is_v6: false,
                    addr: vec![0, 0, 0, 0],
                    port: 0,
                },
                last_seen: UnixSeconds::now(),
            })
        })
        .collect()
}

// ---------- Add / remove members ----------

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    /// Hex-encoded user id to add to the room.
    pub user_id_hex: String,
}

pub async fn add_member(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(room_id_hex): Path<String>,
    Json(req): Json<AddMemberRequest>,
) -> ApiResult<StatusCode> {
    let room_id = parse_room_id(&room_id_hex)?;
    require_admin(&state, room_id, auth.account_id).await?;

    let user_id = parse_user_id(&req.user_id_hex)?;
    let target = accounts::by_user_id(state.storage.db(), user_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("user not found".into()))?;

    let added = rooms::add_member(state.storage.db(), room_id, target.id).await?;
    Ok(if added {
        StatusCode::CREATED
    } else {
        // Already a member — treat idempotently rather than as a 409.
        StatusCode::OK
    })
}

pub async fn remove_member(
    State(state): State<AppState>,
    auth: AuthSession,
    Path((room_id_hex, user_id_hex)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let room_id = parse_room_id(&room_id_hex)?;
    require_admin(&state, room_id, auth.account_id).await?;

    let user_id = parse_user_id(&user_id_hex)?;
    let target = accounts::by_user_id(state.storage.db(), user_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("user not found".into()))?;

    // remove_member at the storage layer refuses to delete owners; if
    // 0 rows are affected we either targeted the owner or a non-member.
    let target_role = rooms::role_of(state.storage.db(), room_id, target.id).await?;
    if target_role == Some(RoomRole::Owner) {
        return Err(ApiError::BadRequest("cannot remove room owner".into()));
    }

    let removed = rooms::remove_member(state.storage.db(), room_id, target.id).await?;
    if removed == 0 {
        Err(ApiError::NotFound)
    } else {
        Ok(StatusCode::NO_CONTENT)
    }
}

async fn require_admin(state: &AppState, room_id: RoomId, account_id: uuid::Uuid) -> ApiResult<()> {
    let role = rooms::role_of(state.storage.db(), room_id, account_id).await?;
    match role {
        Some(RoomRole::Admin) | Some(RoomRole::Owner) => Ok(()),
        // Treat "non-admin member" as Forbidden via 401-equivalent;
        // "not a member" we hide as NotFound to avoid existence leaks.
        Some(RoomRole::Member) => Err(ApiError::Unauthorized),
        None => Err(ApiError::NotFound),
    }
}

// ---------- Post history head ----------

/// JSON-friendly history-head submission body. Mirrors
/// [`HistoryHead`] but uses hex strings for byte fields so the body is
/// debuggable from curl. The server reconstructs a [`HistoryHead`] and
/// verifies the signature against the canonical postcard signing input.
#[derive(Debug, Deserialize)]
pub struct PostHistoryHeadRequest {
    pub head_hex: String,
    pub message_count: u64,
    pub posted_at_unix_secs: i64,
    pub posted_by_device_hex: String,
    pub signature_hex: String,
}

#[derive(Debug, Serialize)]
pub struct PostHistoryHeadResponse {
    pub accepted: bool,
    /// If rejected as stale, the current head's message count for the
    /// poster to retry from.
    pub current_message_count: Option<u64>,
}

pub async fn post_history_head(
    State(state): State<AppState>,
    auth: AuthSession,
    Path(room_id_hex): Path<String>,
    Json(req): Json<PostHistoryHeadRequest>,
) -> ApiResult<(StatusCode, Json<PostHistoryHeadResponse>)> {
    let room_id = parse_room_id(&room_id_hex)?;

    if !rooms::is_member(state.storage.db(), room_id, auth.account_id).await? {
        return Err(ApiError::NotFound);
    }

    let head_bytes: [u8; 32] = hex::decode(&req.head_hex)
        .map_err(|_| ApiError::BadRequest("head_hex is not hex".into()))?
        .try_into()
        .map_err(|_| ApiError::BadRequest("head_hex must be 32 bytes".into()))?;
    let device_bytes: [u8; 32] = hex::decode(&req.posted_by_device_hex)
        .map_err(|_| ApiError::BadRequest("posted_by_device_hex is not hex".into()))?
        .try_into()
        .map_err(|_| ApiError::BadRequest("posted_by_device_hex must be 32 bytes".into()))?;
    let sig_bytes: [u8; 64] = hex::decode(&req.signature_hex)
        .map_err(|_| ApiError::BadRequest("signature_hex is not hex".into()))?
        .try_into()
        .map_err(|_| ApiError::BadRequest("signature_hex must be 64 bytes".into()))?;

    let head = HistoryHead {
        room: room_id,
        head: MessageHash(head_bytes),
        message_count: req.message_count,
        posted_at: UnixSeconds(req.posted_at_unix_secs),
        posted_by: DeviceId::from_bytes(device_bytes),
        signature: Signature(sig_bytes),
    };

    // Fetch the device's public key to verify the signature. Per spec,
    // any member can post; the device must be registered to *some*
    // account but does not have to belong to the calling session
    // (e.g. the host on the call posts, even if a different session
    // owns the API call). We accept any device registered server-side.
    let dpk = lookup_device_pubkey(state.storage.db(), head.posted_by)
        .await?
        .ok_or_else(|| ApiError::BadRequest("posted_by_device is not registered".into()))?;

    let signing_input = head
        .signing_input()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("signing_input error: {e}")))?;
    verify_device_signature(&dpk, &signing_input, &head.signature)
        .map_err(|_| ApiError::BadRequest("signature does not verify".into()))?;

    // Freshness check vs. the currently-stored head.
    let current = history_heads::get(state.storage.db(), room_id).await?;
    if let Some(prev) = current.as_ref() {
        match freshness_cmp(&head, prev) {
            std::cmp::Ordering::Greater => {} // proceed
            // Equal or older: reject as stale.
            _ => {
                return Ok((
                    StatusCode::CONFLICT,
                    Json(PostHistoryHeadResponse {
                        accepted: false,
                        current_message_count: Some(prev.message_count),
                    }),
                ));
            }
        }
    }

    history_heads::put(state.storage.db(), &head).await?;
    Ok((
        StatusCode::CREATED,
        Json(PostHistoryHeadResponse {
            accepted: true,
            current_message_count: None,
        }),
    ))
}

async fn lookup_device_pubkey(
    db: &crate::storage::Db,
    device: DeviceId,
) -> Result<Option<DevicePublicKey>, sqlx::Error> {
    let row: Option<(Vec<u8>,)> = crate::dispatch!(db, |pool| {
        sqlx::query_as("SELECT device_public_key FROM devices WHERE device_id = $1")
            .bind(device.as_bytes().as_slice())
            .fetch_optional(pool)
            .await?
    });
    Ok(row.map(|(b,)| {
        DevicePublicKey(
            b.try_into()
                .expect("device_public_key column must be 32 bytes"),
        )
    }))
}

// ---------- Helpers ----------

fn parse_room_id(s: &str) -> Result<RoomId, ApiError> {
    let bytes = hex::decode(s).map_err(|_| ApiError::BadRequest("room_id is not hex".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!("room_id must be 32 bytes, got {}", v.len()))
    })?;
    Ok(RoomId::from_bytes(arr))
}

fn parse_user_id(s: &str) -> Result<UserId, ApiError> {
    let bytes = hex::decode(s).map_err(|_| ApiError::BadRequest("user_id is not hex".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|v: Vec<u8>| {
        ApiError::BadRequest(format!("user_id must be 32 bytes, got {}", v.len()))
    })?;
    Ok(UserId::from_bytes(arr))
}
