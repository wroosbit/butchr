#!/bin/bash
set -e

HOST_NAME="com.butchr.daemon"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"
HOST_PATH="$DAEMON_DIR/bin/native-host.sh"

# The extension ID is required: unpacked-extension IDs derive from the load
# path, so they differ per machine, and a baked-in default would silently
# authorize the wrong extension.
if [ -z "$1" ]; then
  echo "Usage: $0 <extension-id>" >&2
  echo "" >&2
  echo "Find the ID at chrome://extensions (enable Developer mode). For an" >&2
  echo "unpacked extension the ID is derived from its load path, so it is" >&2
  echo "different on every machine." >&2
  exit 1
fi

EXT_ID="$1"
if ! echo "$EXT_ID" | grep -Eq '^[a-p]{32}$'; then
  echo "Error: '$EXT_ID' does not look like a Chrome extension ID (32 chars, a-p)." >&2
  exit 1
fi

TARGET_DIR_CHROME="$HOME/.config/google-chrome/NativeMessagingHosts"
TARGET_DIR_CHROMIUM="$HOME/.config/chromium/NativeMessagingHosts"

mkdir -p "$TARGET_DIR_CHROME" "$TARGET_DIR_CHROMIUM"

# Create manifest template allowing the specified extension ID
cat << MANIFEST > "$TARGET_DIR_CHROME/$HOST_NAME.json"
{
  "name": "$HOST_NAME",
  "description": "Butchr Local Daemon Native Messaging Host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
MANIFEST

cp "$TARGET_DIR_CHROME/$HOST_NAME.json" "$TARGET_DIR_CHROMIUM/$HOST_NAME.json"

echo "✅ Installed Native Messaging Host manifest to:"
echo "   - $TARGET_DIR_CHROME/$HOST_NAME.json"
echo "   - $TARGET_DIR_CHROMIUM/$HOST_NAME.json"
