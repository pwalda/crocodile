//! Persistent storage layer.
//!
//! Wraps a `sqlx::PgPool` and exposes typed methods the API handlers
//! call. Queries are runtime-checked (`sqlx::query`, `query_as`)
//! rather than compile-time-checked (`query!`, `query_as!`) so that
//! the build does not require a live database. We can promote to
//! compile-time checking later via `cargo sqlx prepare` once the
//! schema stabilises.

pub mod accounts;
pub mod devices;
pub mod sessions;

use sqlx::PgPool;

/// Thin wrapper around the Postgres pool.
#[derive(Debug, Clone)]
pub struct Storage {
    pool: PgPool,
}

impl Storage {
    /// Construct from an already-open pool.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Borrow the pool. Module-internal queries take a pool reference
    /// directly to keep the API methods small and composable.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
}
