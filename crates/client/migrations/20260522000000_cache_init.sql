-- Client-side cache schema.
--
-- One table holds the postcard bytes of any SignedServerStatement<T>,
-- keyed by (kind, key). 'kind' is an opaque short string assigned by
-- the caller ("user_keys", "room_state"), and 'key' identifies the
-- subject within that kind (a UserId or RoomId, hex-encoded).
--
-- expires_at is denormalised from the inner statement so we can sweep
-- without decoding.

CREATE TABLE signed_statements (
    kind        TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    bytes       BLOB    NOT NULL,
    expires_at  INTEGER NOT NULL, -- unix seconds
    received_at INTEGER NOT NULL, -- unix seconds, server-issued
    PRIMARY KEY (kind, key)
);

CREATE INDEX signed_statements_expires_at_idx ON signed_statements(expires_at);
