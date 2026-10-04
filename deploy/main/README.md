# Main server

One machine runs everything the public Crocodile network needs from "us":

| What                      | Where                                       | Notes                                               |
| ------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Website                   | `https://DOMAIN/`                           | the website, or `placeholder/` until it is deployed |
| Server directory          | `https://DOMAIN/v1/servers`                 | what the apps query to find servers                 |
| One-line installers       | `https://DOMAIN/install.sh`, `/install.ps1` | served from `scripts/`                              |
| First coordination server | `https://coord.DOMAIN`, UDP 7443 and 7444   | STUN, opt-in relay and mailbox on                   |

The directory and coordination server run in Docker
([docker-compose.yml](docker-compose.yml)). HTTPS, the installers and the
website come from the reverse proxy already running on the machine.

## Set up

1. A small VPS (1 vCPU, 1 GB RAM is plenty to start) with Docker and a
   reverse proxy that handles HTTPS.
2. DNS: `A`/`AAAA` records for `DOMAIN` and `coord.DOMAIN` pointing to it.
3. Firewall: TCP 80 and 443 (the proxy), UDP 7443 (STUN and relay) and UDP 7444 (STUN, for NAT detection). Do
   **not** open TCP 7400 or 7443: those services listen on 127.0.0.1 and must
   only be reached through the proxy.
4. On the server:

   ```sh
   git clone https://github.com/pwalda/crocodile && cd crocodile/deploy/main
   cp .env.example .env   # set CROC_DOMAIN and CROC_RELAY_IP
   docker compose up -d --build
   ```

5. Route these in the reverse proxy (with HTTPS):

   | Request                                   | Goes to                                                                              |
   | ----------------------------------------- | ------------------------------------------------------------------------------------ |
   | `DOMAIN/v1/*` and `DOMAIN/health`         | `http://127.0.0.1:7400` (directory)                                                  |
   | `DOMAIN/install.sh`, `DOMAIN/install.ps1` | files in `scripts/` of the clone, as `text/plain`                                    |
   | everything else on `DOMAIN`               | the website's `public/` folder (private repo `crocodile-website`), or `placeholder/` |
   | `coord.DOMAIN` (all paths, WebSocket too) | `http://127.0.0.1:7443` (coordinator)                                                |

   The proxy must add the client's address to `X-Forwarded-For` (appending
   or replacing both work) and be the only hop in front of the coordinator:
   the coordinator takes the last entry, the one the proxy added, for its
   per-address limits.

Check that `https://DOMAIN/v1/servers` lists the coordinator after a minute,
and that `https://coord.DOMAIN/health` answers.

## The default in the apps

Apps built from this repository use `https://crocodilechat.com` as their
server directory (set in `apps/desktop/scripts/build.mjs`). A build can use
other directories by setting `CROC_DIRECTORIES` to a comma-separated list of
URLs (for releases: the repository variable under GitHub → Settings →
Secrets and variables → Actions → Variables), or `none` for no default. Users
can still add other servers under Settings → Network.

## Updating

```sh
git pull && docker compose up -d --build
```

The placeholder page and install scripts update with `git pull` alone (the
proxy serves them straight from the clone).

## Load and privacy

The directory only sees coordination servers registering and apps fetching
the list. The coordinator sees metadata (who is online, who talks to whom)
but never message or voice content; relayed traffic and mailbox items are
end-to-end encrypted. Relay users are capped (`CROC_RELAY_MAX_USERS`) and
mailbox items expire after `CROC_MAILBOX_DAYS` (max 7).
