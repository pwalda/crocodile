//! Crocodile coordination server binary entrypoint.

use std::net::SocketAddr;

use anyhow::Context;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crocodile_server::storage::Db;
use crocodile_server::{build_router, build_state, config::Config};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();

    let config = Config::from_env().context("loading config from environment")?;
    tracing::info!(?config, "loaded config");

    let db = Db::open(&config.database_url, config.db_max_connections)
        .await
        .context("opening database")?;
    db.migrate().await.context("running migrations")?;

    let state = build_state(config.clone(), db).await?;
    tracing::info!(server_id = %state.identity.server_id(), "server identity loaded");

    let app = build_router(state);

    let addr: SocketAddr = config.bind_addr.parse().context("parsing bind address")?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding to {addr}"))?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app)
        .await
        .context("running axum server")?;

    Ok(())
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crocodile_server=debug,sqlx=warn"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_thread_ids(false))
        .init();
}
