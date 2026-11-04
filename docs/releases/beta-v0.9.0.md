A beta release of Crocodile: peer-to-peer, end-to-end encrypted voice, video
and text chat. It works, but expect rough edges, and note that it hasn't had an
independent security audit yet.

## What's new in 0.9.0

A security release: everyone should update, and server operators should update
all their servers together. Older versions and this one cannot talk to each
other in a few places (listed under "Updating").

- **Stricter checks between servers.** Servers check more carefully who a
  message, a presence update or a session request comes from, limit how quickly
  one server can introduce others, and a device now signs its own part in a
  conversation, so a server that it isn't connected to can't speak for it.
- **Chat messages and files are tied to the space they were sent in.** Messages
  name their space and file ids are tied to their author.
- **Invite links.** A space has one open link at a time, lasting at most 30
  days, and its secret stays in the link: no server learns it. You can also
  invite one person by name. Member lists are shown only to the space's owner
  and members. Links made by older versions stop working; make a new one.
- **Linking a new device is harder to tamper with.** The security code is
  checked before the account is sent, and the transfer is protected against
  future quantum computers like the rest of the app.
- **Conversations from people you don't know wait as requests.** Nothing of
  yours is shared with them until you accept.
- **Blocking works in spaces.** A blocked member's messages are not kept, and
  keys and files are not given to them.
- **Removed devices clean up after themselves.** A device you remove from your
  account stops and clears its copy of the account the next time it is online.
- **Voice and video.** Each frame is accepted once, voice stays at a constant
  bitrate whatever the host's description says, and members' keys can't displace
  each other.
- **A calmer desktop app.** The app's window only shows its own pages, the
  parts of the app that talk to your computer check what they are asked, release
  builds switch off the debugging doors, files you receive are marked as
  coming from outside, and there is a warning when your system has no keychain.
- **Command line tool.** It shows other people's text without hidden control
  characters, saves a received file only once it is whole, and runs one command
  at a time per account.
- **Servers stay responsive under load.** Long answers are sent in parts,
  lookups of many profiles make fewer requests between servers, requests and
  replies are limited per address, and each account can store a bounded amount.
- **Directory and relay hardening.** The public directory checks a server's
  address more carefully before listing it (a server behind a redirect or on a
  private address is not listed; set `CROC_DIR_ALLOW_PRIVATE=1` for a directory
  on a private network). The built-in relay reads requests exactly as they were
  signed, and `--relay-own-ips` lets it avoid more of its own machine's
  addresses.
- **Installers check what they download.** The one-line installers fetch over
  https only and compare each download with the checksum the release lists
  before installing it.
- **Up-to-date components.** Electron 44.10.0 (Chromium 152.0.7977.169), WebRTC
  (werift), the build tools and the app's libraries.

## Updating

- **Server operators:** this release uses protocol 4. Servers on older versions
  cannot link to it, so update them all together. Behind a reverse proxy, set
  `--trust-proxy`; the self-hosting compose file now publishes the directory on
  `127.0.0.1` only (`CROC_DIR_BIND=0.0.0.0` to change it). See the
  [self-hosting guide](https://github.com/pwalda/crocodile/blob/main/docs/SELF_HOSTING.md).
- **Everyone else:** click **Update** in the top bar. New messages and files from
  people who have not updated yet will not appear until they do, and a device
  cannot be linked between an old and a new version: update both first.

## Download

| System                  | File                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| Windows (x64 and ARM)   | the `.exe` installer                                                     |
| macOS (Intel and Apple) | the `.dmg` (universal)                                                   |
| Linux                   | `.AppImage`, `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE), `.tar.gz` |

Or install with one line in a terminal, which avoids the warnings below; see
the [README](https://github.com/pwalda/crocodile#install).

These builds are not code-signed yet:

- **Windows:** SmartScreen says "Windows protected your PC" → _More info_ →
  _Run anyway_.
- **macOS:** open the app once, then _System Settings → Privacy & Security →
  Open Anyway_.

The app tells you when a new version is out: click **Update** in the top bar,
then **Restart to update** once it has downloaded. Two exceptions: the Linux
`.tar.gz` can't update itself, so **Download update** opens this page; and a
Mac app that can't replace itself (still on the disk image, or in a folder you
can't write to) downloads the new `.dmg` and shows **Install update**, which
opens it so you can drag Crocodile into Applications.

## Getting started

Open Crocodile, pick a name and save your recovery key. The app finds a
coordination server by itself. Add friends under _Home → Add someone_
(`name#1234`), create a space, share the invite, and talk.

Want to run your own server instead, for example on a home network? Turn on
_Settings → Host a server_ and share the address it shows; others add it
under _Settings → Network → Preferred servers_. See the
[self-hosting guide](https://github.com/pwalda/crocodile/blob/main/docs/SELF_HOSTING.md).

## What to try

- Text chat in a space and in DMs; send a DM while your friend is offline and
  see it arrive when they're back.
- Voice rooms with three or more people; leave as the host (the crown / radio
  icon) and check the others stay connected.
- Push-to-talk while another app is focused (Settings → Voice).
- Link a second computer (account menu → _Link another device_); both must be on this version.
- Make a new invite link for a space, or invite one person by name.
- Light/dark theme and accent colours (Settings → Appearance).

Found a problem? Open an
[issue](https://github.com/pwalda/crocodile/issues/new/choose) and attach
_Settings → About → Copy diagnostics_ (it contains no messages). Report
security problems
[privately](https://github.com/pwalda/crocodile/security/advisories/new).
