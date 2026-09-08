#!/usr/bin/env bash
#
# Upgrade dependency ranges to latest, reinstall, audit-fix, then verify.
#
# Default mode follows this repo's packageManager (pnpm). Use --npm only when
# you intentionally want npm install / npm audit fix behavior.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="pnpm"
RUN_AUDIT_FIX=true
RUN_CHECKS=true
NCU_ARGS=()

usage() {
  cat <<'EOF'
Usage: scripts/upgrade-latest.sh [options] [-- npm-check-updates args...]

Update package.json dependency ranges to latest using npm-check-updates,
reinstall dependencies, run an audit fix, then build and test.

Options:
  --pnpm            Use pnpm install / pnpm audit --fix update. Default.
  --npm             Use npm install / npm audit fix.
  --no-audit-fix    Skip the audit fix step.
  --no-checks       Skip build and test after installing.
  -h, --help        Show this help.

Examples:
  pnpm upgrade:latest
  pnpm upgrade:latest -- --target minor
  pnpm upgrade:latest:npm
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pnpm)
      MODE="pnpm"
      shift
      ;;
    --npm)
      MODE="npm"
      shift
      ;;
    --no-audit-fix)
      RUN_AUDIT_FIX=false
      shift
      ;;
    --no-checks)
      RUN_CHECKS=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      NCU_ARGS+=("$@")
      break
      ;;
    *)
      NCU_ARGS+=("$1")
      shift
      ;;
  esac
done

cd "$ROOT"

pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "upgrade-latest: neither pnpm nor corepack is available." >&2
    exit 127
  fi
}

mapfile -t PACKAGE_FILES < <(
  find "$ROOT" \
    \( -path "$ROOT/.git" -o -path "$ROOT/node_modules" -o -path "$ROOT/dist" -o -path "$ROOT/packages/*/dist" \) -prune \
    -o -name package.json -type f -print | sort
)

if [[ "${#PACKAGE_FILES[@]}" -eq 0 ]]; then
  echo "upgrade-latest: no package.json files found." >&2
  exit 1
fi

for package_file in "${PACKAGE_FILES[@]}"; do
  rel="${package_file#"$ROOT"/}"
  echo "upgrade-latest: updating $rel"
  npx --yes npm-check-updates -u --packageFile "$package_file" "${NCU_ARGS[@]}"
done

if [[ "$MODE" == "npm" ]]; then
  npm install
  if [[ "$RUN_AUDIT_FIX" == true ]]; then
    npm audit fix
  fi
  if [[ "$RUN_CHECKS" == true ]]; then
    npm run build
    npm test
  fi
else
  pnpm_cmd install
  if [[ "$RUN_AUDIT_FIX" == true ]]; then
    pnpm_cmd audit --fix update
  fi
  if [[ "$RUN_CHECKS" == true ]]; then
    pnpm_cmd build
    pnpm_cmd test
  fi
fi

echo "upgrade-latest: done"
