# Crocodile — notes for coding agents

Peer-to-peer, end-to-end encrypted voice and text chat. TypeScript pnpm
monorepo. Read `ARCHITECTURE.md` for the design and `docs/SECURITY.md` for
the threat model before changing protocol, crypto or server code.

## Layout

- `packages/protocol` wire formats (zod) · `packages/crypto` keys, sealed
  boxes, ratchets · `packages/client-core` the client (UI-agnostic) ·
  `packages/relay` host SFU · `packages/coordinator` coordination server ·
  `apps/directory` server directory · `apps/desktop` Electron + React UI ·
  `tests/` integration, browser and Electron tests · `deploy/main/` main
  server. The product website lives in a separate repository.

## Commands

```sh
pnpm check                              # typecheck + lint + format + tests (run before every push)
pnpm test / pnpm test:coverage
pnpm vitest run tests/client.test.ts -t "fails over"
pnpm format                             # prettier --write .
node apps/desktop/scripts/build.mjs     # build the desktop app
xvfb-run -a pnpm qa:smoke /tmp/shots    # Electron smoke test (look at the screenshots for UI changes)
pnpm qa:env / pnpm qa:app alice bob     # local QA network and app instances
```

See `docs/QA.md` for the test layers, manual matrix and release checklist.

## Rules

- **Invariant:** message and voice content never passes through or is stored
  on coordination servers, except the user-opted-in relay and mailbox, which
  only ever carry end-to-end encrypted payloads. Don't add server features
  that see content.
- Every bug fix gets a test that fails without it. Prefer integration tests
  with real coordinators and `FakeRelayNetwork` over mocks. Never skip or
  loosen a failing test.
- Keep coverage thresholds (`vitest.config.ts`) as a ratchet: raise, never lower.
- UI: select elements in tests by role/label/text. Colours come from the
  theme tokens in `apps/desktop/src/renderer/styles.css`.
- Network-facing server code: validate input with zod schemas in
  `packages/protocol`, rate-limit per connection, and keep the relay's
  private-address filter (`isForbiddenPeerAddress` in `turn.ts`).
- Licenses: `packages/{protocol,crypto}` are Apache-2.0; everything else
  (including `client-core` and `relay`) is AGPL-3.0. Don't move AGPL code
  into the Apache packages. See `CONTRIBUTING.md` (Licenses) for why.

## Git and GitHub

- Work on a branch and open a PR to `main`; CI (tests, lint, Electron E2E,
  builds, CodeQL) and the CLA check must pass. First-time contributors sign
  the CLA (see `CONTRIBUTING.md`).
- Fill in the PR template, including how the change was tested.
- Workflows: keep tokens read-only unless a job needs more, and pin new
  actions to a commit SHA with the version as a comment.
- Personal preferences (commit identity, attribution lines) belong in your
  own `CLAUDE.local.md` or user-level memory, not in this file.
