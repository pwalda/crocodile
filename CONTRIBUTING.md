# Contributing to Crocodile

Thanks for helping! A few things to know before you open a pull request.

## Contributor License Agreement

Every contributor signs the [CLA](CLA.md) once. When you open your first pull
request, a bot asks you to comment:

> I have read the CLA Document and I hereby sign the CLA

That's all. The CLA lets the project stay open source while keeping the
option to offer commercial licenses, and it guarantees your contribution
stays available under an open-source license.

## Licenses

| Part                                                                                           | License       |
| ---------------------------------------------------------------------------------------------- | ------------- |
| `packages/protocol`, `packages/crypto`                                                         | Apache-2.0    |
| everything else (client core, call host, desktop app, coordination server, directory, scripts) | AGPL-3.0-only |

The wire formats and crypto building blocks are permissive so anyone can
build compatible clients and bots. Everything else is AGPL so improvements,
including ones run as a service, come back to everyone. The maintainer also
offers commercial licences; see [COMMERCIAL.md](COMMERCIAL.md).

## Development

See the [README](README.md#development). Before pushing:

```sh
pnpm typecheck
pnpm format:check
pnpm test
```

UI changes: run the Electron smoke test
(`xvfb-run -a npx tsx tests/electron/smoke.ts /tmp/shots`) and look at the
screenshots.

## Security

Please report vulnerabilities privately to the maintainer (GitHub security
advisories on this repository), not in public issues. See
[docs/SECURITY.md](docs/SECURITY.md).

## Trademarks

The code is open; the name and logo are not. See [TRADEMARKS.md](TRADEMARKS.md).
