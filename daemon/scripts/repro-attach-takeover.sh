#!/bin/bash
# Reproduces the "terminal attach taken over" freeze reported in KAN-16.
#
# `herdr agent attach <name> --takeover` evicts whoever already holds that
# agent's terminal attach. The evicted client prints
#
#     herdr: server shut down: terminal attach taken over
#
# and exits. In Butchr the evicted client is the PTY behind a live sidepanel,
# so the pane stops updating and keeps rendering its last frame — the freeze.
#
# This script drives two attaches at one throwaway agent and shows the first
# one dying.
#
# Usage: daemon/scripts/repro-attach-takeover.sh [--no-takeover]
#
# With --no-takeover the second attach omits the flag, which is the behaviour
# the KAN-16 fix relies on: herdr refuses the second attach and the incumbent
# survives.
#
# ---------------------------------------------------------------------------
# Why this runs against a private server (KAN-35)
#
# Until KAN-35 this drove the *live* herdr: it spawned its throwaway agent
# there and attached to it there. Attaching under `script` gives the client a
# pty with no window size, which herdr reads as 1x1 and shrinks the whole
# workspace layout to match; from then on every `herdr agent start` is handed
# a zero dimension and fails with `ghostty error -2`. That is not theoretical
# — this script caused the 2026-07-31 outage that stopped all agent creation
# and was first misdiagnosed as an fd leak. See KAN-24 and
# repro-pane-geometry-spawn-failure.sh, which demonstrates the mechanism.
#
# The `stty` below sizes each attach 80x24 and so avoids the collapse, but a
# guard is only a promise: any future edit that drops it silently re-arms the
# hazard. So the isolation is structural instead. Everything here runs against
# a private herdr server on its own HERDR_SOCKET_PATH and its own XDG state,
# torn down on exit. With the socket redirected, no herdr command in this
# script can reach the live server even if the `stty` guard is lost — the
# worst a broken edit can do is collapse the throwaway server's own layout.
#
# The old `--agent NAME` flag is gone with it. It borrowed an agent from the
# live server, which private isolation makes impossible by construction, and
# it existed only to work around a herdr that could no longer spawn panes —
# which was this script's own damage. A fresh private server always can.
# ---------------------------------------------------------------------------

set -uo pipefail

TAKEOVER_ARG="--takeover"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-takeover) TAKEOVER_ARG=""; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

# The socket path must fit in sockaddr_un.sun_path (~108 bytes), which rules
# out a mktemp -d under a long TMPDIR.
RUN_DIR="$(mktemp -d /tmp/herdr-k16-XXXXXX)"
STATE_DIR="$(mktemp -d)"
SOCKET="$RUN_DIR/h.sock"
FIRST_LOG="$STATE_DIR/first-attach.log"
SECOND_LOG="$STATE_DIR/second-attach.log"
SERVER_PID=""
FIRST_PID=""
SECOND_PID=""

cleanup() {
  [ -n "$FIRST_PID" ] && kill "$FIRST_PID" 2>/dev/null
  [ -n "$SECOND_PID" ] && kill "$SECOND_PID" 2>/dev/null
  # The private server owns the throwaway agent, so killing it collects the
  # pane too — no `herdr pane close` bookkeeping needed.
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  sleep 0.5
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null
  rm -rf "$RUN_DIR" "$STATE_DIR"
}
trap cleanup EXIT

# Everything below — and every child, since these are exported — talks to the
# private server. This is the isolation; the `stty` guard is only a backstop.
export HERDR_SOCKET_PATH="$SOCKET"
export XDG_CONFIG_HOME="$STATE_DIR/config"
export XDG_STATE_HOME="$STATE_DIR/state"
export HERDR_LOG=herdr=info
mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME"

# Nothing should be listening on a socket we just made a directory for. If
# something is, the run is not isolated and must not proceed.
if herdr pane list >/dev/null 2>&1; then
  echo "a herdr server is already answering on $SOCKET — refusing to run" >&2
  exit 1
fi

echo "== starting a private herdr server (socket $SOCKET) =="
setsid herdr server >"$STATE_DIR/stdout.log" 2>&1 </dev/null &
SERVER_PID=$!
for _ in $(seq 1 20); do
  herdr pane list >/dev/null 2>&1 && break
  sleep 0.5
done
herdr pane list >/dev/null 2>&1 || { echo "server did not come up" >&2; exit 1; }
echo "private server pid $SERVER_PID; the live server is not touched"

AGENT="repro-attach-takeover-$$"
echo
echo "== starting throwaway agent $AGENT on the private server =="
herdr agent start "$AGENT" --cwd /tmp -- bash -c 'while true; do sleep 5; done' >/dev/null || {
  echo "could not start agent" >&2; exit 1; }
sleep 1

# `script` gives each attach a real TTY, the same thing node-pty gives the
# daemon's attach. The `stty` sizes it like the daemon does (80x24): a pty
# opened with no window size reports 1x1, and herdr shrinks the workspace
# layout to match, after which spawning fails. On this private server that
# would only spoil the run, not the session — see the header.
echo
echo "== attach #1 (the incumbent, stands in for the sidepanel's PTY) =="
script -q -c "stty rows 24 cols 80; herdr agent attach $AGENT --takeover" /dev/null >"$FIRST_LOG" 2>&1 &
FIRST_PID=$!
sleep 2

if ! kill -0 "$FIRST_PID" 2>/dev/null; then
  echo "attach #1 died before the test could run; see $FIRST_LOG" >&2
  cat "$FIRST_LOG" >&2
  exit 1
fi
echo "attach #1 is live (pid $FIRST_PID)"

echo "== attach #2 at the same agent (herdr agent attach $AGENT $TAKEOVER_ARG) =="
script -q -c "stty rows 24 cols 80; herdr agent attach $AGENT $TAKEOVER_ARG" /dev/null >"$SECOND_LOG" 2>&1 &
SECOND_PID=$!
sleep 3

echo
echo "== result =="
if kill -0 "$FIRST_PID" 2>/dev/null; then
  echo "attach #1 SURVIVED the second attach."
  VERDICT=survived
else
  wait "$FIRST_PID" 2>/dev/null
  echo "attach #1 DIED (exit $?)."
  VERDICT=died
fi

echo
echo "--- attach #1 output (last 5 lines) ---"
tail -5 "$FIRST_LOG" | cat -v
echo "--- attach #2 output (last 5 lines) ---"
tail -5 "$SECOND_LOG" | cat -v
echo "---------------------------------------"

kill "$FIRST_PID" "$SECOND_PID" 2>/dev/null

if grep -qa "taken over" "$FIRST_LOG"; then
  echo
  echo "REPRODUCED: the incumbent attach was evicted with 'terminal attach taken over'."
  exit 0
fi

if [ "$VERDICT" = survived ]; then
  echo
  echo "NOT REPRODUCED: the incumbent attach was not evicted."
  exit 0
fi

echo
# $FIRST_LOG lives under the temp dir cleanup removes, so print it rather than
# name it.
echo "attach #1 died without the takeover message; its full output was:"
cat -v "$FIRST_LOG" >&2
exit 1
