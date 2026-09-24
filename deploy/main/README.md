# Main server

One machine runs everything the public Crocodile network needs from "us":

| What                      | Where                                       | Notes                                 |
| ------------------------- | ------------------------------------------- | ------------------------------------- |
| Product page              | `https://DOMAIN/`                           | `site/` (static, no trackers or CDNs) |
| Server directory          | `https://DOMAIN/v1/servers`                 | what the apps query to find servers   |
| One-line installers       | `https://DOMAIN/install.sh`, `/install.ps1` | served from `scripts/`                |
| First coordination server | `https://coord.DOMAIN`, UDP 7443            | STUN, opt-in relay and mailbox on     |

## Set up

1. A small VPS (1 vCPU, 1 GB RAM is plenty to start) with Docker.
2. DNS: `A`/`AAAA` records for `DOMAIN` and `coord.DOMAIN` pointing to it.
3. Firewall: TCP 80 and 443, TCP+UDP 7443.
4. On the server:

   ```sh
   git clone https://github.com/pwalda/crocodile && cd crocodile/deploy/main
   cp .env.example .env   # set CROC_DOMAIN and CROC_EMAIL
   docker compose up -d --build
   ```

Caddy obtains HTTPS certificates automatically. Check
`https://DOMAIN/v1/servers` lists the coordinator after a minute.

## Make it the default in the apps

Set the repository variable `CROC_DIRECTORIES` (GitHub → Settings → Secrets
and variables → Actions → Variables) to `https://DOMAIN`. Every release built
afterwards uses it. Users can still add other servers under
Settings → Network.

## Updating

```sh
git pull && docker compose up -d --build
```

The product page and install scripts update with `git pull` alone (they are
mounted read-only into Caddy).

## Load and privacy

The directory only sees coordination servers registering and apps fetching
the list. The coordinator sees metadata (who is online, who talks to whom)
but never message or voice content; relayed traffic and mailbox items are
end-to-end encrypted. Relay users are capped (`CROC_RELAY_MAX_USERS`) and
mailbox items expire after `CROC_MAILBOX_DAYS` (max 7).
