#!/usr/bin/env sh
set -eu

EXT_PUBLISHER="nextera-one"
EXT_NAME="openexecution-idel-vscode"
EXT_VERSION="0.2.0"
EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-${EXT_VERSION}"
PREVIOUS_EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-0.1.0"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
EXT_SRC="$ROOT_DIR/packages/vscode-extension"
STRUCTURE_SRC="$ROOT_DIR/packages/structure"
STRUCTURE_DIST="$STRUCTURE_SRC/dist"

if [ ! -f "$EXT_SRC/package.json" ]; then
  echo "Could not find VS Code extension source at: $EXT_SRC" >&2
  exit 1
fi
if [ ! -f "$STRUCTURE_DIST/index.js" ]; then
  echo "IDEL Structure runtime is not built: $STRUCTURE_DIST/index.js" >&2
  echo "Run the workspace build, then rerun this installer." >&2
  exit 1
fi

TARGET_BASE="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
TARGET_DIR="$TARGET_BASE/$EXT_FOLDER"
TMP_DIR="$TARGET_BASE/.${EXT_FOLDER}.tmp"

detect_node() {
  PATH_NODE=$(command -v node 2>/dev/null || true)
  PATH_NODEJS=$(command -v nodejs 2>/dev/null || true)
  for candidate in \
    "$PATH_NODE" \
    "$PATH_NODEJS" \
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
    if [ -n "$candidate" ] &&
       [ -x "$candidate" ] &&
       "$candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 3) ? 0 : 1)' >/dev/null 2>&1
    then
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
mkdir -p "$TMP_DIR/runtime/structure"
cp -R "$STRUCTURE_DIST"/. "$TMP_DIR/runtime/structure/"
cp "$STRUCTURE_SRC/package.json" "$TMP_DIR/runtime/structure/package.json"

if NODE_BIN=$(detect_node); then
  NODE_JSON=$(printf '%s' "$NODE_BIN" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{\n  "nodePath": "%s"\n}\n' "$NODE_JSON" > "$TMP_DIR/node-path.json"
  echo "Detected Node: $NODE_BIN"
else
  echo "Warning: Node >=22.3 was not found. Language editing works, but set openexecutionIdel.nodePath before starting the terminal server." >&2
fi

rm -rf "$TARGET_DIR"
mv "$TMP_DIR" "$TARGET_DIR"
PREVIOUS_TARGET="$TARGET_BASE/$PREVIOUS_EXT_FOLDER"
if [ -d "$PREVIOUS_TARGET" ]; then
  rm -rf "$PREVIOUS_TARGET"
fi

echo
echo "Installed: $TARGET_DIR"
echo "Reload VS Code, then open any .idel file for coloring, diagnostics, and autocomplete."
echo
echo "To install into another VS Code-compatible profile, set:"
echo "  VSCODE_EXTENSIONS_DIR=/path/to/extensions $0"
