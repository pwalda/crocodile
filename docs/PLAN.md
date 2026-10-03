# Plan: public release, licensing, subscription and video

This is the working plan for getting Crocodile from a test build to a public
product. [ROADMAP.md](ROADMAP.md) lists features; this document covers the
order, the business model and the decisions behind it. It is not legal
advice: have a lawyer review the licensing and trademark parts before selling
anything.

## Where things stand (October 2026)

- The desktop app (Windows, macOS, Linux) does everything listed as done in
  the roadmap: E2E text and voice, spaces, DMs and calls, multiple devices,
  host election with failover, the server mesh and directory, the opt-in
  relay, offline delivery, installers and auto-update.
- `main` is green: 72 tests, about 73% coverage, lint, and a smoke test of
  the packaged Linux app in CI.
- v0.0.1 is published as an unsigned test release.
- **Not yet done:** there is no domain, so the main server (product page,
  directory, first coordination server) has never run. Nobody has used the
  app across real home, mobile or corporate networks. The protocol has had no
  outside security review.

## 1. Licensing: open source, commercial rights stay with the owner

**Decision: Option A**, open source under the AGPL plus a contributor
agreement and a trademark.

An open-source licence cannot forbid others from using the code
commercially. What the AGPL does is make it unattractive: anyone who sells a
product built on Crocodile, including one they only run as a hosted service,
must publish all of their source under the AGPL, and cannot call it
Crocodile. Only the owner can:

- sell commercial licences that exempt a company from the AGPL;
- ship closed add-ons and paid services;
- publish store builds (App Store terms are generally considered
  incompatible with the AGPL; the owner is not bound by their own licence);
- sell under the Crocodile name and logo.

This works because the owner holds the copyright to all code (every commit
so far is theirs) and the [CLA](../CLA.md) (§2) lets the owner distribute
contributions "under any license terms".

### Changes to make

| #   | Change                                                                                                                                 | Why                                                                                                                                                | Status                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Move `packages/client-core` and `packages/relay` from Apache-2.0 to AGPL-3.0                                                           | They hold the product's value: all client logic and the call host. Under Apache, anyone could put a new UI on them and sell a closed-source rival. | Done                                                            |
| 2   | Keep `packages/protocol` and `packages/crypto` on Apache-2.0                                                                           | Wire formats and crypto building blocks; permissive terms let others build compatible clients and bots, and invite review of the crypto            | Decided                                                         |
| 3   | Update every place that states the licences: `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `TRADEMARKS.md`, Settings → About in the app | Keep the statements accurate                                                                                                                       | Done                                                            |
| 4   | Name the owner in `TRADEMARKS.md` and add a copyright notice                                                                           | "The Crocodile project" is not a legal person and cannot own a mark                                                                                | Done with the GitHub handle; legal name or company still to add |
| 5   | Add `COMMERCIAL.md`: how to get a non-AGPL licence                                                                                     | Makes dual licensing a real offer                                                                                                                  | Done                                                            |
| 6   | Check the name "Crocodile" is free to use, then consider registering it (EUIPO, USPTO)                                                 | It is a common word; a clash later is expensive                                                                                                    | Owner                                                           |
| 7   | Lawyer review of the CLA, licences and trademark policy                                                                                | Before the first commercial licence is sold                                                                                                        | Owner                                                           |

v0.0.1 was published with `client-core` and `relay` under Apache-2.0; that
copy stays Apache-2.0 for anyone who has it. The risk is small now, which is
why the switch should happen before the public release.

## 2. Path to a public release

| #   | Step                                                                                                                                                                                     | Who                                         | Rough time                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------- |
| 1   | Licensing changes above                                                                                                                                                                  | Owner decides, Claude implements            | 1 day                     |
| 2   | Domain, main server live (ideally two coordination servers), `CROC_DIRECTORIES` set                                                                                                      | Owner (domain, VPS, DNS), Claude (deploy)   | A few days                |
| 3   | Closed beta: 10–30 testers on Windows, macOS and Linux, on home networks, mobile hotspots, corporate networks and carrier-grade NAT                                                      | Owner and testers; Claude fixes             | 2–4 weeks                 |
| 4   | Code signing: Apple Developer Program (signing, notarization, macOS auto-update) and SignPath or Azure Trusted Signing for Windows                                                       | Owner (accounts), Claude (release workflow) | 1–3 weeks, mostly waiting |
| 5   | Running a service: server monitoring and backups, per-user record quotas, abuse reporting, a privacy policy for the main server (it handles who-talks-to-whom metadata, e.g. under GDPR) | Owner (legal), Claude (code)                | 1–2 weeks                 |
| 6   | Independent security review of the protocol and implementation                                                                                                                           | External reviewer                           | Weeks to months           |

- **Open beta**, labelled "beta, not yet independently audited": steps 1–5,
  about 4–6 weeks. Testers set the pace more than code does.
- **1.0** that can be advertised as secure to the general public: adds step
  6, attachments and moderation tools, store presence and probably mobile,
  about 3–6 months.

## 3. Paid subscription

### Principles

- **Never charge for privacy or for talking.** Encryption, post-quantum key
  exchange, text, voice, basic screen sharing, multiple devices and
  self-hosting stay free.
- **Charge for what costs money to run**, or for convenience and "pro"
  extras.
- **The server rule still holds:** paid services the owner hosts only ever
  handle end-to-end encrypted data. The code can stay open: people pay for
  the owner's hosted service, not for the code. Self-hosters may run the same
  services for themselves.

### Candidates

| Candidate                              | Why it fits                                                                                                                                       | Notes                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Cloud call host**                    | Hosts calls when no member can (phones or browsers only, big rooms, slow home connections). Runs on the owner's servers and costs real bandwidth. | The strongest candidate. Sees only encrypted media. Also what makes large video calls possible.         |
| **HD and larger video / screen share** | Basic sharing stays free peer-to-peer; 1080p60, more cameras and bigger audiences go through the cloud host                                       | Depends on the cloud host and on video (section 4)                                                      |
| **Premium relay**                      | TCP/TLS relay for networks that block UDP, more bandwidth, no 1-hour limit                                                                        | Extends the existing opt-in relay                                                                       |
| **Larger mailbox**                     | 30 days instead of 7, higher limits, mailbox for spaces (today DMs only)                                                                          | Storage costs money                                                                                     |
| **Offline file delivery**              | Files reach friends who are offline, stored encrypted for a limited time. Normal peer-to-peer attachments stay free.                              | Attachments are not built yet                                                                           |
| **Encrypted backup**                   | History and settings restorable on a new device, encrypted with the user's recovery key                                                           | Stores encrypted content on a server: needs a new opt-in exception to the server rule, like the mailbox |
| **Cosmetics**                          | Choose your own `#tag`, profile themes, custom emoji for spaces                                                                                   | Cheap to run                                                                                            |
| **Space upgrades**                     | Larger member limits, more voice slots on the cloud host, branding                                                                                | Paid per space                                                                                          |
| **Teams / business**                   | A managed private coordination server for an organisation, commercial licence, priority support                                                   | Separate from the consumer subscription                                                                 |
| **Remote control "Pro"**               | Unattended access, multiple screens, clipboard and file transfer for IT support                                                                   | Only after basic remote control (section 4)                                                             |

### Billing

Accounts are keys, with no email. A subscription attaches to the user ID:

1. The user pays through a payment provider (Stripe or Paddle).
2. The owner's billing server issues a signed "plan" certificate for that
   user ID, valid for the billing period.
3. The owner's hosted services (cloud host, premium relay, mailbox) check
   the certificate. Open-source clients only display it.

Paying links a real person to an account; the privacy policy must say so.
Anonymous payment tokens (blind signatures) are an option later.

## 4. Video calls, screen sharing and remote control

### What exists

- The call host (`packages/relay`) is **voice only**: it forwards Opus audio
  through "speaker slots" chosen by audio level. Video needs new forwarding
  logic: keyframe requests, quality layers (simulcast) and choosing which
  streams each viewer receives.
- **Encryption carries over**: the per-frame encryption used for voice works
  for video frames too. A few codec header bytes can stay readable so the
  host can find keyframes without seeing the picture.
- **Electron can capture** the screen and camera on all three systems.

### The main limit: the host's upload speed

The host sends every stream to every viewer. A 1080p screen share (about
2–3 Mbps) to 10 viewers needs 20–30 Mbps of upload; a 5-person 720p video
call about 25 Mbps. Many home connections cannot do that, so:

- only send streams to people who choose to watch;
- use quality layers and adapt to each viewer's connection;
- cap the number of cameras;
- offer the cloud call host (section 3) to lift the limit.

### Features

| Feature                  | Approach                                                                                                                   | Platform notes                                                                                                                                                                             | Rough size                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **Screen share** (first) | One sharer per voice room; viewers click "Watch"; encrypted; adaptive quality                                              | macOS needs the Screen Recording permission; Linux Wayland goes through PipeWire; system audio works on Windows and partly on macOS 13+                                                    | 2–4 weeks                    |
| **1:1 video** (DMs)      | Direct between the two people, no host                                                                                     |                                                                                                                                                                                            | 1–2 weeks after screen share |
| **Group video**          | Quality layers through the host; high quality for the speaker or pinned person, low for others; about 6–8 cameras          | Host upload is the limit; the cloud host lifts it                                                                                                                                          | 3–5 weeks                    |
| **Remote control**       | View first, then control on top of screen share; keyboard and mouse events sent encrypted directly between the two devices | Needs native input code per system. Windows cannot control admin prompts or the lock screen. macOS needs the Accessibility permission (already used for push-to-talk). Wayland is limited. | 4–8 weeks                    |

### Remote control safeguards (version 1)

Remote control is the riskiest feature: tech-support scams depend on exactly
this. Version 1 must have:

- friends only;
- an explicit "allow control" prompt on the controlled device every time;
- a red border and indicator while controlled;
- an always-available "stop" shortcut;
- view-only by default;
- no unattended access.

It belongs in the scope of the security review.

### Metadata

Voice is sent at a constant bitrate so the host cannot tell when people
talk. Video cannot be: the host can roughly see activity from the bitrate.
[SECURITY.md](SECURITY.md) must say so when video ships.

## 5. Order

1. Licensing changes (section 1).
2. Domain and main server, then a closed beta and signing (section 2).
3. Open beta.
4. Screen share, then 1:1 video.
5. Cloud call host and billing: the base of the subscription and of large
   video calls.
6. Group video, then remote control.
7. Security review, then 1.0.

Mobile apps and a browser version were assessed and are paused. Both need
a way to hold calls when no member is on the desktop app (direct calls for
DMs and small groups, or the cloud call host), so that work comes first if
they are picked up again.

## Open decisions

- **Domain:** most likely `crocodilechat.com` (subject to the name check in
  section 1).
- **Legal owner** for the copyright notice and trademark: the owner
  personally or a company.
- **Price points** for the subscription, once the cloud call host exists.
