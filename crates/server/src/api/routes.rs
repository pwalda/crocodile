//! Axum router assembly.

use axum::routing::{delete, get, post};
use axum::Router;

use crate::AppState;

/// Build the router. Versioned under `/v1` so we can break-and-add v2
/// alongside without coordinating a flag day.
pub fn router(_state: AppState) -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        // Discovery
        .route("/v1/server/info", get(super::server_info::server_info))
        // Accounts / sessions
        .route("/v1/accounts", post(super::accounts::create_account))
        .route("/v1/sessions", post(super::sessions::login))
        .route("/v1/sessions/current", delete(super::sessions::logout))
        // Keystore
        .route("/v1/devices", post(super::keys::publish_device_key))
        .route("/v1/users/{user_id}/keys", get(super::keys::get_user_keys))
        // Username lookup (unauthenticated). Lets a peer share a
        // short username instead of a 32-byte hex user id. Enables
        // username enumeration; that's an accepted tradeoff for the
        // out-of-band introduction flow.
        .route(
            "/v1/users/by-username/{username}",
            get(super::keys::lookup_by_username),
        )
        // Rooms
        .route(
            "/v1/rooms",
            post(super::rooms::create_room).get(super::rooms::list_my_rooms),
        )
        .route(
            "/v1/rooms/{room_id}",
            get(super::rooms::get_room_state).delete(super::rooms::delete_or_leave_room),
        )
        .route(
            "/v1/rooms/{room_id}/members",
            post(super::rooms::add_member),
        )
        .route(
            "/v1/rooms/{room_id}/members/{user_id}",
            delete(super::rooms::remove_member),
        )
        .route(
            "/v1/rooms/{room_id}/history-head",
            post(super::rooms::post_history_head),
        )
        // Signaling (WebSocket)
        .route("/v1/signaling", get(super::signaling_ws::signaling))
}

async fn health() -> &'static str {
    "ok"
}
