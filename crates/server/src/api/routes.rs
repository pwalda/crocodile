//! Axum router assembly.

use axum::routing::{delete, get, post};
use axum::Router;

use crate::AppState;

/// Build the router. Versioned under `/v1` so we can break-and-add v2
/// alongside without coordinating a flag day.
pub fn router(_state: AppState) -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/v1/accounts", post(super::accounts::create_account))
        .route("/v1/sessions", post(super::sessions::login))
        .route("/v1/sessions/current", delete(super::sessions::logout))
        .route("/v1/devices", post(super::keys::publish_device_key))
        .route("/v1/users/{user_id}/keys", get(super::keys::get_user_keys))
}

async fn health() -> &'static str {
    "ok"
}
