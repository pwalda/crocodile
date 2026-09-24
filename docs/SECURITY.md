# Security model

## What we protect

| Asset                            | Who can read it                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Voice                            | Only the members of the call.                                                       |
| Text messages (channels and DMs) | Only the members of the space or DM, now and in the future (via peer history sync). |
| Your identity key                | Only your device (OS keychain) and whoever holds your recovery key.                 |

## What servers see

Coordination servers see **metadata**: public profiles, friend lists, space
names, channel lists, memberships, who is online, who is in which voice
channel, and when people connect. They relay signalling (SDP and ICE
candidates), which includes IP addresses. They never receive voice or message
content in any form, not even encrypted.

The directory only sees coordination servers.

The **host peer** of a session sees the IP addresses of its members and the
size and timing of their encrypted frames, plus who is speaking (from the
RFC 6464 audio-level header). It holds the same keys as every other member
(it is one), but its relay component only forwards ciphertext.

## Adversaries

| Adversary                          | Can                                                                                                                                   | Cannot                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network observer                   | See that you talk to certain IPs.                                                                                                     | Read content (DTLS-SRTP, plus E2E underneath).                                                                                                                          |
| Malicious coordination server      | Lie about presence, drop or delay signalling, refuse service, log metadata.                                                           | Forge profiles, spaces, invites or memberships (all signed); substitute a user's key (user ids are hashes of keys); MITM WebRTC (SDP is identity-signed); read content. |
| Malicious mesh peer server         | Same as above.                                                                                                                        | Same as above; clients re-verify every record.                                                                                                                          |
| Non-member who learns a session id | Nothing: joining requires a signed membership, and members only share sender keys with peers whose membership they verify themselves. |                                                                                                                                                                         |
| Former member                      | Keep what they already saw.                                                                                                           | Decrypt anything after they left: sender keys rotate on leave.                                                                                                          |
| Stolen device                      | Everything on it. Use OS disk encryption.                                                                                             |                                                                                                                                                                         |

## Cryptography

- Ed25519 signatures and X25519 key agreement (`@noble/curves`).
- HKDF-SHA256 and AES-256-GCM (`@noble/hashes`, `@noble/ciphers`).
- Sealed boxes: ephemeral-static X25519 → HKDF → AES-GCM, signed by the
  sender and bound to the recipient key.
- Voice: SFrame-style per-frame AES-GCM with a (key id, counter) nonce.
- Every signature is domain-separated (`SIG_DOMAIN` in `protocol/constants.ts`).

## Known gaps

- Sender keys provide per-session forward secrecy and rekeying on leave, but
  not the post-compromise security of MLS. Migrating to MLS is planned.
- Safety-number verification is manual.
- Home-hosted coordinators may use plain `ws://`. Server identity is still
  verified, but metadata is not confidential on the wire. Use TLS for public
  servers.
- Messages at rest are protected by the OS account and disk encryption only.

Please report vulnerabilities privately to the maintainers rather than in
public issues.
