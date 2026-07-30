#!/bin/bash
set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/native-host-sh.log"

# Chrome launches this host with a minimal environment (no nvm in PATH).
# Candidates are version-gated: the daemon needs modern node (>=18), and a
# system /usr/bin/node can be ancient — v12 dies on modern syntax, silently.
MIN_MAJOR=18

node_ok() {
  local major
  major="$("$1" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null
}

find_node() {
  local candidate v
  if command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
    if node_ok "$candidate"; then echo "$candidate"; return; fi
  fi
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for v in $(ls -v "$HOME/.nvm/versions/node" 2>/dev/null | tac); do
      candidate="$HOME/.nvm/versions/node/$v/bin/node"
      if [ -x "$candidate" ] && node_ok "$candidate"; then echo "$candidate"; return; fi
    done
  fi
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$candidate" ] && node_ok "$candidate"; then echo "$candidate"; return; fi
  done
  # Last resort: let exec fail with a clear error in the log below.
  echo "node"
}

NODE_BIN="$(find_node)"
echo "[native-host.sh] $(date -Is) using node: $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo 'unknown'))" >> "$LOG_FILE"

exec "$NODE_BIN" "$DAEMON_DIR/dist/native-host.js" "$@" 2>> "$LOG_FILE"
