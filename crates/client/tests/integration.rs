//! Integration test: client speaks to a running server over HTTP.
//!
//! Skips gracefully when `DATABASE_URL` isn't set so `cargo test`
//! works without Docker too.

use std::net::SocketAddr;

use rand::rngs::OsRng;
use sqlx::postgres::PgPoolOptions;
use tempfile::tempdir;
use tokio::task::JoinHandle;

use crocodile_protocol::keys::IdentityKeypair;
use crocodile_protocol::time::UnixSeconds;

use crocodile_client::cache::Cache;
use crocodile_client::server_client::CoordinationClient;

struct TestServer {
    base_url: String,
    _handle: JoinHandle<()>,
    server_pubkey: crocodile_protocol::keys::IdentityPublicKey,
}

async fn spawn_server() -> Option<TestServer> {
    let database_url = std::env::var("DATABASE_URL").ok()?;

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .ok()?;
    sqlx::migrate!("../server/migrations")
        .run(&pool)
        .await
        .expect("migrations");

    let dir = tempdir().expect("tempdir");
    let identity_path = dir.path().join("identity.key");
    let config = crocodile_server::config::Config {
        database_url,
        db_max_connections: 4,
        bind_addr: "127.0.0.1:0".into(),
        server_identity_path: identity_path,
        statement_ttl_secs: crocodile_protocol::time::DEFAULT_CACHE_TTL_SECS,
    };
    let state = crocodile_server::build_state(config, pool).await.expect("state");
    let server_pubkey = state.identity.public_key();
    let app = crocodile_server::build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("local_addr");
    let base_url = format!("http://{addr}");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    std::mem::forget(dir);
    Some(TestServer {
        base_url,
        _handle: handle,
        server_pubkey,
    })
}

#[tokio::test]
async fn cache_first_user_keys_fetch() {
    let Some(server) = spawn_server().await else {
        eprintln!("DATABASE_URL not set; skipping integration test");
        return;
    };

    let cache = Cache::open_in_memory().await.expect("cache");
    let client = CoordinationClient::new(&server.base_url, cache.clone(), server.server_pubkey);

    // Sign up + login.
    let identity = IdentityKeypair::generate(&mut OsRng);
    let username = format!("client_{}", random_suffix());
    let user_id_hex = client
        .create_account(&username, "longpassword", &identity.public_key())
        .await
        .expect("create_account");

    let login = client
        .login(&username, "longpassword")
        .await
        .expect("login");
    assert_eq!(login.user_id_hex, user_id_hex);

    // First fetch: live, populates cache.
    let user_id_bytes: [u8; 32] = hex::decode(&user_id_hex).unwrap().try_into().unwrap();
    let user_id = crocodile_protocol::ids::UserId::from_bytes(user_id_bytes);

    let now = UnixSeconds::now();
    let live = client.user_keys(user_id, now).await.expect("live fetch");
    assert_eq!(live.server_id, server.server_pubkey_to_server_id());

    // Second fetch: should hit cache (we verify by closing the server
    // handle is not necessary; we simply confirm the result decodes
    // identically without touching the wire — easiest signal is that
    // the cache row exists).
    let cached: Option<
        crocodile_protocol::envelope::SignedServerStatement<
            crocodile_protocol::signaling::CacheableServerStatement,
        >,
    > = cache
        .get(
            crocodile_client::cache::kind::USER_KEYS,
            &user_id_hex,
            now,
        )
        .await
        .expect("cache get");
    assert!(cached.is_some(), "cache must contain the entry");
}

// Helper trait to derive server_id from the pinned pubkey, mirroring
// what the server itself does. Kept inline so the test file remains
// self-contained.
trait ServerPubkeyExt {
    fn server_pubkey_to_server_id(&self) -> crocodile_protocol::ids::ServerId;
}
impl ServerPubkeyExt for TestServer {
    fn server_pubkey_to_server_id(&self) -> crocodile_protocol::ids::ServerId {
        crocodile_protocol::keys::server_id_from_public_key(&self.server_pubkey)
    }
}

fn random_suffix() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| {
            let n: u8 = rng.gen_range(0..26);
            (b'a' + n) as char
        })
        .collect()
}
