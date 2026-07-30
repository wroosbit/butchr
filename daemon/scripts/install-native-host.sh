#!/bin/bash
set -e

HOST_NAME="com.butchr.daemon"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"
HOST_PATH="$DAEMON_DIR/bin/native-host.js"

TARGET_DIR_CHROME="$HOME/.config/google-chrome/NativeMessagingHosts"
TARGET_DIR_CHROMIUM="$HOME/.config/chromium/NativeMessagingHosts"

mkdir -p "$TARGET_DIR_CHROME" "$TARGET_DIR_CHROMIUM"

# Create manifest template allowing all extensions in dev mode
cat << MANIFEST > "$TARGET_DIR_CHROME/$HOST_NAME.json"
{
  "name": "$HOST_NAME",
  "description": "Butchr Local Daemon Native Messaging Host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://*/"
  ]
}
MANIFEST

cp "$TARGET_DIR_CHROME/$HOST_NAME.json" "$TARGET_DIR_CHROMIUM/$HOST_NAME.json"

echo "✅ Installed Native Messaging Host manifest to:"
echo "   - $TARGET_DIR_CHROME/$HOST_NAME.json"
echo "   - $TARGET_DIR_CHROMIUM/$HOST_NAME.json"
