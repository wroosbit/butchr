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

**Four sentences on this page are pinned to the constants they quote** — the
three rows below and the `contractVersion` sentence under *What the contract does
not hold*. Each carries an invisible marker naming the declaration and a digest
of it, and `daemon/scripts/verify-doc-constant-pins.mjs` recomputes that digest
on every pull request. Move `CRABCAST_PIN`, `CRABCAST_CONTRACT_VERSION` or the
runtime switch without moving these sentences and CI goes red (KAN-347; the
switch was added by KAN-378, whose `docs/crabcast-cutover-sequence.md` turns on
the same value). **Nothing else on this page is pinned**: that script's header
states the scope and `docs/doc-constant-drift.md` states why it is this narrow.

<!-- constant-pin: RUNTIME_ENV_VAR
     src: daemon/src/runtime-switch.ts
     sha256: 28959b7fe578
     says: **The runtime switch:** `BUTCHR_AGENT_RUNTIME`, read once at daemon construction. -->
<!-- constant-pin: CRABCAST_PIN
     src: daemon/src/crabcast-link.ts
     sha256: 8b5c3f4072d9
     says: **CrabCast pin:** `8d7348fa98201b61642d2454b3a797373361128a` -->
<!-- constant-pin: CRABCAST_CONTRACT_VERSION
     src: daemon/src/crabcast-link.ts
     sha256: 89dabf375257
     says: **CrabCast read-path contract version:** **`8`** -->

- **The runtime switch:** `BUTCHR_AGENT_RUNTIME`, read once at daemon construction.
  Which runtime a *cutover* would move the fleet onto, and in what order, is
  `docs/crabcast-cutover-sequence.md` rather than this page.
- **CrabCast pin:** `8d7348fa98201b61642d2454b3a797373361128a` (KAN-294; was
  `7c6d97f` under KAN-278). Read off `daemon_status.build.commit` of a real
  daemon built at that commit, not off a notice.
- **CrabCast read-path contract version:** **`8`**, which is what
  `CRABCAST_CONTRACT_VERSION` in `crabcast-link.ts` actually pins. **This line
  read `3` until KAN-283, `4` until KAN-357, and `7` for one day inside it** — KAN-324 bumped the constant to
  consume `unreadableRecordsTotal` and did not bump the prose, so the document
  was one version behind the code it describes. Corrected by reading the constant
  rather than the sentence, and this line now moves with it mechanically: the
  pin above is what `verify-doc-constant-pins.mjs` recomputes. **It covers
  `list_agents` and `agent_status` and nothing else** — see *What the contract
  does not hold* below.
- **That number is now proved against a live peer, which it was not on
  2026-08-13.** This line said *"nothing has ever served v7 to this daemon"* and
  that stopped being true on 2026-08-14, when the machine's CrabCast was
  deployed and went **6 → 8 in one step**. See *What v7 buys, and what is still
  unanswered* below for the honest scope — including the two arms that no real
  wire has carried even now.
- **Butchr commit these line numbers were read at:** the branch of KAN-294.

**KAN-283's additions were read at a DIFFERENT build, and this note is here
rather than buried because the alternative is the mistake this document ends by
confessing to.** The `tail_agent` observations — the ruling table's row 18, the
`tail_agent_response` entry under *The fields this runtime branches on*, and the
`sourcesTried` vocabulary match — come from a live daemon answering
`build.commit: 6f47df7d05ebcb8593469c740d7b6dc2aa149b13` with
`contractVersion: 6`, and it was what happened to be running on this machine
rather than something chosen. `verify-crabcast-runtime-live.mjs` §4b reports it
as a failure — which is the instrument working: that assertion exists to notice
exactly this, and it fails identically on `main` against this daemon.

**The direction of that gap reversed at KAN-357 and the sentence here had to
move with it.** It read *"two contract versions **past** the `4` we pin"*, which
was true while we pinned `4` and their peer answered `6`. We now pin `7` and
that same peer still answers `6`, so it is **one version behind us**, not two
ahead — the peer has not moved at all; our pin went past it. §4b goes red either
way and its number is read off the wire rather than from this page, so nothing
mechanical was relying on the stale half. This paragraph is not covered by a
`constant-pin`, which is why it needed a person: the guard covers three
sentences and this is not one of them, exactly as that section says.

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
| 2 | `setAgentSpawnedListener` | **absent** | **CrabCast publishes no spawn command line.** `activate_response` carries `launcher` and 20 other fields but no argv; `agent_status` and `agent.activated` carry none either. The interface's docblock says the command is "part of the contract, not a convenience". So this is registered and **never fired** — the interface explicitly permits that — because firing with a fabricated command would break channel-startup supervision (KAN-246) more quietly than not firing. **Cost: channel-startup supervision does not run under this runtime — and since KAN-393 that is a ruling rather than a cost.** The dialog it exists to answer cannot be raised on this path at all; see [gate 3's ruling](#gate-3-the-ruling-channel-startup-supervision-is-disabled-under-crabcast-deliberately). |
| 3 | `spawnSession` | **different-shaped** | Two calls, `configure_agent` then `activate_agent`, both async, behind a synchronous signature. Returns in `'initializing'` and is promoted on the activation's answer; failure lands in `spawnError`. **Butchr must create the workspace directory** — CrabCast never creates one (their north star 3). |
| 4 | `abandonSession` | **served (locally)** | Purely a local bookkeeping call in `HerdrBridge` too; no wire verb needed or wanted. |
| 5 | `terminateSession` | **different-shaped** | `deactivate_agent`. Synchronous signature, async verb: returns "asked", not "stopped". The local record is marked immediately so the caller's next read cannot see a live session; `agent.detached` is what says it actually stopped. |
| 6 | `resetWorkspace` | **served (locally), since KAN-380** | Verified from the wire: `reset_workspace` and `reset_agent` both answer *"`reset` was removed: CrabCast no longer creates the directory an agent runs in, so it may not delete one either."* That is north star 3, not an oversight, and nothing here asks them to change it — **this method makes no wire call at all.** **Butchr owns the directory at both ends under this runtime** — creation (method 3) and deletion — and until cutover gate 4 it owned only one, so a "reset" left the previous agent's files in place under the same key and the next agent inherited them (invariant 7). Both runtimes now call the same `deleteWorkspaceDir` in `workspace-dir.ts`; the containment guard there is structural rather than a check — the exported delete takes an address and never a path, and the `rmSync` takes a branded type only the containment function can mint. `verify-workspace-reset-boundary.mjs`. |
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
| 17 | `confirmAgentPresent` | **served** | Already `Promise`-returning, so it polls `list_agents` for real. `requireRuntime` reads their `agentRuntime` field, which is the same evidence Butchr uses. A census that could not be taken returns `unverifiable`, never `absent`. **The name join is the row's PATH, not its `paneName` (KAN-397)** — the same derivation `listHerdrAgents` uses, and the same function. It joined on the raw `paneName` until 2026-08-14, which could not match for a single agent this adapter starts; see below. |
| 18 | `tailAgent` | **served (KAN-283)** | **Was `absent (ours, not theirs)` under KAN-278; served over the wire now.** `tail_agent` returns `success`, `text`, `truncated`, `source`, `sourcesTried`, with `source` drawn from the same `'recent-unwrapped' \| 'visible'` pair Butchr uses — a better match than most of this interface. The blocker was **our** synchronous signature, a tail being the one read where a cached answer is the wrong answer; KAN-283 made `AgentRuntime.tailAgent` `Promise`-returning and the refusal is gone. **One limit, from the wire: CrabCast can only tail an agent it configured itself** — their agent name is derived from the path (`crabcast-<leaf>-<hash>`), so a pane herdr owns under a Butchr name answers `not found` even while `list_agents` reports it under `foreignPanes`. That is `success: false`, a claim about the READ, and it is correct. |
| 19 | `pressPaneKey` | **absent** | No `press_pane_key` action — verified, it answers `Unknown action`. `send_to_agent` is not a substitute: it opens with a Ctrl+C (its response reports `interrupts: 1`), which is precisely what this method exists not to do. Throws. |
| 20 | `sendToAgent` | **served (superset)** | `send_to_agent` answers `delivered`, `verdict`, `interrupts`, `submits` and an `evidence` block. We map **`delivered`**, not `success` — `success` says the call worked, `delivered` says the keystrokes landed, and this method's contract is about the typing. |
| 21 | `writePty` | **served** | `pty_input`, fire-and-forget with no `id` (CrabCast only acks a frame carrying one). Returns "do I have this session?", the same meaning as in-process. |
| 22 | `resizePty` | **served** | `pty_resize`. |
| 23 | `registerDataListener` | **different-shaped** | KAN-224's design, implemented. One long-lived `pty_init` per **session**; this call never touches the socket, pushing onto a local array and returning a closure that filters it out. **Its listener takes a `PtyStreamEvent` since KAN-381** — `data`, or `discontinuity` naming a window in which output was produced and not seen. `HerdrBridge` never delivers the second arm and is right not to: an in-process pty callback cannot be detached behind your back, so there is no window there. |

**Totals: 13 served, 8 different-shaped, 2 absent** (methods 2 and 19). **Both
remaining absences are CrabCast's** — a spawn command line they do not publish,
and a `press_pane_key` verb they do not have — which is the first time that has
been true. The two that left were ours rather than theirs, and they left by
different routes worth telling apart: **`tailAgent` (KAN-283) was a signature**,
refusing only for as long as this interface forbade awaiting, and **`resetWorkspace`
(KAN-380) was a capability**, refusing only for as long as the deleting code sat
inside `HerdrBridge` as private detail. Neither was ever a thing CrabCast would
not do.

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
| 6 | `resetWorkspace` | **stays sync** | Nothing to await, and the ruling survived the gap closing. CrabCast removed `reset` because they never create the directory (north star 3), so the missing work was **Butchr deleting a directory** — synchronous filesystem work, which is exactly what KAN-380 wired in. The ruling was right for the reason it gave: this was a capability gap rather than a signature one, and closing it needed no round trip and therefore no `Promise`. |
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
`spawnSession` — and `provision()` sends `configure_agent` exactly seven fields
plus MCP servers: `path`, `priority`, `refusable`, `chargeable`, `preemptable`,
`launcher`, `prompt`. (Four until KAN-492 added the three capacity gate flags;
the count is stated so that a reader who finds it stale knows to check the
builder rather than trust it.) **`url` is never sent to CrabCast at all.** So no read of CrabCast can return it, under any signature,
ever. A restarted daemon cannot recover `url` for an agent it did not itself
start by awaiting anything, because the fact was never on their side to await.

So this is **its own gate**, adjacent to gates 3 and 5 and not folded into them:
it is a **durability** question — persist Butchr's session records, or
reconstruct what is reconstructible from the census on connect — and explicitly
**not** a synchrony one. Their census row does carry a `sessionId` of their own
(`CensusRow.sessionId`), so partial reconstruction is available and `url` is not.

#### KAN-346 closed it, by **both** routes rather than either — and found a third defect on the way

The two halves stayed separate, exactly as the ticket demanded they might not:

| field | fixed by | where it lives |
| --- | --- | --- |
| `sessionId` | reconstruction from their census — `CrabCastRuntime.adoptFromCensus` | `crabcast-runtime.ts` |
| `url` | a read of the durable registry — `MessageRouter.recordedUrlFor` | `router.ts` |

**Neither falls out of the other, and that is asserted rather than assumed**
(`verify-crabcast-session-restore.mjs` §4): the runtime never touches the agent
registry and the router never adopts, so an adopted session carries a
`sessionId` and no `url`, and the router supplies the `url` from what the
activation wrote to disk. The red drive bears it out — removing adoption leaves
the `url` assertions green and vice versa.

**`url` needed no new write.** `rememberActivated` has persisted
`AgentRecord.url` since the registry existed and `reconcile.ts` reads it back
after a power cut. What was missing was the read on the *reporting* path: every
row for an agent with no session hardcoded `url: null` and called that honesty.
It is honest about a session fact and wrong about this one — a url is an
argument of the activation, not a property of a session, and `activatedBy` on
the same row had always been read that way.

**The third defect was not in the ticket and is worse than what was.** An agent
CrabCast *starts* comes back under CrabCast's own pane name —
`crabcast-<key>-<hash>`, measured against a live peer at `6f47df7d` — which
`addressFromAgentName` cannot parse, so `list_agents` skipped the row and the
agent was **absent from the fleet listing entirely** rather than listed as
stranded. `censusRecords` now derives the name from the row's path, which is the
address (their north star 3) and the exact inverse of what this adapter spawns
with. Nothing changes for a foreign pane, because herdr already names those
`butchr-<type>-<key>` — which is why the flip lost sessions and not names.

**And the fix did not reach the reader one function away, which is KAN-397.**
`confirmAgentPresent` kept joining on the raw `paneName`, so the defect above
survived in the one place where it destroys work rather than hiding it:
`router.ts`'s `confirmActivation` answers `absent` by calling `abandonSession`
and reporting the activation `success: false`, so under a flipped daemon every
CrabCast-started agent would have been torn down **while it kept running**,
leaving a live pane no Butchr session addresses. `task/KAN-379` measured it as
cutover gate 2 — both `requireRuntime` arms failing identically, which is what
identifies the failure as the lookup rather than as `expectsRuntime` rejecting
the agent, since the flag is never reached. The derivation now lives in
`butchrNameForCensusRow` and both readers call it, because the lesson of these
two tickets is not the rule but its duplication: a rule written once and applied
once is not a rule the next reader inherits. **`describeAgent`'s `paneName` join
is deliberately untouched** — it looks the row up by `path` first, so the
affected population never reaches the fallback, and what the fallback searches is
`census.foreign`, where `paneName` *is* the Butchr name because herdr put it
there. Making it uniform would change behaviour only for a human's own terminal
opened inside a workspace, which would start being reported as that workspace's
agent.

Live proof: `daemon/scripts/verify-crabcast-confirm-present-name-join.mjs`.

**What adoption deliberately does not rescue: `census.foreign`.** A foreign pane
carries no `sessionId`, so nothing addresses its pty; adopting one would hand
the extension a terminal that renders forever. **That is also the whole answer
to why the 10:58Z flip stranded everything**: every agent alive at that moment
had been started by herdr, so CrabCast held all of them as foreign panes and
none as its own — visible in `fixtures/crabcast-owned-running-census.json`,
where `agents` holds only what CrabCast started. Nothing here would have rescued
that fleet and nothing could have. It rescues the fleet a CrabCast daemon
*started*, which is the fleet that exists after a cutover rather than during
one — so **the first flip is still a one-way door for live conversations**, and
that is a cutover-sequencing fact rather than something code on this side can
close.

#### And what adoption refuses to guess about: a launcher name Butchr does not have (KAN-429)

Adoption reads one field that **CrabCast** chose the value of. `expectsRuntime`
came off `row.launcher !== 'shell'`, and `row.launcher` is `config.launcher` —
their string, in their vocabulary. That comparison is exact for an agent Butchr
configured, because `provision` sends `launcher: defaultAgent ?? 'claude'` and
our own name comes back. It was **a guess** for an agent CrabCast configured
itself inside Butchr's workspace tree, which adoption reaches because it filters
on `addressForPath` and not on who configured the row. A runtime-less launcher of
theirs spelled anything but `shell` was adopted as *expecting* a runtime.

**The consequence is not a mislabelled field.** `router.ts`'s
`confirmActivation` passes `session.expectsRuntime ?? true` into
`confirmAgentPresent`, and an `absent` answer calls `abandonSession` — so the
guess is a **live pane torn out of Butchr's session map and reported a failed
activation**, which is the KAN-397 harm shape exactly, reached by a different
route. It is the third instance of the class KAN-346 and KAN-397 each fixed once:
joining on a name whose producer is the other project. All three were silent —
the wrong join answers plausibly, and nothing shows unless a live peer is running
the launcher in question.

**The fix is a refusal rather than a better guess, and the vocabulary is
Butchr's own.** `isButchrLauncher` admits the names in `AGENT_LAUNCHERS` —
`claude` and `shell` — and a row carrying anything else, or carrying no launcher
at all, is **not adopted**. Past that guard the value is a `ButchrLauncher` and
not a `string`, so `expectsRuntime` is computed inside one vocabulary and
`error TS2367` is what deleting `shell` from the table produces at the comparison
site, rather than a branch that is quietly never taken. **Invariant 10 is
untouched**: nothing enumerates CrabCast's vocabulary, which is exactly the point
— a name Butchr does not have is a name Butchr declines to interpret.

**It costs the population adoption exists for nothing**, which is what makes it
narrow: every row `provision` produces carries a launcher Butchr sent, so the
guard is a no-op on the fleet a CrabCast daemon started for us — the fleet this
method was written to rescue. A refused row is not hidden either, because
`censusRecords()` reads the census and not `this.sessions`: it goes on being
listed as the `sessionless: true` agent it honestly is.

**The vocabulary is spelled in `crabcast-runtime.ts` rather than imported from
`launchers.ts`, and that copy is deliberate.** Gate 3's ruling below rests on a
premise about this file's imports — *"this file imports nothing from
`launchers.js`"* — which
`verify-crabcast-channel-startup-disablement.mjs` watches literally, `import
type` included. Its own header calls the tempting edit *the defect in miniature*.
So the list is copied and then **checked**:
`verify-crabcast-adopt-launcher-vocabulary.mjs` §1 reads `launchers.ts` as text
and goes red if the copy and `AGENT_LAUNCHERS` disagree in either direction, and
§2 records that the copy exists because of the premise.

**What is not covered, stated because the sections above could be read as
covering it:** no committed fixture contains a foreign-launcher row — every
captured row carries `claude` or `shell`, because every captured row was
configured by Butchr — so §3 synthesises one, and nothing here demonstrates that
a real CrabCast *can* produce one. §6 covers the other half against the live
peer: that every adoptable row a real peer is serving carries a launcher Butchr
has, so the guard refuses nothing that exists today. On 2026-08-15 that section
reached the live peer and found it serving **zero** owned rows under Butchr's
tree — the fleet is on the herdr runtime, as `BUTCHR_AGENT_RUNTIME` being unset
says it should be — so it **skipped**, and a skip is not a pass.

---

## The `claude` launcher path — gate 2, measured (KAN-379)

**KAN-278's live proof spawned `shell`, and said so in its own header:** what
that left untested was *"the launcher path only — prompt delivery, MCP wiring,
and `expectsRuntime`"*, with **"nobody covers the `claude` path yet"**. This
section is that coverage. Everything below was read off a **real `claude` agent
started through this runtime against the live peer at
`9d4d999cbac6bb94eb5ed25f58c24a7bf7ebf747`**, contract v8, and
`daemon/scripts/verify-crabcast-claude-launcher-live.mjs` re-runs it.

**The gate's premise thinned while it was being tested, and that is recorded
rather than quietly absorbed.** The human's decision of 2026-08-14, relayed:
*"we should shrink the scope to only use claude, with no shell or antigravity.
no select option at all, only claude."* With `claude` the only launcher that
matters, *"the proof used `shell`, so `claude` is unexercised"* stops being a
comparison and becomes a tautology. **The three mechanisms still needed
demonstrating; the contrast that made this a gate did not survive.** Removing
`shell` and `anti-gravity` from the launcher table is **not** this ticket's — it
is a fleet-wide change that `expectsRuntime` is defined by negation against.

**KAN-395 did that work and it came out asymmetric, which matters to the row
below.** `anti-gravity` is gone. **`shell` stayed**, because every channel probe
in this repository brings its agent up as one — it is the only way to hold a pane
and start `claude` with an extra flag without editing the product
(`daemon/scripts/lib/channel-probe.mjs`, note 3). So `expectsRuntime` did **not**
lose its false case and is not a constant; what it lost is any way for ordinary
fleet traffic to reach that case, since the extension's *Default Agent* select —
whose own initial state was `'shell'` — went at the same time. The ruling is
written out on `HerdrSession.expectsRuntime`.

| mechanism | verdict | what was measured |
| --- | --- | --- |
| **prompt delivery** | **works** | A 69,875-byte prompt — larger than `prompts/task.md` — reached the model whole. Markers at byte 0 and at the final byte both came back out of the pane, so nothing truncated it. |
| **MCP wiring** | **works, with two defects behind it** | The agent called `butchr_list_agents` and `atlassianUserInfo` and both returned. CrabCast wrote `.mcp.json` itself. See the two rows below. |
| **`expectsRuntime`** | **unreachable** | Set correctly (`true` for `claude`) and never consulted: the presence lookup it rides on cannot find a CrabCast-started agent at all. |

### Three findings, in the order they would bite

**1. `confirmAgentPresent` cannot find an agent CrabCast started.** It matches
on the raw `paneName` — `all.find((r) => r.paneName === agentName)` — and an
agent CrabCast starts carries **their** name, `crabcast-<key>-<hash>`, not
`butchr-<type>-<key>`. Measured on two independent agents: both
`requireRuntime: true` and `requireRuntime: false` answer
`present: false, reason: 'absent'` for an agent that is running and that the
same census reports one line earlier under its Butchr name. **Both arms failing
identically is what identifies this as the lookup rather than the flag** —
`expectsRuntime` is never reached.

**KAN-346 fixed this exact join one function away.** `censusRecords()` derives
the name from the row's path, and its docblock explains why at length. The fix
was not carried to this reader. **Consequence under a flipped daemon:**
`confirmActivation` reads `absent`, calls `abandonSession`, and answers the
activation `success: false` — so every CrabCast-started `claude` agent is
reported as a failed activation and has its session torn down **while it keeps
running**, leaving a live pane no Butchr session addresses.

**2. `pathPrefix` crossed the wire and was written verbatim.** *(FIXED by
KAN-398 — the finding is kept because the shape of it is the lesson.)*
`provision()` sent raw `McpServerDefinitions`; every Butchr writer runs
`materializeMcpServers` first, which turns `pathPrefix` into `env.PATH` and drops
`unusable`. CrabCast writes what it is sent — as their own `configure_agent`
refusal text says — so the workspace `.mcp.json` carried a `pathPrefix` key no
MCP client reads, and **no `env.PATH`**. KAN-157 added that field to decide
*which Node runs an npx-based server*, `npx` and `mcp-remote` both being
`#!/usr/bin/env node`. **It did not bite on this machine** — the inherited PATH
happened to resolve the same Node — and that is precisely what makes it worth
writing down: it was a latent defect that worked by luck, not a visible one.

**3. The core server was sent unstamped.** *(FIXED by KAN-398.)*
`withWorkspaceIdentity` was applied in `herdr.ts`, and `crabcast-runtime.ts`
imports nothing from `launchers.js`, so the `butchr` entry reached disk without
`--workspace-type` / `--workspace-key`. **That is the KAN-145 defect returning by
a new road**: a value written where nothing reads it, leaving `activatedBy` null
and the org chart with nothing to draw. The tools still work — `mcp.ts` reads the
flags for *parentage*, not for reachability — which is why this was invisible
from the agent's side.

**How 2 and 3 were fixed, and why it is one fix rather than two.** They had a
single root cause: the transforms lived *inside* `HerdrBridge`, so they were
`HerdrBridge`'s to remember and `CrabCastRuntime` had nothing to inherit. **The
fix moved them above the runtime seam** — `MessageRouter` now calls
`prepareWorkspaceMcpServers` and `AgentRuntime.spawnSession` accepts only the
branded `WorkspaceMcpServers` that function produces, so **handing a runtime a
raw assembly is a compile error** rather than a defect somebody has to notice in
review. A third runtime added later inherits the guarantee without being told
about it.

Three consequences worth knowing:

- **`crabcast-runtime.ts` still imports nothing from `launchers.js`**, so §1 of
  gate 3's guard below stayed an allow-list and was not narrowed. The obvious
  implementation — applying the transforms inside `provision()` — would have
  required that import and cost the guard its strength.
- **KAN-157's unusable-server refusal moved with them**, to
  `MessageRouter.refuseUnusableMcpServers`. It had to: `materializeMcpServers`
  strips the `unusable` field it reads, so left below the seam it would have
  read an empty list on every activation for ever. **CrabCast never had that
  refusal at all**; it now does, because the check runs before the seam rather
  than inside one implementation of it.
- **`configureAgyMcp` stripped the identity itself, and KAN-395 deleted it.** agy's
  config was global — one file for every workspace — and a per-workspace stamp
  written there names whichever agent was activated last. That invariant used to
  hold because `initPty` happened to pass an unstamped assembly to
  `launcher.setup`, and KAN-398 moved it to the writer that owned the file. With
  the anti-gravity launcher gone there is no such writer and no such file: the
  workspace `.mcp.json` is the only thing `launchers.ts` writes.

`daemon/scripts/verify-workspace-mcp-preparation.mjs` covers all of it except the
live leg — that a real peer writes what we sent — which stays with
`verify-crabcast-claude-launcher-live.mjs` §5 and needs a peer.

### What CrabCast does that Butchr's own `claude` launcher also does

Both measured, both **not** defects, and both worth recording because the
obvious prediction was that neither would happen:

- **Folder trust is handled.** `~/.claude.json` had no entry for the probe
  directory before the spawn and `hasTrustDialogAccepted: true` after it.
  Nothing on Butchr's side wrote it: `trustClaudeWorkspace` is called only from
  the `claude` launcher's `setup`, which is `AGENT_LAUNCHERS`' and never runs on
  this path.
- **Permissions are bypassed.** The pane reported `bypass permissions on`
  although no `.claude/settings.local.json` exists in the workspace —
  `configureClaudeSettings` did not run either.

**No startup dialog was met, and that is gate 3's question answered in passing
(KAN-393).** `setAgentSpawnedListener` never fires under this runtime, so
channel-startup supervision does not run and nothing was available to answer a
dialog or press a key. Two cold `claude` starts needed none: both reached the
model, ran three tool calls and printed their results unattended. **That is an
observation about two spawns on one machine, not a guarantee** — it says the
supervision being inert did not block these starts, not that it can never
matter.

**KAN-379 added five more cold starts on the same finding** (PR #164, against
the live peer at `contractVersion 8`, build `9d4d999c`), which makes seven
spawns on one machine and does not make the observation a guarantee. **See
[gate 3's ruling](#gate-3-the-ruling-channel-startup-supervision-is-disabled-under-crabcast-deliberately)
below for the argument that does not depend on the count.**

### Gate 3, the ruling: channel-startup supervision is disabled under CrabCast, deliberately

**KAN-393, `epic/KAN-39`, 2026-08-14. Gate 3 is NOT a cutover blocker**, and
`setAgentSpawnedListener` not firing **is** the disablement rather than an
accident of one. Recorded here and at the method itself so that nobody
re-derives the gate from the supervisor's silence — *"silently inert" was
explicitly ruled out as an end state.*

The supervision exists to answer **one** dialog: the full-screen confirmation
Claude Code raises for `--dangerously-load-development-channels`. Three
independent reasons make that job empty here, and **the first is structural
rather than observed**:

1. **The dialog cannot be raised on this path.** The flag is composed in exactly
   one place — `launchers.ts` `developmentChannelFlags()` — and reaches an agent
   only as **argv on a `claude` command line**. `configure_agent` has no argv
   field: `provision` sends `path`, `priority`, `launcher`, `prompt` and
   `mcpServers`, and no member of that frame can carry a flag.
   `crabcast-runtime.ts` imports nothing from `launchers.js`, so it cannot get
   in by accident either. **A dialog whose trigger cannot be spelled cannot be
   met** — and that is a claim about the wire's shape, not about how many spawns
   happened to be clean.
2. **Even if the listener fired, it returns at its first line.** `daemon.ts`
   gates on `spawn.channelEnabled !== true`, and `provision` deliberately does
   not send the `{"crabcast": "builtin"}` sentinel (KAN-294 item 5), so every
   agent spawned here answers `channelEnabled: false`.
3. **CrabCast publishes no spawn command line** (method 2), which is what made
   this unfireable before either of the above was established.

**The bound on reason 1, because it is narrower than "no dialog ever".** It is a
claim about the *dev-channels* dialog — the only one this supervision answers.
Other Claude Code startup dialogs exist; what covers them here is the seven
observations plus the folder-trust finding directly above. Those belong to
`startup-dialog.ts`'s `FOREIGN_DIALOGS` population, which this daemon refuses to
answer on **every** runtime, so a foreign dialog under CrabCast is an agent that
starts late and says so — not a channel defect, and not what gate 3 asked.

**What would re-open it:** `configure_agent` growing a way to pass argv, this
adapter acquiring an import from `launchers.js`, or `provision` starting to send
the `"builtin"` sentinel. The first two are what
`verify-crabcast-channel-startup-disablement.mjs` watches — **the premises, not
the conclusion**, since the conclusion is prose and prose cannot go red.

**`press_pane_key` is still absent and that is no longer a gate.** Re-measured
on 2026-08-14 against the live peer: `Unknown action: press_pane_key`. It stays
an interface observation for KAN-59 — who ruled the `pty_input` route out as a
foundation for supervision — and it is not on the cutover's path.

**And closing this gate is not clearing the way** (KAN-348's standing rule).
Gate 2 remains open on KAN-397 and KAN-398; this ruling removes gate 3 from the
list and moves nothing else.

### What this did not reach

- **The daemon's own activation path.** The runtime is read once, process-wide,
  at construction, so a single activation can only be pointed at CrabCast by
  building the runtime in a process of one's own. `spawnSession` was therefore
  called directly and `router.ts` never ran — no `confirmActivation`, no
  registry write, no capacity gate. The proof asserts the router still assembles
  the same arguments **by reading `router.ts` as text**, which establishes what
  the call site says and not that it runs. `verify-crabcast-runtime-live.mjs`
  has the same limit.
- **Anything at fleet scale.** Two agents, one machine, one CrabCast build.

---

## Where the brief lives — gate 9, decided (KAN-400)

Gate 2 measured, in passing, that **`.butchr-prompt.md` is never written on this
path**. The consequence was three daemon-composed messages telling an agent to
read a file that is not there — `resume.ts`'s nudge and cold-start prompt, and
the `butchr` MCP server's own `instructions` string, which is the one of the
three that reaches a CrabCast agent **today** (the two resume messages were
unreachable on this path until a resume signal landed; `resumedConversation` was
set in `herdr.ts` and nowhere else).

**KAN-432 landed that signal, and it switched ONE of the two on — not both.**
`provision()` now reads `activate_response.resumedExistingConversation`, so
`resumedConversation` is set on this path for the first time. What follows from
that is asymmetric, and the difference is which side of the runtime boundary
each message is composed on:

| latent site | reachable under CrabCast now? |
| --- | --- |
| `resumeNudge`, via `nudgeResumedAgent` | **yes.** It is runtime-agnostic — it asks `AgentRuntime.briefLocation(type, key)` and gets this runtime's `runtime-owned` arm. It was latent only because nothing set `resumedConversation`. `verify-resumed-conversation-nudge.mjs` §5 drives a real nudge through `reconcileAgents` and asserts the delivered text carries CrabCast's pointer and never names `.butchr-prompt.md`. |
| `degradedResumePrompt` | **no.** Its one call site is inside `HerdrBridge.initPty`, composing an argv fallback. `CrabCastRuntime` has no `initPty` and composes no fallback — `provision()` hands the prompt to `configure_agent`. So it stays unreachable here, and gate 9's wording on it stays unverified against this runtime. §5 asserts that absence rather than describing it. |

KAN-432's own description says both go live; the tree says one does. The
disagreement is recorded here rather than reconciled quietly, because the half
that is **not** live is the half a reader would otherwise take as covered.

**The decision was where the brief lives, not how to patch a sentence**, and it
is settled by their published contract rather than by preference.
`docs/callers-directory.md` records the bootstrap prompt as **"moved out
entirely"** into the agent's sidecar, `<dataDir>/agents/<hash>/prompt.md` —
*"the highest-value single change here, because it was the file rewritten on
every activation and therefore the likeliest to show up as a spurious diff or be
committed by accident."* The caller's directory gets exactly one exception,
`.mcp.json`, and only because Claude Code reads MCP configuration from the
project root *"and from nowhere else"*. So:

| answer considered | verdict |
| --- | --- |
| ask `configure_agent` to put the brief in the workspace | **not available.** It asks them to undo a decision their contract states and defends, and `configure` has no destination knob — `--prompt`/`--prompt-file` and nothing else. |
| write a second `.butchr-prompt.md` ourselves under this runtime | **rejected.** Two copies with *different update rules*: herdr's is rewritten on every activation, while `configure_agent` **refuses** a prompt change under a running agent (*"the agent running there has already read it"*). The pointer at the pane would still name theirs. |
| **stop naming a path; take the location from the runtime** | **taken.** `BriefLocation` in `daemon/src/resume.ts`, answered by `AgentRuntime.briefLocation(type, key)`. |

**The daemon could not name their path even if it wanted to**, which is what
makes the third answer cheap rather than a compromise: `<dataDir>` is their
config knob, the sidecar is keyed by a hash they mint, and **no prompt path
crosses the wire** — `configure_agent` echoes the prompt as a *character count*.
The union has a `workspace-file` arm carrying an absolute path, which herdr still
uses, and a `runtime-owned` arm carrying prose. Nothing lost findability: what
this runtime's arm names is the pointer line CrabCast types at the pane, which is
in the agent's own first turn and carries an absolute path.

**Demonstrated rather than reasoned about** —
`daemon/scripts/verify-crabcast-brief-reachable-live.mjs` starts a real
cold-started `claude` agent here and has it run both arms. Measured on a live
peer: the workspace is **empty** (`[]` — CrabCast wrote nothing into it at all,
this agent having asked for no MCP servers), and the agent followed the new
wording to `/home/brooswit/.local/share/crabcast/agents/<hash>/prompt.md`,
reporting the marker planted at the **end** of the brief and that the file sits
outside its working directory. **The pointer it followed came from CrabCast**;
nothing in the probe tells it where its brief is, which is the leg a constructed
test cannot fake.

**One instrument limit, recorded because it produced a false red first.** The
agent is read by tailing its pane, and **a pane is a screen rather than a
scrollback**: the probe's first run asked for its answers step by step, and the
step-1 answer had scrolled off by the time the tail was taken — absent marker,
correct agent. An absent marker is not a negative answer. The probe now asks for
every answer together at the end, and prints the tail's line count and
CrabCast's own `truncated` flag beside the verdict.

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

**KAN-224's reconnect resync and its discontinuity signal (§3.5, §6.2) are
implemented — KAN-381, cutover gate 5.** This paragraph read *"the link
reconnects, but mirrors are not re-subscribed and no `{discontinuity: true}` is
delivered … **nobody covers this yet**"* until then, and it was accurate: the
accessor for doing it, `CrabCastLink.subscribedSessions()`, existed and was
called from nowhere, while the `close` handler's comment said *"owners
re-subscribe"* and no owner was ever told a drop had happened. See *The
reconnect resync* below.

---

## The reconnect resync, and why the marker matters more than the repair

**KAN-381.** A link that is **down** is visible — calls fail and a caller can
act on that. A link that has **reconnected without resyncing** answers every
question, promptly, with stale data and no disclosure. Nothing errors, nothing
is slow, and no field says *"this may have missed events."* From outside it is
indistinguishable from a healthy link, so a consumer will not check, so the
staleness propagates into whatever it decides. That is why the resync alone was
never the fix.

### What happens on a drop

`CrabCastLink` announces connection transitions on `onLinkState`, and
`CrabCastRuntime` is the owner that acts on them:

1. Every mirror that was `live` or `subscribing` becomes **`stale`** — a fourth
   state, added because the third did not exist and a reconnected-but-
   unsubscribed mirror therefore had to be reported as `live`. A state nothing
   can name is a state nothing can branch on.
2. A `PtyDiscontinuity` is opened on it: `sequence`, `lostAt`, `cause:
   'link-dropped'`, and `resync: 'pending'` with `restoredAt` and `windowMs`
   **`null` rather than `0`** — the gap is still growing, and zero would be a
   duration.
3. It is fanned out to that mirror's listeners **immediately**, while the link
   is still down, and appended to `HerdrSession.ptyDiscontinuities`.

On reconnect each stale mirror gets a fresh `pty_init`, and the record is
settled — `restoredAt`, `windowMs`, and `resync: 'succeeded' | 'failed'` — and
re-emitted **under the same `sequence`**, so one drop reported twice is not two
drops.

### Three choices worth stating, because each has a plausible-looking alternative

- **The window is disclosed whether or not the resync worked.** A resync that
  silently succeeded and one that silently half-succeeded look identical without
  a marker. The snapshot is bounded on both sides, so a long enough gap loses
  bytes off the front whatever either end does — and a consumer that was
  *appending deltas* has a hole in its own copy regardless, because the snapshot
  **replaces** the mirror rather than extending it.
- **The listener takes a discriminated union, not an optional second argument.**
  An optional argument is one every existing consumer keeps compiling without
  reading, which delivers the gap to code that renders it as nothing — this
  ticket's own defect, one layer up. A union has no `.data` on the other arm, so
  every consumer is made to say what a gap means to it. The same argument
  retired a separate `registerDiscontinuityListener`: an opt-in disclosure is
  one a consumer that has never heard of it silently does not get.
- **The record is durable as well as live.** A live event only reaches whoever
  was listening at the time, and the extension re-issues `pty_init` on every
  reconnect of its *own* link — so the consumer that most needs this is
  routinely one that was not present. `pty_init_response` carries
  `discontinuities` beside `buffer`: what the mirror has, and what it could not
  see. That pairing is KAN-367's rule arriving on the transport.

### Failed reconnect attempts do not multiply the gap

One drop is one gap for the length of the outage, however many retries fail
inside it — a gap per attempt would turn a thirty-second outage into two hundred
records and bury the one that matters. That is also what makes `pending` a state
worth having rather than a placeholder: it is what an operator sees while the
link is still down.

### Does Butchr poll independently?

KAN-59's contract says a missed event should degrade to slower convergence
rather than divergence, **but only for a consumer that independently polls** —
which they restate as a consumer requirement rather than a guarantee. So the
answer, per surface:

| surface | polls? | what that means here |
| --- | --- | --- |
| the census (`list_agents`) | **yes**, every 2s | Fleet state converges by itself after a gap. `reachable` already discloses a census that could not be taken. |
| the pty mirror | **no** — it is a subscription, not a poll | Nothing converges it. This is the surface the discontinuity exists for, and the reason the answer could not be *"we poll, so CrabCast's caveat is satisfied."* |

The resync is what makes the mirror converge *at all*, and the marker is what
makes the window in which it had not converged legible. Neither is a poll.

### What is proved, and what is not

| claim | established by |
| --- | --- |
| a real drop against a real peer re-subscribes the mirror, and the snapshot carries what the pane printed during the outage | `verify-crabcast-reconnect-live.mjs`, against the machine's CrabCast |
| the gap is opened on the drop, settled on the repair, and its window is arithmetic on its own endpoints | both proofs |
| a stale mirror and a fresh one are reported **differently** | `verify-crabcast-reconnect-resync.mjs` §5 — the assertion that carries the property |
| **a peer that RESTARTS** — `bootId` and `build.commit` moving under a reconnect | **nobody.** The live proof cuts a relay; CrabCast stays up throughout. This is the ordinary deploy case and it is the honest gap. |
| **the errno path** — a disconnect announced when `error` precedes `close` | **`verify-crabcast-rude-death-live.mjs`** (KAN-456), which kills a real peer rudely and politely in one run. It replaces the *"statically only"* entry that stood here until 2026-08-15, and it corrects that entry's reasoning as well as filling its gap — see [What a rude peer death looks like](#what-a-rude-peer-death-looks-like-kan-456) below. `ECONNRESET` **is** reachable on AF_UNIX; what produces it is *our write* racing the teardown, not the peer's manner of death. |

---

## What a rude peer death looks like (KAN-456)

Gate 5's last leg. `task/KAN-381` disclosed, against its own work, that the errno
path was *asserted statically only* — nobody had killed a CrabCast peer rudely
and watched. This is what happens when you do. Reproduce with
`node daemon/scripts/verify-crabcast-rude-death-live.mjs`, which drives both arms
in one run against a peer it spawns itself.

| observation | rude (`SIGKILL`) | polite (`SIGTERM`) |
| --- | --- | --- |
| passive reader's socket events | `end` → `close(hadError=false)` | `end` → `close(hadError=false)` |
| **writer's** socket events | `error(ECONNRESET)` → `close(hadError=true)` | `error(ECONNRESET)` → `close(hadError=true)` |
| `LinkStateEvent.errno`, link **idle** at the death | `null` | `null` |
| `LinkStateEvent.errno`, link **mid-request** | `ECONNRESET` | `ECONNRESET` |
| socket file left behind | **yes** | no — unlinked |
| errno of the **next** connect attempt | **`ECONNREFUSED`** | **`ENOENT`** |

Read the table by column and then by row. **Nothing moves left-to-right except
the last two rows** — the manner of death changes almost nothing. What moves the
drop's errno is the pair of rows in the middle, and that axis is *ours*.

**On the socket the two are indistinguishable, and that is a property of the
transport rather than a defect in us.** A `SIGKILL`ed peer's fds are closed by
the kernel, and on AF_UNIX that is EOF — the same bytes a clean `close()`
produces. There is no RST to carry the difference and no errno is recorded, so
`LinkStateEvent.errno` is `null` on both arms and every owner of
connection-borne state sees one event, not two kinds.

**`ECONNRESET` is reachable, and reading it as a rude-death signal is the
mistake to avoid.** The entry this section replaces inferred from *"AF_UNIX has
no RST"* that no socket could produce `ECONNRESET`. It can: write into the
teardown window and it arrives. But it arrives on **both** arms, because what it
reports is *our write* meeting a socket the kernel is tearing down — not how the
peer died. The earlier proofs never saw it only because they never wrote at that
moment.

**So the drop's errno is a fact about Butchr, not about CrabCast.** Two links
watching the *same* death disagree: one idle at the moment it happens is told
`errno: null`, one mid-request is told `ECONNRESET`. That holds on both manners
of death, which is what makes the field unusable for the question it looks like
it answers. **A branch on `event.errno` would key on whether this daemon
happened to have a request in flight** — a property of our own scheduling — while
reading, at the call site, as though it discriminated the peer. It would also
fail in the comfortable direction: an idle link takes the `null` arm, so the
branch that looks like *"the peer died cleanly"* is the one that fires when we
simply were not talking at the time.

**The exact errno is a race and must not be asserted on.** `ECONNRESET`
dominates — 12/12 in a dedicated 6×2 repeat — but `EPIPE` has been observed,
depending on whether the write landed before or after the kernel finished the
teardown. The proof asserts membership of `{ECONNRESET, EPIPE}` and prints the
value; pinning it is how this becomes the next [KAN-416](https://wroosbit.atlassian.net/browse/KAN-416),
whose whole finding was a live assertion failing for a reason unrelated to its
subject. Whether `EPIPE` correlates with the rude arm is **not** established
here — it was seen once, on that arm, and one observation is not a correlation.
It does not bear on the verdict, because nothing reads the value.

**This does not disturb KAN-381's fix, and it does relocate its reason.** Not
clearing `this.socket` in the `error` handler is still correct and still
load-bearing, because §3 shows an established connection really can emit `error`
before `close`. What is wrong is the comment's claim that this is *"the ordinary
case"* for a dying peer: a peer death alone never enters that handler. The
handler is reached when we were mid-write, on either manner of death.

**The one real difference is the peer's own cleanup, one connect later.**
CrabCast unlinks its socket file on a clean shutdown and cannot on `SIGKILL`, so
the reconnect attempt that follows answers `ENOENT` after a polite death and
`ECONNREFUSED` after a rude one, and that reaches `describe().lastErrno`. **It
is CrabCast's behaviour, not the transport's, and it is uncontracted** — their
read-path contract covers `list_agents` and `agent_status` only. Do not build on
it.

**And nothing needs it.** `event.errno` has exactly one consumer in the whole
daemon and it is a clause in a log line; both deaths converge on the same
reconnect-and-resync path. So the leg closes on *no difference is needed* rather
than on the weaker *no difference is visible*. §4 of the proof is the gate that
goes red if a branch on `event.errno` ever appears — such a branch would take
the same arm for both deaths while looking like it discriminated.

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
`state`, `workDir`, `createdAt`, and **`config.launcher`**.

`config.launcher` is the one field on this list whose **value** we branch on
rather than merely read, and since KAN-429 the branch is fenced: adoption admits
only a name Butchr itself has (`claude`, `shell`) and refuses to interpret any
other, because what a launcher of CrabCast's delivers is CrabCast's fact and not
ours. **So a new launcher name on your side cannot break us** — it is refused,
loudly and locally, rather than guessed at. If the contract ever publishes
whether a row has an agent runtime behind it, that field is what we would read
instead, and this branch would go away.

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

### What v7 buys, what v8 changed, and what is STILL unanswered

**The problem it solves.** `unreadableRecordsTotal` has read **`1`** on this
machine since 2026-08-03. It is a deliberately preserved tombstone — a
`pre-migration` row for a shell demo, kept on purpose by CrabCast's KAN-302 —
and until the 2026-08-14 deploy nothing on the wire could say whether that `1`
was transient or permanent. **It now can, and the answer is `retired`** — a
tombstone, not a lost agent, with `claimsEvent: "deactivated"` as the evidence
the verdict was read from. Their own count never falls by itself, so **any increase is a real
event**; but a `2` arriving where a `1` has become background noise is
indistinguishable from the noise. `standing` is what turns the number into a
branch: `retired` is boring, and `claims-an-agent` with nothing readable
covering it is the case worth attention.

**Read `standing` behind the version, and `claimsPath` — never `identity` — for
the join.** Both halves have a live counter-example on this machine:

| field | why it is read the way it is |
| --- | --- |
| `standing` | Refused below `contractVersion: 7`, as `{available: false, because: 'peer-below-v7'}` — and `claimsAt`/`claimsEvent` sit behind the SAME gate, because all three arrived in v7 and a peer below it sends none of them. This machine's peer answered **6** until 2026-08-14 and answers **8** now, so both sides of that door have been exercised against real bytes. Reading a below-door `undefined` as *"no standing recorded"* would collapse **this peer cannot tell me** into **this row has no standing**, which are different sentences; `StandingReading` is an object union precisely so that collapse does not compile |
| `claimsPath` | The join key. An agent in CrabCast **is** a canonical path, so `claimsPath` matches a readable row's `path` directly. `identity` is the row's own vocabulary — often `<type>/<key>` — so a failed match on it is indistinguishable from a genuine absence, and branching on it would fire the alarm on the ordinary case |
| `claimsAt` | A **quotation, never a date type.** Their promise is that it is what the row said, not that it parses |

**What `standing` does NOT answer, stated because the field looks like it covers
more than it does.** It is a verdict about **the row**, not about the agent, and
three questions we care about survive it:

1. **Is that agent running now?** `standing` cannot say, and neither can
   CrabCast — the line they would have to read is the line they could not read.
   `claims-an-agent` means *this line asserts an agent*, nothing more.
2. **Is our one live specimen superseded?** **Unanswerable, and it will stay
   that way** — the deploy did not change this. Its `claimsPath` is `null`, so
   the join *cannot run*, which is the `could-not-run` outcome and is **not
   evidence either way**. In practice the question is never reached: the row
   reads `retired`, and `retired` needs no join because nothing was going to be
   restored from it. The only remedies remain a human reading `raw` or
   repairing the line.
3. **Has the row been retired for good?** No: a sanctioned way to retire a row —
   so the count could legitimately reach zero — was deferred to CrabCast's
   KAN-356 and is not ours to decide.

**What v8 changed, ruled on rather than consumed wholesale.** v8's entire delta
is to `capacity`: `measuredTreesSeen` added, and `measuredAgentTrees` narrowed
in **population** rather than in type. The `UnreadableRecord` row shape and the
`rowStanding` vocabulary are **byte-identical between v7 and v8** — established
by diffing their published contract, not by reading their source. **We read no
`capacity` field off their wire**, and `verify-crabcast-standing.mjs` §5 asserts
that rather than leaving it as a sentence, because it is the fact that licensed
moving the pin to `8`.

> ⚠ **Name collision.** Butchr has its *own* `measuredAgentTrees` on
> `list_agents_response`, computed by `capacity.ts` from this machine and
> unrelated to CrabCast's. A reader who greps the name after reading their v8
> notice will find ours and may "correct" it to match theirs. **Do not.** Ours
> narrowed independently at KAN-276 for the same reason theirs did, which is
> exactly what makes the collision easy to mistake for a shared field.

**And the bump's own limit, restated because the previous version of this
paragraph is now false.** It said the v7 fields had *"never been read against a
live v7 peer, because none exists"*. One does now. What is proved against real
bytes is the refusal below the door and the **reading** above it. What is
**not** proved, on any wire ever: the `claims-an-agent` and `matched` arms.
There is one unreadable row on this machine and it is a tombstone, so the branch
this work exists to *enable* is exercised against constructed frames only. That
needs a registry to acquire a second unreadable row claiming an agent — a fault
nobody wants and nobody can schedule. `verify-crabcast-standing.mjs` marks which
of its sections is which in its own header.

### What the contract does not hold

<!-- constant-pin: CRABCAST_CONTRACT_VERSION
     src: daemon/src/crabcast-link.ts
     sha256: 89dabf375257
     says: `contractVersion: 8` covers **`list_agents` and `agent_status`** -->

`contractVersion: 8` covers **`list_agents` and `agent_status`**. It does not
cover `activate_response`, and CrabCast disclosed that themselves — their
KAN-287 is the ticket to bring it in. **`channelEnabled` is read from
`activate_response`**, so it can change without moving the version and without
going red in their CI. Nothing on our side but
`verify-crabcast-runtime-live.mjs` §4b can notice if it does; that is stated in
that script's own header rather than left to inference.

The same holds, unmentioned by anybody until KAN-294, for the census: nothing
promises `list_agents` will *not* grow the field, and nothing promises it will.

### The PTY group is uncontracted too, and a shipped feature rides on it (KAN-393)

**This section listed `activate_response` and stopped, and that was the whole of
what a reader looking for "what is uncovered" would find.** The module docblock
of `crabcast-link.ts` has always been wider — *"what is still unpublished is
everything else we touch — `activate_response`, `configure_response`, the
`pty_*` group and the `agent.*` broadcasts … the parts we lean on hardest are
the undocumented parts"* — so the **surface's** status was recorded. What was
not recorded anywhere is **what depends on it and what breaks if it moves**, and
that is what this section adds.

**`pty_init`, `pty_input` and `pty_resize` are outside `contractVersion: 8`.**
All three were re-measured as served on 2026-08-14 against build `9d4d999c`;
being served is not being contracted, and neither a reshape nor a removal would
move the version or go red in CrabCast's CI.

**What rides on them: the sidepanel terminal — a shipped, user-facing feature.**
Methods 21, 22 and 23. Under CrabCast, *rendering* an agent's terminal is
`crabcast-link.ts`'s long-lived `pty_init` per session plus the `pty_output`
frames it demuxes, and *typing into* one is `crabcast-runtime.ts`'s `pty_input`;
`pty_resize` carries the geometry. There is **no contracted alternative** — the
CLI cannot serve this group at all (see *The transport*, above) — so this is not
a dependency to remove, and KAN-393 does not propose removing it. It is a
dependency that was invisible.

**What breaks if the group reshapes**, in the order a reader would meet it:

- **A renamed or removed action** — the panel gets a refusal, drops its session
  id, re-attaches once, and then renders *"Terminal session not recognised"* with
  a Reconnect button. Loud, and the one benign outcome.
- **A changed `pty_init_response` shape** — `buffer` renamed or dropped is a
  terminal that attaches and paints nothing. There is no assertion on that field
  outside the live proof.
- **A changed `pty_output` frame** — the demux registered before the request
  stops matching, so frames arrive and are discarded. **Silent**, and the worst
  of the three: an empty terminal is indistinguishable from an idle agent.

**And the cutover sequence's step 9 canary asserts on this surface**, which its
own text did not say until KAN-393 — see the note there.

**This paragraph opened `contractVersion: 3` until KAN-347**, which is the
*second* place KAN-324's bump was never carried into the prose. KAN-283
corrected the version row at the top of this page by hand and did not find this
one — not carelessness, but the ordinary reach of a hand-correction: it fixes
the sentence somebody was looking at. Both sentences are pinned now, which is
the argument for the mechanism rather than for a third careful reader.

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
