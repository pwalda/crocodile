//! Crocodile coordination server library.
//!
//! The binary in `main.rs` is a thin wrapper; everything testable lives
//! here so integration tests can spin up the server in-process.
//!
//! See `ARCHITECTURE.md` (workspace root) for the design context. This
//! crate covers Milestone 2 (and grows through Milestones 7, 9, 10 as
//! offline-cache, history-head adjudication, and federation land).

#![forbid(unsafe_code)]
#![warn(rust_2018_idioms, unreachable_pub)]

pub mod api;
pub mod auth;
pub mod config;
pub mod domain;
pub mod error;
pub mod server_identity;
pub mod storage;

use std::sync::Arc;

use axum::Router;
use sqlx::PgPool;

use crate::config::Config;
use crate::server_identity::ServerIdentity;
use crate::storage::Storage;

/// Shared application state passed to all handlers.
#[derive(Clone)]
pub struct AppState {
    /// Database access.
    pub storage: Arc<Storage>,
    /// Server identity (signing key + derived ServerId).
    pub identity: Arc<ServerIdentity>,
    /// Loaded config (mostly immutable).
    pub config: Arc<Config>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("server_id", &self.identity.server_id())
            .finish()
    }
}

/// Build the axum router from the application state.
///
/// Kept as a free function so tests can construct routers against
/// fake/in-memory states without touching `main`.
pub fn build_router(state: AppState) -> Router {
    use tower_http::trace::TraceLayer;
    api::routes::router(state.clone())
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

/// Convenience: build an AppState from a config and an already-open
/// Postgres pool. Loads or generates the server identity from the path
/// in config.
pub async fn build_state(config: Config, pool: PgPool) -> anyhow::Result<AppState> {
    let identity = ServerIdentity::load_or_generate(&config.server_identity_path)?;
    let storage = Storage::new(pool);
    Ok(AppState {
        storage: Arc::new(storage),
        identity: Arc::new(identity),
        config: Arc::new(config),
    })
}
