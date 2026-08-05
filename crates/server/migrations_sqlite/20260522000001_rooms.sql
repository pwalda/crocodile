-- SQLite mirror of the rooms schema.
-- See migrations/20260522000001_rooms.sql for the annotated Postgres version.

CREATE TABLE rooms (
    id           BLOB    PRIMARY KEY,
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE room_members (
    room_id      BLOB    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    account_id   BLOB    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role         TEXT    NOT NULL CHECK (role IN ('member', 'admin', 'owner')),
    joined_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (room_id, account_id)
);

CREATE INDEX room_members_account_id_idx ON room_members(account_id);

CREATE TABLE history_heads (
    room_id           BLOB    PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    head_hash         BLOB    NOT NULL,
    message_count     INTEGER NOT NULL,
    posted_at         INTEGER NOT NULL,
    posted_by_device  BLOB    NOT NULL,
    signature         BLOB    NOT NULL,
    received_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
