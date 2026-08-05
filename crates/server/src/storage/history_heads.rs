//! History-head commitment storage.
//!
//! One row per room. On submission the server compares freshness via
//! [`crocodile_protocol::history::freshness_cmp`] and only updates if
//! the incoming head wins. Fork handling (carrying multiple competing
//! heads) is deferred to milestone 9.

use sqlx::PgPool;

use crocodile_protocol::history::{HistoryHead, MessageHash};
use crocodile_protocol::ids::{DeviceId, RoomId};
use crocodile_protocol::keys::Signature;
use crocodile_protocol::time::UnixSeconds;

/// Shape of the raw row returned from the history_heads query.
/// Tuple kept as a type alias to satisfy clippy's complex-type lint
/// without losing the no-FromRow-derive simplicity.
type HistoryHeadRow = (Vec<u8>, i64, i64, Vec<u8>, Vec<u8>);

/// Fetch the current head for a room, if any.
pub async fn get(pool: &PgPool, room_id: RoomId) -> Result<Option<HistoryHead>, sqlx::Error> {
    let row: Option<HistoryHeadRow> = sqlx::query_as(
        r#"SELECT head_hash, message_count, posted_at, posted_by_device, signature
           FROM history_heads
           WHERE room_id = $1"#,
    )
    .bind(room_id.as_bytes().as_slice())
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(hh, mc, pa, pbd, sig)| HistoryHead {
        room: room_id,
        head: MessageHash(hh.try_into().expect("head_hash column must be 32 bytes")),
        message_count: mc as u64,
        posted_at: UnixSeconds(pa),
        posted_by: DeviceId::from_bytes(
            pbd.try_into()
                .expect("posted_by_device column must be 32 bytes"),
        ),
        signature: Signature(sig.try_into().expect("signature column must be 64 bytes")),
    }))
}

/// Upsert the head for a room. Caller is responsible for the freshness
/// check; this is a raw write. Returns nothing.
pub async fn put(pool: &PgPool, head: &HistoryHead) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO history_heads
           (room_id, head_hash, message_count, posted_at, posted_by_device, signature)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (room_id) DO UPDATE SET
             head_hash = EXCLUDED.head_hash,
             message_count = EXCLUDED.message_count,
             posted_at = EXCLUDED.posted_at,
             posted_by_device = EXCLUDED.posted_by_device,
             signature = EXCLUDED.signature,
             received_at = now()"#,
    )
    .bind(head.room.as_bytes().as_slice())
    .bind(head.head.as_bytes().as_slice())
    .bind(head.message_count as i64)
    .bind(head.posted_at.get())
    .bind(head.posted_by.as_bytes().as_slice())
    .bind(head.signature.0.as_slice())
    .execute(pool)
    .await?;
    Ok(())
}
