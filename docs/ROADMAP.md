# Roadmap

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
- Main server deployment: product page, directory, install scripts and a
  first coordinator (`deploy/main`).
- Desktop app for Windows, macOS and Linux with its own design (light and
  dark themes, accents), installers, auto-update, one-line install scripts
  and an embedded coordination server.

## Next

1. **Mobile (iOS/Android).** React Native app reusing `@crocodile/client-core`
   with a WebRTC build that supports frame encryptors. Mobile devices never
   host; they join hosts. Push notifications need a content-free wake-up (an
   opt-in push relay that only says "open the app").
2. **Per-device signing keys** certified by the identity, so removing a
   device fully revokes it.
3. **Better reachability.** UPnP / NAT-PMP / PCP port mapping on hosts, IPv6
   preference, TURN over TCP/TLS for UDP-blocked networks, pre-warming the
   backup host for sub-second failover.
4. **MLS (RFC 9420)** for very large spaces.
5. **Roles and permissions**: moderators with delegated signing certificates,
   channel permissions, kicking from voice.
6. **Rich content**: attachments sent P2P (chunked over data channels),
   reactions, mentions, on-device search.
7. **Screen share and video** over the same relay design.
8. **Wayland global shortcuts** (XDG GlobalShortcuts portal) and Flathub.
9. **Server-side hardening**: per-IP rate limits, record quotas per user,
   abuse reporting for public directories.
10. **Web client** (cannot host; joins hosts) from the same renderer.
11. **Store and signing path** (see [DISTRIBUTION.md](DISTRIBUTION.md)):
    Microsoft Store listing (MSIX, signed by the Store, with the built-in
    updater disabled) plus winget; Apple Developer Program for Developer ID
    signing, notarization and working macOS auto-update; SignPath for the
    direct Windows download. Until then: the one-line installers.

## Open questions

- The product domain (the main server hosts the directory and product page).
- Mailbox for spaces (today DMs only): sealing to every member's devices is
  costly for big spaces; a per-space rotating mailbox key is one option.
