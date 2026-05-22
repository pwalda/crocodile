-- Initial schema for Crocodile coordination server.
--
-- Tables in this migration cover Milestone 2: accounts, sessions, devices.
-- Rooms / membership / history-head / federation state come in later
-- migrations as their milestones land.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A registered user. The username is the human handle. The
-- identity_public_key is the ed25519 key the client generated at signup
-- and is bound to this account for life — rotation is a separate flow
-- (out of scope for v1).
CREATE TABLE accounts (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username             TEXT        NOT NULL UNIQUE,
    -- Argon2id PHC-string-encoded hash. Bcrypt-style format includes
    -- algorithm + params + salt + tag.
    password_hash        TEXT        NOT NULL,
    -- 32 raw bytes of the user's identity ed25519 public key.
    identity_public_key  BYTEA       NOT NULL UNIQUE,
    -- BLAKE3(identity_public_key); kept as a column for indexed lookup
    -- without requiring callers to do the hash on every query.
    user_id              BYTEA       NOT NULL UNIQUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active sessions. We store SHA-256 of the issued token rather than the
-- token itself, so even a full DB read cannot reveal valid tokens to an
-- attacker. The presented token is hashed on every request and matched
-- against this column.
CREATE TABLE sessions (
    token_hash    BYTEA       PRIMARY KEY,
    account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_account_id_idx ON sessions(account_id);

-- A device key published by a user. Multiple devices per account are
-- supported. The identity_signature is the user's identity-key
-- signature over (user_id, device_public_key) and lets any verifier
-- confirm the binding without trusting the server.
CREATE TABLE devices (
    -- BLAKE3(device_public_key)
    device_id            BYTEA       PRIMARY KEY,
    account_id           UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    device_public_key    BYTEA       NOT NULL UNIQUE,
    -- ed25519 signature, 64 bytes
    identity_signature   BYTEA       NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX devices_account_id_idx ON devices(account_id);
