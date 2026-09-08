#!/usr/bin/env bash
#
# run-ui.sh — build the workspace (if needed) and serve the IDEL web terminal.
#
# This is the one-liner for "show me the UI." It:
#   1. builds the TypeScript packages if `idel` isn't built yet,
#   2. starts `idel serve` bound to loopback with authenticated APIs,
#   3. prints the URL (and opens it when --open is passed).
#
# The AI console lights up when Claude Code or an Anthropic, OpenAI, or Gemini
# API key is configured. Credentials remain in this host process.
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
    corepack pnpm@11.7.0 build
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

node "$ROOT/scripts/sync-xterm-assets.mjs"

if [[ ! -f "$STATIC/index.html" ]]; then
  echo "run-ui: web assets missing at $STATIC" >&2
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}" ]] && ! command -v claude >/dev/null 2>&1; then
  echo "run-ui: note — no Ask AI provider configured; use Claude Code, ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY." >&2
fi

echo "run-ui: serving the IDEL web terminal from $STATIC"
exec node "$IDEL" serve --static "$STATIC" "$@"
