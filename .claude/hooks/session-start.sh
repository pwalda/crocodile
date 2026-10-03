#!/bin/bash
# Claude Code on the web: install workspace dependencies so `pnpm check`
# (typecheck, lint, format, tests) works as soon as the session starts.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null
fi

# `install` (not a frozen install) so the cached container state is reused.
if ! pnpm install --prefer-offline; then
  # Some sandboxes cannot download the Electron binary; everything except the
  # Electron smoke test still works without it.
  echo "Retrying without the Electron binary download" >&2
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --prefer-offline
fi
