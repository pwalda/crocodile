# Crocodile architecture

Crocodile is a voice and text communicator in which **content only ever
travels between the people in a conversation**, always end-to-end encrypted.
Servers exist only to introduce peers to each other and to decide which peer
hosts a group. This document explains how the pieces fit and why.

```
                 ┌────────────────────┐
                 │  Directory service │  list of coordination servers
                 └─────────┬──────────┘  (no users, no content)
                           │ register / list
        ┌──────────────────┼───────────────────┐
┌───────┴────────┐  mesh  ┌┴────────────────┐ mesh ┌────────────────┐
│ Coordinator A  │◄──────►│ Coordinator B   │◄────►│ Coordinator C  │  signed metadata,
└───────┬────────┘        └───────┬─────────┘      └────────────────┘  presence, signalling,
        │ WebSocket (metadata      │                                    host election
        │ + signalling only)       │
   ┌────┴─────┐               ┌────┴─────┐
   │  Alice   │               │   Bob    │ ◄─┐
   │ (host) ┌─┴─────────┐     └──────────┘   │  WebRTC (DTLS/SRTP) carrying
   │        │ host relay │◄──────────────────┘  frames already E2E-encrypted
   │        │  (SFU)     │◄──────────────────┐  with per-sender keys
   └────────┴────────────┘              ┌────┴─────┐
                                        │  Carol   │
                                        └──────────┘
```

## 1. Components

| Package                | What it is                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/protocol`    | Wire formats and zod schemas: signed records, client↔coordinator RPC, server mesh frames, directory entries, relay data-channel messages, E2E envelopes.                                                                       |
| `packages/crypto`      | Identities, record signing/validation, sealed boxes, sender keys, frame and group encryption, signed chat messages and SDP, safety numbers, recovery keys. Pure TypeScript (`@noble/*`), identical on desktop, web and mobile. |
| `packages/coordinator` | The coordination server. Embeddable (the desktop app runs one on request) and standalone (`crocodile-coordinator`, Docker).                                                                                                    |
| `apps/directory`       | The directory: a phone book of coordination servers.                                                                                                                                                                           |
| `packages/relay`       | The **host relay**: a small SFU the elected host peer runs inside its app (werift).                                                                                                                                            |
| `packages/client-core` | The platform-neutral client: server selection, sessions, E2E layer, chat, history sync, voice engine.                                                                                                                          |
| `apps/desktop`         | Electron app (Windows, macOS, Linux) with the React UI.                                                                                                                                                                        |

## 2. Design principles → mechanisms

| Principle                                                             | Mechanism                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice and text only P2P, always E2E                                   | Voice frames are encrypted by the sender's app (Encoded Transforms, SFrame-style) before they leave the device; text is group-encrypted with sender keys. The host relay forwards ciphertext. Coordination servers carry signalling only. There is no TURN fallback: if peers cannot reach the host, the host is re-elected rather than traffic being relayed through a server. |
| Coordination servers on a good-will basis                             | Anyone can run `crocodile-coordinator` or tick "Host a coordination server" in the app. Servers register with the directory, which verifies they are reachable.                                                                                                                                                                                                                 |
| Servers hold accounts and metadata, shared across a mesh              | Accounts are key pairs. Profiles, friend lists, spaces, invites and memberships are **records signed by their author**; every server replicates every record and every client re-verifies them, so no server has to be trusted for integrity.                                                                                                                                   |
| Lowest-latency server, runner-up as backup                            | Clients fetch the directory, probe `/health` round-trip times, connect to the best and fail over to the standby instantly.                                                                                                                                                                                                                                                      |
| Every install can be server and client                                | The coordinator and relay are libraries; the desktop app runs them in Electron utility processes.                                                                                                                                                                                                                                                                               |
| Hassle-free install                                                   | One-click per-user installers (NSIS/DMG/AppImage/deb/rpm), no accounts, passwords or emails: onboarding is "pick a name".                                                                                                                                                                                                                                                       |
| Best peer hosts groups, runner-up is backup, server re-connects peers | Per-session host election on the coordination server with a standby backup and failover on disconnect or member reports.                                                                                                                                                                                                                                                        |
| Discord/TeamSpeak-style UX                                            | Space rail, text + voice channels with live occupants and speaking indicators, friends, DMs, calls.                                                                                                                                                                                                                                                                             |

## 3. Identity and signed records

- A user identity is a 32-byte seed. It yields an Ed25519 signing key and an
  X25519 encryption key. `userId = base32(sha256(signing public key))[:26]`,
  so ids are self-certifying: a server cannot substitute someone's key.
- The seed is the account. It is shown once as a **recovery key**
  (base32 + checksum) and stored with the OS keychain (Electron
  `safeStorage`).
- `name#1234` tags are a display aid derived from the user id.
- **Safety numbers** let two users compare keys out of band.

Metadata lives in signed records (`packages/protocol/src/records.ts`):

| Record  | Key                         | Who may write it                                                              |
| ------- | --------------------------- | ----------------------------------------------------------------------------- |
| profile | `profile:<userId>`          | the user (name, avatar, bio, X25519 key)                                      |
| friends | `friends:<userId>`          | the user; friendship = both list each other; one-sided = request              |
| space   | `space:<spaceId>`           | the owner; `spaceId = hash(owner key, nonce)` binds ownership without history |
| invite  | `invite:<code>`             | the space owner                                                               |
| member  | `member:<spaceId>:<userId>` | the user, referencing a valid invite                                          |

Validation (`crypto/src/records.ts`) checks the signature, authority, and
last-writer-wins versioning, identically on servers and clients.

## 4. Coordination servers and the mesh

A coordinator (`packages/coordinator`) offers a WebSocket JSON-RPC API:

1. Server sends a signed `hello` with a challenge. The client checks it
   against the key in the directory listing, then signs the challenge.
2. The client can put and get records, subscribe to prefixes, search users,
   watch presence and voice-channel occupancy, join or leave sessions, and
   send signalling messages to other session members.

**Mesh.** Servers learn about each other from the directory (and gossip) and
keep mutually authenticated WebSocket links. Replication is anti-entropy by
per-peer sequence cursors: on connect each side streams what the other has
not seen, then pushes new writes live. Records may arrive before their
dependencies (an invite before its space) and are retried. Presence is
gossiped. A client event for a user on another server is routed there.

**Sessions.** Each session (a space's text mesh, a voice channel, a DM) is
owned by one server chosen by rendezvous hashing over the live mesh, so every
server independently agrees on the owner. Member servers keep a registry of
their local members and forward operations to the owner. When the mesh changes
and ownership moves, member servers re-submit their joins with a hint of the
last known host, so the new owner rebuilds the same state without interrupting
the call.

**Storage.** SQLite (`node:sqlite`) with secondary indexes, or a
JSON-snapshotted memory store where SQLite is unavailable.

**STUN.** Each coordinator runs a minimal RFC 5389 binding responder so the
ecosystem does not depend on third-party STUN. It never relays traffic.

## 5. Host election and failover

Members report `HostCaps` when joining: whether they can and may host (desktop
only, user setting), NAT type (detected by comparing STUN mappings), uplink,
CPU cores, battery, RTT. `coordinator/src/election.ts` scores members:

- Open or cone NAT scores highest and symmetric NAT lowest; web and mobile
  clients never host.
- The current host is kept while it is healthy (no flapping when a slightly
  better peer joins).
- The backup is the best other candidate, kept stable unless clearly beaten.

Failover triggers:

1. The host's coordinator connection drops, so it leaves the session and the
   backup is promoted (epoch + 1).
2. Members fail to connect to the host twice and report it. Once half of
   them agree, the host is penalised for 60 s and the backup promoted.
3. The owner server dies. Ownership moves (see above) and the host is kept.

Every host change bumps the **epoch**; signals carry it, so stale offers and
answers are ignored.

## 6. The host relay (SFU inside a peer)

The elected host runs `HostRelay` (werift) in an Electron utility process.
Every member, including the host's own client over loopback, opens one
`RTCPeerConnection` to it:

- 1 upstream audio m-line (the microphone),
- `N` downstream audio m-lines, the **speaker slots** (default 5),
- one ordered data channel for control and E2E envelopes.

The relay assigns whoever is talking to each listener's slots ("last-N"),
using the unencrypted RFC 6464 audio-level header, and rewrites
sequence/timestamps so each slot stays a continuous stream. SDP never needs
renegotiation as people join or leave, and per-listener bandwidth is bounded
regardless of room size.

Offers and answers are signed with identity keys over (session, epoch, both
ids, SDP including the DTLS fingerprint), so a coordination server cannot
splice itself into the WebRTC transport.

## 7. End-to-end encryption

- **Sender keys.** Each member has a random 256-bit key per session. It is
  sent to every other _verified_ member (space membership or DM party is
  checked from signed records, never taken from the relay or server) in a
  **sealed box**: ephemeral X25519 → HKDF-SHA256 → AES-256-GCM, signed with the
  sender's Ed25519 key. Keys rotate whenever a member leaves.
- **Voice.** An Encoded Transform worker (`client-core/src/frame-worker.ts`)
  encrypts every Opus frame with AES-256-GCM before packetisation:
  `ciphertext ‖ tag ‖ kid ‖ counter ‖ 0xC7`, nonce = salt ⊕ (kid ‖ counter).
  Receivers look up the key by `kid`. Frames that cannot be encrypted or
  authenticated are dropped, never sent in the clear. Voice is disabled on
  platforms without encoded transforms.
- **Text.** Messages are signed by their author (so history can be re-shared
  verifiably) and group-encrypted with the sender key.
- **Transport.** DTLS-SRTP and SCTP-over-DTLS underneath, as in all WebRTC.

## 8. Text history without servers

Messages live only on members' devices (IndexedDB). When a member connects to
a session, it asks the host and backup (or the DM partner) for everything
newer than its latest message per channel. Replies are sealed to the
requester and every message is signature-checked. Messages written while
nobody else was online are marked "waiting for peers" and are delivered by
this same sync when a peer appears. This is how DMs reach friends who were
offline.

## 9. Client structure

`CrocodileClient` (`client-core/src/client.ts`) exposes one observable state
object plus methods (create space, send message, join voice, …).
`GroupSession` follows a session's state: it hosts the relay when elected,
connects to the host otherwise, runs the E2E layer and reconnects on
failover. Platform specifics come in through a `PlatformAdapter` (storage,
relay runner, WebRTC, capabilities), so the same core serves desktop, web
(which never hosts) and mobile.

## 10. Technology choices

| Choice                    | Why                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript everywhere** | One language for client, relay, coordinator and directory, so protocol and crypto code is shared, not re-implemented.                                                                                                                                   |
| **WebRTC (Chromium)**     | Industry standard for real-time voice: Opus, AEC3 echo cancellation, noise suppression, ICE NAT traversal, DTLS-SRTP, and Encoded Transforms for E2EE. The previous Rust/QUIC prototype had to rebuild all of this by hand.                             |
| **Electron**              | Ships the same Chromium WebRTC stack on Windows, macOS and Linux, so voice behaves identically everywhere (Tauri's system webviews differ, and WebKitGTK's WebRTC support is limited). Discord, Signal Desktop, Slack and Element make the same choice. |
| **werift for the relay**  | Pure-TypeScript WebRTC, so no native build per platform. It forwards encrypted RTP without decoding.                                                                                                                                                    |
| **@noble crypto**         | Audited, dependency-free, runs in Node, browsers, workers and React Native.                                                                                                                                                                             |
| **Fastify + ws, SQLite**  | Small, fast, zero-ops servers that anyone can run on a small VPS or a home PC.                                                                                                                                                                          |
| **React + Tailwind**      | Mainstream, fast to iterate, and reusable for a web client.                                                                                                                                                                                             |
| **electron-builder**      | One-click installers and auto-update from GitHub Releases.                                                                                                                                                                                              |

## 11. Known limitations and next steps

See [docs/ROADMAP.md](docs/ROADMAP.md). The main ones:

- **No TURN, by design.** Peers behind symmetric NATs on both sides may not
  connect. We elect reachable hosts and plan UPnP/NAT-PMP port mapping; an
  opt-in "encrypted relay of last resort" is open for discussion.
- **Sender keys, not MLS.** There is forward secrecy per session and rekeying
  on leave, but not MLS-grade post-compromise security. MLS (RFC 9420) is the
  planned upgrade.
- **Transport security to coordinators.** Server identity is verified, but
  plain `ws://` is allowed for home-hosted servers. Use HTTPS/WSS for public
  servers.
- **Mesh trust.** Servers cannot forge records. A malicious server could
  still lie about presence or drop messages; clients mitigate this by
  verifying membership themselves before sharing keys.
- **One device per identity** at a time (restore on another device with the
  recovery key). Multi-device linking is planned.
