//! Background session task driving the actual call.
//!
//! Wraps the same flow as the CLI `two_peer_call` binary but exposes
//! a channel-based interface so the egui thread can drive it.

use std::net::{SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use openmls_rust_crypto::OpenMlsRustCrypto;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, Mutex};

use crocodile_protocol::ids::{DeviceId, RoomId, UserId};
use crocodile_protocol::keys::{
    device_id_from_public_key, user_id_from_public_key, DeviceKeypair, DevicePublicKey,
    IdentityKeypair, IdentityPublicKey, Signature,
};
use crocodile_protocol::mls::MlsWelcome;
use crocodile_protocol::signaling::{
    CacheableServerStatement, SignalingClientFrame, SignalingServerFrame,
};
use crocodile_protocol::text::TextMessage;
use crocodile_protocol::time::UnixSeconds;
use crocodile_protocol::voice::VoiceFrame;

use crocodile_client::audio::opus::{f32_to_i16, i16_to_f32, OpusDecoder, OpusEncoder};
use crocodile_client::audio::playback::{self, PlaybackQueue};
use crocodile_client::audio::{capture, jitter::JitterBuffer, SAMPLES_PER_FRAME};
use crocodile_client::cache::Cache;
use crocodile_client::history::{TextHistory, TextReceiver, TextSender};
use crocodile_client::server_client::{CoordinationClient, ServerInfo};
use crocodile_client::signaling_client::SignalingChannel;
use crocodile_client::transport::quic::PeerEndpoint;

use crocodile_mls::{Group, Identity, KeyPackage};

use crate::app::Settings;

/// Events emitted from the background session to the UI.
pub enum SessionEvent {
    /// Free-form status string ("connecting", "added member", "QUIC up", …).
    Status(String),
    /// One received chat line.
    Text { from: String, body: String },
    /// Fatal session error.
    Failed(String),
    /// Session terminated normally.
    Ended,
}

/// Actions the UI sends down to the session.
pub enum SessionAction {
    SendText(String),
    Hangup,
}

/// One room the user belongs to, for the Join pick-list.
#[derive(Debug, Clone)]
pub struct RoomInfo {
    pub room_id_hex: String,
    pub name: String,
    pub role: String,
}

/// Result of a "Connect / Refresh" probe: verifies the server is
/// reachable, the account exists (creating it if needed), the device
/// key is published, and returns the rooms the user belongs to.
pub enum ProbeEvent {
    Ok {
        username: String,
        server_id_hex: String,
        rooms: Vec<RoomInfo>,
    },
    Err(String),
}

/// Spawn a one-shot connectivity probe. Sends exactly one
/// [`ProbeEvent`] on the returned receiver, then finishes.
pub fn spawn_probe(runtime: &Runtime, settings: Settings) -> mpsc::UnboundedReceiver<ProbeEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    runtime.spawn(async move {
        let ev = match probe(&settings).await {
            Ok(ev) => ev,
            Err(e) => ProbeEvent::Err(e.to_string()),
        };
        let _ = tx.send(ev);
    });
    rx
}

async fn probe(settings: &Settings) -> Result<ProbeEvent> {
    // connect() does the full handshake: server_info + signup-or-login
    // + publish device key + open signaling. A successful return means
    // this device can reach the coordination server and is registered.
    let (throwaway, _rx) = mpsc::unbounded_channel();
    let conn = connect(settings, &throwaway).await?;
    let server_id = crocodile_protocol::keys::server_id_from_public_key(&conn.server_pubkey);
    let rooms = conn
        .client
        .list_my_rooms(&conn.token)
        .await
        .context("listing your rooms")?;
    Ok(ProbeEvent::Ok {
        username: settings.username.clone(),
        server_id_hex: hex::encode(server_id.as_bytes()),
        rooms: rooms
            .into_iter()
            .map(|r| RoomInfo {
                room_id_hex: r.room_id_hex,
                name: r.name,
                role: r.role,
            })
            .collect(),
    })
    // conn drops here, closing the probe's signaling WS — presence is
    // only needed during an actual call.
}

/// Handle to a running session.
pub struct SessionHandle {
    pub events: mpsc::UnboundedReceiver<SessionEvent>,
    pub actions: mpsc::UnboundedSender<SessionAction>,
    /// Set by the host's session as soon as it has created the room.
    /// The UI polls this so the user can copy the ROOM_ID without
    /// scrolling the log.
    pub room_id: Arc<std::sync::Mutex<Option<String>>>,
}

/// Spawn a host session. Background task creates a room, adds the
/// invitee, and waits for them to join.
pub fn spawn_host(runtime: &Runtime, settings: Settings, invite_username: String) -> SessionHandle {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (actions_tx, actions_rx) = mpsc::unbounded_channel();
    let room_id_slot = Arc::new(std::sync::Mutex::new(None));
    let room_id_for_task = room_id_slot.clone();

    runtime.spawn(async move {
        let result = run_host(
            settings,
            invite_username,
            events_tx.clone(),
            actions_rx,
            room_id_for_task,
        )
        .await;
        match result {
            Ok(()) => {
                let _ = events_tx.send(SessionEvent::Ended);
            }
            Err(e) => {
                let _ = events_tx.send(SessionEvent::Failed(e.to_string()));
            }
        }
    });

    SessionHandle {
        events: events_rx,
        actions: actions_tx,
        room_id: room_id_slot,
    }
}

/// Spawn a joiner session. The room must already exist and you must
/// already be added to it (host's responsibility).
pub fn spawn_join(runtime: &Runtime, settings: Settings, room_id_hex: String) -> SessionHandle {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (actions_tx, actions_rx) = mpsc::unbounded_channel();
    let room_id_slot = Arc::new(std::sync::Mutex::new(None));

    runtime.spawn(async move {
        let result = run_join(settings, room_id_hex, events_tx.clone(), actions_rx).await;
        match result {
            Ok(()) => {
                let _ = events_tx.send(SessionEvent::Ended);
            }
            Err(e) => {
                let _ = events_tx.send(SessionEvent::Failed(e.to_string()));
            }
        }
    });

    SessionHandle {
        events: events_rx,
        actions: actions_tx,
        room_id: room_id_slot,
    }
}

/// Compute / load identity keys for the configured state directory
/// and return (user_id_hex, device_id_hex) without touching the
/// network. Used by the Settings "Show my user_id" button.
pub fn derive_my_ids(state_dir: &Path) -> Result<(String, String)> {
    let (identity_kp, device_kp) = load_or_create_keys(state_dir)?;
    let user_id = user_id_from_public_key(&identity_kp.public_key());
    let device_id = device_id_from_public_key(&device_kp.public_key());
    Ok((
        hex::encode(user_id.as_bytes()),
        hex::encode(device_id.as_bytes()),
    ))
}

// ----- core flow shared by both modes -----

fn load_or_create_keys(state_dir: &Path) -> Result<(IdentityKeypair, DeviceKeypair)> {
    std::fs::create_dir_all(state_dir)?;
    let path = state_dir.join("keys.json");
    #[derive(Serialize, Deserialize)]
    struct Persisted {
        identity_seed_hex: String,
        device_seed_hex: String,
    }
    if let Ok(bytes) = std::fs::read(&path) {
        let p: Persisted = serde_json::from_slice(&bytes)?;
        let identity_seed: [u8; 32] = hex::decode(&p.identity_seed_hex)?
            .try_into()
            .map_err(|_| anyhow!("identity seed must be 32 bytes"))?;
        let device_seed: [u8; 32] = hex::decode(&p.device_seed_hex)?
            .try_into()
            .map_err(|_| anyhow!("device seed must be 32 bytes"))?;
        Ok((
            IdentityKeypair::from_seed(identity_seed),
            DeviceKeypair::from_seed(device_seed),
        ))
    } else {
        let mut identity_seed = [0u8; 32];
        let mut device_seed = [0u8; 32];
        OsRng.fill_bytes(&mut identity_seed);
        OsRng.fill_bytes(&mut device_seed);
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&Persisted {
                identity_seed_hex: hex::encode(identity_seed),
                device_seed_hex: hex::encode(device_seed),
            })?,
        )?;
        Ok((
            IdentityKeypair::from_seed(identity_seed),
            DeviceKeypair::from_seed(device_seed),
        ))
    }
}

/// Standard server connect: server-info TOFU + signup/login + publish
/// device key + open signaling. Returns the bits both flows need.
struct ConnectedClient {
    client: CoordinationClient,
    token: String,
    signaling: SignalingChannel,
    server_pubkey: IdentityPublicKey,
    my_user_id: UserId,
    my_device_id: DeviceId,
    device_pk: DevicePublicKey,
    state_dir: PathBuf,
}

async fn connect(
    settings: &Settings,
    events: &mpsc::UnboundedSender<SessionEvent>,
) -> Result<ConnectedClient> {
    let state_dir = PathBuf::from(&settings.state_dir);
    let (identity_kp, device_kp) = load_or_create_keys(&state_dir)?;
    let device_pk = device_kp.public_key();
    let my_user_id = user_id_from_public_key(&identity_kp.public_key());
    let my_device_id = device_id_from_public_key(&device_pk);

    let info: ServerInfo = CoordinationClient::server_info(&settings.server)
        .await
        .context("fetching /v1/server/info")?;
    let server_ipk_bytes: [u8; 32] = hex::decode(&info.identity_public_key_hex)?
        .try_into()
        .map_err(|_| anyhow!("server identity_public_key must be 32 bytes"))?;
    let server_pubkey = IdentityPublicKey(server_ipk_bytes);

    let cache = Cache::open(&state_dir.join("cache.sqlite")).await?;
    let client = CoordinationClient::new(settings.server.clone(), cache, server_pubkey);

    let _ = events.send(SessionEvent::Status("signing in...".into()));
    match client
        .create_account(
            &settings.username,
            &settings.password,
            &identity_kp.public_key(),
        )
        .await
    {
        Ok(_) => {}
        Err(crocodile_client::ClientError::ServerStatus { status: 409, .. }) => {}
        Err(e) => return Err(anyhow!("signup/login: {e}")),
    }
    let login = client.login(&settings.username, &settings.password).await?;

    // Publish device key.
    let mut binding_input = Vec::with_capacity(64);
    binding_input.extend_from_slice(my_user_id.as_bytes());
    binding_input.extend_from_slice(&device_pk.0);
    let binding_sig = identity_kp.sign(&binding_input);
    publish_device_key(
        &settings.server,
        &login.session_token,
        &device_pk,
        &binding_sig,
    )
    .await?;

    let _ = events.send(SessionEvent::Status("connecting signaling...".into()));
    let signaling =
        SignalingChannel::connect(&settings.server, &login.session_token, my_device_id).await?;

    Ok(ConnectedClient {
        client,
        token: login.session_token,
        signaling,
        server_pubkey,
        my_user_id,
        my_device_id,
        device_pk,
        state_dir,
    })
}

// ----- Host flow -----

async fn run_host(
    settings: Settings,
    invite_username: String,
    events: mpsc::UnboundedSender<SessionEvent>,
    actions: mpsc::UnboundedReceiver<SessionAction>,
    room_id_slot: Arc<std::sync::Mutex<Option<String>>>,
) -> Result<()> {
    let _ = &actions; // forwarded to run_call below
    let mut conn = connect(&settings, &events).await?;

    // Resolve invitee. A 404 here means the invitee has never signed
    // in, so the server has no account for them yet — surface that
    // clearly rather than as a bare lookup error.
    let invitee_hex = match conn.client.lookup_username(&invite_username).await {
        Ok(hex) => hex,
        Err(crocodile_client::ClientError::ServerStatus { status: 404, .. }) => {
            bail!(
                "no user named '{invite_username}' — they must open Crocodile and \
                 connect once (any Host/Join attempt) so their account exists, then retry"
            );
        }
        Err(e) => return Err(anyhow!("looking up '{invite_username}': {e}")),
    };
    let invitee_bytes: [u8; 32] = hex::decode(&invitee_hex)?
        .try_into()
        .map_err(|_| anyhow!("user_id must be 32 bytes"))?;
    let invitee = UserId::from_bytes(invitee_bytes);

    // Create room + add invitee.
    let room_id = create_room(&settings.server, &conn.token, &settings.username).await?;
    add_member_api(&settings.server, &conn.token, room_id, invitee).await?;
    let room_hex = hex::encode(room_id.as_bytes());
    *room_id_slot.lock().unwrap() = Some(room_hex.clone());
    let _ = events.send(SessionEvent::Status(format!("room created: {room_hex}")));

    let endpoint = PeerEndpoint::bind(parse_addr(&settings.bind_addr)?, &conn.device_pk)?;
    let local_addr = endpoint.local_addr();
    let advertise = pick_advertise(&settings, local_addr);
    let _ = events.send(SessionEvent::Status(format!("QUIC on {advertise}")));

    let history = TextHistory::open(&conn.state_dir.join("history.sqlite")).await?;

    let provider = Arc::new(OpenMlsRustCrypto::default());
    let mls_identity = Arc::new(
        Identity::generate(conn.my_device_id, &provider).map_err(|e| anyhow!("mls: {e}"))?,
    );
    let mut group = Group::create(&provider, &mls_identity, room_id.as_bytes())
        .map_err(|e| anyhow!("mls: {e}"))?;

    // Wait for joiner's KP.
    let _ = events.send(SessionEvent::Status("waiting for peer...".into()));
    let invitee_devices = peer_user_devices(&conn.client, invitee).await?;
    let invitee_set: std::collections::HashSet<DeviceId> =
        invitee_devices.iter().copied().collect();
    let peer_device = loop {
        let frame = conn
            .signaling
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling closed"))?;
        if let SignalingServerFrame::Delivered { from, payload } = frame {
            if invitee_set.contains(&from) {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                if let AppSignal::KeyPackage(b) = msg {
                    // Stash the KP for use below.
                    pending_kp_set(b);
                    break from;
                }
            }
        }
    };

    let kp_bytes = pending_kp_get().expect("KP just set");
    let kp = KeyPackage::from_bytes(&kp_bytes, &provider).map_err(|e| anyhow!("kp: {e}"))?;
    let outcome = group
        .add_member(&provider, &mls_identity, kp)
        .map_err(|e| anyhow!("add: {e}"))?;
    send_app(
        &conn.signaling,
        peer_device,
        &AppSignal::DevicePublicKey(conn.device_pk.0),
    )
    .await?;
    send_app(
        &conn.signaling,
        peer_device,
        &AppSignal::Welcome(outcome.welcome.0.clone()),
    )
    .await?;
    send_app(&conn.signaling, peer_device, &AppSignal::Address(advertise)).await?;
    send_app(&conn.signaling, peer_device, &AppSignal::Ready).await?;

    // Wait for joiner's address (informational; they dial us).
    loop {
        let frame = conn
            .signaling
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling closed"))?;
        if let SignalingServerFrame::Delivered { from, payload } = frame {
            if from == peer_device {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                if let AppSignal::Address(_) = msg {
                    break;
                }
            }
        }
    }

    let _ = events.send(SessionEvent::Status("awaiting QUIC handshake...".into()));
    let incoming = endpoint
        .accept()
        .await
        .ok_or_else(|| anyhow!("endpoint closed"))?;
    let quic_conn = incoming.await.map_err(|e| anyhow!("accept: {e}"))?;
    let _ = events.send(SessionEvent::Status("connected".into()));

    run_call(
        quic_conn,
        group,
        provider,
        mls_identity,
        room_id,
        conn.my_device_id,
        history,
        events,
        actions,
        true,
    )
    .await
}

// ----- Joiner flow -----

async fn run_join(
    settings: Settings,
    room_id_hex: String,
    events: mpsc::UnboundedSender<SessionEvent>,
    actions: mpsc::UnboundedReceiver<SessionAction>,
) -> Result<()> {
    let _ = &actions; // forwarded to run_call below
    let mut conn = connect(&settings, &events).await?;

    let room_bytes: [u8; 32] = hex::decode(&room_id_hex)?
        .try_into()
        .map_err(|_| anyhow!("room_id must be 32 bytes hex"))?;
    let room_id = RoomId::from_bytes(room_bytes);

    let stmt = conn
        .client
        .room_state(room_id, &conn.token, UnixSeconds::now())
        .await?;
    let peer_user = match stmt.payload {
        CacheableServerStatement::RoomState { members, .. } => {
            members
                .iter()
                .find(|m| m.user != conn.my_user_id)
                .ok_or_else(|| anyhow!("no other member in room"))?
                .user
        }
        _ => bail!("unexpected room state"),
    };
    let _ = events.send(SessionEvent::Status(
        "waiting for host to come online...".into(),
    ));

    let peer_devices = peer_user_devices(&conn.client, peer_user).await?;
    let peer_device = loop {
        let cache = Cache::open_in_memory().await?;
        let tmp_client =
            CoordinationClient::new(settings.server.clone(), cache, conn.server_pubkey);
        let s = tmp_client
            .room_state(room_id, &conn.token, UnixSeconds::now())
            .await?;
        let online: std::collections::HashSet<DeviceId> = match s.payload {
            CacheableServerStatement::RoomState { peer_hints, .. } => {
                peer_hints.iter().map(|h| h.device).collect()
            }
            _ => Default::default(),
        };
        if let Some(d) = peer_devices.iter().find(|d| online.contains(d)).copied() {
            break d;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    };

    let peer_keys = conn.client.user_keys(peer_user, UnixSeconds::now()).await?;
    let peer_device_pk = match peer_keys.payload {
        CacheableServerStatement::UserKeys { devices, .. } => devices
            .into_iter()
            .find(|b| device_id_from_public_key(&b.device_public_key) == peer_device)
            .map(|b| b.device_public_key)
            .ok_or_else(|| anyhow!("peer device pubkey missing from keystore"))?,
        _ => bail!("unexpected keystore"),
    };

    let endpoint = PeerEndpoint::bind(parse_addr(&settings.bind_addr)?, &conn.device_pk)?;
    let local_addr = endpoint.local_addr();
    let advertise = pick_advertise(&settings, local_addr);
    let _ = events.send(SessionEvent::Status(format!("QUIC on {advertise}")));

    let history = TextHistory::open(&conn.state_dir.join("history.sqlite")).await?;

    let provider = Arc::new(OpenMlsRustCrypto::default());
    let mls_identity = Arc::new(
        Identity::generate(conn.my_device_id, &provider).map_err(|e| anyhow!("mls: {e}"))?,
    );
    let kp = KeyPackage::generate(&mls_identity, &provider).map_err(|e| anyhow!("kp: {e}"))?;
    send_app(
        &conn.signaling,
        peer_device,
        &AppSignal::DevicePublicKey(conn.device_pk.0),
    )
    .await?;
    send_app(
        &conn.signaling,
        peer_device,
        &AppSignal::KeyPackage(kp.as_bytes().to_vec()),
    )
    .await?;
    send_app(&conn.signaling, peer_device, &AppSignal::Address(advertise)).await?;

    let mut welcome_bytes = None;
    let mut peer_addr = None;
    let mut ready = false;
    while welcome_bytes.is_none() || peer_addr.is_none() || !ready {
        let frame = conn
            .signaling
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling closed"))?;
        if let SignalingServerFrame::Delivered { from, payload } = frame {
            if from == peer_device {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                match msg {
                    AppSignal::Welcome(b) => welcome_bytes = Some(b),
                    AppSignal::Address(a) => peer_addr = Some(a),
                    AppSignal::Ready => ready = true,
                    _ => {}
                }
            }
        }
    }
    let welcome = MlsWelcome(welcome_bytes.unwrap());
    let group = Group::join_from_welcome(&provider, &mls_identity, &welcome)
        .map_err(|e| anyhow!("mls join: {e}"))?;
    let peer_addr = peer_addr.unwrap();

    let _ = events.send(SessionEvent::Status(format!(
        "dialing host at {peer_addr}..."
    )));
    let quic_conn = endpoint
        .connect(peer_addr, peer_device_pk)
        .await
        .map_err(|e| {
            anyhow!(
                "could not reach the host at {peer_addr} over UDP ({e}). \
             The coordination server connected fine, but the peer-to-peer voice \
             link did not. Usual causes: the host's firewall is blocking inbound \
             UDP (macOS: System Settings > Network > Firewall — turn it off or allow \
             Crocodile on the HOST machine), or the two machines aren't on the same \
             network. Tailscale avoids both."
            )
        })?;
    let _ = events.send(SessionEvent::Status("connected".into()));

    run_call(
        quic_conn,
        group,
        provider,
        mls_identity,
        room_id,
        conn.my_device_id,
        history,
        events,
        actions,
        false,
    )
    .await
}

// ----- The audio + text loops -----

#[allow(clippy::too_many_arguments)]
async fn run_call(
    quic_conn: quinn::Connection,
    group: Group,
    provider: Arc<OpenMlsRustCrypto>,
    mls_identity: Arc<Identity>,
    room_id: RoomId,
    my_device_id: DeviceId,
    history: TextHistory,
    events: mpsc::UnboundedSender<SessionEvent>,
    mut actions: mpsc::UnboundedReceiver<SessionAction>,
    is_host: bool,
) -> Result<()> {
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (encoded_tx, mut encoded_rx) = mpsc::unbounded_channel::<(u32, Vec<u8>)>();
    let (inbound_tx, mut inbound_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let playback_queue = PlaybackQueue::new();

    // cpal's Stream isn't Send on macOS, so the streams must be
    // created and kept alive on a single dedicated OS thread. We
    // park the thread until session shutdown; tokio talks to it via
    // the (Send-safe) channel + the PlaybackQueue's internal Mutex.
    let pq_for_audio = playback_queue.clone();
    let (audio_shutdown_tx, audio_shutdown_rx) = std::sync::mpsc::channel::<()>();
    let _audio_thread = std::thread::Builder::new()
        .name("crocodile-audio".into())
        .spawn(move || {
            let _cap = match capture::open_default(capture_tx) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "audio capture init failed");
                    return;
                }
            };
            let _play = match playback::open_default(pq_for_audio) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "audio playback init failed");
                    return;
                }
            };
            // Park until shutdown.
            let _ = audio_shutdown_rx.recv();
        })
        .expect("spawn audio thread");

    let encode_handle = tokio::spawn(async move {
        let mut enc = OpusEncoder::new().expect("opus init");
        let mut acc: Vec<f32> = Vec::with_capacity(SAMPLES_PER_FRAME * 4);
        let mut seq = 0u32;
        while let Some(chunk) = capture_rx.recv().await {
            acc.extend_from_slice(&chunk);
            while acc.len() >= SAMPLES_PER_FRAME {
                let frame: Vec<f32> = acc.drain(..SAMPLES_PER_FRAME).collect();
                if let Ok(opus) = enc.encode_frame(&f32_to_i16(&frame)) {
                    if encoded_tx.send((seq, opus)).is_err() {
                        return;
                    }
                    seq = seq.wrapping_add(1);
                }
            }
        }
    });

    let group_arc = Arc::new(Mutex::new(group));
    let conn_send = quic_conn.clone();
    let provider_send = provider.clone();
    let identity_send = mls_identity.clone();
    let group_send = group_arc.clone();
    let send_handle = tokio::spawn(async move {
        while let Some((seq, opus)) = encoded_rx.recv().await {
            let frame = {
                let mut g = group_send.lock().await;
                let epoch = g.epoch();
                let ct = match g.encrypt(&provider_send, &identity_send, &opus) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                VoiceFrame {
                    epoch,
                    frame_seq: seq,
                    timestamp_ms: 0,
                    ciphertext: ct,
                }
            };
            if let Ok(bytes) = postcard::to_stdvec(&frame) {
                if conn_send.send_datagram(bytes.into()).is_err() {
                    break;
                }
            }
        }
    });

    let conn_recv = quic_conn.clone();
    let provider_recv = provider.clone();
    let group_recv = group_arc.clone();
    let recv_handle = tokio::spawn(async move {
        let mut jb = JitterBuffer::default();
        loop {
            let bytes = match conn_recv.read_datagram().await {
                Ok(b) => b,
                Err(_) => break,
            };
            let frame: VoiceFrame = match postcard::from_bytes(&bytes) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let pt = {
                let mut g = group_recv.lock().await;
                match g.decrypt(&provider_recv, &frame.ciphertext) {
                    Ok(p) => p,
                    Err(_) => continue,
                }
            };
            jb.push(frame.frame_seq, pt);
            while let Some(opus) = jb.pop() {
                if inbound_tx.send(opus).is_err() {
                    return;
                }
            }
        }
    });

    let pq = playback_queue.clone();
    let decode_handle = tokio::spawn(async move {
        let mut dec = OpusDecoder::new().expect("opus dec");
        while let Some(opus) = inbound_rx.recv().await {
            if let Ok(pcm) = dec.decode_frame(Some(&opus)) {
                pq.push(&i16_to_f32(&pcm));
            }
        }
    });

    // Text bidi stream. Joiner opens; host accepts.
    let (mut text_send, mut text_recv) = if is_host {
        quic_conn
            .accept_bi()
            .await
            .map_err(|e| anyhow!("accept_bi: {e}"))?
    } else {
        quic_conn
            .open_bi()
            .await
            .map_err(|e| anyhow!("open_bi: {e}"))?
    };
    text_send.write_all(&[0u8]).await.ok();
    let mut hello = [0u8; 1];
    text_recv.read_exact(&mut hello).await.ok();

    let local_head = history
        .most_recent(room_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.own_hash);
    let text_sender = Arc::new(Mutex::new(TextSender::new(
        room_id,
        my_device_id,
        local_head,
    )));
    let text_receiver = TextReceiver::new(room_id);

    // Outbound text task: pulls from `actions`, encrypts, sends.
    let group_text_send = group_arc.clone();
    let provider_text_send = provider.clone();
    let identity_text_send = mls_identity.clone();
    let history_text = history.clone();
    let sender_arc = text_sender.clone();
    let text_send_handle = tokio::spawn(async move {
        while let Some(action) = actions.recv().await {
            match action {
                SessionAction::Hangup => break,
                SessionAction::SendText(body) => {
                    let now = UnixSeconds::now();
                    let mut sender = sender_arc.lock().await;
                    let payload_bytes = match sender.encode_payload(&body, now, None) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let (wire, stored) = {
                        let mut g = group_text_send.lock().await;
                        let epoch = g.epoch();
                        let ct = match g.encrypt(
                            &provider_text_send,
                            &identity_text_send,
                            &payload_bytes,
                        ) {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        sender.finalize(epoch, ct, now, None, body.clone())
                    };
                    drop(sender);
                    let bytes = match postcard::to_stdvec(&wire) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let len = (bytes.len() as u32).to_be_bytes();
                    if text_send.write_all(&len).await.is_err() {
                        break;
                    }
                    if text_send.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = history_text.store(&stored).await;
                }
            }
        }
    });

    let group_text_recv = group_arc.clone();
    let provider_text_recv = provider.clone();
    let history_recv = history.clone();
    let events_text = events.clone();
    let text_recv_handle = tokio::spawn(async move {
        loop {
            let mut len_buf = [0u8; 4];
            if text_recv.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > 1024 * 1024 {
                break;
            }
            let mut payload = vec![0u8; len];
            if text_recv.read_exact(&mut payload).await.is_err() {
                break;
            }
            let wire: TextMessage = match postcard::from_bytes(&payload) {
                Ok(w) => w,
                Err(_) => continue,
            };
            let pt = {
                let mut g = group_text_recv.lock().await;
                match g.decrypt(&provider_text_recv, &wire.ciphertext) {
                    Ok(p) => p,
                    Err(_) => continue,
                }
            };
            let sender_seq = history_recv.count_for_room(room_id).await.unwrap_or(0);
            let stored = match text_receiver.decode(&wire, &pt, sender_seq, UnixSeconds::now()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let _ = events_text.send(SessionEvent::Text {
                from: hex::encode(&stored.sender_device.as_bytes()[..4]),
                body: stored.body.clone(),
            });
            let _ = history_recv.store(&stored).await;
        }
    });

    tokio::select! {
        _ = encode_handle => {}
        _ = send_handle => {}
        _ = recv_handle => {}
        _ = decode_handle => {}
        _ = text_send_handle => {}
        _ = text_recv_handle => {}
    }
    quic_conn.close(0u32.into(), b"bye");
    let _ = audio_shutdown_tx.send(());
    Ok(())
}

// ----- Small support helpers -----

// One-slot lock-free shuttle for the pending KP bytes captured during
// the host signaling loop above. Avoids restructuring the loop just
// to thread the bytes out.
use std::sync::OnceLock;
static PENDING_KP: OnceLock<std::sync::Mutex<Option<Vec<u8>>>> = OnceLock::new();
fn pending_kp_set(b: Vec<u8>) {
    let m = PENDING_KP.get_or_init(|| std::sync::Mutex::new(None));
    *m.lock().unwrap() = Some(b);
}
fn pending_kp_get() -> Option<Vec<u8>> {
    let m = PENDING_KP.get_or_init(|| std::sync::Mutex::new(None));
    m.lock().unwrap().take()
}

#[derive(Debug, Serialize, Deserialize)]
enum AppSignal {
    KeyPackage(Vec<u8>),
    Welcome(Vec<u8>),
    Address(SocketAddr),
    DevicePublicKey([u8; 32]),
    Ready,
}

async fn send_app(sig: &SignalingChannel, to: DeviceId, msg: &AppSignal) -> Result<()> {
    let payload = postcard::to_stdvec(msg)?;
    sig.send(SignalingClientFrame::Relay { to, payload })?;
    Ok(())
}

async fn peer_user_devices(client: &CoordinationClient, user: UserId) -> Result<Vec<DeviceId>> {
    let stmt = client.user_keys(user, UnixSeconds::now()).await?;
    match stmt.payload {
        CacheableServerStatement::UserKeys { devices, .. } => Ok(devices
            .into_iter()
            .map(|b| device_id_from_public_key(&b.device_public_key))
            .collect()),
        _ => Ok(vec![]),
    }
}

async fn publish_device_key(
    server: &str,
    token: &str,
    device_pk: &DevicePublicKey,
    binding_sig: &Signature,
) -> Result<()> {
    let resp = reqwest::Client::new()
        .post(format!("{server}/v1/devices"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "device_public_key_hex": hex::encode(device_pk.0),
            "identity_signature_hex": hex::encode(binding_sig.0),
        }))
        .send()
        .await?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 409 {
        Ok(())
    } else {
        bail!("publish_device_key: {status}")
    }
}

async fn create_room(server: &str, token: &str, name: &str) -> Result<RoomId> {
    let resp = reqwest::Client::new()
        .post(format!("{server}/v1/rooms"))
        .bearer_auth(token)
        .json(&serde_json::json!({"name": name, "description": ""}))
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let hex_str = body["room_id_hex"]
        .as_str()
        .ok_or_else(|| anyhow!("missing room_id_hex"))?;
    let bytes: [u8; 32] = hex::decode(hex_str)?
        .try_into()
        .map_err(|_| anyhow!("room_id 32 bytes"))?;
    Ok(RoomId::from_bytes(bytes))
}

async fn add_member_api(server: &str, token: &str, room: RoomId, user: UserId) -> Result<()> {
    reqwest::Client::new()
        .post(format!(
            "{server}/v1/rooms/{}/members",
            hex::encode(room.as_bytes())
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({"user_id_hex": hex::encode(user.as_bytes())}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

fn parse_addr(s: &str) -> Result<SocketAddr> {
    s.parse::<SocketAddr>().context("bind addr")
}

fn pick_advertise(settings: &Settings, local_addr: SocketAddr) -> SocketAddr {
    if !settings.advertise_addr.trim().is_empty() {
        if let Ok(a) = settings.advertise_addr.parse() {
            return a;
        }
    }
    if !local_addr.ip().is_unspecified() {
        return local_addr;
    }
    let host_port = settings
        .server
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("8.8.8.8:80");
    let Some(target) = host_port.to_socket_addrs().ok().and_then(|mut a| a.next()) else {
        return local_addr;
    };
    let bind = if target.is_ipv6() {
        "[::]:0"
    } else {
        "0.0.0.0:0"
    };
    let Ok(probe) = std::net::UdpSocket::bind(bind) else {
        return local_addr;
    };
    if probe.connect(target).is_err() {
        return local_addr;
    }
    match probe.local_addr() {
        Ok(p) => SocketAddr::new(p.ip(), local_addr.port()),
        Err(_) => local_addr,
    }
}
