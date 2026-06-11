#!/usr/bin/env bash
#
# run-ui.sh — build the workspace (if needed) and serve the IDEL web terminal.
#
# This is the one-liner for "show me the UI." It:
#   1. builds the TypeScript packages if `idel` isn't built yet,
#   2. starts `idel serve` bound to loopback, serving packages/web/public,
#   3. prints the URL (and opens it when --open is passed).
#
# The Claude console in the UI lights up automatically when ANTHROPIC_API_KEY is
# set in the environment; otherwise the terminal still runs every IDEL command
# through the full safety/policy/OpenLogs pipeline, just without "Ask Claude".
#
# Usage:
#   scripts/run-ui.sh                 # serve on http://127.0.0.1:7878
#   scripts/run-ui.sh --port 8080     # custom port
#   scripts/run-ui.sh --open          # also open the browser
#
# Pass-through: any extra flags after the script are forwarded to `idel serve`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDEL="$ROOT/packages/cli/bin/idel.js"
STATIC="$ROOT/packages/web/public"

if [[ ! -f "$IDEL" ]]; then
  echo "run-ui: CLI not built — running 'pnpm build'…" >&2
  ( cd "$ROOT" && corepack pnpm@10.0.0 build )
fi

if [[ ! -f "$STATIC/index.html" ]]; then
  echo "run-ui: web assets missing at $STATIC" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "run-ui: note — ANTHROPIC_API_KEY not set; the 'Ask Claude' console will be disabled." >&2
fi

echo "run-ui: serving the IDEL web terminal from $STATIC"
exec node "$IDEL" serve --static "$STATIC" "$@"
