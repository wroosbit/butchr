# The CrabCast-backed agent runtime

**Status: landed inert, off by default, nothing migrated onto it.** KAN-278.

`BUTCHR_AGENT_RUNTIME=crabcast` selects `CrabCastRuntime` instead of
`HerdrBridge`. Anything else — unset, empty, misspelled, `1`, `true` — selects
`HerdrBridge`. Which one is serving is answered by the `agent_runtime_report`
socket action and logged once at boot; an operator never has to guess.

Everything below was established by driving a **real CrabCast daemon** and
reading what came back — `crabcast --help`, each command's help, `--json`
responses, and direct socket probes. **No CrabCast source was read**, per the
human's decision of 2026-08-08, which is not lifted. Claims about their
behaviour are claims about observations, and
`daemon/scripts/verify-crabcast-runtime-live.mjs` re-runs them.

- **CrabCast pin:** `8d7348fa98201b61642d2454b3a797373361128a` (KAN-294; was
  `7c6d97f` under KAN-278). Read off `daemon_status.build.commit` of a real
  daemon built at that commit, not off a notice.
- **CrabCast read-path contract version:** **`4`**, which is what
  `CRABCAST_CONTRACT_VERSION` in `crabcast-link.ts` actually pins. **This line
  read `3` until KAN-283** — KAN-324 bumped the constant to consume
  `unreadableRecordsTotal` and did not bump the prose, so the document was one
  version behind the code it describes. Corrected by reading the constant rather
  than the sentence. **It covers `list_agents` and `agent_status` and nothing
  else** — see *What the contract does not hold* below.
- **Butchr commit these line numbers were read at:** the branch of KAN-294.

**KAN-283's additions were read at a DIFFERENT build, and this note is here
rather than buried because the alternative is the mistake this document ends by
confessing to.** The `tail_agent` observations — the ruling table's row 18, the
`tail_agent_response` entry under *The fields this runtime branches on*, and the
`sourcesTried` vocabulary match — come from a live daemon answering
`build.commit: 6f47df7d05ebcb8593469c740d7b6dc2aa149b13` with
`contractVersion: 6`. **That is two contract versions past the `4` we pin**, and
it was what happened to be running on this machine rather than something chosen.
`verify-crabcast-runtime-live.mjs` §4b reports it as a failure — `{"peer":6,
"pinned":4}` — which is the instrument working: that assertion exists to notice
exactly this, and it fails identically on `main` against this daemon.

So: **those claims are claims about `6f47df7d`, not about `8d7348f`.** They are
marked as such where they appear. The pin has deliberately **not** moved —
`CRABCAST_PIN` still reads `8d7348f`, a mismatch is logged and never fatal, and
moving it is a step with a notice behind it rather than a side effect of a ticket
about our own signatures. What this means for a reader: if a `tail_agent` claim
here disagrees with a daemon built at the pin, **the claim is the suspect**, and
`verify-crabcast-runtime-live.mjs` §4c is what re-runs it.

---

## The transport: the daemon socket, not the CLI

Both were sanctioned. The socket wins on three counts, each a fact about their
surface at the pin rather than a preference:

1. **The CLI cannot serve the PTY group at all.** `crabcast --help` lists ten
   commands — `configure`, `activate`, `deactivate`, `forget`, `list`,
   `status`, `tail`, `send`, `capacity`, `daemon-status` — and none is a pty
   verb. The socket answers `pty_init`, `pty_input`, `pty_resize`. That is 3 of
   the 23 methods the CLI simply cannot reach, and it is deliberate on their
   side: CrabCast "never embeds a terminal", so its client exposes no terminal.
2. **Two methods need a stream, and a CLI is one process per call.**
   `registerDataListener` needs `pty_output` frames and
   `setSessionEndedListener` needs `agent.*` broadcasts. Both arrive unsolicited
   on a held-open connection. A process that exits cannot receive them.
3. **Cost.** `getSessionByAddress` is the daemon's dominant lookup — 8 of the 43
   call sites KAN-223 derived the interface from. A process spawn per lookup is
   not affordable.

**What it costs us, stated rather than left implicit.** The CLI is the surface
CrabCast *documents*, with documented exit codes and a `--json` mode that
promises the daemon's answer verbatim. The socket frames are **not yet
published** — that is exactly what their KAN-277 is building, and it is In
Progress rather than landed. So we consume a surface whose contract is still
being written, and **pinning is how we pay for it**. Their decision is *no
compatibility guarantee below 1.0*, with a notice promise instead; the pin is
our own safety mechanism and stays regardless.

A mismatch between the pin and the peer's `daemon_status.build.commit` is
**logged, never fatal**. Refusing to run against a different build would be
Butchr pressuring CrabCast's release cadence, which KAN-278 forbids outright.

---

## The finding: synchrony, not PTY, is the binding constraint

KAN-224 established that **PTY is the one method group that is not a
passthrough**. That is true, and its design survived contact with the real
interface (see below). But it is not the biggest break, and building this turned
up the one that is:

> **`AgentRuntime` is a synchronous interface and CrabCast is a socket.**

Fourteen of the 23 methods return data synchronously. A socket cannot answer a
synchronous call, so each is served one of three ways — and there is no fourth,
exactly as KAN-224 §5.1 found for `ptyBuffer` alone:

1. **From a warm mirror.** Correct for census questions, because the honest
   answer to "what is the fleet doing?" is already an observation with a
   timestamp — `HerdrBridge`'s own answer is a `herdr agent list` shell-out that
   is stale the moment it returns.
2. **From a record only this adapter holds.** Correct for sessions *we* started:
   exact, no round trip, no staleness.
3. **Refuse, with figures, naming the leg.** The only honest answer where the
   caller needs a *fresh* fact that costs a round trip.

PTY at least has a clean answer. Synchrony's answer for `tailAgent` is (3), and
that is a real capability gap rather than a detail.

---

## The 23 methods

`served` — a CrabCast verb answers it with the same meaning.
`different-shaped` — answerable, but the shape or the guarantee changes.
`absent` — no counterpart; the runtime refuses and names what is missing.

| # | Method | Verdict | Evidence and what changes |
| --- | --- | --- | --- |
| 1 | `setSessionEndedListener` | **different-shaped** | Served by the `agent.detached` broadcast. Verified: an idle connection that asked nothing received `agent.deactivated` and `agent.detached` when a second connection deactivated an agent. In-process callback becomes a cross-process event. **`reason` is degraded**: `SessionEndReason` is `'taken-over' \| 'exited'`, CrabCast carries neither, and this runtime always reports `'exited'` rather than guessing. |
| 2 | `setAgentSpawnedListener` | **absent** | **CrabCast publishes no spawn command line.** `activate_response` carries `launcher` and 20 other fields but no argv; `agent_status` and `agent.activated` carry none either. The interface's docblock says the command is "part of the contract, not a convenience". So this is registered and **never fired** — the interface explicitly permits that — because firing with a fabricated command would break channel-startup supervision (KAN-246) more quietly than not firing. **Cost: channel-startup supervision does not run under this runtime.** |
| 3 | `spawnSession` | **different-shaped** | Two calls, `configure_agent` then `activate_agent`, both async, behind a synchronous signature. Returns in `'initializing'` and is promoted on the activation's answer; failure lands in `spawnError`. **Butchr must create the workspace directory** — CrabCast never creates one (their north star 3). |
| 4 | `abandonSession` | **served (locally)** | Purely a local bookkeeping call in `HerdrBridge` too; no wire verb needed or wanted. |
| 5 | `terminateSession` | **different-shaped** | `deactivate_agent`. Synchronous signature, async verb: returns "asked", not "stopped". The local record is marked immediately so the caller's next read cannot see a live session; `agent.detached` is what says it actually stopped. |
| 6 | `resetWorkspace` | **absent, by their design** | Verified from the wire: `reset_workspace` and `reset_agent` both answer *"`reset` was removed: CrabCast no longer creates the directory an agent runs in, so it may not delete one either."* That is north star 3, not an oversight. **Butchr owns the directory at both ends under this runtime** — creation (method 3) and deletion. Wiring deletion up is cutover work; this refuses and names the leg. |
| 7 | `closeAgentByKey` | **served** | `deactivate_agent`, addressed by the translated path. |
| 8 | `getSession` | **served (locally)** | Local session table. Exact for sessions we started. |
| 9 | `getSessionByAddress` | **served (locally)** | Local session table. `(type, key)` → path is a total, lossless mapping through `workspaceDirFor`. |
| 10 | `listActiveSessions` | **served (locally)** | Local session table. |
| 11 | `describeAgent` | **different-shaped** | `list_agents` rows plus `foreignPanes`. Lagging by up to one census interval (2s). |
| 12 | `resolveAddress` | **served (locally)** | **Correctly local, not a shortfall.** `type` is Butchr's vocabulary and CrabCast has none by their north star 4; an agent there is a bare path. Throws on unknown/ambiguous, as the interface requires. |
| 13 | `herdrReachable` | **served** | Link connected **and** the last census succeeded. |
| 14 | `listHerdrAgents` | **different-shaped** | `list_agents`. Rows carry `paneName`, `agentRuntime`, `workDir`, `herdrStatus` — a direct match for `HerdrAgentRecord`. Lagging by the census interval. |
| 15 | `listHerdrAgentsChecked` | **served** | The distinction survives intact: `reachable` is a claim about whether the census could be **taken**, never about whether it found anything. |
| 16 | `listHerdrStatuses` | **different-shaped** | Derived from the same census. `herdrStatus` values match Butchr's `HerdrAgentStatus` set exactly. |
| 17 | `confirmAgentPresent` | **served** | Already `Promise`-returning, so it polls `list_agents` for real. `requireRuntime` reads their `agentRuntime` field, which is the same evidence Butchr uses. A census that could not be taken returns `unverifiable`, never `absent`. |
| 18 | `tailAgent` | **served (KAN-283)** | **Was `absent (ours, not theirs)` under KAN-278; served over the wire now.** `tail_agent` returns `success`, `text`, `truncated`, `source`, `sourcesTried`, with `source` drawn from the same `'recent-unwrapped' \| 'visible'` pair Butchr uses — a better match than most of this interface. The blocker was **our** synchronous signature, a tail being the one read where a cached answer is the wrong answer; KAN-283 made `AgentRuntime.tailAgent` `Promise`-returning and the refusal is gone. **One limit, from the wire: CrabCast can only tail an agent it configured itself** — their agent name is derived from the path (`crabcast-<leaf>-<hash>`), so a pane herdr owns under a Butchr name answers `not found` even while `list_agents` reports it under `foreignPanes`. That is `success: false`, a claim about the READ, and it is correct. |
| 19 | `pressPaneKey` | **absent** | No `press_pane_key` action — verified, it answers `Unknown action`. `send_to_agent` is not a substitute: it opens with a Ctrl+C (its response reports `interrupts: 1`), which is precisely what this method exists not to do. Throws. |
| 20 | `sendToAgent` | **served (superset)** | `send_to_agent` answers `delivered`, `verdict`, `interrupts`, `submits` and an `evidence` block. We map **`delivered`**, not `success` — `success` says the call worked, `delivered` says the keystrokes landed, and this method's contract is about the typing. |
| 21 | `writePty` | **served** | `pty_input`, fire-and-forget with no `id` (CrabCast only acks a frame carrying one). Returns "do I have this session?", the same meaning as in-process. |
| 22 | `resizePty` | **served** | `pty_resize`. |
| 23 | `registerDataListener` | **different-shaped** | KAN-224's design, implemented. One long-lived `pty_init` per **session**; this call never touches the socket, pushing onto a local array and returning a closure that filters it out. |

**Totals: 12 served, 8 different-shaped, 3 absent** (methods 2, 6, 19). One of
the three remaining absences is ours rather than CrabCast's: `resetWorkspace` is
a responsibility that moves to us. **`tailAgent` was the fourth until KAN-283**,
and it was the one absence that was purely a signature.

---

## The synchrony ruling: one method changed, thirteen deliberately did not

**KAN-283.** The finding above says 14 of the 23 methods return data
synchronously. `tailAgent` is now `Promise`-returning; **the other 13 were each
ruled on and every one stayed synchronous.** This section is that ruling, method
by method, because *"we looked at the rest"* is not a reviewable claim.

**The test applied, stated before the answers so it can be disagreed with.** A
method needs an async signature when **the correct answer requires a fact that
is fresh at call time and that CrabCast will actually answer.** Both halves are
load-bearing. Fail the first and a warm mirror is not a compromise but the
honest shape of the answer — a fleet observation *is* a reading with a timestamp,
and `HerdrBridge`'s own answer is a `herdr agent list` shell-out that is stale
the moment it returns. Fail the second and async conjures nothing: a capability
CrabCast does not have is not reachable by awaiting it.

`tailAgent` passes both, uniquely: a tail's entire purpose is to say what the
pane shows *now*, and `tail_agent` answers it in our own vocabulary.

| # | Method | Ruling | Why — and what an async signature would have bought |
| --- | --- | --- | --- |
| 3 | `spawnSession` | **stays sync** | Returns a handle the caller *polls*, and `HerdrBridge` returns an equally not-yet-ready one: `status: 'initializing'`, promoted to `active` or to `terminated` + `spawnError` by `provision()` writing to the object the caller already holds. Async would make every caller wait on a `configure_agent` + `activate_agent` round trip **that no caller waits for today**, and would tell them nothing the handle does not. |
| 5 | `terminateSession` | **stays sync** | Answers *"asked"*, never *"stopped"* — and that is already true of `HerdrBridge`, where the session-ended event is what says it stopped. The local record is marked immediately, so the caller's next read cannot see a live session. Async would let it report the `deactivate_agent` ack, which is **still not "stopped"**: a different wrong answer at the cost of every call site. |
| 6 | `resetWorkspace` | **stays sync** | Nothing to await. CrabCast removed `reset` because they never create the directory (north star 3), so the missing work is **Butchr deleting a directory** — synchronous filesystem work we do not do yet. That is gate 4, and it is a capability gap rather than a signature one. |
| 7 | `closeAgentByKey` | **stays sync** | Delegates to `terminateSession`; same ruling for the same reason. |
| 8 | `getSession` | **stays sync** | Local session table. Exact for sessions we started, no round trip, no staleness. |
| 9 | `getSessionByAddress` | **stays sync** | Local session table, and **the dominant lookup — 8 of the 43 call sites.** The method where an async signature would cost the most and buy the least. |
| 10 | `listActiveSessions` | **stays sync** | Local session table. **This one feeds the symptom a human actually noticed — see below.** It is still the right ruling, and the reason it is worth reading twice. |
| 11 | `describeAgent` | **stays sync** | Census mirror plus `foreignPanes`, lagging by up to one census interval (2 s). A fleet question's honest answer is a timestamped observation. |
| 12 | `resolveAddress` | **stays sync** | Nothing to ask. `type` is Butchr's vocabulary and CrabCast has none by their north star 4; the key→type mapping is a fact about **our own** sessions. |
| 13 | `herdrReachable` | **stays sync** | `link.connected && census.reachable` — two facts this process already holds. Async would turn a health question into a round trip **that can hang**, which is the opposite of what a caller asking "is the runtime there?" needs. |
| 14 | `listHerdrAgents` | **stays sync** | Census mirror. |
| 15 | `listHerdrAgentsChecked` | **stays sync** | Census mirror plus its disclosure. The distinction the method exists for — `reachable` is about whether the census could be **taken** — survives a mirror intact. |
| 16 | `listHerdrStatuses` | **stays sync** | Derived from the same census. |

**Thirteen of thirteen, which is a result and not a shrug.** It is also the
answer KAN-278 predicted, and the value of doing it method by method is the one
case where the prediction was nearly wrong for the right reason:

### `sessionId` and `url`: the ruling that matters more than `tailAgent`'s

`epic/KAN-39` asked which of the 13 feed `sessionId` and `url`, having watched a
cutover on 2026-08-12 come back with **`sessionless: true`, `sessionId: null`,
`url: null` on every agent** — the thing the human noticed, and the reason the
flip was rolled back inside seven minutes.

**The answer is methods 8, 9 and 10, and going async would not have changed one
row of it.** The mechanism, read off `router.ts`: `handleListAgents` walks
`listActiveSessions()` to build its attached set, and **every census row not in
that set becomes `sessionless: true` with the session-only fields explicitly
`null` rather than invented.** Under CrabCast the session table holds only
sessions *this daemon process* started, so immediately after a flip it is empty,
every census row falls to the sessionless branch, and the rendering is correct
behaviour of an empty table.

**`url` is the decisive half, and it settles the question rather than arguing
it.** `url` is a *Butchr* fact — the Jira ticket URL, passed **into**
`spawnSession` — and `provision()` sends `configure_agent` exactly four fields
plus MCP servers: `path`, `priority`, `launcher`, `prompt`. **`url` is never sent
to CrabCast at all.** So no read of CrabCast can return it, under any signature,
ever. A restarted daemon cannot recover `url` for an agent it did not itself
start by awaiting anything, because the fact was never on their side to await.

So this is **its own gate**, adjacent to gates 3 and 5 and not folded into them:
it is a **durability** question — persist Butchr's session records, or
reconstruct what is reconstructible from the census on connect — and explicitly
**not** a synchrony one. Their census row does carry a `sessionId` of their own
(`CensusRow.sessionId`), so partial reconstruction is available and `url` is not.
**Nobody covers this yet.** Naming it is this ticket's contribution to it;
KAN-283 does not fix it, and a cutover should not read *"gate 1 is done"* as
progress on it.

---

## Does KAN-224's PTY design survive contact? Yes, and its key claims verified

KAN-224 read CrabCast's source. This ticket may not, so its claims were
re-established **from the wire**:

| KAN-224 claim | Verified how |
| --- | --- |
| `pty_init` returns a buffer snapshot | `pty_init_response` carried a 36,546-character `buffer`. |
| Streamed output is unsolicited and carries no request id | `pty_output` frames arrived with keys `action, success, sessionId, data` — **no `id`**. |
| `pty_output` carries no `seq` (it is off the event contract) | Confirmed: no `seq`, no `bootId`. Broadcast `agent.*` events **do** carry `at`, `seq`, `bootId`. |
| **CrabCast has no detach verb** | `pty_close` and `attach_pty` both answer `Unknown action`. The dispatch is exactly `pty_init`, `pty_input`, `pty_resize`. |

The design's consequence holds: because the subscription is per **session** and
the disposer is a local array filter, the missing detach verb costs nothing.

**The no-gap/no-duplication join is structural here, not defended.** The
snapshot **replaces** the mirror and is never fanned out; each `pty_output`
frame is **appended and** fanned out. Two destinations, no overlap, nothing to
deduplicate. The demux is registered **before** the `pty_init` request is
written — KAN-224 §3.3's one rule, and the gap that would otherwise be ours.

**What is not implemented from KAN-224:** the reconnect resync and its
discontinuity signal (§3.5, §6.2). The link reconnects, but mirrors are not
re-subscribed and no `{discontinuity: true}` is delivered, because that requires
the interface change §6 prescribes and KAN-278 is not interface work. **Nobody
covers this yet**; it is cutover work.

---

## The fields this runtime branches on

Posted to KAN-59 as they asked. A contract should describe what a consumer
*depends on*, not what the producer *happens to emit*.

**`daemon_status_response`** — `build.commit`, and since KAN-294
**`contractVersion`**. Both are read **once per connection** at the handshake
and neither is enforced: a mismatch is logged. Once-per-connection is what
CrabCast's own document asks for — *"read it once and re-read when `bootId`
moves"* — and a reconnect is when `bootId` may have moved, so the rule is
satisfied by construction rather than by a timer.

**`list_agents_response`** — `success`; `agents[]`, `foreignPanes[]`; per row:
`path`, `paneName`, `sessionId`, `status`, `herdrStatus`, `agentRuntime`,
`state`, `workDir`.

**`configure_response` / `activate_response` / `deactivate_response`** —
`success`, `error`; from activate, **`sessionId`** (the handle every pty call is
addressed by) and since KAN-294 **`channelEnabled`**.

**`configure_agent` sends `mcpServers`, an object** — not `mcpConfig`, a JSON
string, which is what this adapter sent until KAN-294 and which does not exist
on that verb. It was not rejected: CrabCast answered `success: true` and simply
did not have the servers, and `agent_status` echoed `config.mcpServers:
undefined` for every agent configured that way. **So every agent this runtime
spawned had no MCP servers at all, silently.** The shape is definitions rather
than names — `{"atlassian": {"command": …, "args": […]}}` — with the literal
string `"builtin"` reserved for CrabCast's own servers. This adapter never sends
`"builtin"`: giving a Butchr agent CrabCast's channel is a cutover decision.

**`send_to_agent_response`** — `success`, **`delivered`**, `verdict`, `error`.

**`pty_init_response`** — `success`, `buffer`, `error`.
**`pty_output`** — `action`, `sessionId`, `data`, **and the absence of `id`**,
which is how it is told apart from a response.

**Broadcast events** — `action`, matched on the `agent.` prefix and on
`agent.detached` / `agent.deactivated` specifically; and `path`.

**Every frame** — `id` for correlation, `action`, `success`, `error`.

**`tail_agent_response`** — **new since KAN-283**, and it moved onto this list
from the one below it. `success`; `text`, which must be a **string** for the read
to count (a `success: true` with a non-string `text` is reported as a read we
could not make, never as an empty pane); `truncated`; `source`, narrowed against
our own `'recent-unwrapped' | 'visible'` pair with anything unrecognised becoming
`null`; `sourcesTried`, narrowed the same way and carried through on refusals as
well as successes, because it is the evidence that the read was attempted twice.
`error` is carried **verbatim** and never parsed.

The request sends `path` and, when the caller gave one, `lines`. Confirmed from
the wire at `6f47df7d`: `path` is required, must be a non-empty string, and must
exist on disk — all three refusals are `success: false` with their reason stated.
**Their agent name is derived from the path**, so they can only tail an agent
CrabCast itself configured; a pane herdr owns under a Butchr name answers `not
found` while still appearing under `list_agents.foreignPanes`.

**Not branched on, deliberately:** `capacity`, `provenance`,
`configEchoContract`, `pages` and the paging handles, `agent_status` (the census
covers it), and every refusal field including `headroomBoundBy` — refusal text is
carried through **verbatim** and never parsed, so a new value there cannot break
us.

### `channelEnabled` — three states, and the one that is easy to lose

`true` the spawn decided and it is channel-capable; `false` the spawn decided
and it is not; **`null` no spawn decided this** — no record at the path, or a
record configured and never activated, or an activation that was refused. It is
not a way of saying "no channel", and CrabCast say so on the field itself.

Driven on a real daemon at the pin, five ways:

| what was done | surface | value |
| --- | --- | --- |
| `configure --mcp crabcast`, then `activate` | `activate_response` | `true` |
| `configure` with no channel server, then `activate` | `activate_response` | `false` |
| `configure`, never activated | `agent_status` | `null` |
| a path nobody configured | `agent_status` | `null` |
| `activate` refused for capacity | `activate_response` | `null` |

The last row was not planned and is the most useful: a refusal spawned nothing,
so there is no spawn to be about, and CrabCast answer `null` on the one path
most likely to have been written as a boolean.

**`list_agents` does not carry the field on any row.** Checked row by row at the
pin. That matters here more than it would to most consumers, because
`list_agents` is the *only* thing this runtime polls: the verdict is reachable
at the spawn (`activate_response`) or by a per-agent `agent_status` round trip,
and never from the census. So it is recorded at activation and kept, rather than
refreshed.

### What the contract does not hold

`contractVersion: 3` covers **`list_agents` and `agent_status`**. It does not
cover `activate_response`, and CrabCast disclosed that themselves — their
KAN-287 is the ticket to bring it in. **`channelEnabled` is read from
`activate_response`**, so it can change without moving the version and without
going red in their CI. Nothing on our side but
`verify-crabcast-runtime-live.mjs` §4b can notice if it does; that is stated in
that script's own header rather than left to inference.

The same holds, unmentioned by anybody until KAN-294, for the census: nothing
promises `list_agents` will *not* grow the field, and nothing promises it will.

---

## Observations for CrabCast — offered, not requested

Recorded here and on KAN-59 as observations. **None is a change request**, and
"CrabCast may not pressure a Butchr interface" cuts both ways.

1. **No spawn command line anywhere** (method 2). It costs us channel-startup
   supervision. Their model may simply not have the concept, which would be a
   fine answer.
2. **`pty_input` with no `data` field returns a raw Node error** — *"The first
   argument must be of type string or an instance of Buffer…"* — rather than a
   validation refusal. Their other refusals are exemplary; this one leaks an
   internal message.
3. ~~The README's walkthrough is behind the CLI.~~ **Withdrawn — this was
   false, and the way it was false is the useful part.**

   I reported that their README documented `activate <type> <key>`, workspace
   types, and a `reset` command. It does not, at the pin: line 5 opens *"An
   agent is a directory plus a few knobs… There are no workspace types, no keys
   and no names to remember"*, the walkthrough is path-addressed throughout, and
   `crabcast reset` appears zero times in its 823 lines. The four surviving
   mentions of `workspaceTypes` are all in refusal and migration text
   documenting its **removal**.

   **What I actually read was `~/code/wroosbit/crabcast/README.md` — the shared
   clone's working tree, sitting at `59ba420`** — while every behavioural claim
   in this document came from the pinned worktree at the pin of the day. The two
   disagreed by 23 commits and I did not notice, because the clone is kept
   current with `git fetch` and **never checked out**: our own task prompt tells
   agents not to run `checkout` or `pull` there, precisely because other agents
   share it. So its **refs** are fresh and its **files** are frozen wherever the
   clone was last left, and nothing about the directory says so.

   That is a trap for every agent on this machine, not a mistake about
   CrabCast: **read documentation out of your own pinned worktree, never out of
   the shared clone.** The pin is what you are running against, and it is the
   only tree whose files match its name.
