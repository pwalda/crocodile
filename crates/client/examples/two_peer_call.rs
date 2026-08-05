//! Two-peer voice call demo.
//!
//! Wires together the milestone 1–4A pieces into a runnable voice call.
//! See `README.md` in the repo root for setup, networking notes, and
//! the meaningful limitations (no host election yet, no TURN fallback,
//! mostly-LAN-tested).
//!
//! Usage:
//!
//! ```text
//! # First peer (host), creates a room and invites the second peer:
//! cargo run --example two_peer_call -- \
//!     --server http://1.2.3.4:8080 \
//!     --username alice --password somepw \
//!     --state-dir ./crocodile-alice \
//!     host --invite-user-id <bob-user-id-hex>
//!
//! # Second peer (joiner), needs the room id printed by alice:
//! cargo run --example two_peer_call -- \
//!     --server http://1.2.3.4:8080 \
//!     --username bob --password otherpw \
//!     --state-dir ./crocodile-bob \
//!     join --room-id <room-id-hex>
//! ```
//!
//! The two binaries each print their user id on startup so the other
//! side can paste it. After the call connects, Ctrl-C to hang up.

use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use openmls_rust_crypto::OpenMlsRustCrypto;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crocodile_protocol::envelope::SignedServerStatement;
use crocodile_protocol::ids::{DeviceId, RoomId, UserId};
use crocodile_protocol::keys::{
    device_id_from_public_key, user_id_from_public_key, DeviceKeypair, DevicePublicKey,
    IdentityKeypair, IdentityPublicKey,
};
use crocodile_protocol::mls::MlsWelcome;
use crocodile_protocol::signaling::{
    CacheableServerStatement, RoomMember, SignalingClientFrame, SignalingServerFrame,
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

// ---------- App-layer signaling (inside opaque relay payloads) ----------

#[derive(Debug, Serialize, Deserialize)]
enum AppSignal {
    /// Joiner → host: my key package; please add me to the MLS group.
    KeyPackage(Vec<u8>),
    /// Host → joiner: here's the MLS Welcome — apply to join.
    Welcome(Vec<u8>),
    /// Either direction: my UDP address for the QUIC peer link.
    Address(SocketAddr),
    /// Either direction: my QUIC device pubkey (so the recipient can
    /// pin it in the TLS verifier). 32 raw bytes.
    DevicePublicKey([u8; 32]),
    /// Sent after all setup is done. Joiner waits for this before
    /// dialing.
    Ready,
}

// ---------- CLI ----------

#[derive(Debug)]
struct Args {
    server: String,
    username: String,
    password: String,
    state_dir: PathBuf,
    /// UDP address this peer's QUIC endpoint should bind to. Defaults
    /// to `0.0.0.0:0` (ephemeral).
    bind_addr: SocketAddr,
    /// What we advertise as our reachable address. Defaults to the
    /// bound address; LAN works naturally, internet usually needs an
    /// explicit override (port-forward'd public IP or Tailscale).
    advertise_addr: Option<SocketAddr>,
    mode: Mode,
}

#[derive(Debug)]
enum Mode {
    /// Create a room, add the invitee, wait for them. Either
    /// invite_user_id or invite_username must be set; if username,
    /// we resolve it server-side at startup.
    Host {
        invite_user_id: Option<UserId>,
        invite_username: Option<String>,
    },
    /// Join an existing room you've already been added to.
    Join { room_id: RoomId },
    /// Just print our user_id / device_id and exit. Useful for the
    /// out-of-band exchange before the host adds you to a room.
    PrintId,
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
    let mut invite_user_id: Option<UserId> = None;
    let mut invite_username: Option<String> = None;
    let mut room_id: Option<RoomId> = None;

    let mut i = 0;
    while i < raw.len() {
        let arg = &raw[i];
        match arg.as_str() {
            "--server" => {
                server = Some(
                    raw.get(i + 1)
                        .cloned()
                        .context("missing value for --server")?,
                );
                i += 2;
            }
            "--username" => {
                username = Some(
                    raw.get(i + 1)
                        .cloned()
                        .context("missing value for --username")?,
                );
                i += 2;
            }
            "--password" => {
                password = Some(
                    raw.get(i + 1)
                        .cloned()
                        .context("missing value for --password")?,
                );
                i += 2;
            }
            "--state-dir" => {
                state_dir = Some(PathBuf::from(
                    raw.get(i + 1).cloned().context("--state-dir")?,
                ));
                i += 2;
            }
            "--bind-addr" => {
                bind_addr = raw
                    .get(i + 1)
                    .context("missing --bind-addr value")?
                    .parse()
                    .context("invalid --bind-addr")?;
                i += 2;
            }
            "--advertise-addr" => {
                advertise_addr = Some(
                    raw.get(i + 1)
                        .context("missing --advertise-addr value")?
                        .parse()
                        .context("invalid --advertise-addr")?,
                );
                i += 2;
            }
            "--invite-user-id" => {
                let s = raw.get(i + 1).context("missing --invite-user-id value")?;
                let bytes: [u8; 32] = hex::decode(s)
                    .context("invalid --invite-user-id hex")?
                    .try_into()
                    .map_err(|_| anyhow!("--invite-user-id must be 32 bytes"))?;
                invite_user_id = Some(UserId::from_bytes(bytes));
                i += 2;
            }
            "--invite-username" => {
                invite_username = Some(
                    raw.get(i + 1)
                        .cloned()
                        .context("missing --invite-username value")?,
                );
                i += 2;
            }
            "--room-id" => {
                let s = raw.get(i + 1).context("missing --room-id value")?;
                let bytes: [u8; 32] = hex::decode(s)
                    .context("invalid --room-id hex")?
                    .try_into()
                    .map_err(|_| anyhow!("--room-id must be 32 bytes"))?;
                room_id = Some(RoomId::from_bytes(bytes));
                i += 2;
            }
            "host" | "join" | "print-id" => {
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
            if invite_user_id.is_none() && invite_username.is_none() {
                bail!("host mode requires --invite-user-id or --invite-username");
            }
            Mode::Host {
                invite_user_id,
                invite_username,
            }
        }
        Some("join") => Mode::Join {
            room_id: room_id.context("join mode requires --room-id")?,
        },
        Some("print-id") => Mode::PrintId,
        _ => bail!("must specify a subcommand: host, join, or print-id"),
    };

    // print-id is the only subcommand that does not need server /
    // username / password — the identity comes purely from
    // --state-dir. Defaulting them keeps the constructor honest.
    let server = match &mode {
        Mode::PrintId => server.unwrap_or_default(),
        _ => server.context("--server required")?,
    };
    let username = match &mode {
        Mode::PrintId => username.unwrap_or_default(),
        _ => username.context("--username required")?,
    };
    let password = match &mode {
        Mode::PrintId => password.unwrap_or_default(),
        _ => password.context("--password required")?,
    };

    Ok(Args {
        server,
        username,
        password,
        state_dir: state_dir.context("--state-dir required")?,
        bind_addr,
        advertise_addr,
        mode,
    })
}

fn print_help() {
    eprintln!("usage:");
    eprintln!("  two_peer_call --state-dir D print-id");
    eprintln!("  two_peer_call --server URL --username U --password P --state-dir D [--bind-addr ADDR] [--advertise-addr ADDR] host (--invite-user-id HEX | --invite-username NAME)");
    eprintln!("  two_peer_call --server URL --username U --password P --state-dir D [--bind-addr ADDR] [--advertise-addr ADDR] join --room-id HEX");
}

// ---------- Persisted state ----------

#[derive(Debug, Serialize, Deserialize)]
struct PersistedKeys {
    identity_seed_hex: String,
    device_seed_hex: String,
}

fn load_or_create_keys(state_dir: &PathBuf) -> Result<(IdentityKeypair, DeviceKeypair)> {
    std::fs::create_dir_all(state_dir).context("create state_dir")?;
    let path = state_dir.join("keys.json");
    if let Ok(bytes) = std::fs::read(&path) {
        let p: PersistedKeys = serde_json::from_slice(&bytes).context("decode keys")?;
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
        let p = PersistedKeys {
            identity_seed_hex: hex::encode(identity_seed),
            device_seed_hex: hex::encode(device_seed),
        };
        std::fs::write(&path, serde_json::to_vec_pretty(&p)?).context("write keys")?;
        Ok((
            IdentityKeypair::from_seed(identity_seed),
            DeviceKeypair::from_seed(device_seed),
        ))
    }
}

// ---------- Helpers for relayed signaling ----------

async fn send_app_signal(sig: &SignalingChannel, to: DeviceId, msg: &AppSignal) -> Result<()> {
    let payload = postcard::to_stdvec(msg)?;
    sig.send(SignalingClientFrame::Relay { to, payload })?;
    Ok(())
}

async fn recv_app_signal_from(sig: &mut SignalingChannel, expected: DeviceId) -> Result<AppSignal> {
    loop {
        let frame = sig
            .recv()
            .await
            .ok_or_else(|| anyhow!("signaling channel closed"))?;
        match frame {
            SignalingServerFrame::Delivered { from, payload } if from == expected => {
                let msg: AppSignal = postcard::from_bytes(&payload)?;
                return Ok(msg);
            }
            SignalingServerFrame::Delivered { from, .. } => {
                tracing::debug!(?from, "ignoring frame from unexpected peer");
            }
            SignalingServerFrame::UnreachableRecipient { target } => {
                tracing::warn!(?target, "previous relay was unreachable");
            }
            SignalingServerFrame::Error { message } => {
                bail!("signaling error: {message}");
            }
            SignalingServerFrame::Welcome { .. } => {
                tracing::debug!("welcome (re-)received; ignoring");
            }
            _ => {}
        }
    }
}

// ---------- Resolving peer device id ----------

/// Look up the peer's online device id via room state. Polls until at
/// least one device for the peer user shows up online.
async fn wait_for_peer_device(
    client: &CoordinationClient,
    room_id: RoomId,
    session_token: &str,
    peer_user: UserId,
    self_device: DeviceId,
) -> Result<DeviceId> {
    // Force re-fetch by skipping cache: open a tmp cache so the first
    // call always pulls fresh.
    loop {
        // Build a transient client per poll so the cache doesn't hold
        // a stale RoomState. In production we'd add a force-refresh
        // method; for the demo this is the cheaper option.
        let tmp_cache = Cache::open_in_memory().await?;
        let pinned = *client.pinned_pubkey();
        let tmp = CoordinationClient::new(client.base_url().to_string(), tmp_cache, pinned);
        let stmt: SignedServerStatement<CacheableServerStatement> = tmp
            .room_state(room_id, session_token, UnixSeconds::now())
            .await?;
        if let CacheableServerStatement::RoomState {
            peer_hints,
            members,
            ..
        } = &stmt.payload
        {
            // Find a hint whose owner is our peer user.
            let peer_account_devices: Vec<DeviceId> = peer_hints
                .iter()
                .filter(|h| h.device != self_device)
                .map(|h| h.device)
                .collect();

            // We need to confirm the device belongs to peer_user. The
            // RoomState gives us a member list (with user info) but
            // not a device→user mapping. Cross-check by fetching
            // the peer's keystore.
            if !peer_account_devices.is_empty() && member_present(members, peer_user) {
                let peer_devices = peer_user_devices(&tmp, peer_user).await?;
                for d in &peer_account_devices {
                    if peer_devices.contains(d) {
                        return Ok(*d);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
}

fn member_present(members: &[RoomMember], target: UserId) -> bool {
    members.iter().any(|m| m.user == target)
}

async fn peer_user_devices(client: &CoordinationClient, user: UserId) -> Result<Vec<DeviceId>> {
    let stmt: SignedServerStatement<CacheableServerStatement> =
        client.user_keys(user, UnixSeconds::now()).await?;
    match stmt.payload {
        CacheableServerStatement::UserKeys { devices, .. } => Ok(devices
            .into_iter()
            .map(|b| device_id_from_public_key(&b.device_public_key))
            .collect()),
        _ => Ok(vec![]),
    }
}

// ---------- Voice loop ----------

// The demo passes plenty of state; clippy's complaint is fair in the
// general case but we'd rather keep this binary readable as a single
// straight-line function than introduce a packed struct just for the
// signature.
#[allow(clippy::too_many_arguments)]
async fn run_call(
    conn: quinn::Connection,
    group: Group,
    provider: std::sync::Arc<OpenMlsRustCrypto>,
    mls_identity: std::sync::Arc<Identity>,
    role: Role,
    room_id: crocodile_protocol::ids::RoomId,
    my_device_id: DeviceId,
    history: TextHistory,
) -> Result<()> {
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (encoded_tx, mut encoded_rx) = mpsc::unbounded_channel::<(u32, Vec<u8>)>();
    let (inbound_decoded_tx, mut inbound_decoded_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let playback_queue = PlaybackQueue::new();

    // Open cpal capture + playback. Streams must stay alive for the
    // call's duration.
    let _cap_stream = capture::open_default(capture_tx)?;
    let _play_stream = playback::open_default(playback_queue.clone())?;
    tracing::info!("audio devices opened");

    // Encoder task: f32 → 20ms frames of i16 → Opus.
    let encode_handle = tokio::spawn(async move {
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
                match enc.encode_frame(&pcm_i16) {
                    Ok(encoded) => {
                        if encoded_tx.send((seq, encoded)).is_err() {
                            return;
                        }
                        seq = seq.wrapping_add(1);
                    }
                    Err(e) => tracing::warn!(error = %e, "encode failed; dropping frame"),
                }
            }
        }
    });

    // Group state is locked across encrypt/decrypt to serialise epoch
    // advances. OpenMlsRustCrypto isn't Clone — share via Arc.
    let group_handle = std::sync::Arc::new(tokio::sync::Mutex::new(group));

    // Sender task: take encoded frames, MLS-encrypt, send QUIC datagram.
    let conn_send = conn.clone();
    let provider_send = provider.clone();
    let identity_send = mls_identity.clone();
    let group_for_send = group_handle.clone();
    let send_handle = tokio::spawn(async move {
        while let Some((seq, opus_bytes)) = encoded_rx.recv().await {
            let frame = {
                let mut g = group_for_send.lock().await;
                let epoch = g.epoch();
                let ct = match g.encrypt(&provider_send, &identity_send, &opus_bytes) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(error = %e, "MLS encrypt failed; dropping");
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
            let bytes = match postcard::to_stdvec(&frame) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(error = %e, "postcard encode failed; dropping");
                    continue;
                }
            };
            if let Err(e) = conn_send.send_datagram(bytes.into()) {
                tracing::warn!(error = %e, "datagram send failed");
                break;
            }
        }
    });

    // Receiver task: read datagrams, MLS-decrypt, push through jitter,
    // forward Opus bytes to the decoder.
    let conn_recv = conn.clone();
    let provider_recv = provider.clone();
    let group_for_recv = group_handle.clone();
    let recv_handle = tokio::spawn(async move {
        let mut jb = JitterBuffer::default();
        loop {
            let bytes = match conn_recv.read_datagram().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::info!(error = %e, "datagram read ended");
                    break;
                }
            };
            let frame: VoiceFrame = match postcard::from_bytes(&bytes) {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!(error = %e, "voice frame decode failed");
                    continue;
                }
            };
            let plaintext = {
                let mut g = group_for_recv.lock().await;
                match g.decrypt(&provider_recv, &frame.ciphertext) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "MLS decrypt failed");
                        continue;
                    }
                }
            };
            jb.push(frame.frame_seq, plaintext);
            while let Some(opus_bytes) = jb.pop() {
                if inbound_decoded_tx.send(opus_bytes).is_err() {
                    return;
                }
            }
        }
    });

    // Decoder + playback task.
    let pq = playback_queue.clone();
    let decode_handle = tokio::spawn(async move {
        let mut dec = match OpusDecoder::new() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!(error = %e, "opus decoder init failed");
                return;
            }
        };
        while let Some(opus_bytes) = inbound_decoded_rx.recv().await {
            match dec.decode_frame(Some(&opus_bytes)) {
                Ok(pcm_i16) => {
                    let pcm_f32 = i16_to_f32(&pcm_i16);
                    pq.push(&pcm_f32);
                }
                Err(e) => tracing::warn!(error = %e, "decode failed"),
            }
        }
    });

    // ---- Text channel ----
    //
    // Reliable bi-directional QUIC stream. Joiner opens; host accepts.
    let (mut text_send, mut text_recv) = match role {
        Role::Joiner => conn.open_bi().await.map_err(|e| anyhow!("open_bi: {e}"))?,
        Role::Host => conn
            .accept_bi()
            .await
            .map_err(|e| anyhow!("accept_bi: {e}"))?,
    };
    tracing::info!("text stream established");

    // The first thing we send on the stream is a 1-byte sentinel so
    // accept_bi returns on the host. Without an initial write, quinn
    // won't surface the stream to accept_bi.
    text_send
        .write_all(&[0u8])
        .await
        .map_err(|e| anyhow!("text send init: {e}"))?;
    // Drain the matching sentinel from the peer.
    {
        let mut hello = [0u8; 1];
        text_recv
            .read_exact(&mut hello)
            .await
            .map_err(|e| anyhow!("text recv init: {e}"))?;
    }

    // Start sender state from the latest stored head for this room.
    let local_head = history
        .most_recent(room_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.own_hash);
    let mut text_sender = TextSender::new(room_id, my_device_id, local_head);
    let text_receiver = TextReceiver::new(room_id);

    let group_for_text_send = group_handle.clone();
    let provider_for_text_send = provider.clone();
    let identity_for_text_send = mls_identity.clone();
    let history_for_send = history.clone();
    let text_send_handle = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        println!("Type messages and press Enter. Ctrl-C to hang up.");
        while let Ok(Some(line)) = reader.next_line().await {
            if line.is_empty() {
                continue;
            }
            let now = UnixSeconds::now();
            let payload_bytes = match text_sender.encode_payload(&line, now, None) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(error = %e, "encode text failed");
                    continue;
                }
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
                    Err(e) => {
                        tracing::warn!(error = %e, "MLS encrypt text failed");
                        continue;
                    }
                };
                text_sender.finalize(epoch, ct, now, None, line.clone())
            };
            let bytes = match postcard::to_stdvec(&wire) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(error = %e, "postcard text encode failed");
                    continue;
                }
            };
            // Length-prefix framing: 4-byte big-endian length, then payload.
            let len = bytes.len() as u32;
            if text_send.write_all(&len.to_be_bytes()).await.is_err() {
                break;
            }
            if text_send.write_all(&bytes).await.is_err() {
                break;
            }
            // Local echo via history; no stdout echo to avoid double-display.
            if let Err(e) = history_for_send.store(&stored).await {
                tracing::warn!(error = %e, "store sent text failed");
            }
        }
    });

    let group_for_text_recv = group_handle.clone();
    let provider_for_text_recv = provider.clone();
    let history_for_recv = history.clone();
    let recv_room = room_id;
    let text_recv_handle = tokio::spawn(async move {
        loop {
            let mut len_buf = [0u8; 4];
            if text_recv.read_exact(&mut len_buf).await.is_err() {
                break;
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            if len > 1024 * 1024 {
                tracing::warn!(len, "text frame too large; closing");
                break;
            }
            let mut payload = vec![0u8; len];
            if text_recv.read_exact(&mut payload).await.is_err() {
                break;
            }
            let wire: crocodile_protocol::text::TextMessage = match postcard::from_bytes(&payload) {
                Ok(w) => w,
                Err(e) => {
                    tracing::warn!(error = %e, "text wire decode failed");
                    continue;
                }
            };
            let plaintext = {
                let mut g = group_for_text_recv.lock().await;
                match g.decrypt(&provider_for_text_recv, &wire.ciphertext) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(error = %e, "MLS decrypt text failed");
                        continue;
                    }
                }
            };
            // Receiver-side sequence: count what we have from this
            // sender already and use that as the seq. Not ideal long-term
            // (race on concurrent receives) but fine for two-peer demo.
            // Receiver-side sequence is just "total messages stored in
            // this room so far" — fine for the 2-peer demo since
            // there's only one remote sender; M9 will replace this
            // with proper per-sender counters tracked locally.
            let sender_seq = history_for_recv
                .count_for_room(recv_room)
                .await
                .unwrap_or(0);
            let stored =
                match text_receiver.decode(&wire, &plaintext, sender_seq, UnixSeconds::now()) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(error = %e, "text decode failed");
                        continue;
                    }
                };
            println!(
                "[{}]: {}",
                hex::encode(&stored.sender_device.as_bytes()[..4]),
                stored.body
            );
            if let Err(e) = history_for_recv.store(&stored).await {
                tracing::warn!(error = %e, "store recv text failed");
            }
        }
    });

    // Wait for any task to exit (e.g. on Ctrl-C the QUIC connection is
    // dropped and the receiver task ends, which cascades).
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("ctrl-c received; closing");
        }
        _ = encode_handle => {}
        _ = send_handle => {}
        _ = recv_handle => {}
        _ = decode_handle => {}
        _ = text_send_handle => {}
        _ = text_recv_handle => {}
    }

    conn.close(0u32.into(), b"hangup");
    Ok(())
}

// ---------- Main orchestration ----------

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let args = parse_args()?;

    // Identity + device keys.
    let (identity_kp, device_kp) = load_or_create_keys(&args.state_dir)?;
    let identity_pk: IdentityPublicKey = identity_kp.public_key();
    let device_pk: DevicePublicKey = device_kp.public_key();
    let my_user_id = user_id_from_public_key(&identity_pk);
    let my_device_id = device_id_from_public_key(&device_pk);
    println!("My user_id:   {}", hex::encode(my_user_id.as_bytes()));
    println!("My device_id: {}", hex::encode(my_device_id.as_bytes()));

    if matches!(args.mode, Mode::PrintId) {
        // Identity bytes were the only thing the caller wanted; we are
        // done.
        return Ok(());
    }

    // Server pubkey via /v1/server/info (TOFU).
    let info: ServerInfo = CoordinationClient::server_info(&args.server).await?;
    let server_ipk_bytes: [u8; 32] = hex::decode(&info.identity_public_key_hex)?
        .try_into()
        .map_err(|_| anyhow!("server identity_public_key_hex must be 32 bytes"))?;
    let server_pubkey = IdentityPublicKey(server_ipk_bytes);

    let cache = Cache::open(&args.state_dir.join("cache.sqlite")).await?;
    let client = CoordinationClient::new(args.server.clone(), cache.clone(), server_pubkey);

    // Signup-or-login. If the username is taken we just attempt login;
    // the demo assumes you re-use the same password across runs.
    match client
        .create_account(&args.username, &args.password, &identity_pk)
        .await
    {
        Ok(uid) => println!("Signed up as {uid}"),
        Err(crocodile_client::ClientError::ServerStatus { status: 409, .. }) => {
            println!("Account exists; logging in.");
        }
        Err(e) => return Err(e.into()),
    }
    let login = client.login(&args.username, &args.password).await?;
    let token = login.session_token;

    // Publish device key (idempotent on the server via upsert).
    let binding_input = {
        let mut v = Vec::with_capacity(64);
        v.extend_from_slice(my_user_id.as_bytes());
        v.extend_from_slice(&device_pk.0);
        v
    };
    let binding_sig = identity_kp.sign(&binding_input);
    publish_device_key(&args.server, &token, &device_pk, &binding_sig).await?;

    // Open signaling.
    let mut sig = SignalingChannel::connect(&args.server, &token, my_device_id).await?;
    println!("Signaling connected. Server id: {}", sig.server_id());

    // Resolve room + peer user.
    let (room_id, peer_user, role) = match &args.mode {
        Mode::Host {
            invite_user_id,
            invite_username,
        } => {
            // Resolve invitee user_id. Prefer the explicit hex form if
            // both happen to be set.
            let invitee: UserId = if let Some(uid) = invite_user_id {
                *uid
            } else if let Some(name) = invite_username {
                let hex = client
                    .lookup_username(name)
                    .await
                    .with_context(|| format!("looking up username {name:?}"))?;
                let bytes: [u8; 32] = hex::decode(&hex)
                    .context("server returned bad user_id hex")?
                    .try_into()
                    .map_err(|_| anyhow!("server returned non-32-byte user_id"))?;
                UserId::from_bytes(bytes)
            } else {
                // parse_args enforces that one is set; this arm is for the
                // compiler.
                bail!("host mode requires --invite-user-id or --invite-username")
            };

            let room_id = create_room(&args.server, &token, &args.username).await?;
            add_member(&args.server, &token, room_id, invitee).await?;
            println!(
                "Created room. Share this id with the peer:\n  ROOM_ID: {}",
                hex::encode(room_id.as_bytes())
            );
            (room_id, invitee, Role::Host)
        }
        Mode::Join { room_id } => {
            // Joiner doesn't know peer_user yet; resolve from RoomState
            // by picking the member who isn't us.
            let tmp_cache = Cache::open_in_memory().await?;
            let tmp_client = CoordinationClient::new(args.server.clone(), tmp_cache, server_pubkey);
            let stmt = tmp_client
                .room_state(*room_id, &token, UnixSeconds::now())
                .await?;
            let peer = match &stmt.payload {
                CacheableServerStatement::RoomState { members, .. } => {
                    members
                        .iter()
                        .find(|m| m.user != my_user_id)
                        .ok_or_else(|| anyhow!("no peer member in room"))?
                        .user
                }
                _ => bail!("unexpected room state payload"),
            };
            (*room_id, peer, Role::Joiner)
        }
        // PrintId is handled earlier with an early return; the
        // compiler can't see that, hence this unreachable arm.
        Mode::PrintId => unreachable!("print-id exits before this point"),
    };

    println!("Waiting for peer to come online...");
    let peer_device =
        wait_for_peer_device(&client, room_id, &token, peer_user, my_device_id).await?;
    println!(
        "Peer device discovered: {}",
        hex::encode(peer_device.as_bytes())
    );

    // Bind the QUIC endpoint and figure out our advertised address.
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

    // Fetch peer's device public key — needed for the QUIC TLS
    // verifier — from their keystore.
    let peer_keys = client.user_keys(peer_user, UnixSeconds::now()).await?;
    let peer_device_pk = match peer_keys.payload {
        CacheableServerStatement::UserKeys { devices, .. } => devices
            .into_iter()
            .find(|b| device_id_from_public_key(&b.device_public_key) == peer_device)
            .map(|b| b.device_public_key)
            .ok_or_else(|| anyhow!("peer device pubkey not in keystore"))?,
        _ => bail!("unexpected keystore payload"),
    };

    // Spin up MLS + run the peer-to-peer signaling dance.
    let provider = std::sync::Arc::new(OpenMlsRustCrypto::default());
    let mls_identity = std::sync::Arc::new(
        Identity::generate(my_device_id, &provider).map_err(|e| anyhow!("mls identity: {e}"))?,
    );

    let (group, peer_addr) = match role {
        Role::Host => host_signaling_dance(
            &mut sig,
            peer_device,
            advertise,
            device_pk,
            &provider,
            &mls_identity,
            room_id,
        )
        .await
        .context("host signaling dance")?,
        Role::Joiner => joiner_signaling_dance(
            &mut sig,
            peer_device,
            advertise,
            device_pk,
            &provider,
            &mls_identity,
        )
        .await
        .context("joiner signaling dance")?,
    };

    // QUIC connection.
    println!("Establishing QUIC link to {peer_addr}...");
    let conn = match role {
        Role::Host => {
            // Host accepts.
            let incoming = endpoint
                .accept()
                .await
                .ok_or_else(|| anyhow!("endpoint closed before accept"))?;
            tokio::time::timeout(Duration::from_secs(15), incoming)
                .await
                .context("QUIC accept timeout")?
                .map_err(|e| anyhow!("QUIC accept failed: {e}"))?
        }
        Role::Joiner => endpoint.connect(peer_addr, peer_device_pk).await?,
    };
    println!("QUIC connected. Voice flowing. Press Ctrl-C to hang up.");

    // Open local text history (SQLite-backed) under the state dir.
    let history = TextHistory::open(&args.state_dir.join("history.sqlite")).await?;

    run_call(
        conn,
        group,
        provider,
        mls_identity,
        role,
        room_id,
        my_device_id,
        history,
    )
    .await?;

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Host,
    Joiner,
}

async fn host_signaling_dance(
    sig: &mut SignalingChannel,
    peer_device: DeviceId,
    advertise: SocketAddr,
    device_pk: DevicePublicKey,
    provider: &OpenMlsRustCrypto,
    mls_identity: &Identity,
    room_id: RoomId,
) -> Result<(Group, SocketAddr)> {
    // Host creates the MLS group up front.
    let mut group = Group::create(provider, mls_identity, room_id.as_bytes())
        .map_err(|e| anyhow!("mls create group: {e}"))?;

    // Announce our device pubkey + listening address first.
    send_app_signal(sig, peer_device, &AppSignal::DevicePublicKey(device_pk.0)).await?;
    send_app_signal(sig, peer_device, &AppSignal::Address(advertise)).await?;

    // Receive the joiner's key package.
    let kp_bytes = loop {
        match recv_app_signal_from(sig, peer_device).await? {
            AppSignal::KeyPackage(b) => break b,
            other => tracing::debug!(?other, "ignoring non-KP signal during host dance"),
        }
    };

    let kp = KeyPackage::from_bytes(&kp_bytes, provider).map_err(|e| anyhow!("kp parse: {e}"))?;
    let outcome = group
        .add_member(provider, mls_identity, kp)
        .map_err(|e| anyhow!("add_member: {e}"))?;
    send_app_signal(
        sig,
        peer_device,
        &AppSignal::Welcome(outcome.welcome.0.clone()),
    )
    .await?;
    send_app_signal(sig, peer_device, &AppSignal::Ready).await?;

    // Joiner sends us their address.
    let peer_addr = loop {
        match recv_app_signal_from(sig, peer_device).await? {
            AppSignal::Address(a) => break a,
            other => tracing::debug!(?other, "ignoring while waiting for joiner address"),
        }
    };
    Ok((group, peer_addr))
}

async fn joiner_signaling_dance(
    sig: &mut SignalingChannel,
    peer_device: DeviceId,
    advertise: SocketAddr,
    device_pk: DevicePublicKey,
    provider: &OpenMlsRustCrypto,
    mls_identity: &Identity,
) -> Result<(Group, SocketAddr)> {
    // Generate and send a key package.
    let kp =
        KeyPackage::generate(mls_identity, provider).map_err(|e| anyhow!("kp generate: {e}"))?;
    send_app_signal(sig, peer_device, &AppSignal::DevicePublicKey(device_pk.0)).await?;
    send_app_signal(
        sig,
        peer_device,
        &AppSignal::KeyPackage(kp.as_bytes().to_vec()),
    )
    .await?;

    // Receive the welcome + host's address (any order).
    let mut welcome_bytes: Option<Vec<u8>> = None;
    let mut peer_addr: Option<SocketAddr> = None;
    let mut ready = false;
    while welcome_bytes.is_none() || peer_addr.is_none() || !ready {
        match recv_app_signal_from(sig, peer_device).await? {
            AppSignal::Welcome(b) => welcome_bytes = Some(b),
            AppSignal::Address(a) => peer_addr = Some(a),
            AppSignal::Ready => ready = true,
            other => tracing::debug!(?other, "ignoring during joiner dance"),
        }
    }

    let welcome = MlsWelcome(welcome_bytes.unwrap());
    let group = Group::join_from_welcome(provider, mls_identity, &welcome)
        .map_err(|e| anyhow!("mls join: {e}"))?;

    // Now send our own address.
    send_app_signal(sig, peer_device, &AppSignal::Address(advertise)).await?;

    Ok((group, peer_addr.unwrap()))
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
        let body = resp.text().await.unwrap_or_default();
        bail!("publish device key failed: {status} {body}")
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
        .map_err(|_| anyhow!("room_id must be 32 bytes"))?;
    Ok(RoomId::from_bytes(bytes))
}

async fn add_member(server: &str, token: &str, room_id: RoomId, user_id: UserId) -> Result<()> {
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

/// Best-effort local-IP detection for advertising. Same logic as in
/// the group_call example — keeping these inline (rather than in a
/// shared module) until we settle on a stable demo helpers API.
fn best_advertise_addr(server_url: &str, local_addr: SocketAddr) -> SocketAddr {
    if !local_addr.ip().is_unspecified() {
        return local_addr;
    }
    let host_port = server_url
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
