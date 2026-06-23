#!/usr/bin/env sh
set -eu

EXT_PUBLISHER="nextera-one"
EXT_NAME="openexecution-idel-vscode"
EXT_VERSION="0.1.0"
EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-${EXT_VERSION}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
EXT_SRC="$ROOT_DIR/packages/vscode-extension"

if [ ! -f "$EXT_SRC/package.json" ]; then
  echo "Could not find VS Code extension source at: $EXT_SRC" >&2
  exit 1
fi

TARGET_BASE="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
TARGET_DIR="$TARGET_BASE/$EXT_FOLDER"
TMP_DIR="$TARGET_BASE/.${EXT_FOLDER}.tmp"

detect_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if command -v nodejs >/dev/null 2>&1; then
    command -v nodejs
    return 0
  fi
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/share/mise/shims/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    /bin/node
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

echo "Installing OpenExecution IDEL VS Code extension..."
echo "Source: $EXT_SRC"
echo "Target: $TARGET_DIR"

mkdir -p "$TARGET_BASE"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

cp "$EXT_SRC/package.json" "$TMP_DIR/package.json"
cp "$EXT_SRC/README.md" "$TMP_DIR/README.md"
cp -R "$EXT_SRC/src" "$TMP_DIR/src"
cp -R "$EXT_SRC/resources" "$TMP_DIR/resources"

if NODE_BIN=$(detect_node); then
  NODE_JSON=$(printf '%s' "$NODE_BIN" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{\n  "nodePath": "%s"\n}\n' "$NODE_JSON" > "$TMP_DIR/node-path.json"
  echo "Detected Node: $NODE_BIN"
else
  echo "Warning: Node was not found. Set openexecutionIdel.nodePath in VS Code if the extension cannot start." >&2
fi

rm -rf "$TARGET_DIR"
mv "$TMP_DIR" "$TARGET_DIR"

echo
echo "Installed: $TARGET_DIR"
echo "Reload VS Code, then run: IDEL: Open Terminal"
echo
echo "To install into another VS Code-compatible profile, set:"
echo "  VSCODE_EXTENSIONS_DIR=/path/to/extensions $0"
