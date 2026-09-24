# Roadmap

## Done in v0.1

- Identity (no passwords, recovery key), profiles, friends, blocking.
- Spaces with text and voice channels, invites, bans, owner settings.
- E2E group text with peer-to-peer history sync; DMs including delivery after
  the friend was offline.
- E2E voice through the elected host's relay with speaker slots, speaking
  indicators, mute/deafen, VAD and push-to-talk, device selection.
- DM calls with ringing.
- Host election with a backup, failover on disconnect or member reports.
- Coordination server mesh (replication, presence, routing, session
  ownership), directory with reachability checks, built-in STUN.
- Desktop app for Windows, macOS and Linux with one-click installers and
  auto-update; embedded coordination server.

## Next

1. **Mobile (iOS/Android).** React Native app reusing `@crocodile/client-core`
   with a WebRTC build that supports frame encryptors (e.g. LiveKit's
   `react-native-webrtc` fork) and
   platform-specific storage. Mobile devices never host; they join hosts.
   Push notifications need a content-free wake-up mechanism (e.g. an opt-in
   push relay that only says "open the app").
2. **Better reachability without TURN.** UPnP / NAT-PMP / PCP port mapping on
   hosts, IPv6 preference, and pre-warming a connection to the backup host
   for sub-second failover.
3. **MLS (RFC 9420)** for group keys: post-compromise security and efficient
   rekeying for large spaces.
4. **Multi-device**: link devices to one identity (device keys certified by
   the identity key).
5. **Roles and permissions**: admins/moderators with delegated signing
   certificates, channel permissions, kicking from voice.
6. **Rich content**: attachments sent P2P (chunked over data channels),
   reactions, mentions, message search on device.
7. **Global push-to-talk** outside the focused window (native keyboard hook).
8. **Screen share and video** over the same relay design.
9. **Server-side hardening**: per-IP rate limits, record size quotas per
   user, abuse reporting for public directories.
10. **Web client** (cannot host; joins hosts) from the same renderer.

## Open questions

- A default public directory and its domain.
- Whether to offer an opt-in "encrypted relay of last resort" for users behind
  symmetric NAT on both sides. It would carry ciphertext only, but would bend
  the "only peers" rule.
