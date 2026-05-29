//! Persistent, TTL-enforced cache for `SignedServerStatement<T>` values.
//!
//! The in-memory peer-hints registry lives at [`peer_hints`].
//!
//! Stores the postcard-encoded bytes of each statement so the
//! verification path is identical between cache hits and live server
//! responses: decode, then `verify` against the pinned server pubkey
//! with the current time.
//!
//! Eviction is two-layer:
//!
//! 1. **Read-time enforcement**: every `get` checks `expires_at` and
//!    returns `None` if expired (without deleting; deletion happens in
//!    a sweep).
//! 2. **Background sweep**: callers periodically invoke
//!    [`Cache::sweep_expired`] to physically delete rows.
//!
//! This split avoids surprising read latency from cleanup work.

pub mod peer_hints;

use std::path::Path;
use std::str::FromStr;

use serde::{de::DeserializeOwned, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::time::UnixSeconds;

use crate::error::{CacheError, Result};

/// Cache kind discriminator. Stable strings — never renumber.
pub mod kind {
    /// `CacheableServerStatement::UserKeys`, keyed by hex user id.
    pub const USER_KEYS: &str = "user_keys";
    /// `CacheableServerStatement::RoomState`, keyed by hex room id.
    pub const ROOM_STATE: &str = "room_state";
}

/// The cache handle. Cheap to clone (wraps an `sqlx::SqlitePool`).
#[derive(Debug, Clone)]
pub struct Cache {
    pool: SqlitePool,
}

impl Cache {
    /// Open (and migrate) the cache at the given filesystem path. The
    /// file is created if it does not exist. Use ":memory:" for tests.
    pub async fn open(path: &Path) -> Result<Self, CacheError> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        Self::open_with_options(options).await
    }

    /// Open an in-memory cache. Convenient for tests.
    pub async fn open_in_memory() -> Result<Self, CacheError> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?;
        Self::open_with_options(options).await
    }

    async fn open_with_options(options: SqliteConnectOptions) -> Result<Self, CacheError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    /// Insert (or overwrite) a signed statement under `(kind, key)`.
    pub async fn put<T>(
        &self,
        kind: &str,
        key: &str,
        statement: &SignedServerStatement<T>,
    ) -> Result<(), CacheError>
    where
        T: Serialize,
    {
        let bytes = postcard::to_stdvec(statement)?;
        sqlx::query(
            r#"INSERT INTO signed_statements (kind, key, bytes, expires_at, received_at)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT (kind, key) DO UPDATE SET
                 bytes = excluded.bytes,
                 expires_at = excluded.expires_at,
                 received_at = excluded.received_at"#,
        )
        .bind(kind)
        .bind(key)
        .bind(bytes)
        .bind(statement.expires_at.get())
        .bind(statement.issued_at.get())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fetch a cached statement if present and unexpired *at* the
    /// given `now`. Returns `None` if missing or expired.
    pub async fn get<T>(
        &self,
        kind: &str,
        key: &str,
        now: UnixSeconds,
    ) -> Result<Option<SignedServerStatement<T>>, CacheError>
    where
        T: DeserializeOwned,
    {
        let row: Option<(Vec<u8>, i64)> = sqlx::query_as(
            r#"SELECT bytes, expires_at FROM signed_statements
               WHERE kind = ?1 AND key = ?2"#,
        )
        .bind(kind)
        .bind(key)
        .fetch_optional(&self.pool)
        .await?;
        let Some((bytes, expires_at)) = row else {
            return Ok(None);
        };
        if now.get() > expires_at {
            return Ok(None);
        }
        let stmt: SignedServerStatement<T> = postcard::from_bytes(&bytes)?;
        Ok(Some(stmt))
    }

    /// Delete all expired rows. Returns the number deleted.
    pub async fn sweep_expired(&self, now: UnixSeconds) -> Result<u64, CacheError> {
        let result = sqlx::query("DELETE FROM signed_statements WHERE expires_at < ?1")
            .bind(now.get())
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crocodile_protocol::ids::ServerId;
    use crocodile_protocol::keys::Signature;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    struct Toy {
        n: u32,
    }

    fn fake_stmt(payload: Toy, issued_at: i64, expires_at: i64) -> SignedServerStatement<Toy> {
        SignedServerStatement {
            server_id: ServerId::from_bytes([1; 32]),
            issued_at: UnixSeconds(issued_at),
            expires_at: UnixSeconds(expires_at),
            payload,
            signature: Signature([0; 64]),
        }
    }

    #[tokio::test]
    async fn put_get_roundtrip() {
        let cache = Cache::open_in_memory().await.unwrap();
        let stmt = fake_stmt(Toy { n: 7 }, 100, 200);
        cache.put("toy", "key1", &stmt).await.unwrap();

        let got: Option<SignedServerStatement<Toy>> =
            cache.get("toy", "key1", UnixSeconds(150)).await.unwrap();
        assert_eq!(got.unwrap().payload.n, 7);
    }

    #[tokio::test]
    async fn get_returns_none_after_expiry() {
        let cache = Cache::open_in_memory().await.unwrap();
        let stmt = fake_stmt(Toy { n: 7 }, 100, 200);
        cache.put("toy", "k", &stmt).await.unwrap();

        let got: Option<SignedServerStatement<Toy>> =
            cache.get("toy", "k", UnixSeconds(300)).await.unwrap();
        assert!(got.is_none(), "expired row must not be returned");
    }

    #[tokio::test]
    async fn put_overwrites() {
        let cache = Cache::open_in_memory().await.unwrap();
        let a = fake_stmt(Toy { n: 1 }, 100, 200);
        let b = fake_stmt(Toy { n: 2 }, 110, 210);
        cache.put("toy", "k", &a).await.unwrap();
        cache.put("toy", "k", &b).await.unwrap();
        let got: Option<SignedServerStatement<Toy>> =
            cache.get("toy", "k", UnixSeconds(150)).await.unwrap();
        assert_eq!(got.unwrap().payload.n, 2);
    }

    #[tokio::test]
    async fn sweep_removes_expired() {
        let cache = Cache::open_in_memory().await.unwrap();
        let live = fake_stmt(Toy { n: 1 }, 100, 1000);
        let stale = fake_stmt(Toy { n: 2 }, 100, 200);
        cache.put("toy", "live", &live).await.unwrap();
        cache.put("toy", "stale", &stale).await.unwrap();

        let removed = cache.sweep_expired(UnixSeconds(500)).await.unwrap();
        assert_eq!(removed, 1);

        let live_got: Option<SignedServerStatement<Toy>> =
            cache.get("toy", "live", UnixSeconds(500)).await.unwrap();
        assert!(live_got.is_some());
    }
}
