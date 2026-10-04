# Roadmap

For the order of work, the path to a public release, licensing, the paid
subscription and video, see [PLAN.md](PLAN.md).

## Done

- Identity without passwords (recovery key), profiles, friends, blocking.
- Spaces with text channels and voice rooms, invites, bans, owner settings.
- E2E group text with peer-to-peer history sync; DMs including delivery after
  the friend was offline.
- E2E voice through the elected host's relay with speaker slots, speaking
  indicators, mute/deafen, voice activity and push-to-talk (system-wide on
  Windows, macOS and X11, including mouse side buttons), device selection.
- DM calls with ringing.
- Host election with a backup, failover on disconnect or member reports.
- Coordination server mesh (replication, presence, routing, session
  ownership), directory with reachability checks, built-in STUN.
- Hybrid post-quantum key exchange everywhere, ratcheting sender keys,
  prekeys with forward secrecy, padding, constant-bitrate voice, encrypted
  client↔server and server↔server channels, encryption at rest.
- Multiple devices per account: linking with a code and security check,
  per-device keys for message delivery, renaming and removal.
- Opt-in relay through coordination servers for networks that block direct
  connections (one hour at a time, capped users per server).
- Offline delivery: a per-device outbox exchanged peer-to-peer with
  acknowledgements, and an opt-in server mailbox for DMs (sealed per device,
  up to 7 days, works across the server mesh).
- Main server deployment: directory, install scripts, a first coordinator
  and a placeholder page (`deploy/main`).
- Desktop app for Windows, macOS and Linux with its own design (light and
  dark themes, accents), installers, auto-update, one-line install scripts
  and an embedded coordination server.

## Next

The order of this work, and what comes before it, is in [PLAN.md](PLAN.md).

1. **Per-device signing keys** certified by the identity, so removing a
   device fully revokes it.
2. **Better reachability.** UPnP / NAT-PMP / PCP port mapping on hosts, IPv6
   preference, TURN over TCP/TLS for UDP-blocked networks, pre-warming the
   backup host for sub-second failover.
3. **MLS (RFC 9420)** for very large spaces.
4. **Roles and permissions**: moderators with delegated signing certificates,
   channel permissions, kicking from voice.
5. **Rich content**: attachments sent P2P (chunked over data channels),
   reactions, mentions, on-device search.
6. **Screen share, video and remote control** (see PLAN.md §4).
7. **Wayland global shortcuts** (XDG GlobalShortcuts portal) and Flathub.
8. **Server-side hardening**: abuse reporting for public directories
   (per-IP connection limits and per-account record quotas are done).
9. **Store and signing path** (see [DISTRIBUTION.md](DISTRIBUTION.md)):
   Microsoft Store listing (MSIX, signed by the Store, with the built-in
   updater disabled) plus winget; Apple Developer Program for Developer ID
   signing, notarization and working macOS auto-update; SignPath for the
   direct Windows download. Until then: the one-line installers.

## Paused

- **Mobile (iOS/Android) and a web client.** Assessed and paused (see
  PLAN.md). Both first need a way to hold calls when nobody in them is on the
  desktop app: direct calls for DMs and small groups, or a cloud call host.
  A wrapped web build (Capacitor) is the likely route for mobile, since it
  keeps the browser's frame encryption for voice.

## Open questions

- Mailbox for spaces (today DMs only): sealing to every member's devices is
  costly for big spaces; a per-space rotating mailbox key is one option.
