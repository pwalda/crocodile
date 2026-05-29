//! Local text history: persistent SQLite-backed storage of decrypted
//! text messages plus operations for paginated read, chain head
//! lookup, and idempotent insert.
//!
//! Crocodile's privacy stance keeps message content out of the
//! coordination server entirely — every plaintext byte lives on a
//! member's device. This module is where they live on disk.

pub mod channel;
pub mod text;

pub use channel::{TextReceiver, TextSender};
pub use text::{StoredTextMessage, TextHistory};
