//! Domain layer: pure logic that the API and storage layers compose
//! around. Lives here so it stays unit-testable without touching HTTP
//! or the database.

pub mod statement;
