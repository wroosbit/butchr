#!/bin/bash
set -e

# Include NVM and standard user paths in PATH
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:$PATH:/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"

NODE_BIN="$(which node 2>/dev/null || echo "node")"

exec "$NODE_BIN" "$DAEMON_DIR/dist/native-host.js" "$@" 2>> /tmp/native-host-sh.log
