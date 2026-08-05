# Crocodile

Working name for a federated, peer-meshed voice + text communication platform. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

This README covers how to actually run the demo binaries — there are two now, `two_peer_call` (the milestone-4 reference for two participants) and `group_call` (N participants via the architecture's host-as-relay model). Both demonstrate end-to-end voice + text with MLS-encrypted payloads, QUIC peer transport with pubkey-pinned TLS, and a coordination server that never sees content.

---

## What works today

- One coordination server hosting accounts, room metadata, signed keystore responses (48 h TTL), and a WebSocket signaling relay.
- Two desktop clients can sign up / log in, exchange MLS key packages over the signaling relay, establish a direct QUIC connection (pubkey-pinned TLS, no web PKI), and exchange both MLS-encrypted Opus voice frames *and* MLS-encrypted text messages.
- Audio: 48 kHz mono, Opus at 32 kbps, 20 ms frames, 100 ms jitter buffer.
- Text: bidirectional QUIC stream, length-prefixed postcard-encoded MLS-encrypted frames, persisted locally to a SQLite history per peer.

## What does not work yet

- **General-internet NAT traversal.** No TURN fallback, no ICE candidate prioritisation. If both peers are behind symmetric NATs, the call will fail. UDP hole punching works between two open / moderate NATs. Use Tailscale or a LAN if internet doesn't cooperate (see below).
- **Host election + failover.** The election state machine and quality measurement layers are tested in-process, but the runtime data plane uses a fixed host (the room creator). If the host disconnects, the call ends.
- **Audio device selection.** Defaults to the OS default input/output. Adjust those in your OS sound settings before launching.
- **Reconnection.** If the QUIC link drops, the call ends. Restart both binaries.
- **Federation across coordination servers.** One server per deployment for now.

---

## Setup

You need the workspace built (Rust 1.95 toolchain, automatically pulled by `rust-toolchain.toml`) and a reachable coordination server.

### 1. Prerequisites on the machine running the coordination server

```bash
# macOS: install CMake (audiopus_sys' bundled libopus needs it for the
# initial libopus compile in clients; the server itself doesn't).
brew install cmake

# First-time build (this takes a while; it's compiling rustls, quinn,
# openmls, sqlx, libopus, ...).
cargo build --release
```

**No database to install.** The server defaults to an embedded SQLite
file (`crocodile-server.sqlite`), so it runs with zero external
dependencies. Postgres is still supported for production — see below.

### 2. Run the coordination server

Zero-config (SQLite):

```bash
cargo run --release --bin crocodile-server
```

That's it — the server creates its SQLite file and identity key on
first launch, and listens on `0.0.0.0:8080` (all interfaces) so other
machines on your network can reach it. On startup it prints the exact
URL peers should use, e.g.:

```
peers on your network should use: http://192.168.0.46:8080
```

Set `BIND_ADDR=127.0.0.1:8080` to restrict it to this machine only —
but note that no other device will be able to connect, and the server
logs a warning saying so.

> **Server URL rule of thumb.** On the machine running the server,
> either `http://127.0.0.1:8080` or the LAN IP works. On *every other*
> machine you must use the server's LAN IP — `127.0.0.1` there means
> that machine's own loopback, where nothing is listening.

**Postgres (optional, for production / federation):** point `DATABASE_URL`
at a Postgres URL. A `docker compose up -d` brings up a dev Postgres on
:5432 matching the default URL below.

```bash
docker compose up -d   # optional: dev Postgres on :5432
DATABASE_URL=postgres://crocodile:crocodile_dev@localhost:5432/crocodile \
    BIND_ADDR=0.0.0.0:8080 \
    cargo run --release --bin crocodile-server
```

…or via Docker if you'd rather not have a Rust toolchain on the server host:

```bash
docker build -f crates/server/Dockerfile -t crocodile-server .
docker run --rm --network host \
  -e DATABASE_URL=postgres://crocodile:crocodile_dev@localhost:5432/crocodile \
  -e BIND_ADDR=0.0.0.0:8080 \
  -v $PWD/.server_identity.key:/data/.server_identity.key \
  crocodile-server
```

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

## Running the call

Three options depending on how you want to use it:

- **`crocodile-gui`** — desktop window (egui). The functional-MVP UI: settings, host/join buttons, in-call chat, ROOM_ID copy field. Recommended for actual use.
- **`two_peer_call`** — CLI, exactly two participants. The milestone-4 reference.
- **`group_call`** — CLI, N participants via host-as-relay.

### crocodile-gui — the desktop UI

```bash
cargo run --release --bin crocodile-gui
```

On first launch you see the Settings pane. Fill in:

- **Server URL** — `http://<your-server>:8080`.
- **Username** + **Password** — picks an existing account or creates one.
- **State dir** — where your identity key, MLS state, and text history live. Defaults to `./crocodile-state`.

Click **Save settings**, then **Show my user_id** if your peer needs your id to invite you. The full id appears in a copyable text field.

Switch to the **Call** tab to host or join:

- **Host:** type the peer's *username* (not user_id) into "Invite username" and click **Host call**. The UI prints the new `ROOM_ID` at the top of the call view — share it with the joiner.
- **Join:** paste the host's `ROOM_ID` into the field and click **Join call**.

Once the status chip reads **in call**, voice flows automatically and the chat box at the bottom sends text. Settings persist to `~/.config/crocodile/settings.json` between launches.

### CLI binaries

The CLI binaries (`two_peer_call`, `group_call`) follow the same conceptual flow as the GUI but with explicit command-line arguments. They're documented further below — useful for debugging or for running on a headless server.

The flow shape is identical across all three binaries:

### two_peer_call — same as before

Each peer runs `cargo run --release --example two_peer_call` with their own state directory, username, and password.

### One-time: share these out of band

You'll exchange two short hex strings with your friend (paste over chat, email, whatever):

1. Both run `print-id` to learn their `user_id`. This subcommand needs only `--state-dir` — no server, username, or password. (It generates and persists the identity keypair on first run.)
2. The **host** peer (whoever creates the room) needs the **joiner's `user_id`**.
3. The **host** runs in `host` mode, which creates the room and adds the joiner. It prints the `ROOM_ID`.
4. The **joiner** uses that `ROOM_ID` and runs in `join` mode.

### Learning your user_id

```bash
cargo run --release --example two_peer_call -- \
    --state-dir ./state-alice print-id
```

Output:

```
My user_id:   aa5132cb670d…
My device_id: 56beb7180a7f…
```

Send the `user_id` to your peer however you usually share short text (chat, email, etc.).

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

Within a second or two both binaries should print `QUIC connected. Voice flowing. Press Ctrl-C to hang up.` and `Type messages and press Enter.` You'll hear each other, and lines you type get sent as text. Received text shows up as `[<short-device-id>]: message`.

Ctrl-C on either side ends the call. Either peer can restart and re-do the dance — the text history persists across restarts under `--state-dir/history.sqlite`.

### group_call — three or more participants

Same args, except the host can pass `--invite-username` (or `--invite-user-id`) **multiple times**:

```bash
# alice creates the room and invites bob + carol:
cargo run --release --example group_call -- \
    --server http://1.2.3.4:8080 --username alice \
    --password somethinglongerthan8 --state-dir ./state-alice \
    host --invite-username bob --invite-username carol

# bob and carol each join with the room id alice printed:
cargo run --release --example group_call -- \
    --server http://1.2.3.4:8080 --username bob \
    --password somethinglongerthan8 --state-dir ./state-bob \
    join --room-id <ROOM_ID>
```

The host accepts joiners as they come online, adds them to the MLS group one at a time, and from then on fans out voice ciphertext to all members. Each non-host peer has exactly one QUIC connection (to the host).

**Important caveats:**

- The host is *fixed* at the room creator. No election or failover in this binary yet. If alice disconnects, the call ends for everyone.
- Voice scales fine for ~10 peers on a residential uplink (host fans out N-1 copies of each 32 kbps stream).
- Text fan-out for `group_call` is currently host→joiner only; joiner→joiner text via the host is a TODO marked in the source.
- Each joiner does the print-id dance first; the host needs everyone's user_id or username in advance.

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
