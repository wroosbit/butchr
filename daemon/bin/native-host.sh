#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"

# Chrome launches this host with a minimal environment; find node wherever
# it lives instead of pinning a specific nvm version.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local latest
    latest="$(ls -v "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)"
    if [ -n "$latest" ] && [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ]; then
      echo "$HOME/.nvm/versions/node/$latest/bin/node"
      return
    fi
  fi
  local candidate
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done
  # Last resort: let exec fail with a clear error in the log below.
  echo "node"
}

NODE_BIN="$(find_node)"

exec "$NODE_BIN" "$DAEMON_DIR/dist/native-host.js" "$@" 2>> /tmp/native-host-sh.log
