#!/usr/bin/env bash
# Uninstall the IDEL Language VS Code extension.
#
#   ./uninstall.sh               # remove from ~/.vscode/extensions
#   ./uninstall.sh --dir <path>  # remove from a specific extensions directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXT_DIR="${HOME}/.vscode/extensions"
if [[ "${1:-}" == "--dir" ]]; then
  [[ -n "${2:-}" ]] || { echo "error: --dir requires a path" >&2; exit 2; }
  EXT_DIR="$2"
fi

NAME="$(node -p "require('${SCRIPT_DIR}/package.json').name")"
PUBLISHER="$(node -p "require('${SCRIPT_DIR}/package.json').publisher")"

REMOVED=0
for target in "${EXT_DIR}/${PUBLISHER}.${NAME}-"*; do
  if [[ -d "${target}" ]]; then
    rm -rf "${target}"
    echo "==> removed ${target}"
    REMOVED=1
  fi
done

if [[ "${REMOVED}" -eq 0 ]]; then
  echo "==> nothing to remove in ${EXT_DIR}"
else
  echo "==> uninstalled. Restart VS Code to finish."
fi
