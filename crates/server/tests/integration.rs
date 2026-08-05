//! End-to-end integration tests against a real Postgres.
//!
//! Skips when `DATABASE_URL` is not set, so `cargo test` works in
//! environments without Docker too. To run locally:
//!
//! ```bash
//! docker compose up -d   # in repo root
//! DATABASE_URL=postgres://crocodile:crocodile_dev@localhost:5432/crocodile \
//!     cargo test --test integration
//! ```

use std::net::SocketAddr;

use rand::rngs::OsRng;
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use tempfile::tempdir;
use tokio::task::JoinHandle;

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::ids::UserId;
use crocodile_protocol::keys::{
    user_id_from_public_key, DeviceKeypair, IdentityKeypair, IdentityPublicKey,
};
use crocodile_protocol::signaling::CacheableServerStatement;
use crocodile_protocol::time::UnixSeconds;

use crocodile_server::{build_router, build_state, config::Config};

/// Holds a running server so the test can drop it cleanly.
struct TestServer {
    base_url: String,
    _handle: JoinHandle<()>,
    server_pubkey: IdentityPublicKey,
}

async fn spawn_server() -> Option<TestServer> {
    let database_url = std::env::var("DATABASE_URL").ok()?;

    let pool = match PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!("integration test skipped: cannot connect to {database_url}: {e}");
            return None;
        }
    };

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");

    // Generate a fresh identity per server spawn so tests don't share
    // a key file with anyone else.
    let dir = tempdir().expect("tempdir");
    let identity_path = dir.path().join("identity.key");

    let config = Config {
        database_url,
        db_max_connections: 4,
        bind_addr: "127.0.0.1:0".into(),
        server_identity_path: identity_path,
        statement_ttl_secs: crocodile_protocol::time::DEFAULT_CACHE_TTL_SECS,
    };

    let state = build_state(config, pool).await.expect("state");
    let server_pubkey = state.identity.public_key();
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr: SocketAddr = listener.local_addr().expect("local_addr");
    let base_url = format!("http://{addr}");

    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // Make tempdir live as long as the test by leaking it; the OS will
    // reap on process exit.
    std::mem::forget(dir);

    Some(TestServer {
        base_url,
        _handle: handle,
        server_pubkey,
    })
}

#[tokio::test]
async fn full_flow_signup_login_keystore_room_history() {
    let Some(server) = spawn_server().await else {
        eprintln!("DATABASE_URL not set; skipping integration test");
        return;
    };

    let client = reqwest::Client::new();

    // ---- Create two accounts and login ----
    let alice_identity = IdentityKeypair::generate(&mut OsRng);
    let alice_pk = alice_identity.public_key();
    let alice_user_id = user_id_from_public_key(&alice_pk);
    let alice_username = format!("alice_{}", random_suffix());

    let resp = client
        .post(format!("{}/v1/accounts", server.base_url))
        .json(&json!({
            "username": alice_username,
            "password": "hunter2hunter2",
            "identity_public_key_hex": hex::encode(alice_pk.0),
        }))
        .send()
        .await
        .expect("signup");
    assert_eq!(resp.status(), 201, "signup body: {:?}", resp.text().await);

    let bob_identity = IdentityKeypair::generate(&mut OsRng);
    let bob_pk = bob_identity.public_key();
    let bob_user_id = user_id_from_public_key(&bob_pk);
    let bob_username = format!("bob_{}", random_suffix());

    let resp = client
        .post(format!("{}/v1/accounts", server.base_url))
        .json(&json!({
            "username": bob_username,
            "password": "hunter2hunter2",
            "identity_public_key_hex": hex::encode(bob_pk.0),
        }))
        .send()
        .await
        .expect("signup bob");
    assert_eq!(resp.status(), 201);

    let alice_token = login(&client, &server.base_url, &alice_username, "hunter2hunter2").await;

    // ---- Publish Alice's device key ----
    let alice_device = DeviceKeypair::generate(&mut OsRng);
    let device_pk = alice_device.public_key();
    let device_id = crocodile_protocol::keys::device_id_from_public_key(&device_pk);

    let binding_input = {
        let mut v = Vec::with_capacity(64);
        v.extend_from_slice(alice_user_id.as_bytes());
        v.extend_from_slice(&device_pk.0);
        v
    };
    let binding_sig = alice_identity.sign(&binding_input);

    let resp = client
        .post(format!("{}/v1/devices", server.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({
            "device_public_key_hex": hex::encode(device_pk.0),
            "identity_signature_hex": hex::encode(binding_sig.0),
        }))
        .send()
        .await
        .expect("publish device key");
    assert_eq!(
        resp.status(),
        201,
        "device pub body: {:?}",
        resp.text().await
    );

    // ---- Fetch Alice's keystore as a SignedServerStatement and verify ----
    let resp = client
        .get(format!(
            "{}/v1/users/{}/keys",
            server.base_url,
            hex::encode(alice_user_id.as_bytes())
        ))
        .send()
        .await
        .expect("get user keys");
    assert_eq!(resp.status(), 200);
    let bytes = resp.bytes().await.expect("bytes").to_vec();

    let signed: SignedServerStatement<CacheableServerStatement> =
        postcard::from_bytes(&bytes).expect("decode signed statement");
    signed
        .verify(&server.server_pubkey, UnixSeconds::now())
        .expect("server signature must verify");
    match &signed.payload {
        CacheableServerStatement::UserKeys { user, devices } => {
            assert_eq!(*user, alice_user_id);
            assert_eq!(devices.len(), 1);
            assert_eq!(devices[0].device_public_key.0, device_pk.0);
            // Cross-check the binding signature is the one we sent.
            assert_eq!(devices[0].identity_signature.0, binding_sig.0);
        }
        other => panic!("unexpected payload kind: {other:?}"),
    }

    // ---- Create a room and add Bob ----
    let resp = client
        .post(format!("{}/v1/rooms", server.base_url))
        .bearer_auth(&alice_token)
        .json(&json!({
            "name": format!("room_{}", random_suffix()),
            "description": "integration",
        }))
        .send()
        .await
        .expect("create room");
    assert_eq!(resp.status(), 201);
    let room_id_hex = resp.json::<serde_json::Value>().await.expect("json")["room_id_hex"]
        .as_str()
        .expect("room_id_hex string")
        .to_string();

    let resp = client
        .post(format!(
            "{}/v1/rooms/{}/members",
            server.base_url, room_id_hex
        ))
        .bearer_auth(&alice_token)
        .json(&json!({ "user_id_hex": hex::encode(bob_user_id.as_bytes()) }))
        .send()
        .await
        .expect("add member");
    assert_eq!(resp.status(), 201);

    // ---- Fetch room state and verify the signed statement ----
    let resp = client
        .get(format!("{}/v1/rooms/{}", server.base_url, room_id_hex))
        .bearer_auth(&alice_token)
        .send()
        .await
        .expect("get room state");
    assert_eq!(resp.status(), 200);
    let bytes = resp.bytes().await.expect("bytes").to_vec();
    let signed: SignedServerStatement<CacheableServerStatement> =
        postcard::from_bytes(&bytes).expect("decode room state");
    signed
        .verify(&server.server_pubkey, UnixSeconds::now())
        .expect("room state signature must verify");

    match signed.payload {
        CacheableServerStatement::RoomState { members, head, .. } => {
            assert_eq!(members.len(), 2);
            let users: Vec<UserId> = members.iter().map(|m| m.user).collect();
            assert!(users.contains(&alice_user_id));
            assert!(users.contains(&bob_user_id));
            assert!(head.is_none(), "no head posted yet");
        }
        other => panic!("unexpected payload kind: {other:?}"),
    }

    // ---- Post a history head signed by Alice's device, verify acceptance ----
    let head_hash = *crocodile_protocol::history::MessageHash::of(b"first message").as_bytes();
    let posted_at = UnixSeconds::now();
    let signing_input = postcard::to_stdvec(&(
        &crocodile_protocol::ids::RoomId::from_bytes(
            hex::decode(&room_id_hex).unwrap().try_into().unwrap(),
        ),
        &crocodile_protocol::history::MessageHash(head_hash),
        1u64,
        posted_at,
        &device_id,
    ))
    .unwrap();
    let head_sig = alice_device.sign(&signing_input);

    let resp = client
        .post(format!(
            "{}/v1/rooms/{}/history-head",
            server.base_url, room_id_hex
        ))
        .bearer_auth(&alice_token)
        .json(&json!({
            "head_hex": hex::encode(head_hash),
            "message_count": 1u64,
            "posted_at_unix_secs": posted_at.get(),
            "posted_by_device_hex": hex::encode(device_id.as_bytes()),
            "signature_hex": hex::encode(head_sig.0),
        }))
        .send()
        .await
        .expect("post head");
    assert_eq!(
        resp.status(),
        201,
        "head post body: {:?}",
        resp.text().await
    );

    // ---- Re-posting an older head must be rejected ----
    let resp = client
        .post(format!(
            "{}/v1/rooms/{}/history-head",
            server.base_url, room_id_hex
        ))
        .bearer_auth(&alice_token)
        .json(&json!({
            "head_hex": hex::encode(head_hash),
            "message_count": 0u64,
            "posted_at_unix_secs": posted_at.get(),
            "posted_by_device_hex": hex::encode(device_id.as_bytes()),
            "signature_hex": hex::encode(head_sig.0),
        }))
        .send()
        .await
        .expect("post stale head");
    assert_eq!(resp.status(), 409, "stale head should be rejected");
}

async fn login(client: &reqwest::Client, base: &str, username: &str, password: &str) -> String {
    let resp = client
        .post(format!("{base}/v1/sessions"))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status(), 201, "login body: {:?}", resp.text().await);
    let body: serde_json::Value = resp.json().await.expect("login json");
    body["session_token"]
        .as_str()
        .expect("session_token string")
        .to_string()
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
