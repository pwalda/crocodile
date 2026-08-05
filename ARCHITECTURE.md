# Crocodile — Distributed Communicator Platform

> Working name. Final product name TBD.

**Status:** Draft v0.1 — architecture phase, pre-implementation
**Date:** 2026-05-22

A voice + text communication platform competing in the Discord / TeamSpeak space. The defining architectural premise is that a federated coordination layer handles only metadata and signaling, while real-time content (voice, text) flows through a peer mesh whose host is dynamically elected from current room participants based on live network conditions.

---

## 1. Locked design constraints

These have been decided and are foundational; changing them invalidates large parts of what follows.

- **v1 platforms:** native desktop only (Windows / macOS / Linux).
- **v1 features:** voice + text. No video, no screen-share at launch.
- **Room scale:** up to 50 concurrent voice participants per room.
- **Content privacy:** the coordination server never sees voice or text content, including ciphertext bodies. It holds only opaque commitments (hashes) where needed.
- **Identity:** server-issued accounts (username/password) for discovery + login. Per-device cryptographic keys, signed by a per-user identity key, layered on top for E2EE. Signal-style safety-number verification surfaces key changes.
- **Federation:** multiple interoperable coordination servers (Matrix-shape). Users on different servers can join the same rooms.
- **Fallback relays:** project-operated ciphertext-only relays used only when the peer mesh cannot form. Community-contributed relays not in v1.
- **Text history:** persists on participants, not on the coordination server. The server holds an opaque hash commitment to the current head and adjudicates which peers have the freshest copy. Re-syncs are peer-to-peer.
- **Coordination-server outage tolerance:** clients cache the last signed server response and treat it as authoritative for up to **48 hours**. Most operations work during the offline window; new device onboarding and new room creation require server reachability.
- **Host election:** always maintains a primary host *and* a pre-designated hot-standby shadow. Failover target: under 500ms.

## 2. Components

### 2.1 Coordination server

Federated, project-operated *and* self-hostable. One per organization / community / individual.

Responsibilities:

- Accounts, login, device registration.
- Per-user keystore: device public keys + identity-key signatures.
- Room directory + canonical membership.
- Signaling: WebSocket per online client. Relays ICE candidates and MLS welcome / commit messages between peers. All payloads opaque.
- History-head commitment registry: rolling hash per room; knows which currently-online members claim to have it.
- Server-to-server federation protocol.
- Signed responses with timestamps, so clients can cache and continue operating without the server for up to 48h.

Stack: Rust + axum (HTTP / WS), PostgreSQL (durable state), Redis (ephemeral presence and signaling routing).

### 2.2 Client

Native desktop binary. Responsibilities:

- Audio I/O (cpal) + Opus encode/decode.
- QUIC peer connections (quinn). One QUIC connection per peer with multiplexed streams for voice, control, and text-sync.
- ICE for NAT traversal (STUN, hole-punching, project-operated TURN fallback).
- MLS group state machine (openmls).
- Local SQLite for text history, contacts, cached server state, MLS state.
- UI: Tauri + web frontend.

### 2.3 Relay fleet

Single-purpose ciphertext forwarders. Receive encrypted QUIC datagrams, fan them out to designated peer endpoints. Never see plaintext, never participate in MLS, no per-room state beyond connection routing. Minimal Rust binaries deployed as a fleet.

## 3. Cryptography

- **Identity key:** per user, long-lived, generated client-side. Signs all device keys.
- **Device key:** per device, generated locally on first launch. Registered in the user's keystore on the coordination server.
- **MLS (RFC 9420)** for group E2EE. Provides forward secrecy, post-compromise security, efficient group rekey on membership change.
- **Safety numbers:** Signal-style two-party verification. Surfaces in UI when an unverified key change happens.
- **Pre-join history:** by default not visible to new joiners (MLS forward secrecy). Per-room admin can opt-in to "share history with new joiners," which triggers existing members to re-encrypt and forward.

## 4. Transport

- **Peer-to-peer:** QUIC (quinn). Voice frames as datagrams (unreliable, low latency). Control + text on reliable streams. NAT traversal via ICE.
- **Client ↔ server:** HTTPS + WebSocket.
- **Server ↔ server (federation):** signed JSON over HTTPS.

## 5. Host election

### 5.1 Quality scoring

Each client computes two local scores every 10s:

- **Host score:** weighted by sustained upload bandwidth, NAT type permissiveness, median latency to peers, link stability, user opt-in.
- **Shadow score:** weighted by sustained download bandwidth + the same NAT / latency / stability / opt-in factors.

Scores are signed and gossiped to all room members via the existing peer mesh. Server is not involved.

### 5.2 Election function

Deterministic, identical on every peer. Produces an ordered list:

```
[host, shadow, bench[0], bench[1], ...]
```

A 15% sticky bonus favors the current host / shadow to prevent flapping when candidates are close.

### 5.3 Steady-state data path

```
sender ──► host ──► fan-out to (N-2) members + shadow
                            │
                            └─► shadow buffers, does not forward
```

The shadow receives all fan-out so its state is warm. Senders upload to host only (not to shadow directly), keeping sender bandwidth flat.

### 5.4 Failover

- Host emits keepalive every 200ms.
- After **400ms** of silence, peers locally promote the shadow.
- Peers switch send target to shadow. QUIC connections to shadow are already open.
- Shadow begins fan-out. Audio gap is bounded by the keepalive timeout, masked by jitter buffer.
- New shadow elected from bench within ~1-2s.

### 5.5 Edge cases

- **One viable candidate only:** project TURN relay implicitly acts as shadow. If no relay reachable, room runs without standby (surfaced in UI).
- **Host + shadow fail simultaneously:** bench candidate promoted using cached gossip state. Failover ~1-2s.
- **Split brain (partition):** signed quality vectors carry logical clocks. Peers reject fan-out with stale clock. Heals to majority side.
- **Adversarial host degrading service:** M-of-N complaint mechanism (~30%) forces re-election excluding current host.

## 6. Text history

Each room's history is a hash-linked log. Server holds only the current head hash + list of online members who claim to have it.

### 6.1 Sync flow

1. New peer asks server for current head `h` and online members who hold it.
2. Peer asks one of those members for messages between its local head and `h`.
3. Peer verifies hash chain, decrypts with current MLS epoch keys (or earlier epoch keys it retains, for messages encrypted under those).

### 6.2 Forks

Concurrent writes during partition produce divergent heads. On reunion:

- Server detects divergence (two heads claimed by different members of same room).
- Members exchange both branches.
- Deterministic merge (timestamp + sender-pubkey tiebreak) produces a synthetic merge message with both branches as parents.

### 6.3 Commitment posting

The current host periodically (every N seconds or M messages) posts the new head hash to the coordination server. Server never sees content.

## 7. Federation

### 7.1 Control plane

Server-to-server protocol over HTTPS, signed. Servers are authoritative for their own users and rooms. Cross-server membership: when user `alice@A` joins `room@B`, server A proxies signaling to server B; A continues to serve as Alice's signaling endpoint.

### 7.2 Data plane

Federation is invisible at the data plane. Peers exchange QUIC packets directly (or via host), oblivious to which server vouched for whom. MLS groups span servers transparently because MLS is identified by group ID, not by server.

### 7.3 Federation limitations (v1)

- No identity portability between servers (re-verification via safety numbers required for v1 migration).
- Cross-server room availability inherits availability of all involved servers.
- No cross-server reputation / abuse system in v1. Server admins can defederate hostile peers.

## 8. Offline (server-unreachable) operation

### 8.1 What clients cache

- Room rosters + admin sets (signed by server, timestamped).
- Device pubkeys + identity-key signatures.
- MLS group state (epoch, ratchet).
- Peer hints: rolling list of ~8 recently-seen reachable endpoints per room, refreshed both via server and via peer-to-peer gossip.
- Federation chain certificates for cross-server rooms.

### 8.2 What works offline

- Joining rooms the client is already a member of, if a cached peer hint resolves.
- Voice + text in such rooms.
- MLS membership changes among already-known members.
- Text history sync among reachable peers.

### 8.3 What requires the server

- Brand-new device onboarding (registering with the keystore).
- First signup / account creation.
- New room creation.
- Trusting key revocations made during the offline window (up to 48h propagation delay).
- Discovering rooms the client is not a member of.

### 8.4 UX surfacing

- 0-6h offline: silent.
- 6-24h: subtle indicator.
- 24-48h: prominent warning, especially around any operation involving identity verification.
- 48h+: hard expiry. Most operations refuse until the server is reachable.

### 8.5 Revocation propagation under partial offline

Even while some members are offline, any peer that has talked to the server within its 48h window propagates revocation events to the mesh as part of regular signed gossip. So as long as the mesh is not *fully* partitioned from the server for 48h+, revocations spread.

## 9. Threat model

| Adversary | What they can do | What they cannot do | Mitigation |
|---|---|---|---|
| Curious coordination server | See membership, presence, message timing/counts, history-head hashes | Read voice or text content | E2EE via MLS; server holds opaque commitments only |
| Compromised coordination server | All of the above + attempt key MITM by swapping device keys | Read content silently | Safety-number UI; out-of-band verification; signed cache 48h-bounded |
| Malicious host (data-plane peer) | Drop, reorder, or stall packets; observe ciphertext sizes / timing | Read content | Per-message signing + sequence numbers; M-of-N complaint triggers re-election |
| Malicious room member | Spam, abuse, leak content they legitimately decrypted | — | Admin tools (kick/ban → MLS remove); reporting on metadata |
| Network observer | See traffic patterns to server and peers | Read content | TLS to server, QUIC between peers |
| Relay operator | Drop traffic, observe ciphertext metadata | Read content | Ciphertext-only design; MLS confidentiality |
| Compromised user device | Read content for rooms it's in | Read content for rooms it's not in; impersonate other devices | Per-device keys; identity-key signature revocation |
| Stale-cache attacker (revoked device acting in offline window) | Operate for up to 48h before peers learn of revocation | Operate indefinitely | Time-bounded cache; mesh-propagated revocation gossip |

## 10. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Server language | Rust | Shared protocol crate with client; strong async; type safety for security-critical code |
| Server HTTP / WS | axum | Mature, ergonomic, integrates with Tokio |
| Server DB | PostgreSQL (prod) / SQLite (local) | Postgres is boring/correct for production + federation; SQLite lets the server run with zero external deps for local/MVP use. Selected at runtime from the `DATABASE_URL` scheme; shared SQL via a `dispatch!` macro over both pools. |
| Ephemeral state | Redis | Presence + signaling routing |
| Client language | Rust | Same crate sharing; cross-platform; strong audio + crypto + QUIC ecosystems |
| Client UI shell | Tauri + Svelte (or React) | Small binary, OS webview, fast UI iteration; sensitive logic in Rust |
| Peer transport | QUIC (quinn) | Multiplexed streams, modern crypto, UDP-friendly NAT, low handshake cost |
| NAT traversal | ICE + STUN + project TURN | Standard; widely deployed |
| E2EE | MLS (openmls) | RFC 9420; modern group-E2EE primitive |
| Audio codec | Opus | Industry standard for low-latency voice |
| Audio I/O | cpal | Cross-platform native audio in Rust |
| Local storage | SQLite (rusqlite or sqlx) | Embedded, reliable, transactional |

**Rejected alternatives:**

- **Erlang/Elixir for server:** strong concurrency story, but the shared-crate code reuse with client and Rust's type safety win out for a non-extreme-QPS signaling workload.
- **WebRTC for peer transport:** designed for browsers; on native QUIC gives us datagrams + reliable streams in one protocol with less ceremony than DTLS-SRTP + SDP.
- **Megolm:** works but MLS is the standardized successor with active maintenance.
- **Electron UI:** binary size, memory, security surface. Tauri is strictly better for this use case.
- **Iced or other pure-Rust UI:** rejected for v1 due to slower iteration; reconsider later if Tauri's webview becomes a bottleneck.

## 11. Deferred from v1

- Mobile clients.
- Video + screen-share.
- Federation reputation / abuse propagation across servers.
- Account recovery flows (backup phrase, device-linking transfers).
- Voice activity detection, noise suppression, echo cancellation.
- Offline push notifications.
- Community-contributed relays.
- Identity portability across coordination servers.

## 12. Known hard problems and open questions

1. **MLS rekey cost at N=50 under churn.** Wants a prototype-level measurement early. If costly, may need a "lobby" pattern that batches joins.
2. **Federation + dynamic host election** has limited prior art. Believed to work because the data plane is server-oblivious; needs pressure-testing once we get there.
3. **Forward-only vs. opt-in shared history** as the v1 default. Currently: forward-only default, per-room admin can opt in.
4. **Tauri vs. pure-Rust UI.** Currently: Tauri for iteration speed. Re-evaluate after the first UI milestone.
5. **History-head commitment metadata leak.** Server sees update frequency; this is a coarse activity signal. Believed acceptable but worth being explicit.
6. **Whether 48h is the right offline window.** Tradeoff between revocation-propagation lag and online-reachability friction. Currently: 48h hard expiry with graduated UX warnings starting at 6h.

## 13. Build sequence

Each milestone produces something runnable and testable.

1. **Protocol crate** — shared wire types, message formats, MLS wrapper. Builds with tests; no networking.
2. **Coordination server MVP** — accounts, single-server room CRUD, signaling, keystore. Signed-timestamped responses from day one.
3. **Client networking foundation** — QUIC peer connections, ICE / STUN / TURN integration, signed cache layer.
4. **Two-peer voice call** — fixed roles (no election), MLS-encrypted, end-to-end. Proves the core path works.
5. **N-peer voice with host + shadow election** — quality scoring, gossiped vectors, hot-standby failover from day one (not added later). Failover under 500ms.
6. **Quality-probing refinement + adversarial-host handling** — M-of-N complaint mechanism, edge case hardening.
7. **Server-offline operation** — peer hints, cached-state path, offline-mode UX.
8. **Text channels** — MLS-encrypted text alongside voice.
9. **Text history P2P sync with server-held commitments** — including fork merge.
10. **Federation** — cross-server rooms, S2S protocol.
11. **Polish** — UI, key verification UX, admin tools, packaging, installer.

---

## Document conventions

- This is a living document. Material changes during implementation should land here, with the date of the change.
- When in doubt about an open question, prefer the answer that preserves the locked constraints in §1 over local convenience.
