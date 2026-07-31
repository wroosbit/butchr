#!/usr/bin/env python3
"""Cost/hygiene check for herdr agents.

Prints a single OK line when the picture is unremarkable, so a scheduled caller
can stay quiet. Prints a REVIEW block when something wants a decision.

What costs money is a *running agent* nobody expects — dead shells cost file
descriptors, not tokens. They are reported separately, with different urgency.

Provenance: this was written by the board manager as an unreviewed stopgap
living at ~/.local/share/butchr/bin/check_herdr_agents.py, driven by a crontab
entry (KAN-24). KAN-33 folded it into the repo so it is versioned with the code
it watches; daemon/systemd/butchr-agent-check.timer replaces the crontab entry.

The fd-pressure half overlaps what the daemon already reports from the inside
(herdrHealth on list_agents, daemon/src/herdr-health.ts) and is kept only as a
cross-check that fires when nobody is looking at a UI. The live-vs-stale agent
classification is the part with no equivalent inside Butchr, and is the reason
this script survived rather than being deleted.
"""

import glob
import json
import os
import subprocess
import sys

PTMX_PER_PANE = 5  # measured on herdr 0.6.4; see KAN-24
FD_WARN_RATIO = 0.75  # matches FD_PRESSURE_WARN_RATIO in daemon/src/herdr-health.ts
STALE_SHELL_LIMIT = 12


def run(cmd, timeout=10):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def herdr_pid():
    p = run(["pgrep", "-f", "herdr server"])
    for line in p.stdout.split():
        try:
            cmd = open(f"/proc/{line}/cmdline", "rb").read().decode(errors="replace")
        except OSError:
            continue
        if cmd.replace("\0", " ").strip().endswith("herdr server"):
            return line
    return ""


def ptmx_count(pid):
    n = 0
    for f in glob.glob(f"/proc/{pid}/fd/*"):
        try:
            if os.path.realpath(f).endswith("ptmx"):
                n += 1
        except OSError:
            pass
    return n


def soft_limit(pid):
    try:
        for line in open(f"/proc/{pid}/limits"):
            if line.startswith("Max open files"):
                return int(line.split()[3])
    except (OSError, ValueError, IndexError):
        pass
    return 0


def main():
    p = run(["herdr", "agent", "list"])
    if not p.stdout.strip():
        print("REVIEW: herdr agent list returned nothing — server may be down")
        return 1
    try:
        agents = json.loads(p.stdout)["result"]["agents"]
    except (ValueError, KeyError) as e:
        print(f"REVIEW: could not parse herdr agent list: {e}")
        return 1

    live = [a for a in agents if a.get("agent")]
    stale = [a for a in agents if not a.get("agent")]

    panes = 0
    try:
        panes = len(json.loads(run(["herdr", "pane", "list"]).stdout)["result"]["panes"])
    except Exception:
        pass

    pid = herdr_pid()
    fds = ptmx_count(pid) if pid else 0
    soft = soft_limit(pid) if pid else 0

    problems = []

    foreign = [a for a in live if not a["name"].startswith("butchr-")]
    if foreign:
        problems.append("UNEXPECTED LIVE AGENTS (these burn tokens):")
        for a in foreign:
            problems.append(
                "  {name}  agent={agent}  status={status}  cwd={cwd}".format(
                    name=a["name"], agent=a.get("agent"),
                    status=a.get("agent_status"), cwd=a["cwd"]))

    # A soft limit still at the FD_SETSIZE default means setup's herdr drop-in
    # was never installed, or a herdr restart dropped back to the manager
    # default. Report it as a standing condition rather than waiting for the
    # ceiling to be hit, which is what made this invisible the first time.
    if soft and soft <= 1024:
        problems.append(
            f"FD CEILING NOT RAISED: herdr soft limit is {soft}; "
            f"at {PTMX_PER_PANE} fds/pane that caps this server at "
            f"~{soft // PTMX_PER_PANE} panes")
        problems.append(
            "  fix: daemon/scripts/install-service.sh, or see docs/SETUP.md")

    if soft and fds > soft * FD_WARN_RATIO:
        problems.append(f"FD PRESSURE: {fds} ptmx fds vs soft limit {soft} (>75%)")
        problems.append(f"  headroom ≈ {(soft - fds) // PTMX_PER_PANE} more panes")

    if len(stale) > STALE_SHELL_LIMIT:
        problems.append(
            f"STALE SHELLS: {len(stale)} dead agent panes — fd cost, not token cost")

    inventory = [
        "  {name}  {status}  {cwd}".format(
            name=a["name"], status=a.get("agent_status"), cwd=a["cwd"])
        for a in live
    ]

    if problems:
        print("REVIEW")
        print("\n".join(problems))
        print(f"live agents ({len(live)}):")
        print("\n".join(inventory))
        print(f"stale={len(stale)} panes={panes} ptmx={fds} soft={soft}")
        return 2

    print(f"OK live={len(live)} stale={len(stale)} panes={panes} ptmx={fds} soft={soft}")
    print("\n".join(inventory))
    return 0


if __name__ == "__main__":
    sys.exit(main())
