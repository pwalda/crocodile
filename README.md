# Crocodile

Working name for a federated, peer-meshed voice + text communication platform. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

This README covers how to actually run the **two-peer voice call demo** — the milestone-4 deliverable. It's a runnable proof that the protocol crate, the coordination server, the client networking foundation, and MLS all compose end-to-end through real audio capture, encryption, QUIC transport, decryption, and playback.

---

## What works today

- One coordination server hosting accounts, room metadata, signed keystore responses (48 h TTL), and a WebSocket signaling relay.
- Two desktop clients can sign up / log in, exchange MLS key packages over the signaling relay, establish a direct QUIC connection (pubkey-pinned TLS, no web PKI), and exchange MLS-encrypted Opus voice frames.
- Audio: 48 kHz mono, Opus at 32 kbps, 20 ms frames, 100 ms jitter buffer.

## What does not work yet

- **General-internet NAT traversal.** No TURN fallback, no ICE candidate prioritisation. If both peers are behind symmetric NATs, the call will fail. UDP hole punching works between two open / moderate NATs. Use Tailscale or a LAN if internet doesn't cooperate (see below).
- **Three or more peers in a call.** Host election + fan-out lands in milestone 5.
- **Audio device selection.** Defaults to the OS default input/output. Adjust those in your OS sound settings before launching.
- **Reconnection.** If the QUIC link drops, the call ends. Restart both binaries.
- **History, text chat, persistent MLS state.** Coming in milestones 7–9.

---

## Setup

You need the workspace built (Rust 1.95 toolchain, automatically pulled by `rust-toolchain.toml`) and a reachable coordination server.

### 1. Prerequisites on the machine running the coordination server

```bash
# macOS: install CMake (audiopus_sys' bundled libopus needs it for the
# initial libopus compile in clients; the server itself doesn't).
brew install cmake

# Docker Desktop / OrbStack for Postgres.
docker compose up -d   # starts Postgres on :5432

# First-time build (this takes a while; it's compiling rustls, quinn,
# openmls, sqlx, libopus, ...).
cargo build --release
```

### 2. Run the coordination server

```bash
DATABASE_URL=postgres://crocodile:crocodile_dev@localhost:5432/crocodile \
    cargo run --release --bin crocodile-server
```

It listens on `127.0.0.1:8080` by default. Override with `BIND_ADDR=0.0.0.0:8080` to accept connections from other machines.

If you want your friend to reach this server from outside your LAN, options in order of effort:
- **Tailscale (recommended for first try).** Install on both machines, run the server with `BIND_ADDR=0.0.0.0:8080`, give your friend your Tailscale IP. No router config, no public exposure.
- **Same LAN.** Run with `BIND_ADDR=0.0.0.0:8080`, share your LAN IP.
- **Public IP + port forward.** Forward 8080/tcp on your router to your machine. Note that the **voice traffic also goes peer-to-peer**, so each peer also needs to be reachable on its QUIC UDP port (more below).

### 3. Make sure both peers can reach each other for QUIC

The QUIC voice link is peer-to-peer over UDP. The default `--bind-addr 0.0.0.0:0` picks an ephemeral port. For the call to work you both need to be reachable at the addresses you advertise to each other. The simplest configurations:

- **Tailscale.** Pass `--bind-addr <your-tailscale-ip>:0 --advertise-addr <your-tailscale-ip>:<port>` if needed. The `:0` lets the OS pick a port; the demo prints it after binding.
- **Same LAN.** Default `--bind-addr 0.0.0.0:0` is fine; the OS-assigned port and LAN IP get advertised over signaling.
- **Public internet without Tailscale.** Pick a fixed UDP port, forward it, advertise your public IP: `--bind-addr 0.0.0.0:7000 --advertise-addr <your-public-ip>:7000`.

---

## Running the two-peer call

Each peer runs `cargo run --release --example two_peer_call` with their own state directory, username, and password.

### One-time: share these out of band

You'll exchange two short hex strings with your friend (paste over chat, email, whatever):

1. Each of you starts the binary once in **either** mode to learn your `user_id`. The binary prints it before doing any real work. Hit Ctrl-C after copying.
2. The **host** peer (whoever creates the room) needs the **joiner's `user_id`**.
3. The **host** runs in `host` mode, which creates the room and adds the joiner. It prints the `ROOM_ID`.
4. The **joiner** uses that `ROOM_ID` and runs in `join` mode.

### Host side

```bash
cargo run --release --example two_peer_call -- \
    --server http://<server-addr>:8080 \
    --username alice \
    --password somethinglongerthan8 \
    --state-dir ./state-alice \
    host --invite-user-id <bob-user-id-hex>
```

Output will look like:

```
My user_id:   3f...
My device_id: 7a...
Signed up as 3f...
Signaling connected. Server id: ...
Created room. Share this id with the peer:
  ROOM_ID: deadbeef...
Waiting for peer to come online...
```

Share the `ROOM_ID` with your friend.

### Joiner side

```bash
cargo run --release --example two_peer_call -- \
    --server http://<server-addr>:8080 \
    --username bob \
    --password somethinglongerthan8 \
    --state-dir ./state-bob \
    join --room-id <room-id-hex-from-alice>
```

Within a second or two both binaries should print `QUIC connected. Voice flowing. Press Ctrl-C to hang up.` and you'll hear each other.

Ctrl-C on either side ends the call. Either peer can restart and re-do the dance.

---

## How it actually flows (so you can debug)

```
[ alice runs --host ]                            [ bob runs --join ]
       │                                                  │
       │   POST /v1/accounts (if first run)               │
       │   POST /v1/sessions      (login)                 │
       │   POST /v1/devices       (publish device key)    │
       │   GET  /v1/server/info   (TOFU pin)              │
       │                                                  │
       │   POST /v1/rooms         (create)                │
       │   POST /v1/rooms/{id}/members (add bob)          │
       │                                                  │
       ├──── WS /v1/signaling ────────────────────────────┤
       │   identifies, awaits Welcome                     │   identifies, awaits Welcome
       │                                                  │
       │   GET  /v1/rooms/{id}  ──── waits until ─────►   │   GET /v1/rooms/{id}
       │   (peer_hints lists bob's device when online)    │   (waits for alice in peer_hints)
       │                                                  │
       │   AppSignal::DevicePublicKey   ─────────────────►│
       │   AppSignal::Address (alice's UDP)               │
       │                          ◄───── AppSignal::KeyPackage
       │   add_member → (Commit, Welcome)                 │
       │   AppSignal::Welcome    ────────────────────────►│
       │   AppSignal::Ready      ────────────────────────►│  join_from_welcome
       │                          ◄───── AppSignal::Address (bob's UDP)
       │                                                  │
       │      [QUIC handshake: bob dials alice, ALPN crocodile/1]
       │      [TLS verifier checks the device pubkey embedded in cert SAN]
       │                                                  │
       │  mic ► f32 ► Opus ► MLS encrypt ► QUIC datagram ► MLS decrypt ► Opus ► speaker
       │   (bidirectional, 20ms frames, jitter buffer = 100ms on receive)
```

---

## Troubleshooting

- **Build fails on macOS with `cmake_minimum_required` error.** The workspace's `.cargo/config.toml` sets `CMAKE_POLICY_VERSION_MINIMUM=3.5` to work around an outdated CMakeLists in audiopus_sys's bundled libopus. If you're using a non-default cargo invocation that bypasses `.cargo/config.toml`, set the env var manually.
- **"no default input device" / "no default output device".** Make sure your OS has audio devices configured. On macOS check System Settings → Sound; on Linux make sure PulseAudio/PipeWire is running.
- **Hangs at `Waiting for peer to come online...`.** Both peers must be running and logged in for the host's `peer_hints` query to find the other side. Re-check `--server` is reachable from both, and that signaling actually connected (the binary prints `Signaling connected.`).
- **Hangs at `Establishing QUIC link to ...`.** The advertised address is unreachable from the dialing peer. Check firewalls, NAT, and the `--advertise-addr` you set. The bound address gets printed; verify it matches what the other peer sees.
- **Voice is choppy / clipped.** A 100 ms jitter buffer covers most home networks; cross-continent links may need more. The buffer depth is hardcoded for now (`audio/jitter.rs:DEFAULT_DEPTH_FRAMES`). Bump it and rebuild for a quick test.

---

## Where the code lives

| Crate | What it contains |
|---|---|
| `crates/protocol` | Wire types, signed envelopes, election scoring, MLS opaque types. |
| `crates/server`   | axum coordination server, Postgres-backed storage, WebSocket signaling. |
| `crates/client`   | HTTP/WS client, signed cache, QUIC peer transport, STUN, audio pipeline. |
| `crates/mls`      | openmls integration: identities, key packages, group ops. |

The demo binary is `crates/client/examples/two_peer_call.rs`.

## Status & next steps

Milestone 4 delivers the two-peer call. Subsequent milestones (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §13):

- **M5**: N-peer voice with host + shadow election (hot-standby failover under 500 ms).
- **M6**: election hardening, M-of-N complaints, project TURN relay.
- **M7**: 48 h offline cache with peer-hint gossip.
- **M8–9**: text channels with P2P-synced history.
- **M10**: federation across coordination servers.
- **M11**: UI polish, packaging, installers.
