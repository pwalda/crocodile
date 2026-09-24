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

| Option         | Env               | Default                        |
| -------------- | ----------------- | ------------------------------ |
| `--name`       | `CROC_NAME`       | Crocodile coordinator          |
| `--port`       | `CROC_PORT`       | 7443                           |
| `--public-url` | `CROC_PUBLIC_URL` | `http://<host>:<port>`         |
| `--data-dir`   | `CROC_DATA_DIR`   | `.crocodile-data`              |
| `--directory`  | `CROC_DIRECTORY`  | none                           |
| `--peers`      | `CROC_PEERS`      | none (static mesh peers)       |
| `--stun-port`  | `CROC_STUN_PORT`  | same as port, `off` to disable |
| `--private`    | `CROC_PRIVATE=1`  | announce to directory          |

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
