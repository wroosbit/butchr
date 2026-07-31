#!/usr/bin/env bash
# Install Butchr's systemd --user units, so the daemon survives a reboot and
# herdr comes up with an fd limit that is not the FD_SETSIZE default.
#
# Linux only, and deliberately so: systemd --user is the mechanism. On any
# other platform this exits with a message rather than pretending.
#
# Everything here is idempotent. Re-run it after moving the clone, changing
# node versions, or pulling a change to daemon/systemd/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"
REPO="$(dirname "$DAEMON_DIR")"
UNIT_SRC="$DAEMON_DIR/systemd"
UNIT_DIR="$HOME/.config/systemd/user"

MIGRATE_CRON=0
for arg in "$@"; do
  case "$arg" in
    --migrate-cron) MIGRATE_CRON=1 ;;
    -h|--help)
      cat <<'USAGE'
usage: install-service.sh [--migrate-cron]

  --migrate-cron  Also remove the pre-KAN-33 crontab entry and the unversioned
                  ~/.local/share/butchr/bin/check_herdr_agents.py it ran. The
                  systemd timer installed here replaces both. Without this flag
                  the script only reports that they are still there.
USAGE
      exit 0 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
say() { echo "  $*"; }

# Not $USER. It is set by login shells and by nothing else — `docker exec`, a
# systemd ExecStart, and a cron job all leave it unset, and under `set -u` that
# aborts the install halfway through, after the units are written but before
# linger and enable. Found doing exactly that on the clean-machine run.
WHOAMI="$(id -un)"

[ "$(uname -s)" = "Linux" ] || die "systemd --user units are Linux-only; this is $(uname -s). See docs/SETUP.md for the manual alternative."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this machine does not use systemd. Start the daemon yourself: node $REPO/daemon/dist/daemon.js"
systemctl --user show-environment >/dev/null 2>&1 || die "no systemd --user manager for $WHOAMI. Log in on a normal desktop/ssh session and try again."

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node not found on PATH. See docs/SETUP.md — prerequisites."
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 18 ] || die "node $(node --version) is too old; the daemon needs >= 18."
NODE_BIN_DIR="$(dirname "$NODE")"

HERDR="$(command -v herdr || true)"

[ -f "$REPO/daemon/dist/daemon.js" ] || die "daemon/dist/daemon.js is missing — run 'cd $REPO/daemon && npm ci && npm run build' first."

mkdir -p "$UNIT_DIR"

# One sed with @@TOKEN@@ placeholders rather than envsubst: the unit files also
# contain %h and $-free systemd specifiers that envsubst would not respect.
render() {
  sed -e "s|@@REPO@@|$REPO|g" \
      -e "s|@@NODE@@|$NODE|g" \
      -e "s|@@NODE_BIN_DIR@@|$NODE_BIN_DIR|g" \
      -e "s|@@HERDR@@|${HERDR:-herdr}|g" \
      -e "s|@@PYTHON@@|${PYTHON:-$(command -v python3 || echo /usr/bin/python3)}|g" \
      "$1" > "$2"
}

echo "Butchr systemd install"
say "repo:  $REPO"
say "node:  $NODE ($(node --version))"
say "herdr: ${HERDR:-NOT FOUND}"
echo

# --- the daemon itself ----------------------------------------------------
render "$UNIT_SRC/butchr-daemon.service" "$UNIT_DIR/butchr-daemon.service"
say "installed butchr-daemon.service"

# --- herdr: never overwrite a unit we did not write -----------------------
if [ -e "$UNIT_DIR/herdr.service" ]; then
  say "herdr.service already exists — left alone (only the drop-in below is added)"
elif [ -z "$HERDR" ]; then
  say "herdr not on PATH — skipping herdr.service. Install herdr and re-run."
else
  render "$UNIT_SRC/herdr.service" "$UNIT_DIR/herdr.service"
  say "installed herdr.service"
fi

# The drop-in is additive and goes in either way: it is the whole point of this
# script and it cannot clobber anything.
mkdir -p "$UNIT_DIR/herdr.service.d"
cp "$UNIT_SRC/10-butchr-nofile.conf" "$UNIT_DIR/herdr.service.d/10-butchr-nofile.conf"
say "installed herdr.service.d/10-butchr-nofile.conf (LimitNOFILE=65536:1048576)"

# --- the periodic agent/cost check ---------------------------------------
render "$UNIT_SRC/butchr-agent-check.service" "$UNIT_DIR/butchr-agent-check.service"
cp "$UNIT_SRC/butchr-agent-check.timer" "$UNIT_DIR/butchr-agent-check.timer"
chmod +x "$REPO/daemon/scripts/check-herdr-agents.py"
say "installed butchr-agent-check.service + .timer"

echo
systemctl --user daemon-reload

# --- linger: the reason any of this survives a reboot ---------------------
if [ "$(loginctl show-user "$WHOAMI" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  say "linger: already enabled"
else
  if loginctl enable-linger "$WHOAMI" 2>/dev/null; then
    say "linger: enabled (the user manager now starts at boot without a login)"
  else
    echo "  WARNING: could not enable linger. Without it these units start only"
    echo "           after you log in. Run: sudo loginctl enable-linger $WHOAMI"
  fi
fi

systemctl --user enable --now butchr-daemon.service
say "butchr-daemon.service: enabled and started"
systemctl --user enable --now butchr-agent-check.timer
say "butchr-agent-check.timer: enabled and started"

if [ -f "$UNIT_DIR/herdr.service" ]; then
  systemctl --user enable herdr.service >/dev/null 2>&1 || true
  if ! systemctl --user is-active --quiet herdr.service; then
    systemctl --user start herdr.service || true
  fi
  say "herdr.service: enabled"
fi

# --- retire the pre-KAN-33 cron stopgap ----------------------------------
OLD_SCRIPT="$HOME/.local/share/butchr/bin/check_herdr_agents.py"
OLD_CRON=0
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'check_herdr_agents.py'; then
  OLD_CRON=1
fi

if [ "$OLD_CRON" = 1 ] || [ -f "$OLD_SCRIPT" ]; then
  echo
  if [ "$MIGRATE_CRON" = 1 ]; then
    if [ "$OLD_CRON" = 1 ]; then
      crontab -l 2>/dev/null | grep -v 'check_herdr_agents.py' \
        | grep -v '^# butchr: herdr agent/cost check' | crontab -
      say "removed the check_herdr_agents.py crontab entry"
    fi
    if [ -f "$OLD_SCRIPT" ]; then
      rm -f "$OLD_SCRIPT"
      rmdir "$(dirname "$OLD_SCRIPT")" 2>/dev/null || true
      say "removed $OLD_SCRIPT"
    fi
  else
    echo "  NOTE: the old unversioned cron check is still installed and will now"
    echo "        run alongside the timer. Re-run with --migrate-cron to remove"
    echo "        the crontab entry and $OLD_SCRIPT."
  fi
fi

# --- the one thing this script will not do for you ------------------------
cat <<EOF

Done.

The herdr fd limit does NOT apply to the herdr server that is running right
now. A drop-in takes effect on the next start, and restarting herdr kills
every pane it is holding — including any agent mid-work. This script will not
do that to you.

  Already at 1024, nothing running you care about?
      systemctl --user restart herdr.service

  Agents running that you do not want to lose? Raise the live server instead,
  and let the drop-in cover the next restart:
      prlimit --pid \$(pgrep -f 'herdr server' | head -1) --nofile=65536:1048576

Then check the whole install:
      node $REPO/daemon/scripts/butchr-doctor.mjs
EOF
