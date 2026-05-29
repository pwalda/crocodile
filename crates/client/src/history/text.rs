//! SQLite-backed text-message history.

use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

use crocodile_protocol::history::MessageHash;
use crocodile_protocol::ids::{DeviceId, RoomId};
use crocodile_protocol::time::UnixSeconds;

use crate::error::CacheError;

/// One decrypted message stored locally. Mirrors the wire shape with
/// our own observation timestamp added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredTextMessage {
    /// The room this message belongs to.
    pub room: RoomId,
    /// Device that sent the message.
    pub sender_device: DeviceId,
    /// Per-(room, sender_device) monotonic sequence number.
    pub sender_seq: u64,
    /// Sender's wall-clock at send time.
    pub sent_at: UnixSeconds,
    /// Our wall-clock when we accepted the message.
    pub received_at: UnixSeconds,
    /// Hash of the message this one chains from (`None` only for the
    /// very first message in the room from this sender).
    pub prev_hash: Option<MessageHash>,
    /// Own hash, computed by the caller from the wire envelope.
    pub own_hash: MessageHash,
    /// Optional in-reply-to reference.
    pub in_reply_to: Option<MessageHash>,
    /// UTF-8 message body.
    pub body: String,
}

/// Handle for the local text history. Cheap to clone (wraps a SQLite
/// pool).
#[derive(Debug, Clone)]
pub struct TextHistory {
    pool: SqlitePool,
}

impl TextHistory {
    /// Open (and migrate) a history database at the given path.
    pub async fn open(path: &Path) -> Result<Self, CacheError> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        Self::open_with_options(options).await
    }

    /// Open an in-memory store for tests.
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

    /// Insert a message. Idempotent on the primary key
    /// (room, sender_device, sender_seq): a re-insert of the same
    /// row is a no-op, while a re-insert with the same key but
    /// different `own_hash` returns a uniqueness violation
    /// (the caller may want to surface that as a fork).
    ///
    /// Returns `Ok(true)` if a new row was inserted, `Ok(false)` if
    /// an identical row already existed.
    pub async fn store(&self, msg: &StoredTextMessage) -> Result<bool, CacheError> {
        let result = sqlx::query(
            r#"INSERT INTO text_messages
               (room_id, sender_device, sender_seq, sent_at, received_at,
                prev_hash, own_hash, in_reply_to, body)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT (room_id, sender_device, sender_seq) DO NOTHING"#,
        )
        .bind(msg.room.as_bytes().as_slice())
        .bind(msg.sender_device.as_bytes().as_slice())
        .bind(msg.sender_seq as i64)
        .bind(msg.sent_at.get())
        .bind(msg.received_at.get())
        .bind(msg.prev_hash.as_ref().map(|h| h.as_bytes().as_slice()))
        .bind(msg.own_hash.as_bytes().as_slice())
        .bind(msg.in_reply_to.as_ref().map(|h| h.as_bytes().as_slice()))
        .bind(&msg.body)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Number of stored messages in a room.
    pub async fn count_for_room(&self, room: RoomId) -> Result<u64, CacheError> {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM text_messages WHERE room_id = ?1")
            .bind(room.as_bytes().as_slice())
            .fetch_one(&self.pool)
            .await?;
        Ok(n as u64)
    }

    /// Paginated read of the most recent `limit` messages for a room,
    /// optionally returning only those with `sent_at < before`.
    /// Output is sender-clock ordered, newest first.
    pub async fn list_recent(
        &self,
        room: RoomId,
        limit: u32,
        before: Option<UnixSeconds>,
    ) -> Result<Vec<StoredTextMessage>, CacheError> {
        let rows: Vec<HistoryRow> = match before {
            None => sqlx::query_as::<_, HistoryRow>(
                r#"SELECT room_id, sender_device, sender_seq, sent_at, received_at,
                          prev_hash, own_hash, in_reply_to, body
                   FROM text_messages
                   WHERE room_id = ?1
                   ORDER BY sent_at DESC, sender_device, sender_seq DESC
                   LIMIT ?2"#,
            )
            .bind(room.as_bytes().as_slice())
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await?,
            Some(before) => sqlx::query_as::<_, HistoryRow>(
                r#"SELECT room_id, sender_device, sender_seq, sent_at, received_at,
                          prev_hash, own_hash, in_reply_to, body
                   FROM text_messages
                   WHERE room_id = ?1 AND sent_at < ?2
                   ORDER BY sent_at DESC, sender_device, sender_seq DESC
                   LIMIT ?3"#,
            )
            .bind(room.as_bytes().as_slice())
            .bind(before.get())
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await?,
        };
        Ok(rows.into_iter().map(StoredTextMessage::from).collect())
    }

    /// Look up a message by its own hash.
    pub async fn get_by_hash(
        &self,
        hash: MessageHash,
    ) -> Result<Option<StoredTextMessage>, CacheError> {
        let row: Option<HistoryRow> = sqlx::query_as(
            r#"SELECT room_id, sender_device, sender_seq, sent_at, received_at,
                      prev_hash, own_hash, in_reply_to, body
               FROM text_messages
               WHERE own_hash = ?1"#,
        )
        .bind(hash.as_bytes().as_slice())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(StoredTextMessage::from))
    }

    /// Return the most-recently-received message in a room, if any —
    /// useful as a sync waypoint when reconnecting.
    pub async fn most_recent(
        &self,
        room: RoomId,
    ) -> Result<Option<StoredTextMessage>, CacheError> {
        let row: Option<HistoryRow> = sqlx::query_as(
            r#"SELECT room_id, sender_device, sender_seq, sent_at, received_at,
                      prev_hash, own_hash, in_reply_to, body
               FROM text_messages
               WHERE room_id = ?1
               ORDER BY received_at DESC
               LIMIT 1"#,
        )
        .bind(room.as_bytes().as_slice())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(StoredTextMessage::from))
    }
}

// --- Row materialisation ---

#[derive(sqlx::FromRow)]
struct HistoryRow {
    room_id: Vec<u8>,
    sender_device: Vec<u8>,
    sender_seq: i64,
    sent_at: i64,
    received_at: i64,
    prev_hash: Option<Vec<u8>>,
    own_hash: Vec<u8>,
    in_reply_to: Option<Vec<u8>>,
    body: String,
}

impl From<HistoryRow> for StoredTextMessage {
    fn from(r: HistoryRow) -> Self {
        StoredTextMessage {
            room: RoomId::from_bytes(r.room_id.try_into().expect("room_id 32 bytes")),
            sender_device: DeviceId::from_bytes(
                r.sender_device.try_into().expect("sender_device 32 bytes"),
            ),
            sender_seq: r.sender_seq as u64,
            sent_at: UnixSeconds(r.sent_at),
            received_at: UnixSeconds(r.received_at),
            prev_hash: r
                .prev_hash
                .map(|b| MessageHash(b.try_into().expect("prev_hash 32 bytes"))),
            own_hash: MessageHash(r.own_hash.try_into().expect("own_hash 32 bytes")),
            in_reply_to: r
                .in_reply_to
                .map(|b| MessageHash(b.try_into().expect("in_reply_to 32 bytes"))),
            body: r.body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(
        room_byte: u8,
        sender_byte: u8,
        seq: u64,
        sent_at: i64,
        body: &str,
    ) -> StoredTextMessage {
        // Hash distinguishes by (room, sender, seq) so each test
        // message has a globally unique own_hash (UNIQUE constraint).
        let mut hash_seed = [0u8; 32];
        hash_seed[0] = room_byte;
        hash_seed[1] = sender_byte;
        hash_seed[2..10].copy_from_slice(&seq.to_le_bytes());
        StoredTextMessage {
            room: RoomId::from_bytes([room_byte; 32]),
            sender_device: DeviceId::from_bytes([sender_byte; 32]),
            sender_seq: seq,
            sent_at: UnixSeconds(sent_at),
            received_at: UnixSeconds(sent_at + 1),
            prev_hash: None,
            own_hash: MessageHash(hash_seed),
            in_reply_to: None,
            body: body.to_string(),
        }
    }

    #[tokio::test]
    async fn store_and_count() {
        let h = TextHistory::open_in_memory().await.unwrap();
        assert!(h.store(&msg(1, 9, 0, 100, "hi")).await.unwrap());
        assert!(h.store(&msg(1, 9, 1, 110, "there")).await.unwrap());
        assert_eq!(h.count_for_room(RoomId::from_bytes([1; 32])).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn store_is_idempotent_on_primary_key() {
        let h = TextHistory::open_in_memory().await.unwrap();
        let m = msg(1, 9, 0, 100, "hi");
        assert!(h.store(&m).await.unwrap()); // first insert
        assert!(!h.store(&m).await.unwrap()); // duplicate → false
        assert_eq!(h.count_for_room(m.room).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn list_recent_orders_newest_first() {
        let h = TextHistory::open_in_memory().await.unwrap();
        h.store(&msg(1, 9, 0, 100, "first")).await.unwrap();
        h.store(&msg(1, 9, 1, 200, "second")).await.unwrap();
        h.store(&msg(1, 9, 2, 300, "third")).await.unwrap();

        let recent = h.list_recent(RoomId::from_bytes([1; 32]), 10, None).await.unwrap();
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].body, "third");
        assert_eq!(recent[2].body, "first");
    }

    #[tokio::test]
    async fn list_recent_paginates_with_before() {
        let h = TextHistory::open_in_memory().await.unwrap();
        for (seq, t) in (0..5u64).zip([100, 200, 300, 400, 500]) {
            h.store(&msg(1, 9, seq, t, &format!("m{seq}"))).await.unwrap();
        }
        let page = h
            .list_recent(RoomId::from_bytes([1; 32]), 2, Some(UnixSeconds(400)))
            .await
            .unwrap();
        // sent_at < 400 → {100,200,300}, newest-first, limit 2 → {300, 200}
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].body, "m2");
        assert_eq!(page[1].body, "m1");
    }

    #[tokio::test]
    async fn most_recent_returns_latest_received() {
        let h = TextHistory::open_in_memory().await.unwrap();
        let mut older = msg(1, 9, 0, 100, "old");
        older.received_at = UnixSeconds(1);
        let mut newer = msg(1, 9, 1, 110, "new");
        newer.received_at = UnixSeconds(999);
        h.store(&older).await.unwrap();
        h.store(&newer).await.unwrap();

        let mr = h.most_recent(RoomId::from_bytes([1; 32])).await.unwrap().unwrap();
        assert_eq!(mr.body, "new");
    }

    #[tokio::test]
    async fn rooms_isolated() {
        let h = TextHistory::open_in_memory().await.unwrap();
        h.store(&msg(1, 9, 0, 100, "in-room-1")).await.unwrap();
        h.store(&msg(2, 9, 0, 100, "in-room-2")).await.unwrap();

        let r1 = h.list_recent(RoomId::from_bytes([1; 32]), 10, None).await.unwrap();
        let r2 = h.list_recent(RoomId::from_bytes([2; 32]), 10, None).await.unwrap();
        assert_eq!(r1.len(), 1);
        assert_eq!(r2.len(), 1);
        assert_eq!(r1[0].body, "in-room-1");
        assert_eq!(r2[0].body, "in-room-2");
    }

    #[tokio::test]
    async fn get_by_hash_finds_the_message() {
        let h = TextHistory::open_in_memory().await.unwrap();
        let m = msg(1, 9, 0, 100, "lookup-me");
        h.store(&m).await.unwrap();
        let got = h.get_by_hash(m.own_hash).await.unwrap().unwrap();
        assert_eq!(got, m);
    }
}
