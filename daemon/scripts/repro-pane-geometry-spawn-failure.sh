#!/bin/bash
# Reproduces the `ghostty error -2` agent-spawn failure investigated in KAN-24.
#
# The failure was originally read as file-descriptor exhaustion. It is not.
# herdr sizes a new pane by splitting the workspace layout, and the layout is
# sized to the clients attached to it. A client that attaches reporting a tiny
# window shrinks the layout; once a new pane's share rounds to a zero
# dimension, libghostty refuses to build the terminal and herdr returns
#
#     {"error":{"code":"agent_start_failed","message":"ghostty error -2"}}
#
# ...for every spawn, until that client detaches.
#
# A pty opened without an explicit window size reports 1x1, which is why a
# diagnostic script driving `herdr agent attach` under `script`/`openpty`
# without an `stty` is enough to disable agent spawning for the whole session.
#
# This runs entirely against a private herdr server on its own socket, so it
# cannot disturb a live session. That matters: the bug it demonstrates breaks
# agent spawning for everyone sharing the server.
#
# Usage: daemon/scripts/repro-pane-geometry-spawn-failure.sh

set -uo pipefail

command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

# The socket path must fit in sockaddr_un.sun_path (~108 bytes), which rules
# out a mktemp -d under a long TMPDIR.
RUN_DIR="$(mktemp -d /tmp/herdr-k24-XXXXXX)"
STATE_DIR="$(mktemp -d)"
SOCKET="$RUN_DIR/h.sock"
LOG="$STATE_DIR/config/herdr/herdr-server.log"
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  sleep 0.5
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null
  rm -rf "$RUN_DIR" "$STATE_DIR"
}
trap cleanup EXIT

export HERDR_SOCKET_PATH="$SOCKET"
export XDG_CONFIG_HOME="$STATE_DIR/config"
export XDG_STATE_HOME="$STATE_DIR/state"
export HERDR_LOG=herdr=info
mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME"

echo "== starting a private herdr server (socket $SOCKET) =="
setsid herdr server >"$STATE_DIR/stdout.log" 2>&1 </dev/null &
SERVER_PID=$!
for _ in $(seq 1 20); do
  herdr pane list >/dev/null 2>&1 && break
  sleep 0.5
done
herdr pane list >/dev/null 2>&1 || { echo "server did not come up" >&2; exit 1; }

spawn_geometry() {
  grep 'pane.spawn.start' "$LOG" 2>/dev/null | tail -1 |
    grep -oE 'rows=[0-9]+ cols=[0-9]+'
}

echo
echo "== control: start an agent with nothing attached =="
herdr agent start probe-control --cwd /tmp -- bash -c 'while true; do sleep 5; done' \
  >/dev/null 2>&1 && echo "  agent start: OK" || echo "  agent start: FAILED"
echo "  pane geometry: $(spawn_geometry)"

echo
echo "== attach a client on a pty with no window size (reports 1x1) =="
# No `stty` here: reporting 1x1 is the whole point of this step.
script -q -c "herdr agent attach probe-control --takeover" /dev/null >/dev/null 2>&1 &
TINY_PID=$!
sleep 3
echo "  client connected as: $(grep 'terminal attach client connected' "$LOG" 2>/dev/null | tail -1 | grep -oE 'cols=[0-9]+ rows=[0-9]+')"

echo
echo "== now start a second agent, with that client still attached =="
OUT="$(herdr agent start probe-victim --cwd /tmp -- bash -c 'while true; do sleep 5; done' 2>&1)"
echo "  herdr said: $(echo "$OUT" | head -c 200)"
echo "  pane geometry: $(spawn_geometry)"

kill "$TINY_PID" 2>/dev/null
wait "$TINY_PID" 2>/dev/null
sleep 2

echo
echo "== after that client detaches, spawning works again =="
herdr agent start probe-recovered --cwd /tmp -- bash -c 'while true; do sleep 5; done' \
  >/dev/null 2>&1 && echo "  agent start: OK" || echo "  agent start: FAILED"
echo "  pane geometry: $(spawn_geometry)"

echo
echo "== fd accounting on this server (note how few — fds are not the cause) =="
echo "  open fds: $(ls "/proc/$SERVER_PID/fd" 2>/dev/null | wc -l), soft limit: $(awk '/Max open files/{print $4}' "/proc/$SERVER_PID/limits" 2>/dev/null)"

if echo "$OUT" | grep -q 'ghostty error -2'; then
  echo
  echo "REPRODUCED: a 1x1 client collapsed the layout and agent spawning failed with ghostty error -2."
  exit 0
fi

echo
echo "NOT REPRODUCED: the second agent started anyway; inspect $LOG."
exit 1
