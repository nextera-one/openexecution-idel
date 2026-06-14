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
IDEL_DIST="$ROOT/packages/cli/dist/main.js"
STATIC="$ROOT/packages/web/public"

if ! command -v node >/dev/null 2>&1 && [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "run-ui: node not found; install Node >=22.3 or load it before running this script." >&2
  exit 127
fi

build_workspace() {
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm@10.0.0 build
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm build
  else
    echo "run-ui: neither corepack nor pnpm was found; cannot build the workspace." >&2
    exit 127
  fi
}

needs_build=false
if [[ ! -f "$IDEL" || ! -f "$IDEL_DIST" ]]; then
  needs_build=true
elif find "$ROOT/packages" -path '*/src/*' -type f \( -name '*.ts' -o -name '*.tsx' \) -newer "$IDEL_DIST" -print -quit | grep -q .; then
  needs_build=true
fi

if [[ "$needs_build" == true ]]; then
  echo "run-ui: CLI build missing or stale — running 'pnpm build'…" >&2
  ( cd "$ROOT" && build_workspace )
fi

if [[ ! -f "$STATIC/index.html" ]]; then
  echo "run-ui: web assets missing at $STATIC" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && ! command -v claude >/dev/null 2>&1; then
  echo "run-ui: note — no claude CLI and ANTHROPIC_API_KEY not set; the Ask AI console will be disabled." >&2
elif [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "run-ui: note — ANTHROPIC_API_KEY not set; Ask AI will use Claude Code if 'claude login' is active." >&2
fi

echo "run-ui: serving the IDEL web terminal from $STATIC"
exec node "$IDEL" serve --static "$STATIC" "$@"
