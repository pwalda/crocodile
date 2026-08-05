//! Room and membership storage.

use rand::rngs::OsRng;
use rand::RngCore;
use uuid::Uuid;

use crocodile_protocol::ids::{RoomId, UserId};
use crocodile_protocol::keys::IdentityPublicKey;
use crocodile_protocol::signaling::{RoomMember, RoomRole};

use crate::dispatch;
use crate::storage::Db;

/// Insert a new room with the given creator as `owner`. Returns the
/// freshly-generated room id.
pub async fn create(
    db: &Db,
    name: &str,
    description: &str,
    creator_account_id: Uuid,
) -> Result<RoomId, sqlx::Error> {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let room_id = RoomId::from_bytes(bytes);

    // Wrap the two inserts in a transaction on whichever backend.
    dispatch!(db, |pool| {
        let mut tx = pool.begin().await?;
        sqlx::query("INSERT INTO rooms (id, name, description) VALUES ($1, $2, $3)")
            .bind(room_id.as_bytes().as_slice())
            .bind(name)
            .bind(description)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            r#"INSERT INTO room_members (room_id, account_id, role)
               VALUES ($1, $2, 'owner')"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .bind(creator_account_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    });
    Ok(room_id)
}

/// Returns true if the given account is a member of the room.
pub async fn is_member(db: &Db, room_id: RoomId, account_id: Uuid) -> Result<bool, sqlx::Error> {
    let exists: Option<i32> = dispatch!(db, |pool| {
        sqlx::query_scalar(
            r#"SELECT 1 FROM room_members
               WHERE room_id = $1 AND account_id = $2"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .bind(account_id)
        .fetch_optional(pool)
        .await?
    });
    Ok(exists.is_some())
}

/// Returns the caller's role in the room, or `None` if not a member.
pub async fn role_of(
    db: &Db,
    room_id: RoomId,
    account_id: Uuid,
) -> Result<Option<RoomRole>, sqlx::Error> {
    let row: Option<(String,)> = dispatch!(db, |pool| {
        sqlx::query_as(
            r#"SELECT role FROM room_members
               WHERE room_id = $1 AND account_id = $2"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .bind(account_id)
        .fetch_optional(pool)
        .await?
    });
    Ok(row.map(|(s,)| parse_role(&s)))
}

/// Add an account as a regular member. Returns `Ok(false)` if the
/// account is already a member (idempotent), `Ok(true)` if newly added.
pub async fn add_member(db: &Db, room_id: RoomId, account_id: Uuid) -> Result<bool, sqlx::Error> {
    // rows_affected() is extracted inside the arm because the two
    // backends return distinct QueryResult types that can't unify
    // across the match boundary.
    let added = dispatch!(db, |pool| {
        sqlx::query(
            r#"INSERT INTO room_members (room_id, account_id, role)
               VALUES ($1, $2, 'member')
               ON CONFLICT DO NOTHING"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .bind(account_id)
        .execute(pool)
        .await?
        .rows_affected()
            > 0
    });
    Ok(added)
}

/// Remove a member. Returns whether a row was deleted. Refuses to remove
/// an owner: the caller must check the target's role first and surface
/// the right error to the user.
pub async fn remove_member(db: &Db, room_id: RoomId, account_id: Uuid) -> Result<u64, sqlx::Error> {
    let removed = dispatch!(db, |pool| {
        sqlx::query(
            r#"DELETE FROM room_members
               WHERE room_id = $1 AND account_id = $2 AND role <> 'owner'"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .bind(account_id)
        .execute(pool)
        .await?
        .rows_affected()
    });
    Ok(removed)
}

/// List the members of a room, joined with account identity data.
pub async fn list_members(db: &Db, room_id: RoomId) -> Result<Vec<RoomMember>, sqlx::Error> {
    let rows: Vec<(Vec<u8>, Vec<u8>, String)> = dispatch!(db, |pool| {
        sqlx::query_as(
            r#"SELECT a.user_id, a.identity_public_key, m.role
               FROM room_members m
               JOIN accounts a ON a.id = m.account_id
               WHERE m.room_id = $1
               ORDER BY a.user_id"#,
        )
        .bind(room_id.as_bytes().as_slice())
        .fetch_all(pool)
        .await?
    });

    Ok(rows
        .into_iter()
        .map(|(uid, ipk, role)| RoomMember {
            user: UserId::from_bytes(uid.try_into().expect("user_id column must be 32 bytes")),
            identity_public_key: IdentityPublicKey(
                ipk.try_into()
                    .expect("identity_public_key column must be 32 bytes"),
            ),
            role: parse_role(&role),
        })
        .collect())
}

/// A room the caller belongs to: id, display name, and the caller's
/// role in it.
pub struct MyRoom {
    /// Room id.
    pub room: RoomId,
    /// Human-readable room name.
    pub name: String,
    /// The caller's role in this room.
    pub role: RoomRole,
}

/// List the rooms a given account is a member of, newest first.
pub async fn list_for_account(db: &Db, account_id: Uuid) -> Result<Vec<MyRoom>, sqlx::Error> {
    let rows: Vec<(Vec<u8>, String, String)> = dispatch!(db, |pool| {
        sqlx::query_as(
            r#"SELECT r.id, r.name, m.role
               FROM room_members m
               JOIN rooms r ON r.id = m.room_id
               WHERE m.account_id = $1
               ORDER BY r.created_at DESC"#,
        )
        .bind(account_id)
        .fetch_all(pool)
        .await?
    });
    Ok(rows
        .into_iter()
        .map(|(id, name, role)| MyRoom {
            room: RoomId::from_bytes(id.try_into().expect("room id must be 32 bytes")),
            name,
            role: parse_role(&role),
        })
        .collect())
}

/// Delete a room and, by cascade, its membership and history-head rows.
/// Caller must have already checked that the requester owns the room.
pub async fn delete(db: &Db, room_id: RoomId) -> Result<u64, sqlx::Error> {
    let removed = dispatch!(db, |pool| {
        sqlx::query("DELETE FROM rooms WHERE id = $1")
            .bind(room_id.as_bytes().as_slice())
            .execute(pool)
            .await?
            .rows_affected()
    });
    Ok(removed)
}

/// Returns true if the room exists.
pub async fn exists(db: &Db, room_id: RoomId) -> Result<bool, sqlx::Error> {
    let row: Option<i32> = dispatch!(db, |pool| {
        sqlx::query_scalar("SELECT 1 FROM rooms WHERE id = $1")
            .bind(room_id.as_bytes().as_slice())
            .fetch_optional(pool)
            .await?
    });
    Ok(row.is_some())
}

fn parse_role(s: &str) -> RoomRole {
    // The CHECK constraint at the schema level enforces these values,
    // so anything else here indicates DB corruption.
    match s {
        "member" => RoomRole::Member,
        "admin" => RoomRole::Admin,
        "owner" => RoomRole::Owner,
        other => panic!("invalid role in DB: {other}"),
    }
}
