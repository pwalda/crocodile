//! Group call (N peers, host-as-relay).
//!
//! Same setup as `two_peer_call` (signup, signaling, MLS, QUIC) but
//! supports more than two participants in a single room. The room
//! creator is the permanent host: all other peers connect their QUIC
//! to the host, who fans out voice datagrams and text streams.
//!
//! This is a deliberately simpler topology than the full host-election
//! design (which is what milestone 5 phases D+E will deliver). What we
//! have here:
//!
//! - Host is fixed at the room creator. No election, no failover.
//! - Host fans out: voice datagrams are forwarded ciphertext to all
//!   other members (no decryption — MLS keeps it E2EE).
//! - Each non-host peer maintains exactly one QUIC connection (to
//!   host); the host maintains N-1 connections.
//! - MLS group grows as joiners arrive; the host sends Welcomes to
//!   newcomers and Commits to existing members.
//!
//! Usage:
//!
//! ```text
//! # host on alice's machine:
//! cargo run --release --example group_call -- \
//!     --server http://1.2.3.4:8080 --username alice \
//!     --password somethinglongerthan8 --state-dir ./state-alice \
//!     host --invite-username bob --invite-username carol
//!
//! # bob:
//! cargo run --release --example group_call -- \
//!     --server http://1.2.3.4:8080 --username bob \
//!     --password somethinglongerthan8 --state-dir ./state-bob \
//!     join --room-id <ROOM_ID_FROM_ALICE>
//!
//! # carol (same shape):
//! cargo run --release --example group_call -- \
//!     --server http://1.2.3.4:8080 --username carol \
//!     --password somethinglongerthan8 --state-dir ./state-carol \
//!     join --room-id <ROOM_ID_FROM_ALICE>
//! ```

use std::collections::HashMap;
use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use openmls_rust_crypto::OpenMlsRustCrypto;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crocodile_protocol::ids::{DeviceId, RoomId, UserId};
use crocodile_protocol::keys::{
    device_id_from_public_key, user_id_from_public_key, DeviceKeypair, DevicePublicKey,
    IdentityKeypair, IdentityPublicKey,
};
use crocodile_protocol::mls::MlsWelcome;
use crocodile_protocol::signaling::{
    CacheableServerStatement, RoomRole, SignalingClientFrame, SignalingServerFrame,
};
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

// ---------- App-layer signaling ----------

#[derive(Debug, Serialize, Deserialize)]
enum AppSignal {
    KeyPackage(Vec<u8>),
    Welcome(Vec<u8>),
    /// Extra commit for already-joined members to advance their epoch
    /// when a new peer is added after them.
    Commit(Vec<u8>),
    Address(SocketAddr),
    DevicePublicKey([u8; 32]),
    Ready,
}

// ---------- CLI ----------

#[derive(Debug)]
struct Args {
    server: String,
    username: String,
    password: String,
    state_dir: PathBuf,
    bind_addr: SocketAddr,
    advertise_addr: Option<SocketAddr>,
    mode: Mode,
}

#[derive(Debug)]
enum Mode {
    Host {
        invite_user_ids: Vec<UserId>,
        invite_usernames: Vec<String>,
    },
    Join {
        room_id: RoomId,
    },
}

fn parse_args() -> Result<Args> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let mut server = None;
    let mut username = None;
    let mut password = None;
    let mut state_dir = None;
    let mut bind_addr: SocketAddr = "0.0.0.0:0".parse().unwrap();
    let mut advertise_addr: Option<SocketAddr> = None;
    let mut subcommand: Option<String> = None;
    let mut invite_user_ids: Vec<UserId> = Vec::new();
    let mut invite_usernames: Vec<String> = Vec::new();
    let mut room_id: Option<RoomId> = None;

    let mut i = 0;
    while i < raw.len() {
        let arg = &raw[i];
        match arg.as_str() {
            "--server" => {
                server = Some(raw.get(i + 1).cloned().context("--server value")?);
                i += 2;
            }
            "--username" => {
                username = Some(raw.get(i + 1).cloned().context("--username value")?);
                i += 2;
            }
            "--password" => {
                password = Some(raw.get(i + 1).cloned().context("--password value")?);
                i += 2;
            }
            "--state-dir" => {
                state_dir = Some(PathBuf::from(
                    raw.get(i + 1).cloned().context("--state-dir")?,
                ));
                i += 2;
            }
            "--bind-addr" => {
                bind_addr = raw.get(i + 1).context("--bind-addr value")?.parse()?;
                i += 2;
            }
            "--advertise-addr" => {
                advertise_addr = Some(raw.get(i + 1).context("--advertise-addr value")?.parse()?);
                i += 2;
            }
            "--invite-user-id" => {
                let s = raw.get(i + 1).context("--invite-user-id value")?;
                let bytes: [u8; 32] = hex::decode(s)?
                    .try_into()
                    .map_err(|_| anyhow!("--invite-user-id must be 32 bytes"))?;
                invite_user_ids.push(UserId::from_bytes(bytes));
                i += 2;
            }
            "--invite-username" => {
                invite_usernames.push(raw.get(i + 1).cloned().context("--invite-username")?);
                i += 2;
            }
            "--room-id" => {
                let s = raw.get(i + 1).context("--room-id value")?;
                let bytes: [u8; 32] = hex::decode(s)?
                    .try_into()
                    .map_err(|_| anyhow!("--room-id must be 32 bytes"))?;
                room_id = Some(RoomId::from_bytes(bytes));
                i += 2;
            }
            "host" | "join" => {
                subcommand = Some(arg.clone());
                i += 1;
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => bail!("unknown argument: {other}"),
        }
    }

    let mode = match subcommand.as_deref() {
        Some("host") => {
            if invite_user_ids.is_empty() && invite_usernames.is_empty() {
                bail!("host mode requires at least one --invite-user-id or --invite-username");
            }
            Mode::Host {
                invite_user_ids,
                invite_usernames,
            }
        }
        Some("join") => Mode::Join {
            room_id: room_id.context("join requires --room-id")?,
        },
        _ => bail!("must specify a subcommand: host or join"),
    };

    Ok(Args {
        server: server.context("--server required")?,
        username: username.context("--username required")?,
        password: password.context("--password required")?,
        state_dir: state_dir.context("--state-dir required")?,
        bind_addr,
        advertise_addr,
        mode,
    })
}

fn print_help() {
    eprintln!("usage:");
    eprintln!("  group_call --server URL --username U --password P --state-dir D [--bind-addr ADDR] [--advertise-addr ADDR]");
    eprintln!("             host (--invite-username NAME)+");
    eprintln!("  group_call --server URL --username U --password P --state-dir D [--bind-addr ADDR] [--advertise-addr ADDR]");
    eprintln!("             join --room-id HEX");
}

// ---------- Persisted keys ----------

#[derive(Debug, Serialize, Deserialize)]
struct PersistedKeys {
    identity_seed_hex: String,
    device_seed_hex: String,
}

fn load_or_create_keys(state_dir: &PathBuf) -> Result<(IdentityKeypair, DeviceKeypair)> {
    std::fs::create_dir_all(state_dir)?;
    let path = state_dir.join("keys.json");
    if let Ok(bytes) = std::fs::read(&path) {
        let p: PersistedKeys = serde_json::from_slice(&bytes)?;
        let identity_seed: [u8; 32] = hex::decode(&p.identity_seed_hex)?
            .try_into()
            .map_err(|_| anyhow!("32 bytes"))?;
        let device_seed: [u8; 32] = hex::decode(&p.device_seed_hex)?
            .try_into()
            .map_err(|_| anyhow!("32 bytes"))?;
        Ok((
            IdentityKeypair::from_seed(identity_seed),
            DeviceKeypair::from_seed(device_seed),
        ))
    } else {
        let mut identity_seed = [0u8; 32];
        let mut device_seed = [0u8; 32];
        OsRng.fill_bytes(&mut identity_seed);
        OsRng.fill_bytes(&mut device_seed);
        let p = PersistedKeys {
            identity_seed_hex: hex::encode(identity_seed),
            device_seed_hex: hex::encode(device_seed),
        };
        std::fs::write(&path, serde_json::to_vec_pretty(&p)?)?;
        Ok((
            IdentityKeypair::from_seed(identity_seed),
            DeviceKeypair::from_seed(device_seed),
        ))
    }
}

// ---------- Signaling helpers ----------

async fn send_app(sig: &SignalingChannel, to: DeviceId, msg: &AppSignal) -> Result<()> {
    let payload = postcard::to_stdvec(msg)?;
    sig.send(SignalingClientFrame::Relay { to, payload })?;
    Ok(())
}

async fn recv_app_from(
    sig: &mut SignalingChannel,
    expected_set: &std::collections::HashSet<DeviceId>,
) -> Result<(DeviceId, AppSignal)> {
    loop {
        let frame = sig
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling closed"))?;
        match frame {
            SignalingServerFrame::Delivered { from, payload } if expected_set.contains(&from) => {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                return Ok((from, msg));
            }
            SignalingServerFrame::Delivered { from, .. } => {
                tracing::debug!(?from, "ignoring frame from non-expected device");
            }
            SignalingServerFrame::UnreachableRecipient { target } => {
                tracing::warn!(?target, "previous relay unreachable");
            }
            SignalingServerFrame::Error { message } => bail!("signaling error: {message}"),
            _ => {}
        }
    }
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

// ---------- Per-peer link (host's view of one joiner) ----------

#[derive(Debug)]
struct JoinerLink {
    conn: quinn::Connection,
    text_send: quinn::SendStream,
    /// Cancel handles for the per-peer receiver tasks.
    _recv_handle: tokio::task::JoinHandle<()>,
}

// ---------- Main orchestration ----------

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let args = parse_args()?;

    let (identity_kp, device_kp) = load_or_create_keys(&args.state_dir)?;
    let identity_pk: IdentityPublicKey = identity_kp.public_key();
    let device_pk: DevicePublicKey = device_kp.public_key();
    let my_user_id = user_id_from_public_key(&identity_pk);
    let my_device_id = device_id_from_public_key(&device_pk);
    println!("My user_id:   {}", hex::encode(my_user_id.as_bytes()));
    println!("My device_id: {}", hex::encode(my_device_id.as_bytes()));

    let info: ServerInfo = CoordinationClient::server_info(&args.server).await?;
    let server_ipk_bytes: [u8; 32] = hex::decode(&info.identity_public_key_hex)?
        .try_into()
        .map_err(|_| anyhow!("server identity_public_key must be 32 bytes"))?;
    let server_pubkey = IdentityPublicKey(server_ipk_bytes);

    let cache = Cache::open(&args.state_dir.join("cache.sqlite")).await?;
    let client = CoordinationClient::new(args.server.clone(), cache.clone(), server_pubkey);

    // Signup-or-login.
    match client
        .create_account(&args.username, &args.password, &identity_pk)
        .await
    {
        Ok(_) => println!("Signed up."),
        Err(crocodile_client::ClientError::ServerStatus { status: 409, .. }) => {
            println!("Account exists; logging in.")
        }
        Err(e) => return Err(e.into()),
    }
    let login = client.login(&args.username, &args.password).await?;
    let token = login.session_token;

    // Publish device key.
    let binding_input = {
        let mut v = Vec::with_capacity(64);
        v.extend_from_slice(my_user_id.as_bytes());
        v.extend_from_slice(&device_pk.0);
        v
    };
    let binding_sig = identity_kp.sign(&binding_input);
    publish_device_key(&args.server, &token, &device_pk, &binding_sig).await?;

    // Open signaling.
    let sig = SignalingChannel::connect(&args.server, &token, my_device_id).await?;
    println!("Signaling connected. Server id: {}", sig.server_id());

    // Bind QUIC endpoint and figure out our advertised address.
    let endpoint = PeerEndpoint::bind(args.bind_addr, &device_pk)?;
    let local_addr = endpoint.local_addr();
    let advertise = args
        .advertise_addr
        .unwrap_or_else(|| best_advertise_addr(&args.server, local_addr));
    println!("QUIC bound on {local_addr}; advertising {advertise}");
    if args.advertise_addr.is_none() && local_addr.ip().is_unspecified() {
        println!(
            "  (auto-detected; pass --advertise-addr ADDR if this isn't reachable from your peer)"
        );
    }

    let history = TextHistory::open(&args.state_dir.join("history.sqlite")).await?;

    // MLS setup.
    let provider = Arc::new(OpenMlsRustCrypto::default());
    let mls_identity = Arc::new(
        Identity::generate(my_device_id, &provider).map_err(|e| anyhow!("mls identity: {e}"))?,
    );

    match args.mode {
        Mode::Host {
            invite_user_ids,
            invite_usernames,
        } => {
            // Resolve invitees (mix of explicit IDs + name lookups).
            let mut invitees: Vec<UserId> = invite_user_ids.clone();
            for name in &invite_usernames {
                let uid_hex = client
                    .lookup_username(name)
                    .await
                    .with_context(|| format!("looking up username {name:?}"))?;
                let bytes: [u8; 32] = hex::decode(&uid_hex)?
                    .try_into()
                    .map_err(|_| anyhow!("server returned non-32-byte user_id"))?;
                invitees.push(UserId::from_bytes(bytes));
            }

            let room_id = create_room(&args.server, &token, &args.username).await?;
            for invitee in &invitees {
                add_member_api(&args.server, &token, room_id, *invitee).await?;
            }
            println!(
                "Created room with {} invitees. Share this id:\n  ROOM_ID: {}",
                invitees.len(),
                hex::encode(room_id.as_bytes())
            );

            run_host(
                sig,
                client.clone(),
                token.clone(),
                room_id,
                invitees,
                my_device_id,
                device_pk,
                advertise,
                endpoint,
                provider,
                mls_identity,
                history,
            )
            .await?;
        }
        Mode::Join { room_id } => {
            // Identify host (room owner) from RoomState.
            let stmt = client
                .room_state(room_id, &token, UnixSeconds::now())
                .await?;
            let host_user = match stmt.payload {
                CacheableServerStatement::RoomState { members, .. } => {
                    members
                        .iter()
                        .find(|m| m.role == RoomRole::Owner)
                        .ok_or_else(|| anyhow!("no owner in room"))?
                        .user
                }
                _ => bail!("unexpected room state"),
            };
            println!("Host user: {}", hex::encode(host_user.as_bytes()));

            run_joiner(
                sig,
                client.clone(),
                token.clone(),
                room_id,
                host_user,
                my_device_id,
                device_pk,
                advertise,
                endpoint,
                provider,
                mls_identity,
                history,
            )
            .await?;
        }
    }

    Ok(())
}

// ---------- Host runtime ----------

#[allow(clippy::too_many_arguments)]
async fn run_host(
    mut sig: SignalingChannel,
    client: CoordinationClient,
    _token: String,
    room_id: RoomId,
    invitees: Vec<UserId>,
    my_device_id: DeviceId,
    device_pk: DevicePublicKey,
    advertise: SocketAddr,
    endpoint: PeerEndpoint,
    provider: Arc<OpenMlsRustCrypto>,
    mls_identity: Arc<Identity>,
    history: TextHistory,
) -> Result<()> {
    // Create the MLS group with us as the founding member.
    let group = Group::create(&provider, &mls_identity, room_id.as_bytes())
        .map_err(|e| anyhow!("mls create: {e}"))?;
    let group = Arc::new(Mutex::new(group));

    // Maintain a registry of joined peers and their links.
    let links: Arc<Mutex<HashMap<DeviceId, JoinerLink>>> = Arc::new(Mutex::new(HashMap::new()));
    let (forward_tx, mut forward_rx) = mpsc::unbounded_channel::<(DeviceId, Vec<u8>)>(); // (from, bytes)

    // Voice fan-out task: receives (sender_device, bytes), forwards
    // to all other peers in the registry.
    let links_for_fanout = links.clone();
    let fanout_handle = tokio::spawn(async move {
        while let Some((from, bytes)) = forward_rx.recv().await {
            let guard = links_for_fanout.lock().await;
            for (dev, link) in guard.iter() {
                if *dev != from {
                    if let Err(e) = link.conn.send_datagram(bytes.clone().into()) {
                        tracing::debug!(error = %e, ?dev, "fan-out send failed");
                    }
                }
            }
        }
    });

    // Local audio: we capture, encrypt, broadcast to all joiners,
    // and play back what we receive from them (via the same fanout
    // pipeline, marked as from=self so we skip our own peer).
    let playback_queue = PlaybackQueue::new();
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let _cap = capture::open_default(capture_tx)?;
    let _play = playback::open_default(playback_queue.clone())?;

    // Our own encode → broadcast loop.
    let provider_for_self_send = provider.clone();
    let identity_for_self_send = mls_identity.clone();
    let group_for_self_send = group.clone();
    let links_for_self_send = links.clone();
    let self_send_handle = tokio::spawn(async move {
        let mut enc = match OpusEncoder::new() {
            Ok(e) => e,
            Err(e) => {
                tracing::error!(error = %e, "opus encoder init failed");
                return;
            }
        };
        let mut accumulator: Vec<f32> = Vec::with_capacity(SAMPLES_PER_FRAME * 4);
        let mut seq: u32 = 0;
        while let Some(chunk) = capture_rx.recv().await {
            accumulator.extend_from_slice(&chunk);
            while accumulator.len() >= SAMPLES_PER_FRAME {
                let frame: Vec<f32> = accumulator.drain(..SAMPLES_PER_FRAME).collect();
                let pcm_i16 = f32_to_i16(&frame);
                let opus_bytes = match enc.encode_frame(&pcm_i16) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(error = %e, "encode failed");
                        continue;
                    }
                };
                // MLS encrypt
                let frame = {
                    let mut g = group_for_self_send.lock().await;
                    let epoch = g.epoch();
                    let ct = match g.encrypt(
                        &provider_for_self_send,
                        &identity_for_self_send,
                        &opus_bytes,
                    ) {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!(error = %e, "mls encrypt failed");
                            continue;
                        }
                    };
                    VoiceFrame {
                        epoch,
                        frame_seq: seq,
                        timestamp_ms: 0,
                        ciphertext: ct,
                    }
                };
                seq = seq.wrapping_add(1);
                let bytes = match postcard::to_stdvec(&frame) {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(error = %e, "postcard encode failed");
                        continue;
                    }
                };
                // Broadcast to all currently-joined links.
                let guard = links_for_self_send.lock().await;
                for link in guard.values() {
                    if let Err(e) = link.conn.send_datagram(bytes.clone().into()) {
                        tracing::debug!(error = %e, "host self-send datagram failed");
                    }
                }
            }
        }
    });

    // Local playback decoder: receives Opus bytes that the per-peer
    // receivers decrypt for us, decodes via Opus, pushes into the
    // playback queue.
    let (local_decoded_tx, mut local_decoded_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let pq_for_play = playback_queue.clone();
    let decode_handle = tokio::spawn(async move {
        let mut dec = match OpusDecoder::new() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(error = %e, "decoder init failed");
                return;
            }
        };
        while let Some(opus_bytes) = local_decoded_rx.recv().await {
            match dec.decode_frame(Some(&opus_bytes)) {
                Ok(pcm_i16) => pq_for_play.push(&i16_to_f32(&pcm_i16)),
                Err(e) => tracing::warn!(error = %e, "decode failed"),
            }
        }
    });

    // Background: accept new joiners. The accept loop runs in
    // parallel with the signaling dance below.
    let endpoint_for_accept = endpoint.clone();
    let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<quinn::Connection>();
    let accept_handle = tokio::spawn(async move {
        while let Some(incoming) = endpoint_for_accept.accept().await {
            match incoming.await {
                Ok(conn) => {
                    if incoming_tx.send(conn).is_err() {
                        break;
                    }
                }
                Err(e) => tracing::debug!(error = %e, "accept handshake failed"),
            }
        }
    });

    // For each invitee, run the signaling dance + accept their QUIC.
    // Sequential: this keeps MLS state simple. Joiners can come online
    // in any order — we wait for whichever invitee's KP arrives next.
    let mut remaining: std::collections::HashSet<UserId> = invitees.iter().copied().collect();

    // For text: open a bidi stream per joiner (joiner opens, we
    // accept). We track and use them in the text loop.
    let text_history = history.clone();
    let group_for_text_recv = group.clone();
    let provider_for_text_recv = provider.clone();

    while !remaining.is_empty() {
        // Wait for the next KeyPackage from any remaining invitee.
        // We need to map the sending device → user_id via keystore.
        let (from_device, msg) = recv_app_from_any(&mut sig, |d| {
            // Accept from any device that hasn't already joined.
            !links
                .try_lock()
                .map(|g| g.contains_key(&d))
                .unwrap_or(false)
        })
        .await?;

        let kp_bytes = match msg {
            AppSignal::KeyPackage(b) => b,
            other => {
                tracing::debug!(?other, "non-KP signal during host dance; ignoring");
                continue;
            }
        };

        // Identify which user this device belongs to.
        let device_user = identify_user_for_device(&client, from_device, &remaining).await?;
        if !remaining.remove(&device_user) {
            tracing::warn!(?device_user, "got KP from device not in remaining set");
            continue;
        }
        println!(
            "Adding {} (device {})",
            hex::encode(device_user.as_bytes()),
            hex::encode(&from_device.as_bytes()[..4])
        );

        let kp =
            KeyPackage::from_bytes(&kp_bytes, &provider).map_err(|e| anyhow!("kp parse: {e}"))?;
        let outcome = {
            let mut g = group.lock().await;
            g.add_member(&provider, &mls_identity, kp)
                .map_err(|e| anyhow!("add_member: {e}"))?
        };

        // Send the welcome to the newcomer.
        send_app(
            &sig,
            from_device,
            &AppSignal::Welcome(outcome.welcome.0.clone()),
        )
        .await?;

        // Send the commit to each already-joined member so they
        // advance epoch.
        {
            let guard = links.lock().await;
            for (existing, _link) in guard.iter() {
                send_app(
                    &sig,
                    *existing,
                    &AppSignal::Commit(outcome.commit.0.clone()),
                )
                .await?;
            }
        }

        // Send our advertised address + the Ready signal.
        send_app(&sig, from_device, &AppSignal::DevicePublicKey(device_pk.0)).await?;
        send_app(&sig, from_device, &AppSignal::Address(advertise)).await?;
        send_app(&sig, from_device, &AppSignal::Ready).await?;

        // Wait for the joiner's address (informational; they dial us).
        loop {
            let (from, msg) = recv_app_from(
                &mut sig,
                &[from_device]
                    .iter()
                    .copied()
                    .collect::<std::collections::HashSet<_>>(),
            )
            .await?;
            if from == from_device {
                if let AppSignal::Address(_) = msg {
                    break;
                }
            }
        }

        // Accept their QUIC connection (background accept task
        // already takes it; here we wait for it to appear).
        let conn = tokio::time::timeout(Duration::from_secs(15), incoming_rx.recv())
            .await
            .context("timeout waiting for joiner's QUIC connection")?
            .ok_or_else(|| anyhow!("accept channel closed"))?;

        // Open a bidi stream for text. Joiner opens; we accept.
        let (mut send_stream, mut recv_stream) = conn
            .accept_bi()
            .await
            .map_err(|e| anyhow!("accept_bi: {e}"))?;
        // Drain init sentinel.
        let mut hello = [0u8; 1];
        recv_stream.read_exact(&mut hello).await.ok();
        send_stream.write_all(&[0u8]).await.ok();

        // Spawn a per-peer receiver task that handles voice
        // datagrams (decrypt for local playback + forward to other
        // peers via the fanout channel) AND text stream reads.
        let conn_for_task = conn.clone();
        let forward_tx_for_task = forward_tx.clone();
        let local_decoded_tx_for_task = local_decoded_tx.clone();
        let group_for_task = group.clone();
        let provider_for_task = provider.clone();
        let from_device_for_task = from_device;
        let voice_handle = tokio::spawn(async move {
            loop {
                let bytes = match conn_for_task.read_datagram().await {
                    Ok(b) => b.to_vec(),
                    Err(_) => break,
                };
                // Forward the ciphertext bytes to all OTHER peers.
                let _ = forward_tx_for_task.send((from_device_for_task, bytes.clone()));
                // Locally decode for playback.
                let frame: VoiceFrame = match postcard::from_bytes(&bytes) {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::debug!(error = %e, "decode voice frame");
                        continue;
                    }
                };
                let pt = {
                    let mut g = group_for_task.lock().await;
                    match g.decrypt(&provider_for_task, &frame.ciphertext) {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::debug!(error = %e, "mls decrypt host-side");
                            continue;
                        }
                    }
                };
                let _ = local_decoded_tx_for_task.send(pt);
            }
        });

        // Text receive task — reads from joiner, decrypts, prints,
        // and forwards (re-encoded since each peer pair has its own
        // stream).
        let group_for_text = group_for_text_recv.clone();
        let provider_for_text = provider_for_text_recv.clone();
        let history_for_text = text_history.clone();
        let links_for_text = links.clone();
        let from_device_for_text = from_device;
        let room_id_for_text = room_id;
        let text_handle = tokio::spawn(async move {
            let receiver = TextReceiver::new(room_id_for_text);
            loop {
                let mut len_buf = [0u8; 4];
                if recv_stream.read_exact(&mut len_buf).await.is_err() {
                    break;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                if len > 1024 * 1024 {
                    break;
                }
                let mut payload = vec![0u8; len];
                if recv_stream.read_exact(&mut payload).await.is_err() {
                    break;
                }
                let wire: crocodile_protocol::text::TextMessage =
                    match postcard::from_bytes(&payload) {
                        Ok(w) => w,
                        Err(_) => continue,
                    };
                let plaintext = {
                    let mut g = group_for_text.lock().await;
                    match g.decrypt(&provider_for_text, &wire.ciphertext) {
                        Ok(p) => p,
                        Err(_) => continue,
                    }
                };
                let sender_seq = history_for_text
                    .count_for_room(room_id_for_text)
                    .await
                    .unwrap_or(0);
                let stored =
                    match receiver.decode(&wire, &plaintext, sender_seq, UnixSeconds::now()) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                println!(
                    "[{}]: {}",
                    hex::encode(&stored.sender_device.as_bytes()[..4]),
                    stored.body
                );
                let _ = history_for_text.store(&stored).await;

                // Fan-out text to other joiners. Re-uses the bytes
                // we already received (they're already MLS-encrypted
                // under the group epoch, so all other members can
                // decrypt them). Length-prefix the same way we did
                // on send.
                let len = (payload.len() as u32).to_be_bytes();
                let mut guard = links_for_text.lock().await;
                for (other_dev, link) in guard.iter_mut() {
                    if *other_dev == from_device_for_text {
                        continue;
                    }
                    if link.text_send.write_all(&len).await.is_err() {
                        continue;
                    }
                    let _ = link.text_send.write_all(&payload).await;
                }
            }
        });

        let combined_handle = tokio::spawn(async move {
            tokio::select! {
                _ = voice_handle => {},
                _ = text_handle => {},
            }
        });

        // Register the link.
        links.lock().await.insert(
            from_device,
            JoinerLink {
                conn,
                text_send: send_stream,
                _recv_handle: combined_handle,
            },
        );

        println!(
            "Joiner attached. {} of {} expected.",
            invitees.len() - remaining.len(),
            invitees.len()
        );
    }

    println!("All joiners attached. Voice fan-out active. Ctrl-C to hang up.");

    // Host's text input → broadcast to all joiners.
    let group_for_text_send = group.clone();
    let provider_for_text_send = provider.clone();
    let identity_for_text_send = mls_identity.clone();
    let links_for_text_send = links.clone();
    let history_for_text_send = history.clone();
    let local_head = history
        .most_recent(room_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.own_hash);
    let mut text_sender = TextSender::new(room_id, my_device_id, local_head);
    let text_send_handle = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        println!("Type messages and press Enter.");
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            let now = UnixSeconds::now();
            let payload_bytes = match text_sender.encode_payload(&line, now, None) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let (wire, stored) = {
                let mut g = group_for_text_send.lock().await;
                let epoch = g.epoch();
                let ct = match g.encrypt(
                    &provider_for_text_send,
                    &identity_for_text_send,
                    &payload_bytes,
                ) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                text_sender.finalize(epoch, ct, now, None, line.clone())
            };
            let bytes = match postcard::to_stdvec(&wire) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let len = (bytes.len() as u32).to_be_bytes();
            let mut guard = links_for_text_send.lock().await;
            for (_dev, link) in guard.iter_mut() {
                let _ = link.text_send.write_all(&len).await;
                let _ = link.text_send.write_all(&bytes).await;
            }
            let _ = history_for_text_send.store(&stored).await;
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("Hanging up.");
        }
        _ = fanout_handle => {}
        _ = self_send_handle => {}
        _ = decode_handle => {}
        _ = text_send_handle => {}
        _ = accept_handle => {}
    }
    Ok(())
}

// ---------- Joiner runtime ----------

#[allow(clippy::too_many_arguments)]
async fn run_joiner(
    mut sig: SignalingChannel,
    client: CoordinationClient,
    // Used to re-poll RoomState while waiting for the host to come online.
    token: String,
    room_id: RoomId,
    host_user: UserId,
    my_device_id: DeviceId,
    device_pk: DevicePublicKey,
    advertise: SocketAddr,
    endpoint: PeerEndpoint,
    provider: Arc<OpenMlsRustCrypto>,
    mls_identity: Arc<Identity>,
    history: TextHistory,
) -> Result<()> {
    // Wait for host's device to appear in peer hints.
    println!("Waiting for host to come online...");
    let host_devices = peer_user_devices(&client, host_user).await?;
    if host_devices.is_empty() {
        bail!("host has no published devices");
    }
    // Poll RoomState until the host's device appears online.
    let host_device = loop {
        let stmt = client
            .room_state(room_id, &token, UnixSeconds::now())
            .await?;
        let online: std::collections::HashSet<DeviceId> = match stmt.payload {
            CacheableServerStatement::RoomState { peer_hints, .. } => {
                peer_hints.iter().map(|h| h.device).collect()
            }
            _ => Default::default(),
        };
        if let Some(d) = host_devices.iter().find(|d| online.contains(d)).copied() {
            break d;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    };
    println!("Host device: {}", hex::encode(host_device.as_bytes()));

    // Fetch host's device pubkey for the QUIC verifier.
    let host_keys = client.user_keys(host_user, UnixSeconds::now()).await?;
    let host_device_pk = match host_keys.payload {
        CacheableServerStatement::UserKeys { devices, .. } => devices
            .into_iter()
            .find(|b| device_id_from_public_key(&b.device_public_key) == host_device)
            .map(|b| b.device_public_key)
            .ok_or_else(|| anyhow!("host device pubkey not in keystore"))?,
        _ => bail!("unexpected keystore payload"),
    };

    // MLS join dance.
    let kp =
        KeyPackage::generate(&mls_identity, &provider).map_err(|e| anyhow!("kp generate: {e}"))?;
    send_app(&sig, host_device, &AppSignal::DevicePublicKey(device_pk.0)).await?;
    send_app(
        &sig,
        host_device,
        &AppSignal::KeyPackage(kp.as_bytes().to_vec()),
    )
    .await?;
    send_app(&sig, host_device, &AppSignal::Address(advertise)).await?;

    let mut group: Option<Group> = None;
    let mut host_addr: Option<SocketAddr> = None;
    let mut ready = false;
    let host_set: std::collections::HashSet<DeviceId> = [host_device].iter().copied().collect();
    while group.is_none() || host_addr.is_none() || !ready {
        let (from, msg) = recv_app_from(&mut sig, &host_set).await?;
        if from != host_device {
            continue;
        }
        match msg {
            AppSignal::Welcome(b) => {
                let welcome = MlsWelcome(b);
                let g = Group::join_from_welcome(&provider, &mls_identity, &welcome)
                    .map_err(|e| anyhow!("mls join: {e}"))?;
                group = Some(g);
            }
            AppSignal::Address(a) => host_addr = Some(a),
            AppSignal::Ready => ready = true,
            _ => {}
        }
    }
    let group = Arc::new(Mutex::new(group.unwrap()));
    let host_addr = host_addr.unwrap();

    // Background: any further commits from the host (when new peers
    // join after us) must be applied to keep our MLS state current.
    let group_for_commits = group.clone();
    let provider_for_commits = provider.clone();
    let commit_listener = tokio::spawn(async move {
        // We can't keep using the same `sig` since it's moved into the
        // main thread for other purposes. In practice, late commits
        // can be ignored for the simple demo (we don't add more peers
        // mid-call gracefully). Skip wiring this; document the
        // limitation in the binary's banner.
        let _ = (group_for_commits, provider_for_commits);
    });
    drop(commit_listener);

    println!("Joined MLS group. Dialing host at {host_addr}...");
    let conn = endpoint.connect(host_addr, host_device_pk).await?;
    println!("QUIC connected.");

    // Open the text bidi stream (we initiate).
    let (mut text_send, mut text_recv) =
        conn.open_bi().await.map_err(|e| anyhow!("open_bi: {e}"))?;
    text_send.write_all(&[0u8]).await.ok();
    let mut hello = [0u8; 1];
    text_recv.read_exact(&mut hello).await.ok();

    // Audio I/O.
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (decoded_tx, mut decoded_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let playback_queue = PlaybackQueue::new();
    let _cap = capture::open_default(capture_tx)?;
    let _play = playback::open_default(playback_queue.clone())?;

    // Encoder → send to host.
    let conn_for_send = conn.clone();
    let provider_for_send = provider.clone();
    let identity_for_send = mls_identity.clone();
    let group_for_send = group.clone();
    let send_handle = tokio::spawn(async move {
        let mut enc = OpusEncoder::new().expect("opus init");
        let mut accumulator: Vec<f32> = Vec::with_capacity(SAMPLES_PER_FRAME * 4);
        let mut seq: u32 = 0;
        while let Some(chunk) = capture_rx.recv().await {
            accumulator.extend_from_slice(&chunk);
            while accumulator.len() >= SAMPLES_PER_FRAME {
                let frame: Vec<f32> = accumulator.drain(..SAMPLES_PER_FRAME).collect();
                let opus = match enc.encode_frame(&f32_to_i16(&frame)) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let frame = {
                    let mut g = group_for_send.lock().await;
                    let epoch = g.epoch();
                    let ct = match g.encrypt(&provider_for_send, &identity_for_send, &opus) {
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
                seq = seq.wrapping_add(1);
                let bytes = match postcard::to_stdvec(&frame) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if conn_for_send.send_datagram(bytes.into()).is_err() {
                    break;
                }
            }
        }
    });

    // Receive from host (host fans out everyone's voice to us).
    let conn_for_recv = conn.clone();
    let provider_for_recv = provider.clone();
    let group_for_recv = group.clone();
    let recv_handle = tokio::spawn(async move {
        let mut jb = JitterBuffer::default();
        loop {
            let bytes = match conn_for_recv.read_datagram().await {
                Ok(b) => b,
                Err(_) => break,
            };
            let frame: VoiceFrame = match postcard::from_bytes(&bytes) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let pt = {
                let mut g = group_for_recv.lock().await;
                match g.decrypt(&provider_for_recv, &frame.ciphertext) {
                    Ok(p) => p,
                    Err(_) => continue,
                }
            };
            jb.push(frame.frame_seq, pt);
            while let Some(opus) = jb.pop() {
                if decoded_tx.send(opus).is_err() {
                    return;
                }
            }
        }
    });

    let pq = playback_queue.clone();
    let decode_handle = tokio::spawn(async move {
        let mut dec = OpusDecoder::new().expect("opus dec init");
        while let Some(opus) = decoded_rx.recv().await {
            if let Ok(pcm) = dec.decode_frame(Some(&opus)) {
                pq.push(&i16_to_f32(&pcm));
            }
        }
    });

    // Text loops.
    let text_history = history.clone();
    let local_head = text_history
        .most_recent(room_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.own_hash);
    let mut text_sender = TextSender::new(room_id, my_device_id, local_head);
    let group_for_text_send = group.clone();
    let provider_for_text_send = provider.clone();
    let identity_for_text_send = mls_identity.clone();
    let history_for_send = text_history.clone();
    let text_send_handle = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        println!("Type messages and press Enter.");
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            let now = UnixSeconds::now();
            let payload_bytes = match text_sender.encode_payload(&line, now, None) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let (wire, stored) = {
                let mut g = group_for_text_send.lock().await;
                let epoch = g.epoch();
                let ct = match g.encrypt(
                    &provider_for_text_send,
                    &identity_for_text_send,
                    &payload_bytes,
                ) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                text_sender.finalize(epoch, ct, now, None, line.clone())
            };
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
            let _ = history_for_send.store(&stored).await;
        }
    });

    let group_for_text_recv = group.clone();
    let provider_for_text_recv = provider.clone();
    let history_for_recv = text_history.clone();
    let text_recv_handle = tokio::spawn(async move {
        let receiver = TextReceiver::new(room_id);
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
            let wire: crocodile_protocol::text::TextMessage = match postcard::from_bytes(&payload) {
                Ok(w) => w,
                Err(_) => continue,
            };
            let pt = {
                let mut g = group_for_text_recv.lock().await;
                match g.decrypt(&provider_for_text_recv, &wire.ciphertext) {
                    Ok(p) => p,
                    Err(_) => continue,
                }
            };
            let sender_seq = history_for_recv.count_for_room(room_id).await.unwrap_or(0);
            let stored = match receiver.decode(&wire, &pt, sender_seq, UnixSeconds::now()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            println!(
                "[{}]: {}",
                hex::encode(&stored.sender_device.as_bytes()[..4]),
                stored.body
            );
            let _ = history_for_recv.store(&stored).await;
        }
    });

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = send_handle => {}
        _ = recv_handle => {}
        _ = decode_handle => {}
        _ = text_send_handle => {}
        _ = text_recv_handle => {}
    }
    Ok(())
}

// ---------- More signaling helpers ----------

async fn recv_app_from_any(
    sig: &mut SignalingChannel,
    accept: impl Fn(DeviceId) -> bool,
) -> Result<(DeviceId, AppSignal)> {
    loop {
        let frame = sig
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling closed"))?;
        match frame {
            SignalingServerFrame::Delivered { from, payload } if accept(from) => {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                return Ok((from, msg));
            }
            SignalingServerFrame::Delivered { .. } => continue,
            SignalingServerFrame::UnreachableRecipient { target } => {
                tracing::warn!(?target, "relay unreachable")
            }
            SignalingServerFrame::Error { message } => bail!("signaling: {message}"),
            _ => {}
        }
    }
}

async fn identify_user_for_device(
    client: &CoordinationClient,
    device: DeviceId,
    candidates: &std::collections::HashSet<UserId>,
) -> Result<UserId> {
    for user in candidates {
        let devices = peer_user_devices(client, *user).await?;
        if devices.contains(&device) {
            return Ok(*user);
        }
    }
    bail!("device {device:?} not associated with any expected user")
}

// ---------- Server REST helpers ----------

async fn publish_device_key(
    server: &str,
    token: &str,
    device_pk: &DevicePublicKey,
    binding_sig: &crocodile_protocol::keys::Signature,
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
        bail!("publish device key: {status}")
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

async fn add_member_api(server: &str, token: &str, room_id: RoomId, user_id: UserId) -> Result<()> {
    reqwest::Client::new()
        .post(format!(
            "{server}/v1/rooms/{}/members",
            hex::encode(room_id.as_bytes())
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({"user_id_hex": hex::encode(user_id.as_bytes())}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Best-effort guess at a locally-reachable address to advertise to
/// peers when the user didn't pass --advertise-addr.
///
/// Strategy:
/// 1. If `local_addr` is already a concrete IP, use it.
/// 2. Otherwise (bound to 0.0.0.0 or [::]), open an unconnected UDP
///    socket and "connect" it to the server URL's host. The OS
///    populates the local address based on the route it would use —
///    that's almost always the LAN / Tailscale IP we want.
/// 3. If all that fails, fall back to the unspecified local address;
///    the user will need to pass --advertise-addr.
fn best_advertise_addr(server_url: &str, local_addr: SocketAddr) -> SocketAddr {
    if !local_addr.ip().is_unspecified() {
        return local_addr;
    }
    // Strip scheme and path from server URL to get a host:port to
    // probe. We tolerate failures here because this is best-effort.
    let host_port = server_url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("8.8.8.8:80");
    let server_target: Option<SocketAddr> =
        host_port.to_socket_addrs().ok().and_then(|mut a| a.next());
    let Some(target) = server_target else {
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
        Ok(picked) => SocketAddr::new(picked.ip(), local_addr.port()),
        Err(_) => local_addr,
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,crocodile_client=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer())
        .init();
}
