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

`herdr update` is fine to run, and so is letting it update itself.

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
secret-tool lookup service butchr account jira; echo "exit=$?"
```

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

## 7. Check that it worked

```bash
node daemon/scripts/butchr-doctor.mjs
```

This is the point of the whole document: it re-checks every step above and
exits non-zero if any of them is not true. It reports node, herdr, herdr's live
fd soft limit and the pane headroom that implies, both builds *and whether they
are stale relative to their sources*, the native-messaging manifest (including
whether the path it names still exists), the systemd unit and linger, whether
anything can actually connect to the daemon socket, which backend a Jira
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

If the sidepanel reports it cannot reach the daemon, the order to check things
in is: `butchr-doctor` first, then `~/.local/share/butchr/daemon.log`, then
`/tmp/native-host-sh.log` (which records which `node` Chrome's minimal
environment resolved), then the extension's service-worker console at
`chrome://extensions`.

---

## 8. Optional: the Jira credential

Butchr works without one. Its only effect is that Jira **Stories** open as
`story` workspaces instead of `task` workspaces — everything degrades to `task`
on any failure, by design.

On the extension's **Settings** page, supply your site URL, account email and
an Atlassian API token. Prefer a **scoped** token limited to `read:jira-work`;
the daemon has no write path to Jira and none should be added. The page tells
you which storage backend this machine will use before you type the token, and
validates it at submit time. See `docs/butchr.md` for the full design.

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

## What is running on your machine when this is done

```
~/.config/systemd/user/butchr-daemon.service
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
rm -rf ~/.config/systemd/user/herdr.service.d
systemctl --user daemon-reload
rm -f ~/.config/{google-chrome,chromium}/NativeMessagingHosts/com.butchr.daemon.json
rm -rf ~/.local/share/butchr       # deletes every agent workspace — check first
```

Remove the extension at `chrome://extensions`. `loginctl disable-linger $USER`
if nothing else on the machine wants it, and remove `herdr.service` only if
Butchr installed it.
