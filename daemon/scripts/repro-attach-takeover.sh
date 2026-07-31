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
# one dying. It touches only the agent it creates, and removes it on exit.
#
# Usage: daemon/scripts/repro-attach-takeover.sh [--no-takeover] [--agent NAME]
#
# With --no-takeover the second attach omits the flag, which is the behaviour
# the KAN-16 fix relies on: herdr refuses the second attach and the incumbent
# survives.
#
# --agent reuses an agent that already exists instead of starting a throwaway
# one. Point it at an idle agent nothing is attached to — it is the only way
# to run this when herdr cannot spawn new panes.

set -uo pipefail

AGENT=""
TAKEOVER_ARG="--takeover"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-takeover) TAKEOVER_ARG=""; shift ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

WORKDIR="$(mktemp -d)"
FIRST_LOG="$WORKDIR/first-attach.log"
SECOND_LOG="$WORKDIR/second-attach.log"
STARTED_AGENT=""

cleanup() {
  # Only ever close a pane this script created; a borrowed agent is left alone.
  if [ -n "$STARTED_AGENT" ]; then
    local pane
    pane="$(herdr agent get "$STARTED_AGENT" 2>/dev/null | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p')"
    [ -n "$pane" ] && herdr pane close "$pane" >/dev/null 2>&1
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

command -v herdr >/dev/null || { echo "herdr not on PATH" >&2; exit 1; }

if [ -n "$AGENT" ]; then
  echo "== borrowing existing agent $AGENT =="
  herdr agent get "$AGENT" >/dev/null 2>&1 || { echo "no such agent: $AGENT" >&2; exit 1; }
else
  AGENT="repro-attach-takeover-$$"
  echo "== starting throwaway agent $AGENT =="
  herdr agent start "$AGENT" --cwd /tmp -- bash -c 'while true; do sleep 5; done' >/dev/null || {
    echo "could not start agent" >&2; exit 1; }
  STARTED_AGENT="$AGENT"
  sleep 1
fi

# `script` gives each attach a real TTY, the same thing node-pty gives the
# daemon's attach. Without one, herdr's client refuses to run.
echo "== attach #1 (the incumbent, stands in for the sidepanel's PTY) =="
script -q -c "herdr agent attach $AGENT --takeover" /dev/null >"$FIRST_LOG" 2>&1 &
FIRST_PID=$!
sleep 2

if ! kill -0 "$FIRST_PID" 2>/dev/null; then
  echo "attach #1 died before the test could run; see $FIRST_LOG" >&2
  cat "$FIRST_LOG" >&2
  exit 1
fi
echo "attach #1 is live (pid $FIRST_PID)"

echo "== attach #2 at the same agent (herdr agent attach $AGENT $TAKEOVER_ARG) =="
script -q -c "herdr agent attach $AGENT $TAKEOVER_ARG" /dev/null >"$SECOND_LOG" 2>&1 &
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
echo "attach #1 died without the takeover message; inspect $FIRST_LOG."
exit 1
