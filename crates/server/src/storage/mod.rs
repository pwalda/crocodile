//! Persistent storage layer.
//!
//! Supports two backends behind one [`Db`] handle:
//!
//! - **Postgres** — the production / federation target.
//! - **SQLite** — a zero-dependency single-file backend so the whole
//!   server runs on one machine with no Docker / no external database.
//!   This is what makes the local MVP self-contained.
//!
//! Backend is chosen from the `DATABASE_URL` scheme: anything starting
//! with `sqlite:` opens SQLite, otherwise Postgres. The two share
//! almost all SQL — sqlx accepts `$1`-style placeholders on both, and
//! `uuid::Uuid` / byte columns round-trip on both. The only dialect
//! divergence is `now()` (Postgres) vs `strftime('%s','now')`
//! (SQLite), handled at the two call sites that need it.
//!
//! Queries are runtime-checked (`sqlx::query`, `query_as`) rather than
//! compile-time-checked so the build does not require a live database.

pub mod accounts;
pub mod devices;
pub mod history_heads;
pub mod rooms;
pub mod sessions;

use std::str::FromStr;

use sqlx::postgres::PgPoolOptions;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{PgPool, SqlitePool};

/// A database handle over either supported backend.
#[derive(Debug, Clone)]
pub enum Db {
    /// PostgreSQL pool.
    Pg(PgPool),
    /// SQLite pool.
    Sqlite(SqlitePool),
}

/// Run a query body against whichever backend is active, binding the
/// pool to `$pool` inside the block. The block is monomorphised per
/// arm, so the same source runs on both typed pools without
/// duplicating the query text.
///
/// ```ignore
/// dispatch!(db, |pool| {
///     sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
///         .bind(hash)
///         .execute(pool)
///         .await
/// })
/// ```
#[macro_export]
macro_rules! dispatch {
    ($db:expr, |$pool:ident| $body:block) => {
        match $db {
            $crate::storage::Db::Pg($pool) => $body,
            $crate::storage::Db::Sqlite($pool) => $body,
        }
    };
}

impl Db {
    /// Open a pool from a `DATABASE_URL`. SQLite URLs (`sqlite:...`)
    /// select the file backend and create the file if missing;
    /// everything else is treated as Postgres.
    pub async fn open(url: &str, max_connections: u32) -> anyhow::Result<Self> {
        if url.starts_with("sqlite:") {
            let options = SqliteConnectOptions::from_str(url)?
                .create_if_missing(true)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal);
            let pool = SqlitePoolOptions::new()
                .max_connections(max_connections)
                .connect_with(options)
                .await?;
            Ok(Db::Sqlite(pool))
        } else {
            let pool = PgPoolOptions::new()
                .max_connections(max_connections)
                .connect(url)
                .await?;
            Ok(Db::Pg(pool))
        }
    }

    /// Run the backend-appropriate migrations.
    pub async fn migrate(&self) -> anyhow::Result<()> {
        match self {
            Db::Pg(pool) => sqlx::migrate!("./migrations").run(pool).await?,
            Db::Sqlite(pool) => sqlx::migrate!("./migrations_sqlite").run(pool).await?,
        }
        Ok(())
    }

    /// True if this is the SQLite backend. Used at the two call sites
    /// that need a dialect-specific `now()` expression.
    pub fn is_sqlite(&self) -> bool {
        matches!(self, Db::Sqlite(_))
    }
}

/// Thin wrapper carried in `AppState`.
#[derive(Debug, Clone)]
pub struct Storage {
    db: Db,
}

impl Storage {
    /// Construct from an already-open [`Db`].
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Borrow the backend handle.
    pub fn db(&self) -> &Db {
        &self.db
    }
}
