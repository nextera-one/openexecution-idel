#!/usr/bin/env bash
# Install the IDEL Language VS Code extension from this checkout.
#
#   ./install.sh                 # install into ~/.vscode/extensions
#   ./install.sh --dir <path>    # install into a specific extensions directory
#
# The script builds @openexecution/structure if needed, bundles its parser
# into the extension, and copies the extension into the VS Code extensions
# directory. Restart VS Code (or run "Developer: Reload Window") afterwards.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STRUCTURE_DIST="${REPO_ROOT}/packages/structure/dist/index.js"

EXT_DIR="${HOME}/.vscode/extensions"
if [[ "${1:-}" == "--dir" ]]; then
  [[ -n "${2:-}" ]] || { echo "error: --dir requires a path" >&2; exit 2; }
  EXT_DIR="$2"
fi

NAME="$(node -p "require('${SCRIPT_DIR}/package.json').name")"
PUBLISHER="$(node -p "require('${SCRIPT_DIR}/package.json').publisher")"
VERSION="$(node -p "require('${SCRIPT_DIR}/package.json').version")"
TARGET="${EXT_DIR}/${PUBLISHER}.${NAME}-${VERSION}"

echo "==> IDEL Language ${VERSION}"

if [[ ! -f "${STRUCTURE_DIST}" ]]; then
  echo "==> building @openexecution/structure"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "${REPO_ROOT}" && pnpm --filter @openexecution/structure build)
  else
    (cd "${REPO_ROOT}" && npx tsc --build packages/structure)
  fi
fi
[[ -f "${STRUCTURE_DIST}" ]] || { echo "error: ${STRUCTURE_DIST} was not produced" >&2; exit 1; }

echo "==> bundling parser"
mkdir -p "${SCRIPT_DIR}/lib"
cp "${STRUCTURE_DIST}" "${SCRIPT_DIR}/lib/structure.mjs"

echo "==> validating extension entry point"
node --check "${SCRIPT_DIR}/src/extension.cjs"

echo "==> installing into ${TARGET}"
mkdir -p "${EXT_DIR}"
rm -rf "${EXT_DIR}/${PUBLISHER}.${NAME}-"*
mkdir -p "${TARGET}"
cp -R \
  "${SCRIPT_DIR}/package.json" \
  "${SCRIPT_DIR}/language-configuration.json" \
  "${SCRIPT_DIR}/README.md" \
  "${SCRIPT_DIR}/src" \
  "${SCRIPT_DIR}/lib" \
  "${SCRIPT_DIR}/syntaxes" \
  "${TARGET}/"

echo "==> installed. Restart VS Code or run \"Developer: Reload Window\" to activate."
