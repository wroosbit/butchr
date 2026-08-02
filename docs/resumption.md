# Surviving a power cut

Butchr agents are supposed to outlive the machine they run on. This is how.

## The failure this exists to end

On 2026-07-31 two task agents were activated at `17:23:47 UTC`. At `17:25:20` the
machine rebooted. Ninety-three seconds of work vanished, and:

* nothing resumed on its own — not the task agents, not their supervisors;
* `butchr_agent_status` answered `agent target butchr-task-kan-16 not found`,
  so the agents were gone at the herdr level, not merely detached;
* both Jira tickets read **In Progress** for another twenty minutes;
* the loss surfaced only because a human asked whether the board was accurate.

Nothing survives a power cut, so "keep the agent alive" was never available as a
strategy. The shape is **persist, then restore on boot**.

## The four pieces

### 1. A durable registry — `~/.local/share/butchr/agents.jsonl`

An append-only JSONL log, one record per lifecycle event, written and `fsync`ed
*before* the activation is acknowledged to whoever asked for it. See
`daemon/src/agent-registry.ts`.

```jsonl
{"agentName":"butchr-task-kan-21","type":"task","key":"kan-21","workDir":"/home/you/.local/share/butchr/workspaces/task/kan-21","url":"https://site.atlassian.net/browse/KAN-21","defaultAgent":"claude","mcpServers":["atlassian","butchr"],"event":"activated","at":"2026-07-31T18:04:11.902Z"}
{"agentName":"butchr-task-kan-21","type":"task","key":"kan-21","workDir":"…","event":"deactivated","at":"2026-07-31T19:40:02.115Z"}
```

Two things about the format matter:

**It is written eagerly, not on exit.** A power cut runs no shutdown hook, so
anything saved at exit is not saved. The `fsync` is the point: without it a
`write()` that has already returned still lives only in the page cache, which a
power cut discards.

**A torn tail is expected and survivable.** Appending means a machine that dies
mid-write leaves half a final record. The reader drops any line it cannot parse
and keeps every complete record before it, so a tear costs at most the one event
that was in flight. Losing a *deactivation* that way leaves the agent recorded as
active, which is the safe direction to be wrong: it stays visible as missing
rather than silently disappearing.

The log is compacted — atomically, via temp file + `rename` + directory `fsync` —
once it passes 500 records.

**It records intent, not history.** Only the last event per agent counts.
`activated` means restore it; `deactivated` means leave it down. An agent a human
stood down before the outage stays down.

### 2. Starting at boot — already done

`butchr-daemon.service`, `herdr.service` and `loginctl enable-linger`, installed
by `daemon/scripts/install-service.sh`. See [SETUP.md](SETUP.md) §6. Verified
across a real reboot: both units up eleven seconds after boot, with nobody logged
in. Restoration hangs off the daemon's own startup, so it inherits that.

### 3. Reconciliation — `daemon/src/reconcile.ts`

When the daemon has finished listening, it reads the registry, asks herdr what
actually survived, and starts what is missing.

It goes through the same `handleActivateByKey` a sidepanel toggle uses. **No
browser is involved**, which was the thing to prove: activation was always a
daemon-side operation that the extension merely *called*, so restoration needs no
tab, no sidepanel and nobody logged in.

Three details worth knowing:

* **It waits for herdr first.** `herdr agent list` returns an empty list both
  when herdr has no agents and when herdr cannot be reached, and at boot the
  second is likely — systemd's `After=herdr.service` says herdr was *launched*
  first, not that its socket is accepting. Treating "not up yet" as "everything
  is missing" would start a second copy of a fleet that was about to appear.
  `HerdrBridge.herdrReachable()` is the distinction.
* **Restores are staggered** by three seconds, because six agents starting at
  once on a machine that is also finishing its own boot is how a restoration
  becomes the outage.
* **They override the capacity cap.** These agents were being carried when the
  power went out, so the machine has already shown it can hold them; refusing
  them on a load average that is high *because the machine is booting* would
  recreate the silent loss. The override is recorded and broadcast, as any
  override is.

### 4. Resume framing — `daemon/src/resume.ts`

Respawning is half a resume. The other half is that the agent knows what
happened.

Before spawning, the daemon checks whether Claude Code has a transcript for that
workspace — `~/.claude/projects/<cwd with every non-alphanumeric replaced by a
dash>/*.jsonl`, the same lookup `--continue` performs.

| | what runs | what the agent is told |
|---|---|---|
| transcript present | `claude --continue` restores it | the daemon **types a message** into the pane once it reaches a prompt: you were interrupted, check the repo and workspace for what you already did, don't start over |
| transcript absent | `--continue` exits 1 and the fallback runs | the fallback's argv prompt **is** the interrupted-work framing, so the agent starts working immediately and depends on nothing being delivered |

Getting the probe wrong is survivable either way: a false positive nudges an
agent that is already working, and a false negative leaves an agent idle but
remembering — which is what the missing-agent report is for.

## What was actually wrong with `--continue`

The original ticket suspected conversation persistence. It was measured on this
host against Claude Code `2.1.220`, in a real PTY, and persistence was fine:

* the transcript is written **eagerly**, per event;
* it **survives `SIGKILL`** with no shutdown hook;
* a **deliberately torn** final record still resumes;
* `--continue` with genuinely no history exits **1** with `No conversation found
  to continue`, which is what makes the launcher's `||` fallback correct.

*(A caveat for anyone re-running this: a test spawned from inside a Claude agent
inherits `CLAUDE_CODE_CHILD_SESSION=1`, and child sessions do not persist a
transcript. That produces a convincing false negative. The daemon spawns through
herdr, whose environment has no such variable.)*

Two other things did block an unattended resume.

### The resume modal

Claude Code offers *"Resume from summary / Resume full session as-is / Don't ask
me again"* when a resumed conversation is **both** older than
`CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) **and** larger than
`CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100000) — the exact profile of an
agent that has been working all afternoon, and a hard stop for one with nobody at
the keyboard. Both are read from the environment, so the daemon raises them past
any real conversation when it starts a pane (`RESUME_ENV`).

The cost is real and deliberate: suppressing the prompt always takes the *full
session* branch, which is the more expensive of the two. For an unattended agent
that is right — its context is the thing being restored — but it is not free.

### Nobody told the restored agent to carry on

This is the larger one, and it is why "it came up at a fresh splash with an empty
composer" was an ambiguous reading: **a successful `--continue` also renders the
splash banner**, with the restored history above it. What was certainly true is
that the agents sat idle until a human retyped their instructions. Restored or
not, Claude Code resumes at a prompt and waits. Hence the nudge, on both paths.

## Detection

Restoration can fail. An agent that dies and does not come back has to surface
somewhere, and a log line does not count.

The registry says what *should* be running; herdr says what *is*. The difference
is `missingAgents`, and it appears:

* on **every `list_agents` response**, which is what `butchr_list_agents` returns
  — the call the epic and story agents already make. A non-empty `missingAgents`
  also sets `isError`, so a supervisor skimming for problems cannot skim past it;
* as an **`agent_lost_event`** broadcast by a sweep every 30 seconds, for
  newly-missing agents only (re-announcing an hour-old loss twice a minute would
  train everyone to ignore it);
* as a **banner on the Agents page**, above the list — because three running
  agents mean something different when a fourth should be there.

The sweep **reports only; it never restarts anything.** Boot restoration is a
known situation with a known cause. An agent that dies mid-afternoon is not, and
guessing at it is a different ticket.

## Checking it yourself

```bash
cd daemon && npx tsc && node scripts/verify-agent-resumption.mjs
```

That covers the registry's crash-safety (including a real `SIGKILL`), torn tails,
intent-over-history, and the resume framing. It does **not** stand in for the
reboot — the failure being fixed is a power cut, and only a power cut proves it.

```bash
# the registry, as the daemon sees it
cat ~/.local/share/butchr/agents.jsonl

# what the daemon did at boot
grep reconcile ~/.local/share/butchr/daemon.log
```
