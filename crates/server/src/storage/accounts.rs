//! Account-related storage.

use uuid::Uuid;

use crocodile_protocol::ids::UserId;
use crocodile_protocol::keys::{user_id_from_public_key, IdentityPublicKey};

use crate::dispatch;
use crate::storage::Db;

/// Row stored in the `accounts` table.
#[derive(Debug, Clone)]
pub struct AccountRow {
    /// Internal account UUID.
    pub id: Uuid,
    /// Username chosen at signup.
    pub username: String,
    /// Argon2 PHC hash of the user's password.
    pub password_hash: String,
    /// User's identity public key (raw 32 bytes).
    pub identity_public_key: [u8; 32],
    /// `BLAKE3(identity_public_key)` — denormalised for fast lookup.
    pub user_id: [u8; 32],
}

impl AccountRow {
    /// Returns the protocol-level [`UserId`] view of `self.user_id`.
    pub fn user_id_typed(&self) -> UserId {
        UserId::from_bytes(self.user_id)
    }

    /// Returns the protocol-level identity public key view.
    pub fn identity_pk_typed(&self) -> IdentityPublicKey {
        IdentityPublicKey(self.identity_public_key)
    }
}

/// Insert a new account. Returns the created row's UUID.
///
/// The id is generated in Rust (rather than via a DB default) so the
/// same INSERT works on both Postgres and SQLite — SQLite has no
/// `gen_random_uuid()`.
pub async fn insert(
    db: &Db,
    username: &str,
    password_hash: &str,
    identity_public_key: &IdentityPublicKey,
) -> Result<Uuid, sqlx::Error> {
    let user_id = user_id_from_public_key(identity_public_key);
    let id = Uuid::new_v4();
    dispatch!(db, |pool| {
        sqlx::query(
            r#"
            INSERT INTO accounts (id, username, password_hash, identity_public_key, user_id)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(id)
        .bind(username)
        .bind(password_hash)
        .bind(identity_public_key.0.as_slice())
        .bind(user_id.as_bytes().as_slice())
        .execute(pool)
        .await?;
    });
    Ok(id)
}

const SELECT_ACCOUNT: &str =
    "SELECT id, username, password_hash, identity_public_key, user_id FROM accounts";

/// Look up an account by username.
pub async fn by_username(db: &Db, username: &str) -> Result<Option<AccountRow>, sqlx::Error> {
    let sql = format!("{SELECT_ACCOUNT} WHERE username = $1");
    let row = dispatch!(db, |pool| {
        sqlx::query_as::<_, AccountRowDb>(&sql)
            .bind(username)
            .fetch_optional(pool)
            .await?
    });
    Ok(row.map(Into::into))
}

/// Look up an account by [`UserId`].
pub async fn by_user_id(db: &Db, user_id: UserId) -> Result<Option<AccountRow>, sqlx::Error> {
    let sql = format!("{SELECT_ACCOUNT} WHERE user_id = $1");
    let row = dispatch!(db, |pool| {
        sqlx::query_as::<_, AccountRowDb>(&sql)
            .bind(user_id.as_bytes().as_slice())
            .fetch_optional(pool)
            .await?
    });
    Ok(row.map(Into::into))
}

/// Look up an account by its internal UUID.
pub async fn by_id(db: &Db, id: Uuid) -> Result<Option<AccountRow>, sqlx::Error> {
    let sql = format!("{SELECT_ACCOUNT} WHERE id = $1");
    let row = dispatch!(db, |pool| {
        sqlx::query_as::<_, AccountRowDb>(&sql)
            .bind(id)
            .fetch_optional(pool)
            .await?
    });
    Ok(row.map(Into::into))
}

// Intermediate row type holding the Vec<u8>s sqlx materialises BYTEA
// columns as. Converted to the fixed-size-array AccountRow in From.
#[derive(sqlx::FromRow)]
struct AccountRowDb {
    id: Uuid,
    username: String,
    password_hash: String,
    identity_public_key: Vec<u8>,
    user_id: Vec<u8>,
}

impl From<AccountRowDb> for AccountRow {
    fn from(r: AccountRowDb) -> Self {
        // The schema enforces 32 bytes via length checks at insert
        // time (and would be caught by the BYTEA constraint were one
        // declared). Any non-32 value here indicates the DB was
        // tampered with out of band; panic is acceptable because we
        // would have no way to recover.
        let identity_public_key: [u8; 32] = r
            .identity_public_key
            .try_into()
            .expect("identity_public_key column must be 32 bytes");
        let user_id: [u8; 32] = r
            .user_id
            .try_into()
            .expect("user_id column must be 32 bytes");
        Self {
            id: r.id,
            username: r.username,
            password_hash: r.password_hash,
            identity_public_key,
            user_id,
        }
    }
}
