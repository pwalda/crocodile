//! Environment-driven configuration.
//!
//! Keeping this minimal: anything that isn't a runtime knob lives as a
//! constant. The few things that vary between dev / staging / prod live
//! here.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crocodile_protocol::time::DEFAULT_CACHE_TTL_SECS;

/// Loaded server configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Postgres connection URL, e.g. `postgres://user:pass@localhost:5432/db`.
    pub database_url: String,
    /// Maximum pool size.
    pub db_max_connections: u32,
    /// `host:port` to bind the HTTP server.
    pub bind_addr: String,
    /// Where to load / store the server identity keypair.
    pub server_identity_path: PathBuf,
    /// TTL (seconds) applied to all `SignedServerStatement`s issued by
    /// this server. Defaults to 48h per the architecture spec; tunable
    /// via env for tests that want short windows.
    pub statement_ttl_secs: i64,
}

impl Config {
    /// Load configuration from environment variables, with dev-friendly
    /// defaults for everything except the database URL (which is too
    /// environment-sensitive to default).
    pub fn from_env() -> Result<Self> {
        // Default to a local SQLite file so the server runs with zero
        // external dependencies. Point DATABASE_URL at a
        // `postgres://...` URL for the production backend.
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite://crocodile-server.sqlite".to_string());

        let db_max_connections = parse_env_or("DB_MAX_CONNECTIONS", 16u32)?;
        // Bind all interfaces by default. A coordination server exists to
        // be reached by peers on other machines; the previous
        // loopback-only default silently made the server unreachable from
        // anywhere but its own host, which is the single most confusing
        // failure mode in setup. Set BIND_ADDR=127.0.0.1:8080 explicitly
        // to restrict it back to this machine.
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let server_identity_path: PathBuf = std::env::var("SERVER_IDENTITY_PATH")
            .unwrap_or_else(|_| ".server_identity.key".to_string())
            .into();
        let statement_ttl_secs = parse_env_or("STATEMENT_TTL_SECS", DEFAULT_CACHE_TTL_SECS)?;

        Ok(Self {
            database_url,
            db_max_connections,
            bind_addr,
            server_identity_path,
            statement_ttl_secs,
        })
    }
}

fn parse_env_or<T>(key: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Err(_) => Ok(default),
        Ok(raw) => raw
            .parse::<T>()
            .map_err(|e| anyhow::anyhow!("invalid env var {key}: {e}"))
            .with_context(|| format!("parsing env var {key}")),
    }
}
