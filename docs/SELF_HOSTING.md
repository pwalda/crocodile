# Running a coordination server

Coordination servers are the volunteer backbone of Crocodile. They store
signed public metadata, keep track of who is online, relay WebRTC signalling
and elect session hosts. **They never carry voice or messages.** A small VPS
(1 vCPU, 512 MB) handles thousands of users.

## From the desktop app

Settings → **Host a Server** → _Run a coordination server_. For internet
use, forward TCP+UDP port 7443 on your router to your computer, then enter
your public address (e.g. `http://203.0.113.7:7443`). Enable _List in the
public directory_ to let others use it. Without a public address it serves
your local network.

## With Docker

```sh
git clone https://github.com/pwalda/crocodile && cd crocodile
CROC_NAME="Swamp EU-1" \
CROC_PUBLIC_URL=https://croc.example.org \
CROC_DIRECTORY=https://directory.example.org \
CROC_REGION=eu-west \
docker compose up -d coordinator
```

Expose **TCP 7443** (HTTP + WebSocket) and **UDP 7443** (STUN). For HTTPS,
put a reverse proxy (Caddy, nginx, Traefik) in front of TCP 7443 with
WebSocket upgrades enabled, and set `CROC_PUBLIC_URL` to the https URL. Keep
UDP 7443 open directly.

Example Caddyfile:

```
croc.example.org {
  reverse_proxy 127.0.0.1:7443
}
```

## Without Docker

```sh
pnpm install && pnpm --filter @crocodile/coordinator build
node packages/coordinator/dist/bin.js --help
```

| Option                     | Env                          | Default                          |
| -------------------------- | ---------------------------- | -------------------------------- |
| `--name`                   | `CROC_NAME`                  | Crocodile coordinator            |
| `--port`                   | `CROC_PORT`                  | 7443                             |
| `--public-url`             | `CROC_PUBLIC_URL`            | `http://<host>:<port>`           |
| `--data-dir`               | `CROC_DATA_DIR`              | `.crocodile-data`                |
| `--directory`              | `CROC_DIRECTORY`             | none                             |
| `--peers`                  | `CROC_PEERS`                 | none (static mesh peers)         |
| `--stun-port`              | `CROC_STUN_PORT`             | same as port, `off` to disable   |
| `--private`                | `CROC_PRIVATE=1`             | announce to directory            |
| `--relay`                  | `CROC_RELAY`                 | `on` (`off` to disable)          |
| `--relay-max-users`        | `CROC_RELAY_MAX_USERS`       | 25                               |
| `--relay-ip`               | `CROC_RELAY_IP`              | public IP from `--public-url`    |
| `--mailbox`                | `CROC_MAILBOX`               | `on` (`off` to disable)          |
| `--mailbox-days`           | `CROC_MAILBOX_DAYS`          | 3 (max 7)                        |
| `--relay-allow-private`    | `CROC_RELAY_ALLOW_PRIVATE=1` | off (LAN-only setups)            |
| `--max-connections-per-ip` | `CROC_MAX_CONN_PER_IP`       | 50                               |
| `--trust-proxy`            | `CROC_TRUST_PROXY=1`         | off (set behind a reverse proxy) |

### The opt-in mailbox

Users who opt in can leave direct messages for friends who are offline. Your
server stores them as boxes sealed to the recipient's devices (it cannot read
them) until the recipient connects anywhere in the mesh or `--mailbox-days`
pass. Quotas per sender and recipient keep storage bounded (a few MB per
thousand messages). Turn it off with `--mailbox off`.

### The opt-in relay

Some users sit behind networks that block direct connections. If they turn
on "Relay through a coordination server", your server can relay their
already end-to-end encrypted media over the STUN UDP port (TURN). Each
grant lasts at most one hour, `--relay-max-users` caps how many people use
it at once, and each allocation is rate-limited (about 100 kbit/s of voice
per person). Your server only ever sees ciphertext. Turn it off with
`--relay off` if bandwidth is scarce. The desktop app's built-in server
leaves it off unless you enable "Offer a relay".

## Hosting safely

**Why port 7443?** It's an unprivileged port (no administrator rights needed
to open it), it reads as "an alternative HTTPS port" to firewalls and
people, and one number serves both TCP (HTTP/WebSocket) and UDP (STUN and the
relay), so there is only one port to forward. Any port works (`--port`); the
main server puts the TCP side behind Caddy on 443.

**What sharing your server's address exposes:**

- **Your public IP address.** It reveals your approximate location and
  internet provider, and makes you a target for denial-of-service attacks
  (someone flooding your connection). If you list the server in the
  directory, the address is public. Calls already expose IP addresses
  between the people in them (that is how peer-to-peer works), but a server
  address is shared with everyone who connects.
- **A program listening on the internet.** Any bug in it could be attacked.
  The server validates every message, limits sizes and rates, caps
  connections per address (`--max-connections-per-ip`) and in total
  (`--capacity`), and times out connections that don't authenticate. The
  built-in relay refuses to send traffic to your own machine or your private
  network (loopback, 10/8, 172.16/12, 192.168/16, link-local, CGNAT, IPv6
  ULA and similar), so relay users cannot reach your router or other home
  devices through it.
- **Metadata of the people using it.** Your server sees who is online, who
  talks to whom and when, and public profiles. Never message content. In
  many countries (e.g. the EU's GDPR) this makes you responsible for handling
  that data sensibly.

**Recommendations:**

- For friends on your network, the desktop app's server is fine: nothing is
  exposed to the internet unless you forward the port.
- For a public server, prefer a small VPS or a separate machine with Docker
  over the computer you use every day, so a compromise doesn't reach your
  files. Keep it updated (`docker compose pull && docker compose up -d`).
- Only forward the one port (TCP+UDP 7443). Don't put the machine in your
  router's "DMZ".
- If your home IP is sensitive, host on a VPS or behind a reverse proxy
  instead of sharing it.

## The main server

`deploy/main/` runs the product page, the directory, the install scripts and
a first coordinator behind Caddy with automatic HTTPS. See
[deploy/main/README.md](../deploy/main/README.md).

## Running a directory

The directory is tiny: `docker compose --profile directory up -d directory`
(port 7400). Point coordinators at it with `CROC_DIRECTORY` and build the app
with `CROC_DIRECTORIES=https://your-directory` to make it the default.
Directories verify that each registered server is reachable at its advertised
URL, and drop servers that stop sending heartbeats.

## Private networks

For a LAN-only or company-internal setup, run a directory with
`CROC_DIR_ALLOW_PRIVATE=1` and coordinators with `--private` or private
URLs, or skip the directory entirely: users add the server under
Settings → Connection → Preferred servers.
