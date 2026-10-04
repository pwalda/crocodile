# Security policy

Crocodile is end-to-end encrypted chat, so security reports matter more than
any other kind. Thank you for taking the time.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:
[Security → Report a vulnerability](https://github.com/pwalda/crocodile/security/advisories/new).

Include what you can of:

- what an attacker can do, and who the attacker is (another user, a malicious
  coordination server, a network observer, a call host, ...);
- steps or a proof of concept;
- the version (Settings → About in the app) or commit you tested.

You'll get an answer within 7 days. We'll keep you updated, agree a
disclosure date with you (normally within 90 days, sooner once a fix
ships) and credit you in the advisory unless you'd rather not be named.

## Scope

In scope:

- the desktop app and everything in this repository: the protocol and
  cryptography, the client, the call host, the coordination server and the
  directory;
- the servers we run at `crocodilechat.com` and `coord.crocodilechat.com`,
  and the website.

What the design protects, and what it deliberately doesn't (for example
metadata visible to coordination servers), is described in the
[threat model](../docs/SECURITY.md). A way around a protection described
there is a vulnerability; a limitation it already lists is not.

Out of scope: denial of service by sheer volume, social engineering,
coordination servers run by other people, and issues that need an
already-compromised device.

## Good-faith research

Test against your own accounts and devices, or a local setup
(`pnpm qa:env` runs a whole network on one machine). Don't access other
people's data, and don't degrade the public servers for others. Research
done this way, and reported to us privately, is welcome: we won't take
action against you for it.

## Supported versions

Fixes go into the latest release; older versions don't get backported fixes.
On Windows, and on Linux with the AppImage, `.deb` or `.rpm`, the app updates
itself. On macOS, until builds are code-signed, the app tells you when a new
version is out and you install it yourself, so please do so promptly.
