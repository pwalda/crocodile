# Main server

One machine runs everything the public Crocodile network needs from "us":

| What                      | Where                                       | Notes                                    |
| ------------------------- | ------------------------------------------- | ---------------------------------------- |
| Website                   | `https://DOMAIN/`                           | a "work in progress" placeholder for now |
| Server directory          | `https://DOMAIN/v1/servers`                 | what the apps query to find servers      |
| One-line installers       | `https://DOMAIN/install.sh`, `/install.ps1` | served from `scripts/`                   |
| First coordination server | `https://coord.DOMAIN`, UDP 7443            | STUN, opt-in relay and mailbox on        |

The directory and coordination server run in Docker
([docker-compose.yml](docker-compose.yml)). HTTPS, the installers and the
website come from the Caddy already running on the machine
([Caddyfile.example](Caddyfile.example)).

## Set up

1. A small VPS (1 vCPU, 1 GB RAM is plenty to start) with Docker and Caddy.
2. DNS: `A`/`AAAA` records for `DOMAIN` and `coord.DOMAIN` pointing to it.
3. Firewall: TCP 80 and 443 (Caddy), UDP 7443 (STUN and relay). Do **not**
   open TCP 7400 or 7443: those services listen on 127.0.0.1 and must only be
   reached through Caddy.
4. On the server:

   ```sh
   git clone https://github.com/pwalda/crocodile && cd crocodile/deploy/main
   cp .env.example .env   # set CROC_DOMAIN and CROC_RELAY_IP
   docker compose up -d --build
   ```

5. Add the site blocks from [Caddyfile.example](Caddyfile.example) to your
   Caddyfile, with `/opt/crocodile` replaced by the path of the clone, and
   reload Caddy (`systemctl reload caddy`).

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

The placeholder page and install scripts update with `git pull` alone (Caddy
serves them straight from the clone).

## Load and privacy

The directory only sees coordination servers registering and apps fetching
the list. The coordinator sees metadata (who is online, who talks to whom)
but never message or voice content; relayed traffic and mailbox items are
end-to-end encrypted. Relay users are capped (`CROC_RELAY_MAX_USERS`) and
mailbox items expire after `CROC_MAILBOX_DAYS` (max 7).
