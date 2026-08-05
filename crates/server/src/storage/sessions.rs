//! Session-related storage.
//!
//! Sessions are identified by an opaque random token. The DB stores
//! only `SHA-256(token)` — so a full DB read does not yield valid
//! tokens. Lookup is by hash.

use sqlx::PgPool;
use uuid::Uuid;

/// Insert a new session for an account.
pub async fn insert(
    pool: &PgPool,
    token_hash: &[u8; 32],
    account_id: Uuid,
) -> Result<(), sqlx::Error> {
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
    Ok(())
}

/// Look up the account associated with a token hash and refresh
/// `last_seen_at`. Returns `None` if the token is unknown.
pub async fn touch_and_resolve(
    pool: &PgPool,
    token_hash: &[u8; 32],
) -> Result<Option<Uuid>, sqlx::Error> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        r#"
        UPDATE sessions
        SET last_seen_at = now()
        WHERE token_hash = $1
        RETURNING account_id
        "#,
    )
    .bind(token_hash.as_slice())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(a,)| a))
}

/// Delete a session (logout).
pub async fn delete(pool: &PgPool, token_hash: &[u8; 32]) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(token_hash.as_slice())
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
