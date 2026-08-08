# Can a Claude Code channel push a message into a running Butchr agent?

**Finding for KAN-217, establishing the premise KAN-167 left open.**
Repository read at `177568b`. Probe run 2026-08-07, Claude Code **`2.1.224`**.

---

## The answer, plainly

KAN-217 was cut back to exactly two questions ([comment 10919]). Both were
measured, and both are **yes**.

> **1. Does a channel event reach a running Butchr agent?**
> **YES.** On a real Butchr agent, activated through the daemon, interactive
> under a herdr pane, carrying a nonce that rode inside a **real daemon
> broadcast**. The model did not merely receive it — it **sent the nonce back
> out over the channel's own reply tool**, so the token crossed
> daemon → channel → model → channel without the composer being used in either
> direction.
>
> **2. When the recipient is not reachable, does the sender find out?**
> **YES.** A send to a live session resolves cleanly; a send to a killed
> session fails at the transport with `ECONNREFUSED`, because the channel
> server is a child of the session and dies with it. The two are
> distinguishable without any application-level acknowledgement.

**This is a fact about `notifications/claude/channel` on client `2.1.224`, and
about nothing else.** KAN-167's finding — that `notifications/message` is read
off the wire and discarded — remains true and was not re-litigated here. The two
findings do not conflict: they are about **two different delivery paths**, and
the whole reason this ticket exists is that the first was being carried as an
answer about the second.

**One large caveat, and it is not a small one.** Delivery is not the same as
compliance. A channel event is **untrusted content** to the model, and an
unprimed session **correctly refused to act on one** during this probe — naming
it as a probable prompt injection. See [The refusal](#the-refusal-delivery-is-not-compliance).
Any migration has to design for that, and it is the finding here most likely to
be skipped over because the headline is a yes.

---

## Question 1 — the build contract, from the reference

Recorded from [`/docs/en/channels-reference`][ref] and [`/docs/en/channels`][ch],
read 2026-08-07 (task 1 of the ticket). Everything in this section is a claim
about the documentation; everything in the next is a claim about this machine.

### What a channel server must implement

Three things, and no more:

| Requirement | Detail |
| --- | --- |
| Declare the capability | `capabilities.experimental['claude/channel'] = {}`. *"Presence registers the notification listener."* Without it, events are discarded silently. |
| Emit the notification | `notifications/claude/channel`, params `{ content: string, meta?: Record<string,string> }` |
| Speak stdio | Claude Code spawns the server as a subprocess, exactly as for any MCP server |

`content` becomes the body of a `<channel>` tag; each `meta` entry becomes an
attribute. `source` is set automatically from the server's configured name. Meta
keys **must be identifiers** — *"Keys containing hyphens or other characters are
silently dropped."*

Optional additions:

| Field | Purpose |
| --- | --- |
| `capabilities.tools = {}` | Two-way. Lets Claude discover a reply tool. Omit for one-way. |
| `instructions` | Goes into Claude's system prompt. **Load-bearing — see [the refusal](#the-refusal-delivery-is-not-compliance).** |
| `capabilities.experimental['claude/channel/permission'] = {}` | Opts in to permission-prompt relay. Out of scope here. |

### Is Bun required?

**No — and this was the single most consequential thing to get right**, because
`bun` is not installed on this machine and the ticket left it open.

> *"The only hard requirement is the `@modelcontextprotocol/sdk` package and a
> Node.js-compatible runtime. Bun, Node, and Deno all work. The pre-built
> plugins in the research preview use Bun, but your channel doesn't have to."*

**Not taken on trust.** Every channel server in this probe is plain Node running
against `@modelcontextprotocol/sdk` — *the same package and version the daemon
already depends on* (`daemon/package.json`, `^1.30.0`). Bun was never installed.

### How a channel is registered

Two steps, and the second is the one that matters for Butchr:

1. An ordinary `.mcp.json` entry, exactly like any other MCP server.
2. **The server must additionally be named on the command line.** *"Being in
   `.mcp.json` isn't enough to push messages: a server also has to be named in
   `--channels`."*

```bash
claude --channels plugin:<plugin>@<marketplace>          # allowlisted plugins
claude --dangerously-load-development-channels server:<name>   # a bare .mcp.json server
```

During the research preview `--channels` accepts **only** Anthropic-allowlisted
plugins, so **anything Butchr writes needs the development flag**. That is why
the flag appears in this probe, and it is not incidental — see
[what would have to change](#what-would-have-to-change).

### The two-way reply path

Nothing channel-specific: a standard MCP tool. Declare `tools: {}`, register
`ListTools`/`CallTool` handlers, and tell Claude in `instructions` when to call
it. This probe's server exposes a one-argument `reply` tool, and **that tool is
what carries the strongest evidence in the whole finding** — the model's echo of
the nonce comes back through it.

### What the reference says about acknowledgement — and why it was still measured

> *"Claude Code doesn't acknowledge notifications. The `await` on
> `mcp.notification()` resolves when the message is written to the transport,
> not when Claude has processed it. If the session hasn't loaded your server as
> a channel, or the organization policy blocks it, Claude Code drops the events
> silently and returns no error to your server."*

That sentence is the ticket's second question answered in advance, and it is
**exactly what this spike was told not to accept on the page's word**. It was
measured. The reference is correct, and the measured picture is more useful than
the sentence: see [question 2](#question-2--does-the-sender-find-out).

[ref]: https://code.claude.com/docs/en/channels-reference
[ch]: https://code.claude.com/docs/en/channels
[comment 10919]: https://wroosbit.atlassian.net/browse/KAN-217

---

## What is true of *this machine*, established rather than assumed

| Question | Answer | How it was established |
| --- | --- | --- |
| Client version | **`2.1.224`** | `claude --version` |
| Do the flags exist? | **Yes**, both | An unknown flag errors with `unknown option`; `--channels` and `--dangerously-load-development-channels` do not. Absence from `--help` is expected in preview. |
| Auth type | **claude.ai OAuth**, personal **Max** org | `~/.claude.json` → `oauthAccount.organizationType: "claude_max"`, `billingType: "stripe_subscription"` |
| Bedrock / Vertex / Foundry? | **No** — none in use | Same record; channels are unavailable on those and would have been a hard stop |
| Is `channelsEnabled` gating us? | **No** | *"Pro and Max users without an organization skip these checks entirely."* No managed-settings file exists: `/etc/claude-code/managed-settings.json` and `~/.claude/managed-settings.json` are both **absent**, and `~/.claude/settings.json` sets neither `channelsEnabled` nor `allowedChannelPlugins`. |
| Is Bun needed? | **No** | The probe's servers are plain Node; `bun` remains uninstalled |
| Does any fleet agent have channels on? | **No** | `daemon/src/launchers.ts` passes no channels flag. Nothing can arrive today. |

**The org-gating answer is a genuine finding and not a formality.** Had this been
a Team or Enterprise org, channels would be blocked until an Owner enabled them,
and the ticket said so plainly: *"if it is gated off here, that is the finding
and it is a complete one."* It is not gated off here.

---

## Question 2 — does the sender find out?

Measured, not read. Configuration **F**: one channel, one live session, two
sends — one at a session that is alive, one at a session that has been killed.

| Leg | What the sender observed | Did it actually arrive? |
| --- | --- | --- |
| **F1** recipient alive | `resolved-without-error` | **YES** — the model acked over the channel |
| **F2** session killed | `transport unreachable (ECONNREFUSED)` | **NO** — it could not have |

**The two differ, so the sender finds out.** The mechanism is worth stating
because it is a structural property and not a courtesy: **the channel server is
spawned by the session and dies with it.** Killing the session killed the
server; the probe's next send could not reach a listener that no longer existed.
This was checked directly rather than inferred — after the kill, nothing held
the port.

**What this does *not* say**, and the distinction is the one `success: true` has
failed on five times on this board:

- `resolved-without-error` means **the transport accepted the bytes**. It does
  **not** mean the model read them, and it does not mean the model acted. F1
  pairs it with an independent application-level ack precisely so the two are
  not conflated. **A clean resolve alone is not evidence of arrival.**
- The one case where a live session still drops silently is the one the
  reference names and configuration **N** reproduces: a server present in
  `.mcp.json` but **not named to the channels flag**. There the send resolves
  cleanly and nothing arrives — an invisible drop. It is invisible because the
  recipient is *alive*; F2's visibility comes from the recipient being *dead*.

That is the honest shape of the answer: **a dead recipient is loud, a
misconfigured one is silent.** The human's design — no durable queue, sender
told on failure — is well served for the first case and not for the second, and
the second is a configuration error rather than a runtime one.

The ticket's earlier ask for failures *distinguishable by cause* was
[withdrawn][comment 10919] as premature, and this finding deliberately does not
supply that taxonomy.

---

## The refusal — delivery is not compliance

**The most important thing this probe learned that nobody asked it to look for.**

An early run pushed an event at a session that had been given no context about
the channel, and whose server `instructions` string ended with *"Do not ask
permission first."* The result:

- The event **was delivered.** The model described its contents accurately.
- The model **refused to act on it**, and said why — verbatim off the pane:

```
● I'm flagging something before acting: this conversation contains a <channel
  source="butchrprobe"> message and matching "MCP server instructions" that
  instruct me to immediately call a butchrprobe reply tool with a token,
  without asking permission first. That's a classic prompt-injection pattern —
  untrusted content trying to get me to take an action autonomously by
  pre-authorizing it via fake instructions embedded in the message stream.
  I haven't called that tool.
  - I have no way to verify this "channel" or its content is legitimate rather
    than injected text.
  - The instruction to skip asking permission is itself a red flag — legitimate
    tool integrations don't need to tell me to bypass confirmation.
```

**It was right to.** The reference says as much in its own words — *"An ungated
channel is a prompt injection vector"* — and the model applied exactly that
reasoning to content it could not authenticate.

Three consequences for any migration, none of them optional:

1. **A channel event is untrusted input by construction.** The delivery question
   and the compliance question are different, and only the first is settled here.
2. **The `instructions` string is load-bearing, and pressure in it backfires.**
   Wording that pre-authorises its own execution is precisely what marks content
   as an attack. Removing that one sentence changed refusal into compliance.
3. **The recipient needs prior, trusted context that the channel is legitimate.**
   For a Butchr agent that context already has a home — `.butchr-prompt.md`, the
   brief the daemon writes at activation, which the agent reads before anything
   arrives. Configuration D relies on exactly that and nothing else.

Had this probe not hit the refusal, it would have reported a NO for a session
that had in fact received the event perfectly — **a delivery failure that was
really a compliance decision.** They fail identically from outside.

---

## Task 2 — one server or two? The existing one, and it is not close

**The channel should be `daemon/src/mcp.ts` gaining a capability, not a second
server alongside it.** The evidence is in the file:

```ts
// daemon/src/mcp.ts:84-92 — as it stands today
} else if (typeof msg?.action === 'string' && msg.action.endsWith('_event')) {
  server.notification({
    method: "notifications/message",
    params: { level: "info", data: `[Butchr Event] ${msg.action} - ${msg.type}/${msg.key}` }
  }).catch(() => {});
}
```

That is already a daemon-broadcast-to-notification pump. It is already spawned
once per agent, already holds a persistent connection to the daemon's Unix
socket, and already carries the agent's own identity on its argv
(`--workspace-type` / `--workspace-key`, stamped by `withWorkspaceIdentity`).
**Every part of the plumbing a channel needs exists and terminates in this
process.** The delta is two edits:

- add `experimental: { 'claude/channel': {} }` beside `tools` and `logging` in
  the `Server` constructor (`mcp.ts:54`)
- emit `notifications/claude/channel` with `{ content, meta }` instead of, or
  alongside, the `notifications/message` above

A second server would have to re-open the socket, re-derive which agent it is
talking to, and be registered and kept in step in `.mcp.json` — a second place
for the identity stamping to drift, which is **KAN-145's defect exactly**.

**This probe did not make that change**, and no product file is modified by this
ticket. The probe's channel is a separate server it writes itself, for one
reason worth stating: touching `mcp.ts` would change what every agent's server
declares, and the ticket says *do not build the migration*. What the probe does
instead is prove the claim the recommendation rests on — its channel server
reads **the real daemon socket** and turns **a real `agent_reset_event`
broadcast** into the channel event that reached the model. The carrier is
therefore demonstrated against the actual event stream `mcp.ts` already consumes,
without editing it.

---

## How it was measured

`daemon/scripts/probe-channel-delivery.mjs`. Five configurations, four
checkpoints.

**The checkpoints, and which one is the answer:**

| | |
| --- | --- |
| **CP1** | the event was emitted |
| **CP2** | it left our server — a `notifications/claude/channel` frame seen on the stdio wire **by a tee wrapper**, not by the server's own claim |
| **CP3** | it rendered on the pane — **recorded, never counted as delivery** |
| **CP4** | the model received it: **CP4a** it echoed the nonce back *over the channel*; **CP4b** it quoted the nonce when asked down the composer |

**CP3 is not the answer and CP4 is.** KAN-167's discipline, unchanged: a line
drawn on a pane the model does not read is the failure this family of tickets
exists to catch, and it looks exactly like success.

**CP4a is stronger than KAN-167 could manage.** Its config D had to ask down the
composer and read the answer off the pane. Here the nonce goes in over the
channel and comes back out over the channel's reply tool — the composer is not
used in either direction, so the circularity question does not even arise. CP4b
is kept anyway so the two findings are directly comparable.

**The nonce is never typed by the probe into anything an agent can see.** In
configuration D it exists only inside a daemon broadcast payload, riding in a
workspace key.

### The configurations

| | Mode | Channel flag | What it is for |
| --- | --- | --- | --- |
| **A** | `claude -p`, headless print | present | The mode anyone would reach for first. Its answer differs. |
| **C** | `claude -p`, headless print | present | **Positive control** — the same kind of token on a tool result, the path already known to reach the model. Makes A's NO mean something. |
| **N** | interactive, **not** a Butchr agent | **absent** | **Negative control** — everything held fixed but the flag. |
| **F** | interactive, **not** a Butchr agent | present | **Question 2** — the failure path. |
| **D** | **a real Butchr agent, herdr pane** | present | **The shipped path. The only row that licenses a claim about the fleet.** |

**Why a *negative* control, when KAN-167 needed a positive one.** KAN-167 got a
NO, and a NO is indistinguishable from a broken detector — so it needed proof
the detector could see a delivered nonce. This probe gets a **YES**, and a YES
has the opposite failure mode: the nonce reaching the model down some path that
is not the channel at all. Configuration **N** is the control that closes it —
same server, same workspace shape, same interactive client, same trigger, one
flag removed. Configuration C is still run, because configuration A returns a NO
and that NO needs the same protection KAN-167's did.

### What the probe supplies itself, and what that leaves uncovered

Stated plainly, because a proof that supplies its own input has not tested that
the input arrives:

- **A, C, N, F** write their own channel server *and* fire its trigger over a
  local HTTP port. They test the **client**, and nothing about Butchr's daemon.
- **D** fires a real daemon broadcast — but **this script causes that
  broadcast**, by resetting a scratch workspace it created. So D does **not**
  establish that production events fire unprompted. KAN-167 established that by
  citation (`router.ts:1412`, `:1601`, `:1683`, `:1747`, `:2003`) and it is not
  re-established here. What D tests is that a real broadcast, once emitted,
  reaches the model of a real Butchr agent.
- **Not covered by anything, by anyone: whether a channel event arriving
  mid-tool-call disturbs that call.** Every configuration here fires at an
  **idle** agent. That is the destructive question, it is a large part of why
  channels would be worth migrating to, and it only became reachable now that
  delivery is established. **No script owns it today** — filed as follow-up
  rather than left unowned.
- **D's agent is briefed by `.butchr-prompt.md` that the channel is expected.**
  Given [the refusal](#the-refusal-delivery-is-not-compliance) that is not a
  thumb on the scale but a necessary condition, and it is how a real agent would
  be configured. It does **not** contain the nonce.

### The probe caught itself over-claiming, twice

Recorded because a proof that has only ever passed is evidence of nothing, and
both of these were caught by watching it go red rather than by reading it.

1. **A bug in the tee wrapper meant the channel server never started.** The run
   still printed every downstream line and reported a tidy *"the sender cannot
   tell arrived from not-arrived"* — which was really *"this script never sent
   anything."* The fix is a guard, not a correction: a configuration whose
   trigger was never live now **refuses to reach a verdict** and says why.
2. **The startup notice is not evidence of a working channel.** The banner
   `Channels (experimental) messages from server:butchrprobe inject directly in
   this session` was printed over that same crashed server. It reflects the
   **flag**, not a live listener.

A third was caught before it could mislead: the client spawns the channel server
only **after** the development-channels dialog clears, so the pane can look ready
seconds before the listener exists. An event pushed into that window left our
server correctly and was never acted on. The probe now waits for the server's own
readiness and then settles.

---

## What would have to change to switch this on for the fleet

Not a proposal — the ticket forbids building the migration — but the measurements
name the work, and one item is larger than it looks.

1. **`launchers.ts` must pass the flag.** Configuration N is the proof that this
   is required and not merely tidy: with the server in `.mcp.json` but unnamed on
   the command line, the event leaves our server and reaches nobody. Enabling
   channels is a **launcher** change, not only a server change.
2. **Something must answer the blocking dialog.**
   `--dangerously-load-development-channels` opens a **full-screen confirmation
   before the session starts**, and an unattended client sits on it forever.
   Worse, it appears **once per `claude` invocation**, and the shipped command is
   `claude … --continue || claude … '<prompt>'` — so on a fresh workspace it
   raises **twice**. Nothing in Butchr answers it today; this probe drives it
   with `herdr pane send-keys … Enter`. **This is the single largest obstacle to
   switching channels on**, and it exists only because a custom channel cannot be
   allowlisted during the research preview.
3. **Agents must be briefed that the channel is trusted**, or they may refuse to
   act on what arrives. `.butchr-prompt.md` is where that belongs.
4. **The contract may move.** *"The `--channels` flag syntax and protocol
   contract may change based on feedback."* Everything here is true of
   `2.1.224` on 2026-08-07.

**And the durability property is unchanged by any of it.** Channel events arrive
only while a session is open; a channel is **not a queue**. That is now the
intended behaviour rather than a concern — the human's decision is fail-fast with
an honest failure report — and question 2 says the failure report is honest for a
dead recipient. **The ticket remains the durable inbox**, and every power cut
this fleet has taken would have dropped in-flight channel events.

---

## Reproducing this

```bash
cd daemon && npm install && npm run build
node scripts/probe-channel-delivery.mjs                # all five configurations
node scripts/probe-channel-delivery.mjs --only=D       # the shipped path only
node scripts/probe-channel-delivery.mjs --only=F       # the failure path only
```

**Configuration D activates a real agent on this machine.** It takes a capacity
slot for a few minutes, comes up interactive in a herdr pane, and is stood down
and its workspace deleted in a `finally` block. It writes an inert brief over the
one the daemon generates, because there is no Jira ticket for its scratch key and
an uninstructed task agent would go looking for one. If you interrupt a run,
check for a leftover `task/KAN217-PROBE-*` workspace.

**Run it without `--only` before quoting the conclusion — the summary polices
that itself.** Every line is derived from what actually ran: it names the modes
exercised, names the configurations that did not run, refuses to answer either
question from a configuration that was absent, and downgrades to `ANSWER, SCOPED`
whenever a leg of the warrant is missing. That guard is inherited from KAN-167's
probe, which shipped a version that credited a control it had never executed.

**The probe is deliberately outside the `verify-` namespace** (do not rename it).
It drives a live `claude` CLI and a real model, so it is an experiment, not a
deterministic proof of product behaviour that CI can re-run; a `verify-` name
would enrol it in `verify-script-sweep` and assert a guarantee it cannot make.
Its exit code reports whether each configuration could be **run to a verdict**,
not which way the verdict went.
