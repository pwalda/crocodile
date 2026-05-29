-- Local text history.
--
-- One row per stored text message. Keyed by (room_id, sender_device,
-- sender_seq) so a device can't accidentally overwrite an existing
-- entry while preserving idempotent re-store.
--
-- own_hash is denormalised from the wire envelope so we can index it
-- for chain lookups (find-previous, find-children) without a JOIN
-- against the body.

CREATE TABLE text_messages (
    room_id         BLOB    NOT NULL,
    sender_device   BLOB    NOT NULL,
    sender_seq      INTEGER NOT NULL,
    sent_at         INTEGER NOT NULL,         -- unix seconds, sender's clock
    received_at     INTEGER NOT NULL,         -- unix seconds, ours
    prev_hash       BLOB,                     -- NULL only for first-ever message
    own_hash        BLOB    NOT NULL UNIQUE,
    in_reply_to     BLOB,                     -- NULLABLE
    body            TEXT    NOT NULL,
    PRIMARY KEY (room_id, sender_device, sender_seq)
);

CREATE INDEX text_messages_room_received_idx
    ON text_messages(room_id, received_at);

CREATE INDEX text_messages_room_sent_idx
    ON text_messages(room_id, sent_at);

CREATE INDEX text_messages_prev_hash_idx
    ON text_messages(prev_hash);
