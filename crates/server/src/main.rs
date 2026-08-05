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

    // The most confusing setup failure is a loopback-only bind: the
    // server works from its own machine and is silently unreachable
    // from every other one. Say so loudly rather than let users
    // rediscover it via a client-side timeout.
    if addr.ip().is_loopback() {
        tracing::warn!(
            "bound to loopback ({addr}) — ONLY reachable from this machine. \
             Other devices cannot connect. Restart with BIND_ADDR=0.0.0.0:8080 \
             to accept connections from your network."
        );
    } else {
        // Print the concrete URL peers should enter, so nobody has to
        // hunt for the machine's LAN address.
        for ip in local_ipv4_addresses() {
            tracing::info!(
                "peers on your network should use: http://{ip}:{}",
                addr.port()
            );
        }
    }

    axum::serve(listener, app)
        .await
        .context("running axum server")?;

    Ok(())
}

/// Best-effort discovery of this machine's outbound IPv4 address, so
/// startup can print the exact URL peers should use.
///
/// Uses the standard route-probe trick: "connect" an unbound UDP socket
/// to an off-link address. No packets are sent — the kernel just picks
/// the source address it would route from, which is the LAN address we
/// want. Returns empty on failure; callers treat this as advisory only.
fn local_ipv4_addresses() -> Vec<std::net::Ipv4Addr> {
    let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") else {
        return Vec::new();
    };
    // 203.0.113.0/24 is TEST-NET-3 (RFC 5737) — guaranteed not to be a
    // real host, and never contacted since UDP connect sends nothing.
    if sock.connect("203.0.113.1:80").is_err() {
        return Vec::new();
    }
    match sock.local_addr() {
        Ok(SocketAddr::V4(v4)) if !v4.ip().is_loopback() => vec![*v4.ip()],
        _ => Vec::new(),
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crocodile_server=debug,sqlx=warn"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_thread_ids(false))
        .init();
}
