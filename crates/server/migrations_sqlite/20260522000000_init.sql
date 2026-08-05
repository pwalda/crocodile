-- SQLite mirror of the initial schema.
--
-- Differences from the Postgres version (migrations/20260522000000_init.sql):
--   * UUID -> BLOB (uuid::Uuid round-trips as a 16-byte blob)
--   * BYTEA -> BLOB
--   * TIMESTAMPTZ DEFAULT now() -> INTEGER DEFAULT (strftime('%s','now'))
--   * account id is generated in Rust (no gen_random_uuid()), so no default
--   * no pgcrypto extension

CREATE TABLE accounts (
    id                   BLOB    PRIMARY KEY,
    username             TEXT    NOT NULL UNIQUE,
    password_hash        TEXT    NOT NULL,
    identity_public_key  BLOB    NOT NULL UNIQUE,
    user_id              BLOB    NOT NULL UNIQUE,
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE sessions (
    token_hash    BLOB    PRIMARY KEY,
    account_id    BLOB    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX sessions_account_id_idx ON sessions(account_id);

CREATE TABLE devices (
    device_id            BLOB    PRIMARY KEY,
    account_id           BLOB    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    device_public_key    BLOB    NOT NULL UNIQUE,
    identity_signature   BLOB    NOT NULL,
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX devices_account_id_idx ON devices(account_id);
