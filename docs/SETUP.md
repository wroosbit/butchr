# Setting up Butchr

From a clone to a working agent. Every step here was run on a machine that had
never seen Butchr; the transcript is on [KAN-33](https://wroosbit.atlassian.net/browse/KAN-33).

**Platform: Linux.** The daemon and the extension are portable in principle,
but three things in this document are not, and are called out where they
appear: the systemd `--user` units, the `~/.config/google-chrome/` path for the
native-messaging manifest, and the `/proc`-based fd checks. macOS needs
different paths for all three and a keyring backend that does not yet exist
(see the comment at the top of `daemon/src/credentials.ts`). Nobody has tried
it; assume it does not work.

**One step cannot be automated and is not pretended away:** loading and
reloading the Chrome extension. Chrome offers no way to install, reload, or
read the ID of an unpacked extension from outside the browser. Steps 4, 5 and 7
require you to click. Everything else is a command.

**Every code block here is `bash`, and your login shell may not be.** This
matters more than it sounds: the second machine this document was rehearsed
against (KAN-568) has `fish` as its login shell, and a reader who pastes into
their own prompt is not running what is written here. Most of it survives —
`export VAR=...`, brace expansion and `$(...)` all work in fish — so the
breakage is not where you would look for it. **Run `bash` first**, or read the
per-step notes where a line is called out as shell-sensitive:

```bash
bash        # then follow the rest of this document inside it
```

⚠ **The one construct that is not portable is `$?`**, and what it costs you
depends on how much of this document fish was reading when it hit it — because
**fish parses a whole unit before it runs any of that unit**, and a single `$?`
anywhere inside one refuses the lot:

- **Saved to a file and run** (`fish steps.fish`) — the parse unit is the
  **entire file**, so **not one line of it runs**, *including the steps above
  the offending one*. fish prints one diagnostic naming the line, then
  `warning: Error while reading file`, and exits `127`. Measured on fish 3.7.0
  and 3.3.1 alike — **this case does not vary.**
- **Pasted or typed as a single line** (`some-command; echo "exit=$?"`) — the
  parse unit is that line, and **what you lose here depends on your fish
  version**: on 3.7.0 nothing runs at all and it exits `127`; on 3.3.1
  `some-command` runs first and fish then refuses, exiting `121`.
- **Typed as two lines**, pressing Enter between them — two parse units. The
  first command runs, the second is refused, and you are left with output that
  **looks like the step worked**.

**What does not vary, on any fish measured, is that you never get the exit
code** — so if a step's whole content *is* the exit code (step 1's keyring probe
is exactly that), every case above leaves you without the one thing you ran it
for. What varies is only whether you *also* lose the command's own output.

**The last case is the quiet one; the first is the broad one.** Only the last
hands you a plausible-looking partial result. The first is loud — a diagnostic
and a non-zero exit — but it discards every remaining step of a document you
were working through, which is why running from a file is called out here rather
than left to a per-step note. That line is written portably below; this note is
here because the next line somebody adds will not be.

---

## 0. What you are installing

Three pieces that have to find each other:

| Piece | What it is | Started by |
| --- | --- | --- |
| **herdr** | separate tool; owns the terminals and the agent panes | you, or `herdr.service` |
| **butchr daemon** | Node process; bridges Chrome to herdr, loads prompts | `butchr-daemon.service`, or auto-spawned by the first client |
| **butchr extension** | unpacked Chrome extension; the sidepanel and Agents page | Chrome, by hand |

Chrome reaches the daemon through a **native-messaging host** — a small proxy
Chrome launches, which relays to the one long-lived daemon over a Unix socket
at `~/.local/share/butchr/butchr.sock`. Registering that host is step 5, and it
is the step most likely to be the reason nothing works.

**Agents message each other over a fourth thing that is off by default**, and it
is the one omission most likely to be mistaken for a bug later: without it,
`butchr_send_to_agent` falls back to typing into the recipient's terminal, which
interrupts whatever that agent was doing. It is a research preview and it is
step 9.

---

## 0.5 Is this machine actually clean?

**Skip this if you know the box has never run Butchr. Read it if you are not
sure, and read it especially if you are rehearsing this document** — an install
that lands on top of a previous one is the one case where every step below can
report success while proving nothing.

This section exists because of a measured near-miss (KAN-568). A machine offered
as the clean-room target for exactly that rehearsal turned out to carry a prior,
**architecturally different** Butchr: SQLite-backed, with `workspace/` singular,
`butchr.log`, and units named `butchr.service`, `butchr-sentinel.service`,
`butchr-resource-guard.service` and `butchr-ld-collector.service` — none of which
exist in the current tree, which uses `workspaces/` plural, `daemon.log`,
`agents.jsonl` and `butchr-daemon.service`. Nothing in this document would have
told the operator that, and most of the prerequisites below were already
satisfied by whoever installed them last.

⚠ **The hazard is not that the install fails. It is that it succeeds.** A
prerequisite already present is a step never tested; a `git clone` that finds a
directory already there is a clone that silently keeps somebody else's commit; a
stale `butchr.db` sits under a path the current daemon reads. **For a reader who
cannot read the source and has no one to ask, a false green is worse than a
crash.**

```bash
ls -d ~/.local/share/butchr 2>/dev/null
ls    ~/.config/systemd/user/ | grep -iE 'butchr|herdr|drovr'
ls -d ~/code/*/butchr ~/code/*/crabcast 2>/dev/null
```

Every line that prints something is a decision you have to make **before** step
1, not a thing to install past:

| What you find | What it means |
| --- | --- |
| `~/.local/share/butchr/` exists | state from a previous install. `workspace/` singular or a `butchr.db` means a *different generation* of the product, not an older version of this one |
| any `butchr*.service` that is not `butchr-daemon.service` | a unit this document does not install and step 6 will not overwrite; it can hold the socket and win the race described in step 7 |
| a `butchr` clone already on disk | step 2's `git clone` will not run. You will build **whatever commit is already checked out** |

**There is no supported migration from that generation, and this document does
not pretend to offer one.** The honest options are a fresh user account (truly
clean `$HOME`, same box — this needs `sudo`), a different machine, or removing
the prior state deliberately with the *Uninstall* recipe at the end of this
document read against the **old** layout rather than this one. ⚠ Removing it is
irreversible; on the machine above, artefacts were named `PRESERVED` and
`leader-preserved`, which is not a state to clear on a hunch.

**If you are rehearsing this document rather than installing for real, say which
box you were on and whether it was clean.** A rehearsal run over an existing
install cannot go red, so reporting it as a clean-install pass closes the one
check that was worth running.

### `sudo`, and where it will stop you

Root is needed in **step 1 only, and conditionally in step 6** — the document
used to leave you to discover both:

| Where | What wants root | Avoidable? |
| --- | --- | --- |
| step 1 | `curl … nodesource … \| sudo -E bash -` and `sudo apt-get install -y nodejs` | yes — `nvm`, or any node 20 already on `PATH` |
| step 1 | `sudo apt install libsecret-tools gnome-keyring` | yes — the keyring is optional; without it you get the `0600` file backend, which is supported |
| step 6 | `loginctl enable-linger` | **usually not needed.** `install-service.sh` calls it unprivileged first, and on a desktop polkit normally allows it. Only if that fails does it print `Run: sudo loginctl enable-linger <user>` |

**Everything else runs as an ordinary user.** The daemon, all four units and the
fd drop-in are `systemd --user` and land under `~/.config`; steps 2–5 and 7–10
touch nothing privileged. So if you are driving this unattended, or over SSH as
an account whose `sudo` needs a password nobody is there to type, **arrange node
20 in advance and decide about the keyring, and the rest completes without a
password** — with the one caveat that a failed `enable-linger` leaves the units
starting at login instead of at boot, which is a real difference on a headless
box and is reported rather than silent.

---

## 1. Prerequisites

**node >= 18.** CI uses 20, so use 20. Ubuntu 24.04's `apt install nodejs`
gives 18.19, which is past end-of-life; NodeSource is the shorter path:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version    # v20.x
```

`nvm` works too. Whatever you use, the daemon records the resolved `node` path
in its systemd unit at install time, so re-run `install-service.sh` after
changing node versions.

**git.** Any version.

**herdr — 0.7 or newer**, which is what the obvious command gives you:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

Then **open a new shell** — Ubuntu's `~/.profile` adds `~/.local/bin` to `PATH`
only if the directory existed when the shell started, so in the session that
just installed it, `herdr` is not yet findable:

```bash
herdr --version   # herdr 0.8.0, or anything >= 0.7
```

If it still is not found: `export PATH="$HOME/.local/bin:$PATH"`.

`herdr update` is fine to run **at install time, from an ordinary terminal, with
no fleet running**. That is the only condition under which this sentence used to
be unqualified, and it is not the condition most readers meet. Once Butchr is
running, upgrading herdr is a different operation with two properties that will
surprise you — it cannot be driven from inside the fleet, and it does not roll
back. Both are in **step 11**, and it is worth reading before you type it rather
than after.

> **This section used to say the opposite, and the reversal is worth one
> paragraph** (KAN-533). Until 2026-08-18 this was *"the one prerequisite you
> cannot get from the obvious command"*: herdr 0.7 redesigned `agent start` —
> it attaches a named agent kind to an **existing** pane (`--kind`, `--pane`)
> instead of creating one, dropping `--cwd`, `--tab`, `--no-focus` and the
> trailing `-- <command>` — and `daemon/src/herdr.ts` passed all of those, so
> every activation on 0.7.x died with `unknown option: --cwd`. This document
> therefore told you to download a specific 0.6.4 binary by URL and never run
> `herdr update`. **The spawn path is ported and that pin is gone.** A user who
> installs herdr the way herdr tells them to now gets a Butchr that works, which
> was the entire complaint (found on the KAN-33 clean-machine run).
>
> ⚠ **0.6.x is no longer supported**, and that is a deliberate drop rather than
> an oversight. Butchr now starts agents with `agent start --kind/--pane`, which
> 0.6 does not have; on a 0.6 build every activation fails with `unknown option:
> --kind`. `butchr-doctor` (step 7) and the daemon's startup log both name the
> version explicitly, so it cannot go wrong silently — and the message points at
> the installer above rather than at a download URL.
>
> **Verified against 0.7.5 and 0.8.0.** Those two are API-identical for every
> command Butchr issues; their bundled `herdr api schema --json` differ only in
> definitions Butchr never touches. Above 0.8 the daemon logs *"newer than
> verified"* — a note, not a refusal, because "we have not tried it" is not
> evidence of a fault.

**Chrome or Chromium.** The extension is Manifest V3 and is loaded unpacked;
publishing to the Web Store is out of scope.

**`gh`** (GitHub CLI) — *not* needed to run Butchr. It is needed by the task
agents Butchr spawns, because `prompts/task.md` tells them to clone and open
pull requests with it. Install and `gh auth login` if you intend to use the
`task` workspace type for anything real.

**`libsecret` — optional, and worth a decision rather than a default.** The
daemon stores the Atlassian API token (step 8) in the OS keyring when one is
available and in a `0600` file when one is not. Both are supported. The file
backend is not a degraded mode to be embarrassed about, but you should know
which you are getting *before* you type a token, so:

```bash
bash -c 'secret-tool lookup service butchr account jira; echo "exit=$?"'
```

**The `bash -c` is load-bearing, not decoration** — it is what makes this line
give the same answer in every shell. Written bare, the `$?` is a parse error in
fish, so you do not get the `exit=` line — which is the one thing this step is
for. Because the lookup and the `echo` are one line, fish may refuse the lookup
along with it: on fish 3.7.0 nothing runs at all and it exits `127`, while on
3.3.1 the lookup runs and it exits `121`. Bash prints `exit=127` either way, and
wrapped in `bash -c` so does fish. **Put this line bare in a file with the rest
of your steps and fish runs none of that file** — see the `$?` note at the top.

Exit `0` or `1` means a working keyring. Anything else (including "command not
found") means the file backend, at
`~/.local/share/butchr/jira-credential.json`. To get a keyring on
Debian/Ubuntu: `sudo apt install libsecret-tools gnome-keyring`. Note that
having `secret-tool` on `PATH` is *not* sufficient — it fails at runtime with
no D-Bus secret service, which is the normal state on a headless box or in a
container. The settings page probes and tells you which one this machine will
use; so does `butchr-doctor`.

**Python 3** — only for the periodic agent check installed in step 6. Present
on any desktop Linux.

---

## 2. Clone

```bash
git clone https://github.com/wroosbit/butchr.git
cd butchr
```

The daemon reads `prompts/*.md` relative to the repo root at activation time,
so **the clone is a runtime dependency, not just a build directory**. Put it
somewhere permanent. If you move it later you must re-run steps 5 and 6, both
of which bake in absolute paths.

---

## 3. Build

Two independent builds. Neither is done for you, and neither warns you when it
goes stale — `butchr-doctor` (step 7) is what tells you.

```bash
cd daemon && npm ci && npm run build && cd ..
cd extension && npm ci && npm run build && cd ..
```

`daemon/npm ci` builds `node-pty` from source, which needs a C++ toolchain
(`build-essential` and `python3` on Debian/Ubuntu). It is the slowest and most
fragile part of the install; if it fails, that is why.

You should now have `daemon/dist/daemon.js`, `daemon/dist/native-host.js` and
`extension/dist/manifest.json`.

---

## 4. Load the extension into Chrome — and get its ID

**Manual. There is no way around this.**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select `extension/dist` (the built output, *not*
   `extension/`).
4. The card that appears shows an **ID** — 32 lowercase letters, e.g.
   `mfhdmkkkpaepapfmelifphbjgmpekpah`. Copy it.

> **The ID is derived from the load path**, so it is different on every machine
> and it changes if you move the clone. It is not a secret, but it is not
> portable either — which is why nothing in this repository can hard-code it,
> and why step 5 takes it as an argument.

---

## 5. Register the native-messaging host

```bash
daemon/scripts/install-native-host.sh <the-id-from-step-4>
```

This writes `com.butchr.daemon.json` into both
`~/.config/google-chrome/NativeMessagingHosts/` and the Chromium equivalent,
pointing at `daemon/bin/native-host.sh` in your clone and allowing exactly that
one extension origin.

Then **reload the extension** (the ↻ on its card at `chrome://extensions`).
Chrome reads the host manifest when the extension connects, and an extension
loaded before the manifest existed will report `Specified native messaging host
com.butchr.daemon not found` until it is reloaded.

If you ever move the clone, re-run this — the manifest holds an absolute path.

---

## 6. Autostart, and the file-descriptor ceiling

```bash
daemon/scripts/install-service.sh
```

This is one command because the two things it does are the two things that were
previously typed by hand on one machine and existed nowhere else.

**It installs:**

| Unit | Purpose |
| --- | --- |
| `butchr-daemon.service` | the daemon, enabled at boot |
| `herdr.service` | *only if you do not already have one* |
| `herdr.service.d/10-butchr-nofile.conf` | raises herdr's `LimitNOFILE` — always installed, additive |
| `butchr-agent-check.{service,timer}` | the periodic agent/cost check, every 5 minutes |

and runs `loginctl enable-linger $USER`, which is what makes the user manager
start at boot rather than at your first login. Without linger, none of this
comes back after an unattended reboot.

Getting the daemon back is half of surviving a reboot; getting the *agents* back
is the other half, and it happens automatically once the daemon is up. See
[resumption.md](resumption.md) for the registry it reads, what it does with an
agent whose conversation could not be restored, and how a loss that could not be
repaired is reported.

The unit is called **`butchr-daemon`**, not `butchr`. An unrelated project of
the same name ships a `butchr.service` user unit, and this machine had one; the
installer will not overwrite a unit it did not write.

`Restart=on-failure`, deliberately not `always`: the daemon exits **0** when it
loses the race for the socket to a daemon that a Chrome native host already
auto-spawned. That is correct behaviour, and `Restart=always` would relaunch
the loser in a loop.

### Why the fd limit is a setup step

`herdr` holds **5 open `/dev/ptmx` descriptors per pane** — measured on 0.6.4.
It is not a leak; they are four `dup()`s of one pty master plus the master, and
all five come back when the pane closes. But 5 per pane against the **default
soft limit of 1024** is a hard ceiling at roughly **205 panes**, and past it
every `herdr agent start` fails. 205 panes is ordinary accumulated terminal
use, not abuse.

A systemd `--user` unit inherits the manager's default. Measured on a stock
Ubuntu 24.04 host:

```
$ systemd-run --user --pipe --quiet --wait /bin/sh -c 'ulimit -Sn; ulimit -Hn'
1024
1048576
```

So a herdr started that way lands exactly on the ceiling, and a `prlimit`
applied by hand to the running process is gone at the next restart. The drop-in
is the durable form of it.

**On raising it above 1024 — read this before assuming it is free.** 1024 is
`FD_SETSIZE`, the largest descriptor `select(2)` can represent; passing a
higher one to `select()`/`FD_SET` is undefined behaviour that writes past the
end of the bitmap. Raising the limit for a process that calls `select()` turns
a spawn failure into memory corruption in the process holding every terminal,
which is strictly worse. That hazard was raised on KAN-24 and left open.

It was closed empirically before this drop-in was written. herdr 0.6.4 was
traced through server start, three agent spawns, an attach and a detach:

```
$ strace -f -c -o summary.txt herdr server     # + 3 agent starts, attach, detach, stop
% time     seconds  usecs/call     calls    errors syscall
 62.85    3.936402        3443      1143       681 futex
 15.06    0.943103       41004        23         9 wait4
 13.24    0.829085        1619       512           poll
  4.45    0.278725        3358        83        76 accept4
...
100.00    6.262787         193     32303      1380 total

$ grep -cE '\b(select|pselect6|_newselect)\b' summary.txt
0
$ nm ~/.local/bin/herdr | grep -icE '\b(p?select|_newselect)\b'
0
```

**Zero `select`-family calls in 32,303 syscalls.** herdr's readiness syscall is
`poll(2)`, which takes an explicit array of descriptor numbers and has no
`FD_SETSIZE` limit at all. Repeated independently on a container with no other
herdr on it: 0 select-family calls in 8,177 syscalls, 461 `poll`.

The honest limits of that evidence: it covers the workload above on 0.6.4, and
the binary is statically linked so a dependency could in principle call
`select()` on a path this workload never reached. It is much stronger than
"I found no symbol", and it is not a proof. **Re-check it if herdr changes its
event loop** — and note that `butchr-doctor` and the daemon's startup log both
report the live soft limit, so a machine that reverts to 1024 says so out loud
rather than waiting to fail.

### The one thing the installer will not do

**Applying the drop-in requires restarting herdr, and restarting herdr kills
every pane it holds** — including any agent mid-work. The installer refuses to
do that to you and prints what to run instead:

```bash
# nothing running you care about:
systemctl --user restart herdr.service

# agents running you do not want to lose — raise the live server, and let the
# drop-in cover the next restart:
prlimit --pid $(pgrep -f 'herdr server' | head -1) --nofile=65536:1048576
```

### If you do not use systemd

Start the daemon yourself, from anywhere:

```bash
node /path/to/butchr/daemon/dist/daemon.js
```

It detaches nothing and logs to `~/.local/share/butchr/daemon.log`. You will
have no autostart and no fd drop-in; raise the limit in whatever starts herdr
(`ulimit -n 65536` before `herdr server` works).

---

## 6.5 Configure the daemon — the two knobs that decide whether it acts

⚠ **Steps 1–6 install Butchr. None of them configures it, and both defaults are
inert.** A machine that stops at step 6 comes up, holds its socket, answers
every question you put to it — and staffs no agents and has no path to Atlassian
at all. It reads finished. That is why this step is here, and why it is *before*
the health check rather than after it.

| variable | default | what a box that leaves it alone does |
| --- | --- | --- |
| `BUTCHR_BOARD_RECONCILE` | `report` | the reconciler reads the board, computes the diff, writes `would converge: start …` to the log — and starts nothing, forever |
| `BUTCHR_ATLASSIAN_PROXY` | `off` | the daemon serves no Atlassian tools at all, so no agent reaches Jira or Confluence through Butchr |

`daemon/scripts/install-service.sh` sets neither, and the unit it writes
declares exactly one variable — `PATH`. Nothing above this line has named
either knob. [env-knobs.md](env-knobs.md) is the reference table for both, with
every value and every default; **this step is the decision, not the table.**

### Which value you want, and why

**`BUTCHR_BOARD_RECONCILE=converge`** is what makes the board drive the fleet:
the reconciler starts an agent for each issue assigned to you and In Progress or
In Review, and stands down the ones the board no longer wants. `report` runs the
same loop and writes what it *would* have done to the log instead of doing it —
genuinely useful on a machine you are not ready to hand the board, and inert by
design. `off` stops it reading Jira at all.

⚠ **`converge` is the value that spends money and acts on a live board**, so
decide it deliberately. But do decide it: leaving it unmade is not a cautious
middle position, it is a box that looks staffed and is not.

**`BUTCHR_ATLASSIAN_PROXY=<rung>`** decides how far agents reach into Atlassian,
and how far the credential in step 8 is used. It is a ladder — `off`,
`jira-read`, `confluence-read`, `jira-write`, `confluence-write` — and **step 8
is where the ladder and the token are described.** Read it before picking a
rung, and see [atlassian-proxy.md](atlassian-proxy.md) for the full account.
What matters here is only that a rung gets chosen and written down: left at
`off`, a machine with a perfectly good credential still gives its agents no
Atlassian path, and step 8 will look like it did nothing.

The fleet this document was written from runs `converge` and `confluence-write`
(the "what is set on this machine" section of [env-knobs.md](env-knobs.md) is
read from its running daemon). That is one machine's answer and not a
recommendation to copy without reading step 8.

### Write the drop-in

Both knobs are read from the daemon's **environment**, and the durable way to
put something there is a systemd drop-in. Step 12 explains the same directory
for `BUTCHR_AGENT_RUNTIME`; these are the two files the machine in
[env-knobs.md](env-knobs.md) actually has:

```bash
mkdir -p ~/.config/systemd/user/butchr-daemon.service.d
printf '[Service]\nEnvironment=BUTCHR_BOARD_RECONCILE=converge\n' \
  > ~/.config/systemd/user/butchr-daemon.service.d/converge.conf
printf '[Service]\nEnvironment=BUTCHR_ATLASSIAN_PROXY=jira-write\n' \
  > ~/.config/systemd/user/butchr-daemon.service.d/atlassian-proxy.conf
systemctl --user daemon-reload
systemctl --user restart butchr-daemon.service
```

One file per knob, because that is what a deployment accumulates and because
`ls` of that directory then reads as a list of decisions somebody made. A single
file carrying both `Environment=` lines behaves identically — systemd merges
every `*.conf` in the directory.

**A drop-in that has not been reloaded is not in force, and neither is one the
running daemon predates.** Both values are read from the environment the daemon
process was started with, so `daemon-reload` on its own changes nothing: the
restart is the half that applies it. Restarting `butchr-daemon` does **not**
kill herdr's panes — herdr owns them, and it is the *herdr* restart in step 6
that takes them down with it. An agent that is already running keeps the MCP
servers it was provisioned with, so a proxy rung you turn on now reaches the
next agent to start rather than the ones already up. Step 9 makes the general
form of that point.

### Why the installer does not write this for you

`install-service.sh` writes units, herdr's descriptor drop-in and a timer. Every
one of those is mechanical: there is one correct answer and the script knows it.
**Neither knob here is that kind of decision.** `converge` hands this machine's
agent budget to a Jira board, and the proxy rung decides how far a credential's
grant reaches. An installer that picked either would be making a policy choice
on your behalf, silently, in a file you did not know existed — and the first
evidence of it would be agents starting.

So it is left to you deliberately, and the omission is **guarded rather than
trusted**: `butchr-doctor` — the next step — **fails while either knob is still
undecided**, and reports what you decided when both are. It does not fail on
`report` or `off` *chosen*: a decision is not a fault, and failing one would be
reporting a choice as a defect. What it refuses is a machine where the default
decided and nobody knows. Before this step existed it passed such a box and said
`Ready.`

### If you do not use systemd

Set both in whatever starts the daemon, remembering that it reads them once at
startup:

```bash
env BUTCHR_BOARD_RECONCILE=converge BUTCHR_ATLASSIAN_PROXY=jira-write \
  node /path/to/butchr/daemon/dist/daemon.js
```

`butchr-doctor` reads the declaration off the systemd unit. On a machine with no
unit it asks the daemon serving the socket instead, which can say **which** of
the two it carries but not what they are set to — the values are not on that
wire.

---

## 7. Check that it worked

```bash
node daemon/scripts/butchr-doctor.mjs
```

This is the point of the whole document: it re-checks every step above and
exits non-zero if any of them is not true. It reports node, herdr, herdr's live
fd soft limit and the pane headroom that implies, both builds *and whether they
are stale relative to their sources*, the native-messaging manifest (including
whether the path it names still exists), the systemd unit and linger, whether
anything can actually connect to the daemon socket, **whether step 6.5's two
knobs have been decided and what they were decided to be**, which backend a Jira
token would land in, and whether agent-to-agent channels are on.

It also reports **which daemon is serving the socket, and where its
configuration came from** (KAN-550). That is a separate question from whether
the unit is active, and on 2026-08-20 the two answers disagreed for two
minutes: `systemctl is-active` read `inactive` — correctly — while a daemon
Chrome had auto-spawned served the fleet with none of the unit's `BUTCHR_*`
variables, so the runtime pin and the agent cap were both silently dropped.
Nothing reported it, because nothing reported the process actually holding the
socket. `butchr-doctor` now asks that process directly and FAILS when it is not
carrying what the unit declares, naming each variable that differs.

A clean run ends in `Ready.`

Then the end-to-end check, which needs the browser:

1. Open any Jira issue, e.g. `https://yoursite.atlassian.net/browse/KAN-1`.
2. Open the Butchr sidepanel and activate.
3. A herdr pane appears with an agent in it; `herdr agent list` shows
   `butchr-task-kan-1`.

<!-- constant-pin: RUNTIME_ENV_VAR
     src: daemon/src/runtime-switch.ts
     sha256: 28959b7fe578
     says: a daemon that would have come up without the `BUTCHR_AGENT_RUNTIME` this machine pins refuses to start -->

**If `systemctl --user status butchr-daemon.service` and the fleet disagree** —
the unit reads `inactive` or `failed` while agents are plainly working — that is
the KAN-550 shape and `butchr-doctor`'s *serving daemon* line resolves it. The
unit is also now able to say so itself: a daemon that loses the race for the
socket to a process that is **not** the unit's own exits `3` rather than `0`, so
`Restart=on-failure` retries and the unit ends up `failed` instead of sitting
quietly `inactive`. And a daemon that would have come up without the `BUTCHR_AGENT_RUNTIME` this machine pins refuses to start
at all — it exits `4`, printing what it expected and what it got. Set
`BUTCHR_ALLOW_UNPINNED_RUNTIME=1` if you mean it.

**That refusal is scoped to the daemon this machine's agents actually talk to**
(KAN-574). A `verify-` script spawns a real daemon into a throwaway `$HOME`, so
it claims a socket of its own and cannot displace the fleet — the pin does not
apply to it, and running the suite on a machine with the unit installed needs no
knob set. Until KAN-574 it did: nine CI-runnable scripts failed on every
developer machine and passed on every runner, because a runner has no unit for
the guard to disagree with.

If the sidepanel reports it cannot reach the daemon, the order to check things
in is: `butchr-doctor` first, then `~/.local/share/butchr/daemon.log`, then
`/tmp/native-host-sh.log` (which records which `node` Chrome's minimal
environment resolved), then the extension's service-worker console at
`chrome://extensions`.

### Reading the daemon's log

Two places hold it, and they are not equivalent:

```bash
journalctl --user -u butchr-daemon.service --since -60min   # this run, via systemd
grep '\[board\]' ~/.local/share/butchr/daemon.log           # the full history
```

`daemon.log` is the complete record and is not subject to the journal's
retention. The journal carries the same lines for a daemon systemd started, and
**only** for one: a daemon a client auto-spawned has its stdout on `/dev/null`,
so `journalctl` will show that unit's lifecycle records and none of its
decisions.

> ⚠ **A journal holding only `Started` / `Stopping` / `Consumed CPU time` is not
> a quiet daemon.** Before KAN-598 that was the *only* thing this unit ever put
> in the journal — the daemon sent every line to `daemon.log` and nothing to
> stdout — and because the output was real and well-formed, the honest reading
> of it was wrong. An operator grepped it for a stand-down, matched nothing, and
> was one sentence from reporting that none had been attempted; the daemon had
> logged 65, one per minute. `butchr-doctor` now names this state explicitly
> (its **daemon journal** check), so if you are unsure which you are looking at,
> ask it rather than the journal.

---

## 8. Optional: the Jira credential

Butchr works without one. Its only effect is that Jira **Stories** open as
`story` workspaces instead of `task` workspaces — everything degrades to `task`
on any failure, by design.

On the extension's **Settings** page, supply your site URL, account email and
an Atlassian API token. The page tells you which storage backend this machine
will use before you type the token, and validates it at submit time. See
`docs/butchr.md` for the full design.

**Which scopes that token needs depends on one environment variable, and the
answer is no longer "read only".** This paragraph read *"prefer a scoped token
limited to `read:jira-work`; the daemon has no write path to Jira and none
should be added"* until KAN-603. That was true when it was written and stopped
being true at **KAN-291**, which gave the daemon a Jira status transition, and
again at **KAN-293**, which added Confluence writes. `BUTCHR_ATLASSIAN_PROXY`
selects how far the grant goes — `off` (the default), `jira-read`,
`confluence-read`, `jira-write`, `confluence-write` — as a ladder where each
rung contains the one below it. `docs/atlassian-proxy.md` is the full account,
and the daemon prints the exact grant it is serving at startup, so read that
line rather than this one for what your machine actually does.

**Which server your agents get depends on the same variable (KAN-603).** With
the proxy `off`, a workspace is provisioned with the official `atlassian` MCP
server — a remote endpoint whose first use opens a browser OAuth flow you have
to complete on this machine. With the proxy on, that server is **not**
provisioned at all: agents reach Atlassian through Butchr's own `butchr` server,
under the credential you just typed, with no per-agent login. So a `.mcp.json`
carrying only `butchr` is the proxy working, not provisioning failing. Before
KAN-603 the server was emitted either way, which on a fresh machine meant every
agent came up waiting on an OAuth token nobody was going to supply.

**Which rung you are on is set in step 6.5**, not here. This section is where
the ladder and the credential are explained; the drop-in that actually selects a
rung is written there, and a token typed here with the proxy left at `off` buys
nothing at all.

### Moving the credential to a second machine

**The short answer is: do not move it — type it again.** The Settings page takes
the token in a password field, so entering it on the second machine puts it
through no shell, no history file and no transcript. It is also the only route
that writes *both* halves of the credential consistently for **that** machine's
backend, which matters more than it looks — see the warning at the end of this
section.

If the second machine has to carry the same secret and re-entering it is not
possible, the two backends move differently, and **neither route may print the
token to a terminal.** A terminal is a transcript.

**Keyring → keyring.** The secret is in libsecret under
`service butchr account jira`; the metadata beside it is not secret and is
copied separately.

```bash
# the secret: read on one machine, written on the other, never displayed
secret-tool lookup service butchr account jira \
  | ssh you@newbox 'secret-tool store --label "Butchr — Atlassian API token" service butchr account jira'

# the non-secret half: site URL, account email, and which backend to read
scp ~/.local/share/butchr/jira-credential.json you@newbox:~/.local/share/butchr/
```

⚠ **Never run the `lookup` half on its own.** On its own it writes the token to
your terminal, which is the one thing this whole page forbids. Piping it is what
keeps it out. That `store` invocation is the daemon's own: `credentials.ts`
stores a token by handing it to `secret-tool store` on **stdin**, with the
secret never appearing as an argument — arguments are visible in `ps`. That is
where this recipe comes from, and it is the limit of what is claimed for it: the
machine this section was written on has **no keyring at all**, so the two-box
transfer above has not been run end to end. Run `butchr-doctor` on the receiving
box before you believe it worked.

**File backend.** Here `jira-credential.json` holds the token as well as the
site URL and email, so the file *is* the credential. Copy it; never `cat` it.

```bash
scp ~/.local/share/butchr/jira-credential.json you@newbox:~/.local/share/butchr/
ssh you@newbox 'chmod 600 ~/.local/share/butchr/jira-credential.json'
```

⚠ **The metadata file records which backend it was written for, and the two
machines need not agree.** A `jira-credential.json` saying `"storage":
"keyring"` copied onto a machine with no keyring leaves Butchr looking for a
secret that is not there, and it reports *not configured* rather than an error —
the same quiet-and-wrong shape step 6.5 exists to close. Step 7's **jira
credential storage** line tells you which backend each machine actually has;
read it on both before you copy anything, and if they differ, re-enter the token
through Settings on the second machine instead.

**Confirm it landed** by running `butchr-doctor` on the new machine and opening
the Settings page, which validates the credential at submit time and reports
what it is holding. Issuing or rotating an Atlassian token is a human action and
is out of scope for this document.

---

## 9. Optional: agent-to-agent channels

<!-- constant-pin: DEV_CHANNELS_FLAG
     src: daemon/src/launchers.ts
     sha256: 4d18addee408
     says: `--dangerously-load-development-channels=server:butchr` -->
<!-- constant-pin: VERIFIED_CLIENT_VERSIONS
     src: daemon/src/channel-selfcheck.ts
     sha256: 71edc27416cc
     says: measured on ['2.1.224', '2.1.226'] -->

**Off unless you turn it on.** This step exists because the alternative is not
"agents that cannot talk to each other" — it is agents that talk by a route
which damages the thing it is steering.

Butchr carries an agent-to-agent message (`butchr_send_to_agent`) one of two
ways, and the daemon picks per recipient. A **channel** places the message in
the recipient's context, to be read at its next turn boundary; it interrupts
nothing. With no channel the daemon falls back to the **composer**, which types
into the recipient's terminal — and that fallback opens with a Ctrl+C:

* it **destroys the tool call the recipient had in flight**, which the recipient
  then reports as a human having rejected work that nobody rejected;
* a long or multi-line message can be **left in the composer unsubmitted**
  ([KAN-499](https://wroosbit.atlassian.net/browse/KAN-499)), silently.

So the default switches nothing on behind your back, and it is not free. If your
agents coordinate at all, read this step before you decide the silence is a bug.

### Turning it on

One switch, read fresh on every routing decision. **Absent, malformed, or
anything but `true` reads as off** — it fails closed, which matters most when
somebody has been editing it in a hurry.

```bash
# read it
cat ~/.local/share/butchr/channel.json

# turn it on
printf '{ "enabled": true }\n' > ~/.local/share/butchr/channel.json
```

⚠ **Turning it on does not reach the agents already running.** Whether an agent
has a channel is decided once, when it is spawned; whether the daemon writes to
one is decided per message. Flip it on under a running fleet and the daemon
starts writing frames at agents whose clients **discard them in silence**. So
restart the fleet to mean it. Flipping it **off** is immediate and needs no
restart — that direction is what a kill switch is for.

### The flag, and its name

With the switch on, the daemon adds one argument to every agent it spawns:

```
--dangerously-load-development-channels=server:butchr
```

The spelling `--dangerously-load-development-channels=server:butchr` is
upstream's, and so is the word in the middle of it. We neither soften it nor
wrap it in something friendlier, because renaming somebody else's warning is how
a caveat stops being read. What it warns about is scope: it loads a
**development** channel from a named MCP server — Butchr's own — rather than
promising the feature is finished. If you searched that string to find out
whether we knew: we do, and this paragraph is the reason.

### What is unfinished about it

**Channels are a research preview.** Delivery all the way to a *model* has been
measured on ['2.1.224', '2.1.226'] and on no other client version, so a client
upgrade can move the contract with nothing announcing it.

The daemon does not pretend otherwise — it flags rather than assumes. Each
agent's startup self-check is readable per agent under `channel` in
`butchr_list_agents`:

| what it reports | what it means |
| --- | --- |
| `transport: 'channel'` | messages to it travel by channel and interrupt nothing |
| `transport: 'composer'` | its channel did not prove out; a message will interrupt it |
| `transport: 'unregistered'` | no registration right now, so a send is **refused** rather than delivered. Ordinary for a few seconds after a daemon restart, and it clears itself |
| `outcome: 'unverified-client'` | the loop works, but on a client version nobody has measured. Treat delivery as unproven and say so if you rely on it |

**A brand-new agent is not a channel-less agent.** Registration lands roughly
twelve seconds after spawn, so an agent read the instant it starts will honestly
report no channel yet.

### ⚠ The failure is silent, and it is silent *on the side that would report it*

This is the part most worth understanding before you turn the step on, because
every instrument above reports from the **sender's** side.

**An agent spawned without the flag is deaf, and nothing tells it so.** It has no
channel registration, so channel frames addressed to it are never delivered —
and from inside that agent the result is indistinguishable from nobody having
written to it. There is no error, no dropped-message log on its own pane, and
nothing in its context to notice. It will report itself healthy, because by every
measure available to it, it is.

**Which means the count of deaf agents is not something the fleet can see.** Ask
from the outside, per agent, and treat a missing answer as a missing answer
rather than as a clean bill of health:

```bash
# is the switch on, and who is already deaf because they predate it?
node daemon/scripts/butchr-doctor.mjs | grep -i channel
```

That reports the **switch**, and — usefully — says in as many words when agents
already running were spawned without a channel and will keep the composer until
restarted. It does not report per-agent transport; the per-agent `channel` block
on `butchr_list_agents` is what does, and step 9's table above is how to read it.
**`butchr_agent_status` carries the same block**, but note that on daemons older
than KAN-435 it omitted the key entirely for every agent — an absent field there
is the tool declining to answer, not an agent without a channel, and it was
filed as a defect twice on agents that were fine.

Two ways a fleet ends up here, both quiet:

* **Agents that were already running when you flipped the switch on.** Covered
  above — whether an agent has a channel is decided when it is *spawned*. Those
  agents are deaf for the rest of their lives and the daemon will keep writing
  frames at them.
* **A client that no longer takes the flag.** The spelling
  `--dangerously-load-development-channels` **does not appear in `claude --help`
  at all** — measured `0` occurrences against a positive control of `1` for
  `permission-mode`, so the search was capable of finding it. It is an
  undocumented upstream flag. Nothing guarantees it keeps working, and the day it
  stops, every agent spawns deaf and no agent notices.

⚠ **Check the client version you are actually running against the measured
list**, which is two entries long and above the fold in this step:

```bash
claude --version
```

If that does not match, delivery to a *model* is unproven on your install
whatever the transport says — `outcome: 'unverified-client'` is the daemon
saying exactly that, and it is a statement about evidence rather than about
health. **The fleet this document was last rehearsed against was itself outside
the measured list** (client `2.1.238`), which is the ordinary state rather than
an alarming one: clients update on their own schedule and the list only grows
when somebody re-measures.

### Why this is optional and not recommended

Recommending it to every new install would mean telling you to pass a flag whose
contract is a research preview we do not control, pinned to a measured-version
list that is two entries long — and both directions of getting it wrong are
quiet. Leaving it off and saying nothing is the state this step replaces: the
failure a new user actually met was the composer's, with nothing to tell them a
better mode existed. So it stays off, it is written down, and the switch is
yours.

`butchr-doctor` reports which way the switch is set, and warns when the file
exists but does not parse — the one state here that is a surprise rather than a
decision. See [docs/channel-addressed-delivery.md](channel-addressed-delivery.md)
for the switch's design and
[docs/channel-messaging-design.md](channel-messaging-design.md) for the split
between the two carriers.

---

## 10. Keeping it working

Merging a PR changes nothing on your machine until you do this. The daemon now
says so when it is outstanding — at startup in its log, and as a banner on the
Agents page — but it will not do any of it for you. See
[docs/staleness.md](staleness.md) for what it checks and why it warns rather
than blocks; `butchr-doctor` reports the same build staleness on demand.

```bash
git pull
cd daemon && npm run build && cd ..
cd extension && npm run build && cd ..
systemctl --user restart butchr-daemon.service
```

...and then **reload the extension by hand** at `chrome://extensions`. Again:
this cannot be driven from outside the browser. If you skip it you will be
testing yesterday's bundle while reading today's code, which is a genuinely
expensive mistake and the reason it is spelled out twice in this document.

**None of this reaches a running agent's MCP server, and nothing above will.**
Each running agent holds its own long-lived `mcp.js`, spawned by its client and
serving every proxy call that agent makes; the restart above reaches the daemon
and not one of them. So after a deploy, a merged fix is live for everything the
daemon computes and inert for everything `mcp.js` computes, until each agent's
client is restarted — which costs that agent its session, and is therefore left
to a human rather than done for you.

The daemon stops being silent about it: about 45 seconds after it starts — long
enough for the fleet to re-announce itself — it logs a `deploy reach:` line
naming which agents are still running an older build. `butchr_staleness_check`
answers the same question on demand under `mcp-servers`, and tells an agent
about *its own* server under `servingProcess`. See
[docs/staleness.md](staleness.md) — *"a live probe measures the answering
process, not the deploy"*.

---

## 11. Upgrading herdr — which is not the same operation as step 10

Step 10 upgrades **Butchr**, and it is reversible: the clone is a git checkout,
so a bad deploy is `git checkout <old>` plus a rebuild. **Upgrading herdr is
neither of those things**, and this section exists because both of its surprises
were learned by hitting them rather than by reading anything.

### ⚠ It is forward-only. Keeping the old binary is not a rollback.

Measured across a 0.6.4 → 0.8.2 upgrade: restoring the previous herdr binary did
**not** undo the upgrade. 0.8.2 had already migrated `session.json` and fetched
engine-v2 detection manifests, and 0.6.4 put back on top of that **could not open
a pane at all** — a worse state than either version on its own.

**So back up the state directory, not just the binary**, before you upgrade:

```bash
cp -a ~/.local/share/herdr ~/.local/share/herdr.bak-$(date +%Y%m%d)
```

⚠ **Any upgrade advice that implies reversibility — including a previous version
of this document — is actively dangerous.** The binary is the part that is easy
to keep and the part that does not help.

### ⚠ It cannot be run from inside the fleet

`herdr update` replaces the binary that owns the panes your agents are sitting
in, and it wants to stop the running server to do it — the update path carries an
interactive `stop the old server now? [y/N]` prompt. **An agent cannot answer
that**, and an agent is by definition running inside a pane that the update is
about to take away. Butchr's own agents report `herdr update` refusing when
invoked from inside a herdr session.

**So this is a human step, performed from outside the fleet**, and it is the one
operation in this document that a Butchr agent cannot do for you:

```bash
# 1. from a terminal that is NOT a herdr pane -- check
[ -n "$HERDR_PANE_ID" ] && echo "INSIDE a herdr pane -- do not upgrade here" \
                        || echo "outside herdr -- ok"

# 2. stop the fleet
systemctl --user stop butchr-daemon.service
systemctl --user stop herdr.service     # if Butchr installed one

# 3. back up state (above), then upgrade
herdr update
herdr --version

# 4. bring it back
systemctl --user start herdr.service
systemctl --user start butchr-daemon.service
node daemon/scripts/butchr-doctor.mjs
```

`herdr update` also **refuses outright when herdr came from a package manager**,
naming the right command instead — Nix, `mise upgrade herdr`, or
`brew update && brew upgrade herdr`. That refusal is correct and is not a
failure; use what it tells you.

### Which versions Butchr supports

Step 1 has the detail and it is not repeated here, because a version list written
in two places drifts. The short form: **0.7 or newer**, 0.6.x is deliberately
dropped, 0.7.5 and 0.8.0 are the verified pair, and above that the daemon logs
*"newer than verified"* as a note rather than a refusal. `butchr-doctor` and the
daemon's startup log both name the version, so a wrong one cannot fail silently.

⚠ **After any herdr upgrade, re-run `butchr-doctor`** — it is the only thing that
checks the new binary against what Butchr actually issues, and it is cheaper than
discovering the mismatch at the next activation.

---

## 12. Which runtime you just installed — and why it may not be the one you meant

**Following this document gives you the herdr runtime.** That is the default,
it is the supported path, and if you have no reason to want otherwise you are
finished — skip to the summary below.

Read this if you are standing up a box to **match an existing Butchr
deployment**, because the two can differ with nothing announcing it.

Butchr can drive agents through either of two runtimes, chosen by
`BUTCHR_AGENT_RUNTIME` and read **once, at daemon construction**:

| value | runtime | how you get it |
| --- | --- | --- |
| unset, empty, misspelled, `1`, `true` | **herdr** (`HerdrBridge`) | the default. Every step above installs this |
| `crabcast` | **CrabCast** (`CrabCastRuntime`) | only if you set it deliberately, in a systemd drop-in |

⚠ **Nothing in steps 1–11 sets it, and nothing warns you that a peer machine
might have.** The fallback is deliberately asymmetric — an unrecognised value
falls back to `herdr` and says so, because falling back to CrabCast on a typo
would move a fleet onto an unproven path. So a fresh install is *always* herdr,
and a machine you are trying to match may not be.

**Ask the machine rather than assuming**, on both boxes:

```bash
node daemon/scripts/butchr-doctor.mjs | grep -i runtime
ls ~/.config/systemd/user/butchr-daemon.service.d/
```

The drop-in directory is the part worth looking at directly. It is where a
deployment's real configuration accumulates — the runtime pin, the agent cap, the
proxy mode — **and no script here writes any of it**. Step 6.5 is the only place
this document tells you to write one, and it covers two knobs of the several that
can live there. Two machines that both followed this file to the letter can still
be running different products because one of them has a drop-in the other does
not.

To select CrabCast, if you have been told to:

```bash
mkdir -p ~/.config/systemd/user/butchr-daemon.service.d
printf '[Service]\nEnvironment=BUTCHR_AGENT_RUNTIME=crabcast\n' \
  > ~/.config/systemd/user/butchr-daemon.service.d/crabcast.conf
systemctl --user daemon-reload
systemctl --user restart butchr-daemon.service
```

CrabCast is a **separate tool that must already be installed and running** — it
is not fetched by anything above, and Butchr talks to it over a socket
(`BUTCHR_CRABCAST_SOCKET`, which has a default it will report). Butchr pins the
CrabCast commit it was verified against, and the daemon logs the pin at boot. See
[docs/crabcast-runtime.md](crabcast-runtime.md) for the contract and
[docs/crabcast-cutover-sequence.md](crabcast-cutover-sequence.md) for the
supported way to move a live fleet across.

⚠ **Once the pin is set, the daemon refuses to start without it** — that is the
exit-`4` behaviour described in step 7, and it is a guard rather than a fault: a
daemon that would silently have come up on the *other* runtime stops instead.
`BUTCHR_ALLOW_UNPINNED_RUNTIME=1` overrides it if you mean it.

---

## What is running on your machine when this is done

```
~/.config/systemd/user/butchr-daemon.service
~/.config/systemd/user/butchr-daemon.service.d/*.conf      (step 6.5 — you wrote these)
~/.config/systemd/user/herdr.service                       (if you had none)
~/.config/systemd/user/herdr.service.d/10-butchr-nofile.conf
~/.config/systemd/user/butchr-agent-check.{service,timer}
~/.config/google-chrome/NativeMessagingHosts/com.butchr.daemon.json
~/.config/chromium/NativeMessagingHosts/com.butchr.daemon.json
~/.local/share/butchr/                 socket, logs, workspaces, credential
<your clone>/                          prompts and dist/ are read at runtime
```

`~/.local/share/butchr/workspaces/<type>/<key>/` is where agents work. Butchr
will delete a directory under there on request and refuses to delete anything
that resolves outside it.

### Uninstall

```bash
systemctl --user disable --now butchr-daemon.service butchr-agent-check.timer
rm -f  ~/.config/systemd/user/butchr-daemon.service \
       ~/.config/systemd/user/butchr-agent-check.{service,timer}
rm -rf ~/.config/systemd/user/herdr.service.d \
       ~/.config/systemd/user/butchr-daemon.service.d
systemctl --user daemon-reload
rm -f ~/.config/{google-chrome,chromium}/NativeMessagingHosts/com.butchr.daemon.json
rm -rf ~/.local/share/butchr       # deletes every agent workspace — check first
```

Remove the extension at `chrome://extensions`. `loginctl disable-linger $USER`
if nothing else on the machine wants it, and remove `herdr.service` only if
Butchr installed it.
