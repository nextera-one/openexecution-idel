#!/usr/bin/env bash
#
# install-local.sh — build the workspace and make `idel` runnable on this machine.
#
# This is the supported V1 install path (spec §31 "developer can install and run
# idel locally"). It installs dependencies, builds all packages, and symlinks the
# `idel` binary onto your PATH via `npm link`.
#
# Note: a fully decoupled `npm install -g @openexecution/cli` from a clean machine
# additionally requires `@nextera.one/tps-standard@0.8.1` to be published to npm
# (this repo currently vendors it via a pnpm override). See CONCERNS.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "install-local: pnpm is required (https://pnpm.io/installation)." >&2
  exit 1
fi

echo "install-local: installing dependencies…"
pnpm install

echo "install-local: building all packages…"
pnpm build

echo "install-local: linking the idel binary onto PATH…"
cd "$ROOT/packages/cli"
npm link

echo
echo "install-local: done. Try:"
echo "  idel --version"
echo "  idel remove.folder name=/ recursive=true force=true   # → BLOCKED"
echo "  idel terminal"
