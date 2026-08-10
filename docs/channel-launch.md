# Launching an agent with a channel — and how to take it back

**KAN-246 (T3 of KAN-150).** What the launcher does when channels are on, what
answers the dialog that flag raises, what "ready" means, and — because this is
the change most likely to need it — **exactly what to revert and how you would
know.**

Scoped to **Claude Code 2.1.226**, measured 2026-08-09. §6.1 of
[the design](channel-messaging-design.md) says the contract may move; §"When the
contract moves" below says what that looks like from here.

---

## The short version

| | |
|---|---|
| **Switch off** (the shipped state) | The launcher composes the command Butchr has always composed, byte for byte. No flag, no dialog, no watcher. |
| **Switch on** | Both arms of the `||` carry `--dangerously-load-development-channels server:butchr`. Claude Code raises a blocking full-screen dialog per invocation; **the daemon answers it** and then waits for the agent's MCP server to register. |
| **The revert** | `echo '{"enabled": false}' > ~/.local/share/butchr/channel.json`. Immediate, no restart, no deploy. |

The switch is KAN-244's, not a new one — see [Why one switch](#why-one-switch).

---

## What the launcher spawns

`AGENT_LAUNCHERS.claude.command()` (`daemon/src/launchers.ts`) builds one string
from one template, so both arms of the `||` necessarily carry the same flags:

```
# switch off
claude --permission-mode bypassPermissions --continue \
  || claude --permission-mode bypassPermissions '<prompt>'

# switch on
claude --dangerously-load-development-channels server:butchr --permission-mode bypassPermissions --continue \
  || claude --dangerously-load-development-channels server:butchr --permission-mode bypassPermissions '<prompt>'
```

The `||` is load-bearing and measured — `claude --continue` in a directory with
no history exits 1 — and nothing here restructures it.

**Why a template and not a splice.** KAN-217's probe added the flag by
string-replacing into the shipped command, and proved the hazard on itself: an
early version stamped only the first arm, so a fresh workspace fell through into
an arm with no flag. A *half-flagged* command line is worse than an unflagged
one, because it works on every resumed activation and fails only on cold starts.
Composing both arms from one `flags` string makes that state unrepresentable.
`verify-channel-launch-flag.mjs` asserts it per arm anyway, and `--one-arm`
reproduces the historical defect so you can watch that assertion go red.

### What `--dangerously-load-development-channels` costs an unattended fleet

Three things, in descending order of how much they should worry you.

**1. It puts a blocking dialog on the critical path of activation itself.**
A full-screen confirmation *before the session starts*, once per `claude`
invocation — so **twice** on a fresh workspace. There is **no persisted
acceptance**: Claude Code's `DevChannelsDialog` is mounted unconditionally
whenever dev channels are named and channels are live for the account. (The
`ClaudeInChromeOnboarding` component beside it in the same bundle *does* persist
its acceptance, which is what makes the absence here evidence rather than a
failure to find it.) So it cannot be pre-accepted in config the way folder trust
is by `trustClaudeWorkspace`. Something has to press Enter, every time, forever.

**2. It is a second dangerous flag on top of one we already run.** The fleet
already launches with `--permission-mode bypassPermissions`. A channel means
content can enter the model's context of a session that does not stop to ask
before acting. **This is not a new exposure** — the composer path already types
arbitrary text into a bypassing agent, and anything that can reach the daemon's
Unix socket could already do it (KAN-149 names the socket as the trust boundary,
and it is a filesystem permission, not a credential check). What changes is that
it becomes *quieter*: a composer injection leaves a line in the pane a human can
scroll back to, and a channel event leaves nothing on screen at all.

**3. There is a startup race.** The client spawns its MCP servers only *after*
the dialog clears, so a pane can look ready seconds before any listener exists,
and an event fired into that window is lost in silence. Hence the wait below.

---

## What answers the dialog

`daemon/src/channel-startup.ts`, driven from `daemon.ts` by a listener the
`HerdrBridge` fires once per pane it spawns. It reads the pane through the same
`recent-unwrapped` source `butchr_tail_agent` uses, and presses Enter through
`herdr pane send-keys` — the instrument KAN-217 established.

* **It matches the dialog's own words** (`Loading development channels`, `I am
  using this for local development`), never the flag name — a pattern that
  matched the flag would fire on any pane that echoed the command line and press
  Enter at a session that is running fine.
* **It sends at most four Enters.** Two is the measured number, one per `claude`
  invocation, and the `||` makes at most two invocations. Four is what is
  allowed; the gap is deliberate, because more than that means our model of the
  startup sequence is wrong and pressing Enter blind at a session we no longer
  understand is worse than stopping.
* **A send herdr refused is not counted against that cap**, so a transient herdr
  outage cannot permanently stop the watcher answering a dialog that is still
  there.
* **It is bounded by a 180-second deadline** and then reports. It never becomes a
  background task that outlives the agent it was watching.

### It does not block the activation, and that is a trade

`activate` answers on herdr's own evidence, as it always has, and the watcher
runs afterwards. The reason is arithmetic: an MCP client gives a daemon request
30 seconds, and a fresh channel-enabled workspace has to answer two dialogs, fail
a `--continue`, boot a second `claude` and spawn an MCP server inside that.
Blocking the response would trade a wedged agent for a timed-out activation and
tell the caller less.

**What it costs, said plainly: `activate` can answer `success: true,
verified: true` for an agent sitting on a dialog it will never clear.**
`verified` has always meant "a live runtime is behind the pane" (KAN-58), and a
`claude` rendering a dialog is exactly that. This is not a new lie, but it is a
new way for the old one to matter — and the daemon log is where the truth lands.

---

## What "ready" means, and what it does not

Ready is **all three of these, in the same pass**:

1. **A fresh connection** for this agent's address in KAN-243's identity map —
   one registered after the spawn. Not a proxy: it is literally the socket
   `routeChannelMessage` would write an addressed frame to. Before it resolves,
   an addressed send answers `no-connection`; after, the send has somewhere to go.
2. **No dialog on the pane.**
3. **The pane at a session prompt.**

### Condition 3 is not belt and braces — a live run paid for it

The first version of this watcher returned on condition 1 alone. On a fresh
workspace it reported ready in **six seconds having answered one dialog**, and
the agent never reached its prompt.

`claude --continue` boots far enough to **spawn its MCP servers** before it
discovers there is no conversation to continue. So the sequence was: dialog #1 →
Enter → server registers → watcher declares victory and stops → that `claude`
exits 1 → the `||` starts the second one → **dialog #2 raised with nothing
watching for it**. The pane read `No conversation found to continue` and stayed
there.

That is the exact brick this module exists to prevent, produced by the module
itself. **No deterministic harness could have caught it**: every one of them
supplies its own answer to "has a connection appeared", and would have supplied
the same wrong one. `verify-channel-startup-supervision.mjs` section 8 is the
regression, written from the live sequence afterwards.

The design's §1.4 warning — wait for *server* readiness, **not** the pane — is
not being disregarded here. Its point is that a ready-looking pane is not
*sufficient*; conditions 2 and 3 are *necessary* ones, and condition 1 is still
what makes the claim about reachability.

Three things that are *not* readiness on their own, each rejected for a measured
reason:

* **The pane looking ready** — defect 3 above, exactly.
* **The `Channels (experimental) …` startup banner** — KAN-217 saw it printed
  over a *crashed* server. It is the client saying it intends to have a channel.
* **A connection that is merely present** — a re-activation finds the previous
  session's connection still in the map, because socket close is not ordered
  against a fresh connect. "Is there a connection?" answers yes instantly, for a
  dead session, on every restart. Freshness is decided against the spawn
  timestamp, with a one-second grace for the two events racing.

**And here is the edge of the claim.** A registered connection proves the agent's
`mcp.js` is up and addressable. It does **not** prove the client registered a
*channel* with it — that handshake is stdio between Claude Code and `mcp.js`, and
the daemon is not on it. Claude Code 2.1.226 can decline a channel for six
separately-named reasons (`capability`, `era`, `provider`, `disabled`, `policy`,
`session`) **with the flag on the command line and the banner printed**. Nothing
in this ticket catches that. **KAN-248 (T5), the per-agent startup self-check, is
what covers it**, and until it lands the gap is real and unwatched.

---

## Why one switch

The launcher does not get a switch of its own. It reads
`channelEmissionEnabled()` — KAN-244's `channel.json`, the same file, the same
reader, the same fail-closed-on-anything-unreadable semantics as the daemon's
addressed-send path. `channel.ts` argues generally why a second copy of one
condition is worse than one copy; here the argument is sharper, because two
switches would admit two states nothing reports:

* agents launched with a channel the router will not write to, and
* the router writing frames at agents that have no channel to receive them.

**What one switch cannot do.** A launch decision is taken once, at spawn; an
emission decision is taken per message. So:

* Turning it **on** does nothing for agents already running — they were spawned
  without the flag and stay that way until restarted — while the daemon will
  happily resolve them in the identity map and write frames their client
  discards in silence. **Whoever turns this on for the fleet must restart the
  fleet to mean it.**
* Turning it **off** is immediate for emission and needs nothing restarted. The
  safe direction is the fast one, which is what a kill switch is for.

---

## THE REVERT

### Level 1 — the switch. Seconds, no restart, no deploy.

```bash
echo '{"enabled": false}' > ~/.local/share/butchr/channel.json
# or, equivalently, delete it: absent means off
```

Every activation after this composes the pre-KAN-246 command line **byte for
byte** — no flag, therefore no dialog, therefore nothing that can wedge. The
watcher is not installed for those spawns at all.

Agents *already running* keep whatever they were started with. They are not
harmed by it; the flag's cost is paid at startup and they are past it. **Any
agent still stuck on a dialog needs re-activating** — the switch does not reach
back into a pane.

This is also the answer to "the fleet is behaving oddly and channels are the
newest thing in it": turn it off, confirm, and diagnose with the variable
removed.

### Level 2 — the code. Only if the switch is not enough.

Revert the KAN-246 merge commit. What comes out:

| File | What it was |
|---|---|
| `daemon/src/launchers.ts` | `claudeCommand` / `developmentChannelFlags` / `DEV_CHANNELS_FLAG` — back to the two-line literal command |
| `daemon/src/channel-startup.ts` | deleted entirely |
| `daemon/src/herdr.ts` | `setAgentSpawnedListener`, its call site in `initPty`, and `pressPaneKey` |
| `daemon/src/daemon.ts` | the `setAgentSpawnedListener` wiring |
| `daemon/scripts/verify-channel-launch-flag.mjs`, `verify-channel-startup-supervision.mjs`, `probe-channel-launch.mjs` | deleted |

Nothing else in the channel stack depends on it: KAN-244's capability, KAN-247's
routing and KAN-249's brief all continue to work, inert, exactly as they did
before this landed.

### How you would know you need it

The daemon writes every one of these to `~/.local/share/butchr/daemon.log`:

```bash
grep ChannelStartup ~/.local/share/butchr/daemon.log
```

| What you see | What it means |
|---|---|
| `ready after <n>ms — the agent is at its prompt and its MCP server is registered` | The healthy path. Nothing to do. |
| `GIVING UP — a development-channels dialog was still on the pane …` | **The brick.** The agent has not reached its prompt and will not on its own. The `REVERT` line follows it in the log. |
| `GIVING UP — an MCP server registered … but the pane never reached a session prompt` | The client booted, connected and then left. Read the pane before assuming the channel is at fault. |
| `GIVING UP — no MCP server registered …` | The session may be up with no channel behind it. Addressed sends to it will answer `no-connection`. |
| `GIVING UP — the pane could not be read at all …` | herdr is not answering. This is a herdr problem, not a channel one; the agent may be fine. |
| `refusing to press Enter again at a startup sequence this no longer models` | A fifth dialog appeared. The client's startup has changed under us — **stop and read the pane before doing anything else.** |

The symptom without the log — because this is what somebody will actually
notice first — is **an agent that activated successfully and then never said
anything.**

**And `butchr_tail_agent` on it will very likely show you NOTHING AT ALL, which
is the part that will waste your time if nobody tells you.** The tail reports
what has recently *scrolled*; a full-screen dialog paints once and then produces
no further output, so the box is in the tail for perhaps a minute and the pane
reads empty after that. Measured in `probe-channel-launch.mjs` phase 3: the
dialog was on the tail at t+30s and gone from it at t+60s and t+90s, with the
agent still wedged behind it the whole time.

So: **an empty tail on a channel-enabled agent that never spoke is the symptom**,
not evidence that nothing is wrong. The log is what distinguishes it, and the
watcher reports `dialog-unanswered` for this shape rather than `no-connection`
precisely so the log does not send you looking for a channel fault. The fix is
the switch above and a re-activation.

**The revert instruction is also printed into the log beside the failure**, by
`logRevert` in `channel-startup.ts`, because a runbook nobody can find is not a
runbook and this failure is met by somebody staring at a fleet that is not
working.

**It is not applied automatically, and that is a decision.** One agent failing to
bring a channel up is not evidence about the fleet, and a daemon that silently
flipped a fleet-wide switch on one agent's timeout would be making a policy call
nobody asked it to make — and hiding the failure it was reacting to.

---

## When the contract moves

The research preview's flag syntax and protocol contract may change. Two shapes
to expect, both of which look like success from here:

* **The dialog's wording changes.** The watcher stops matching, stops pressing,
  and every channel-enabled activation wedges. Loud, immediate, and the log says
  `GIVING UP — a development-channels dialog was still on the pane`.
* **The client silently declines the channel.** `era` is the one to watch:
  *"connection negotiated a modern protocol revision with no unsolicited
  notification path"*. An MCP SDK bump could turn every channel off with the flag
  still on the command line, the server still connected, the banner still
  printed, and this document's definition of "ready" still satisfied. **Nothing
  here would notice.** That is KAN-248's subject.

---

## Reproducing any of this

```bash
cd daemon && npm install && npm run build

# the command string, both switch states, both arms — deterministic
node scripts/verify-channel-launch-flag.mjs
node scripts/verify-channel-launch-flag.mjs --one-arm       # watch it go red

# the watcher's outcomes, on a virtual clock — deterministic
node scripts/verify-channel-startup-supervision.mjs
node scripts/verify-channel-startup-supervision.mjs --blind # watch it go red

# the live proof: real claude, real dialog, real pane. Minutes, and it takes
# a capacity slot. Phase 3 reproduces the brick.
node scripts/probe-channel-launch.mjs
```

The probe runs its daemon under a relocated `$HOME`, so **the fleet's channel
switch is never read and never written**. The caveat that comes with that route,
carried in full: a private `$HOME` gives a private *daemon* and **not** a private
*herdr* — the agents it starts are real panes taking real capacity, its folder
trust goes into the real `~/.claude.json`, and a composer send from it would
reach a real fleet pane. The probe refuses on all three counts rather than
relying on anyone remembering.
