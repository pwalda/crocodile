-- Rooms, membership, and history-head commitments.

-- A room. The id is a random 32-byte value, opaque outside the server.
CREATE TABLE rooms (
    id           BYTEA       PRIMARY KEY,
    name         TEXT        NOT NULL,
    description  TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A user's membership in a room. Owner is the creator and cannot be
-- removed by anyone else (changing ownership is out of scope for v1).
-- Admins can add and remove members.
CREATE TABLE room_members (
    room_id      BYTEA       NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    -- 'member', 'admin', 'owner'
    role         TEXT        NOT NULL CHECK (role IN ('member', 'admin', 'owner')),
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, account_id)
);

CREATE INDEX room_members_account_id_idx ON room_members(account_id);

-- The current history-head commitment per room. One row per room; on
-- a fresher submission we update in place (after freshness check).
-- Fork handling — keeping multiple competing heads — is deferred to
-- milestone 9.
CREATE TABLE history_heads (
    room_id           BYTEA       PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    head_hash         BYTEA       NOT NULL,
    message_count     BIGINT      NOT NULL,
    posted_at         BIGINT      NOT NULL,  -- unix seconds from the poster's clock
    posted_by_device  BYTEA       NOT NULL,
    signature         BYTEA       NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
