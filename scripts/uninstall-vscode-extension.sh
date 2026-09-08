#!/usr/bin/env sh
set -eu

EXT_PUBLISHER="nextera-one"
EXT_NAME="openexecution-idel-vscode"
EXT_VERSION="0.1.0"
EXT_FOLDER="${EXT_PUBLISHER}.${EXT_NAME}-${EXT_VERSION}"

TARGET_BASE="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
TARGET_DIR="$TARGET_BASE/$EXT_FOLDER"
TMP_DIR="$TARGET_BASE/.${EXT_FOLDER}.tmp"

echo "Uninstalling OpenExecution IDEL VS Code extension..."
echo "Target: $TARGET_DIR"

rm -rf "$TMP_DIR"

if [ ! -e "$TARGET_DIR" ]; then
  echo
  echo "Nothing to remove. Extension was not found at: $TARGET_DIR"
  exit 0
fi

rm -rf "$TARGET_DIR"

echo
echo "Removed: $TARGET_DIR"
echo "Reload VS Code to finish uninstalling the extension."
echo
echo "To uninstall from another VS Code-compatible profile, set:"
echo "  VSCODE_EXTENSIONS_DIR=/path/to/extensions $0"
