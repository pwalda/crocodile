//! Session-related storage.
//!
//! Sessions are identified by an opaque random token. The DB stores
//! only `SHA-256(token)` — so a full DB read does not yield valid
//! tokens. Lookup is by hash.

use uuid::Uuid;

use crate::dispatch;
use crate::storage::Db;

/// Insert a new session for an account.
pub async fn insert(db: &Db, token_hash: &[u8; 32], account_id: Uuid) -> Result<(), sqlx::Error> {
    dispatch!(db, |pool| {
        sqlx::query(
            r#"
            INSERT INTO sessions (token_hash, account_id)
            VALUES ($1, $2)
            "#,
        )
        .bind(token_hash.as_slice())
        .bind(account_id)
        .execute(pool)
        .await?;
    });
    Ok(())
}

/// Look up the account associated with a token hash and refresh
/// `last_seen_at`. Returns `None` if the token is unknown.
pub async fn touch_and_resolve(
    db: &Db,
    token_hash: &[u8; 32],
) -> Result<Option<Uuid>, sqlx::Error> {
    // `now()` (Postgres) vs `strftime('%s','now')` (SQLite) is the one
    // dialect divergence; the last_seen_at column type matches each
    // backend's expression (TIMESTAMPTZ / INTEGER).
    let now_expr = if db.is_sqlite() {
        "strftime('%s','now')"
    } else {
        "now()"
    };
    let sql = format!(
        "UPDATE sessions SET last_seen_at = {now_expr} WHERE token_hash = $1 RETURNING account_id"
    );
    let row: Option<(Uuid,)> = dispatch!(db, |pool| {
        sqlx::query_as(&sql)
            .bind(token_hash.as_slice())
            .fetch_optional(pool)
            .await?
    });
    Ok(row.map(|(a,)| a))
}

/// Delete a session (logout).
pub async fn delete(db: &Db, token_hash: &[u8; 32]) -> Result<u64, sqlx::Error> {
    let removed = dispatch!(db, |pool| {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash.as_slice())
            .execute(pool)
            .await?
            .rows_affected()
    });
    Ok(removed)
}
