#!/usr/bin/env sh
set -eu

EXT_PUBLISHER="nextera-one"
EXT_NAME="openexecution-idel-vscode"
EXT_VERSION="0.2.0"
EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-${EXT_VERSION}"
PREVIOUS_EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-0.1.0"

TARGET_BASE="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
TARGET_DIR="$TARGET_BASE/$EXT_FOLDER"
TMP_DIR="$TARGET_BASE/.${EXT_FOLDER}.tmp"
PREVIOUS_TARGET="$TARGET_BASE/$PREVIOUS_EXT_FOLDER"

echo "Uninstalling OpenExecution IDEL VS Code extension..."
echo "Target: $TARGET_DIR"

rm -rf "$TMP_DIR"

if [ ! -e "$TARGET_DIR" ] && [ ! -e "$PREVIOUS_TARGET" ]; then
  echo
  echo "Nothing to remove. Extension was not found at: $TARGET_DIR"
  exit 0
fi

rm -rf "$TARGET_DIR"
if [ -e "$PREVIOUS_TARGET" ]; then
  rm -rf "$PREVIOUS_TARGET"
fi

echo
echo "Removed: $TARGET_DIR"
echo "Reload VS Code to finish uninstalling the extension."
echo
echo "To uninstall from another VS Code-compatible profile, set:"
echo "  VSCODE_EXTENSIONS_DIR=/path/to/extensions $0"
