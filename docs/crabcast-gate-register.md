<!-- constant-pin-exempt: RUNTIME_ENV_VAR — every mention of BUTCHR_AGENT_RUNTIME in
     this file is inside the VERBATIM ARCHIVE below, which is a byte-identical snapshot
     of KAN-348's description and must not be edited. A pin here would assert a present
     fact about the constant from inside a dated quotation, and keeping that pin honest
     would mean rewriting the archive — which is the one thing this file exists to
     prevent. The live pin for RUNTIME_ENV_VAR is `docs/crabcast-runtime.md`'s, and the
     cutover sequence carries its own. Added by KAN-457. -->

# The CrabCast gate register — schema and archive

**Status: this is the register's ARCHIVE and its SCHEMA. It is not the gate
list's live status.** Read
[KAN-348](https://wroosbit.atlassian.net/browse/KAN-348) for that, exactly as
`docs/crabcast-cutover-sequence.md` already tells you to. Nothing here opens,
closes, or rules on a gate.

KAN-457. Filed by `epic/KAN-39` against a document they own, after the eighth
update to KAN-348 was **refused**:

```
editJiraIssue -> {"errors":{"description":"CONTENT_LIMIT_EXCEEDED"}}

live description   31,743 characters
attempted update   33,766 characters
cap                32,767
```

## Why the register is split, and along which seam

The register had grown to **32,377 of 32,767 characters — 390 left**. Measured
across its preceding four updates it was growing at **1,879 characters an hour**,
which is **twelve minutes** of headroom. Every option that keeps the whole
document inside a 32,767-character container has a runway measured in hours:
trimming the dated blocks recovers 3,823 characters, moving the standing rules
out recovers 5,795, and a displacement rule recovers nothing at all by
construction. **A container whose stated purpose is to outlive the tickets and
the agents, and whose runway is hours, has not been fixed by rearranging what is
inside it.**

So the seam is **write cadence**, not kind:

| | the INDEX | the ARCHIVE |
| --- | --- | --- |
| size | bounded — one row per gate | unbounded, monotonic |
| written | the day a gate moves, under time pressure | retrospectively |
| cost of a slow write path | fatal — it stops being maintained | none, it is history |
| cost of a cap | fatal — silent refusal | fatal |
| home | **KAN-348's description** | **this file** |

A PR gate is **a feature for the archive and fatal for the index**, which is why
only the archive moved. **No same-day write is blocked on a PR**: the row a gate
movement touches is still one `editJiraIssue` away.

**This is not the founding failure repeating.** That failure was a *live* list in
a place nobody re-reads — KAN-283's closed description, which nearly took gate 6
with it. This is its inverse: the live list stays at the front door and the dead
narrative goes to the basement. Forgetting an archive costs you reasoning you can
reconstruct from nine gate tickets, all of which exist because KAN-348's own AC1
made them exist; forgetting a live list costs you a cutover shipped with an open
gate. **Those are not the same risk and must not be priced the same.**

**And the repo was already the answer for this domain.**
`docs/crabcast-cutover-sequence.md` made this move first, and its reasoning is
the reasoning here: *"It is in the repository rather than on a ticket or a
Confluence page because it is what somebody needs during an incident, and because
a plan held between two supervisors is the shape that nearly lost gate 6."*
Repo **code** already cites this register as its authority —
`daemon/scripts/verify-crabcast-claude-launcher-live.mjs:579` takes its
permission for the capacity-override bypass from *"the standing rule on
KAN-348"*. **A source file's permission to bypass a capacity limit was citing a
rule in a container that could no longer accept an amendment to that rule.**

## The row schema

The defect this fixes is narrower than "the document is full", and it is
`epic/KAN-203`'s: **the register held closures whose basis is somebody else's
versioned artefact, presented as unconditional.** Gate 7's row cited
`contractVersion: 8` as *provenance*. Nothing said the citation was also an
*expiry* — that a new `resumeCause` member changes the gate's answer the moment
CrabCast deploys, and they have versions 9, 10 and 11 written and undeployed.

A row is:

```
GATE <n> · <STATUS> [<date>] · <ticket>[, <ticket>...]
  BASIS      internal | external — <what the closure rests on>
  PINNED-AT  build.commit <sha> (contractVersion <n>)     [external only]
  ON-MOVE    re-open | re-measure | no-longer-applies — <why>   [external only]
  WHY        <pointer into this file, or a ticket key>
```

- **`BASIS`** is the field that makes conditionality **visible without reading
  the prose**. `internal` means the closure rests on this repository, which we
  control; `external` means it rests on an artefact somebody else versions.
- **`PINNED-AT` records the BUILD, not only the version, and the checker
  enforces that.** `epic/KAN-59` measured `pty_input`/`pty_resize` behaviour
  changing between CrabCast's deployed build and their `main` while **none** of
  versions 9, 10 or 11 mentions it — correctly, because that surface is
  deliberately uncontracted. A consumer tracking the version alone reads
  8 → 11, concludes *"three additive additions"*, and is exactly wrong about the
  change most likely to affect it. **A version-only pin is not a weaker pin; it
  is a pin on the wrong thing.**
- **`ON-MOVE` is a closed vocabulary** so a reader can act on it without
  interpreting prose.
- **Only `external` rows carry `PINNED-AT` and `ON-MOVE`.** A required field
  that is usually noise is a field people stop filling in.

### The index states no totals — it enumerates

KAN-348's summary read `10 gates, 9 closed`. It enumerates **nine** gates
(1, 2, 3, 4, 5, 6, 7, 9, 10 — there is no gate 8; **8 is the flip step**) of
which **eight** are closed. Both numbers were wrong and the enumeration beside
them was right the whole time. `epic/KAN-39` then corrected `10 gates, 8 closed`
to `10 gates, 9 closed` — fixing the closed-count while propagating the wrong
total, in the same edit, while explicitly correcting a count. **Two independent
authors made the identical off-by-one on the same document.**

That is not a document that invites an error. **A total stated in prose beside an
enumeration is a second source of truth, and the two drift the moment anybody
edits one.** So a total is either derived or absent, and
`daemon/scripts/verify-gate-register-schema.mjs` §2 goes red when a stated one
disagrees with the rows beside it.

### Worked example — the schema, not the live status

⚠ **These two rows are a worked example of the FORMAT, transcribed from what the
register already said. They are not this file's claim about gate 4 or gate 7,
and they are not maintained here.** Populating the remaining rows is
`epic/KAN-39`'s — this ticket makes room for the field and does not fill it.

<!-- GATE-INDEX-BEGIN -->
GATE 4 · CLOSED 2026-08-14 · KAN-380
  BASIS      internal — a branded `ContainedWorkspaceDir` in this repository;
             skipping the containment check is a compile error
  WHY        KAN-380

GATE 7 · CLOSED 2026-08-15 · KAN-396
  BASIS      external — CrabCast's published contract and wire
  PINNED-AT  build.commit 9d4d999cbac6bb94eb5ed25f58c24a7bf7ebf747 (contractVersion 8)
  ON-MOVE    re-measure — AC1 rests on `resumeCause` being a CLOSED enumeration
             (`reboot`, `daemon-restart`, `preempted`); one new member changes
             the answer from NO to something else
  WHY        KAN-396
<!-- GATE-INDEX-END -->

## The budget, which is derived and never typed

⚠ **A size written into a document is a stated figure nobody re-derives — the
identical defect as the stated total.** So the register's size is not recorded
here. It is measured:

```bash
# before posting an edited description, instead of discovering the cap by refusal
node daemon/scripts/verify-gate-register-schema.mjs --as-description <extracted.md>
```

which prints `SIZE  description: 32,382 / 32,767 chars (98.8%), headroom 385`
**before** the write rather than after the refusal.

**Extracting the description is the awkward step and the route is not obvious.** A
direct REST read is refused for this account — `epic/KAN-39`'s own probe stored
`"Issue does not exist or you do not have permission to see it."` — but an
Atlassian MCP read whose response exceeds the client's token budget is **spilled
to a file on disk**, and the description can be lifted out of that JSON. That is
how the snapshot below was taken losslessly.

### ⚠ The maintenance method has a ratchet in it, and it was invisible

**The markdown the register hands back is not the markdown that was posted.**
Comparing the live description against `epic/KAN-39`'s pre-post copy of the same
update:

```
live 32,382 chars   pre-post copy 32,377 chars   delta +5
differing lines: 10
content words after stripping all markup:  4,952 vs 4,952
CONTENT-WORD DIFFERENCES: 0
```

Every one of the ten differing lines is the same transformation: **a bold span
that contains inline code is split, the `**` closing before the code and
reopening after.** Ten lines, two extra `**` pairs and one added backslash escape
account for all five characters.

Two consequences, and the second is the one that matters for the cap:

1. **"Re-fetch and compare" produces guaranteed false positives.** Any document
   with bold-around-code differs from itself on every cycle. An author who
   compares raw text sees ten spurious diffs, learns the noise is normal, and is
   then trained to dismiss the diff that is real. **Compare content words with
   markup stripped** — that is the comparison that returns a clean zero above.
2. ⚠ **The round trip is net-additive.** Each extract → edit → post cycle
   re-round-trips the whole document and adds a few characters to it. **Part of
   the pressure on the cap was manufactured by the maintenance method itself**,
   and nothing would have shown that.

---

# ARCHIVE

**Snapshot of KAN-348's description, verbatim, as at
`fields.updated = 2026-08-15T05:46:28.006-0700` (the eighth update).** Extracted
by the spill-to-file route above and committed unaltered. **Nothing below is
edited, re-ordered, or summarised** — it is here so that every character of the
register exists in git before anything is removed from Jira.

Verified against `epic/KAN-203`'s independent before-snapshot
(`kan-348-structure-BEFORE-8th-update.md`): 11 top-level headings, nine gate rows
(1, 2, 3, 4, 5, 6, 7, 9, 10), 12 standing rules — all present.

<!-- ARCHIVE-VERBATIM-BEGIN -->
**Filed by** `epic/KAN-39`, 2026-08-12. **This Story is a home, not a piece of work.** It holds the cutover gate list so that the list outlives the tickets that discovered it. Nothing here is a request to cut over.

**Last updated 2026-08-15 (eighth update)** — ⚠ **GATE 5 CLOSED** by [KAN-456](https://wroosbit.atlassian.net/browse/KAN-456) (#198); the daemon was **DEPLOYED** ([KAN-461](https://wroosbit.atlassian.net/browse/KAN-461)). **CLOSED: 1, 3, 4, 5, 6, 7, 9, 10. OPEN: 2 ALONE** — and on its author's ruling **not closeable before the flip**, so ⚠ **no gate on this list can now be closed by work.** ⚠ **8 is not a gate — it is the flip step itself.** Every row below states what its ticket established and what it did not.

## Why this exists, which is itself one of the findings

The five cutover gates were written into **KAN-283's description**, under _"context, not scope"_. KAN-283 merged and went **Done** on 2026-08-12. At that moment the entire gate list moved into a closed task's description — a place that is read once, by one agent, and then never again.

**Gate 6 was discovered in KAN-283's own close-out and nearly stayed there.** `epic/KAN-203` filed it as KAN-346 only because they pushed back on leaving it as a note, quoting my own rule at me:

> a gate held between two supervisors at 05:00 is a plan; by 09:00 it is a thing we both assume the other remembers.

Then a JQL search for the others returned **KAN-346 and nothing else**. Gates 2, 3, 4 and 5 had no tickets and no owner. **That is my failure specifically.** Maintaining this epic's structure is my job, and I let live work sit in a task's description because the task was the place it was convenient to write it down.

## The gates

**Gate 1 —** `AgentRuntime` async where the transport requires it. **CLOSED 2026-08-12.**
KAN-283, merged `60bd102`. Proved live against a real peer at `build.commit 6f47df7d`, `contractVersion: 6`.

**Gate 2 — the** `claude` launcher path is untested. **OPEN. Both its tickets have merged and the gate is still open** — [KAN-379](https://wroosbit.atlassian.net/browse/KAN-379) (#164) and [KAN-398](https://wroosbit.atlassian.net/browse/KAN-398) (#177), plus [KAN-397](https://wroosbit.atlassian.net/browse/KAN-397) (#168) which was a defect gate 2's work turned up.

⚠ **RULED 2026-08-15 by** `task/KAN-417`, quoted rather than paraphrased: this gate CANNOT CLOSE BEFORE THE FLIP. _"Legs 2 and 3 both stop at the same seam, and it is the seam the gate is about. Each mechanism now works when invoked; what is unobserved in both cases is_ `MessageRouter` invoking it on a real activation. Nothing can observe that until the fleet is flipped." **"Open" implies somebody could close it. Nobody can.**

**Three legs, and only one is proven live:**

| leg | state |
| --- | --- |
| prompt delivery | ✅ **proven live** by KAN-379 — a 67,684-byte prompt, markers at byte 0 and the final byte both recovered from the pane. _The whole prompt arrived_, which is a different claim from _the prompt arrived_. Reproduced twice on 2026-08-14 at 76,484 bytes. |
| `expectsRuntime` | reported **unreachable** by KAN-379; KAN-397 fixed the lookup. **KAN-417 has now watched the strict branch be reached and succeed on a live CrabCast-started agent** — but it is their proof script calling `confirmAgentPresent`, not `router.ts` calling it on a real activation. |
| MCP preparation | **file observed** by [KAN-417](https://wroosbit.atlassian.net/browse/KAN-417) — no `pathPrefix`, `env.PATH` ordered, core server stamped, stamp read back by the agent's own client and by the daemon. **The router's application of the transform on a real activation is still a static read.** |

**⚠ KAN-398's fix is proven by the type system and never watched on the wire, and I approved it without noticing.** Its author disclosed it plainly on the ticket before I signed: _"It needs a live CrabCast peer and this workspace has none, so I have not observed the fixed_ `.mcp.json` on the wire … the live leg is uncovered by me and I am not claiming otherwise." **I reviewed the proofs they wrote and not the proof the ticket asked for.**

**Two propositions, and the first does not entail the second:** _(1)_ Butchr cannot send raw definitions — established unconditionally, `spawnSession` accepts only a branded `WorkspaceMcpServers`, one producer, one cast, an unexported `unique symbol`, and a raw assembly is `error TS2345`. _(2)_ What CrabCast then writes to disk is what a `claude` agent needs — **observed by KAN-417 on 2026-08-14.**

**KAN-398's design deserves recording because it is better than the fix I ruled for.** I required the transforms be applied inside `provision()`, which needs a `launchers.js` import and would have turned gate 3's §1 check red. **The author took the other shape the ticket named: transforms moved ABOVE the runtime seam, so** `crabcast-runtime.ts` imports nothing from `launchers.js`, §1 stays an airtight allow-list, and a third runtime added later inherits the guarantee without being told. ⚠ **My premise — that the import was unavoidable — was never checked.**

### ⚠ Gate 2 OBSERVED at last — and the flip found a fourth leg nobody had listed

⚠ **The flip happened on 2026-08-15, four times, human-driven, and gate 2's
unobservable seam was finally observed. It refused.** `epic/KAN-203` measured
**36 spawn failures and 0 activations** across all 8 agents in a 15-minute
window, every one the same `configure_agent` refusal, before the dead-man
reverted it. Not intermittent, not a race, not a warm-up.
[KAN-474](https://wroosbit.atlassian.net/browse/KAN-474) is that observation and
this is its ruling.

**The refusal is CrabCast working exactly as designed, and it is not theirs to
relax** — `provisionMcpConfig` refusal 2: a server key already present that they
have no record of writing *"is the consumer's, and is refused rather than
silently taken over."* **The colliding entries were Butchr's**, written by
`writeWorkspaceMcpConfig` on every prior herdr activation. **368 of the 372
workspaces on this machine carried one**, all 368 defining both `atlassian` and
`butchr`. This was Butchr's side to fix and it is fixed.

⚠ **The obvious fix is a NO-OP, and shipping it would have closed the ticket
with the fleet still unflippable.** The ticket's own leading candidate was
*"Butchr stops pre-writing `.mcp.json` when `BUTCHR_AGENT_RUNTIME=crabcast`"*.
**Butchr already does not, and never did**: `writeWorkspaceMcpConfig` has exactly
one production caller, `herdr.ts`, inside `HerdrBridge`, and `runtime-switch.ts`
constructs exactly one runtime at boot. **There is no write on that path to
suppress.** What collides is what the *previous* runtime left on disk — the file
is **residue**, not output. Anybody reaching for that candidate is aiming at a
code path that does not run.

**THE DECISION.** Butchr clears **its own** server entries — by name, the ones it
is about to send — out of the workspace's `.mcp.json` immediately before
`configure_agent`, and only under this runtime.
`clearWorkspaceMcpResidue` in `workspace-dir.ts`, called from
`CrabCastRuntime.provision()`.

**Why that module:** it already owns *"what Butchr may do to a workspace
directory"*, and the clearance reuses its containment discipline unchanged — it
takes an **address, never a path**, so no caller can aim it. Butchr already owns
both ends of that directory's lifecycle under this runtime (it creates it because
CrabCast will not, and deletes it for the same reason); this is the same
ownership applied to a file inside it. **Removing a key we wrote is not taking
over the caller's file — we are the caller.**

**What happens to the 368 existing files: nothing, and deliberately.** Each
workspace is repaired by its own first CrabCast activation, in the same call that
needed it. No sweep to order, no step before a flip, no window in which a
workspace created after a sweep is broken again. **A migration would have been
strictly worse**: it covers only what exists when it runs, and herdr *rewrites*
this file on every activation, so a rollback regrows exactly what it cleared.
**Rollback is self-healing for the same reason** — nothing in the fix runs under
herdr, and the first herdr activation after a revert restores the entries.

**Rejected, named as the ticket asked:**

| option | why not |
| --- | --- |
| Stop pre-writing under `crabcast` | **Already true.** A no-op that looks like a fix. See above. |
| Rename or move the file per-runtime | Claude Code reads MCP config from the project root **and nowhere else** (CrabCast's own `callers-directory.md`). A renamed file is a file no client reads — this silences the refusal by deleting the configuration, which is KAN-294's silent-no-servers defect in a new costume. |
| Omit the colliding entries from what we send | Incoherent: CrabCast writes **only** what we send. Omitting them means the agent gets no `butchr` and no `atlassian` at all. There is no re-add step. |
| Delete the whole `.mcp.json` | CrabCast **merges** rather than replaces, so a non-Butchr entry in that file is live configuration. Deleting wholesale would have Butchr commit, against its own workspace, the exact offence their refusal exists to prevent. Key-scoped removal is strictly narrower and costs nothing. |
| Ask CrabCast to relax the refusal | Invariant 10, and the ticket forbade it. Their refusal is principled, documented in its own error text, and correct. |
| A one-shot sweep of the 368 files | Decays. See above. Kept available as a supplement, needed by nothing. |

**An unparseable `.mcp.json` is refused and left alone**, which is the opposite of
what the herdr writer does (*"Butchr owns this file; a corrupt one is
replaced"*). The asymmetry is deliberate: under herdr Butchr is the sole writer,
under CrabCast the file is co-owned, and CrabCast's own refusal for that case
names the file and says `NOTHING WAS STARTED` — a better error than one produced
by destroying the evidence first.

**The proof drives CrabCast's real code, not a reproduction of it.**
`verify-crabcast-mcp-residue-cleared.mjs` imports `provisionMcpConfig` from the
peer checkout, having first asserted its tree is clean, its HEAD is at or after
`CRABCAST_PIN`, its `dist` is not stale, and that `src/provisioning.ts` is
**unchanged between the pin and that HEAD**. So the red it produces is the
production refusal firing. ⚠ **Its first draft asserted `HEAD === CRABCAST_PIN`
and went red on a perfectly valid peer** — the pin is `8d7348f` and the checkout
is its descendant `9d4d999`, the commit this register already cites for gate 3.
The question that matters is whether the *file under test* moved, and it has not.

⚠ **WHAT THIS DOES NOT CLOSE.** The gate's ruling above is untouched: this was
observed only because the fleet was flipped, and whether the refusals **stop** can
be established the same way and no other. `cutover.sh` refuses to run inside a
herdr pane, so **the human drives the re-test**; the evidence is
`grep -a "spawn failed" ~/.local/share/butchr/daemon.log | tail` (the `-a` matters
— KAN-422). And a flip that activates agents may still show *"no live agent"* in
the panel: that is [KAN-475](https://wroosbit.atlassian.net/browse/KAN-475), a
second blocker sitting immediately behind this one, and the daemon.log line is
what tells the two apart.

**Gate 3 — channel-startup supervision is inert under CrabCast. CLOSED 2026-08-14.** [KAN-393](https://wroosbit.atlassian.net/browse/KAN-393), merged as #171.

**The ruling's basis changed, and the new one is much stronger.** `epic/KAN-39` ruled gate 3 not-a-blocker on **five cold starts producing no startup dialog** — an observation over a sample, on one machine. `task/KAN-393` replaced it with a **structural** argument, and their docblock says so about my evidence: _seven spawns on one machine … is an observation rather than a guarantee, and would be worth little on its own._

**The structure:** `--dangerously-load-development-channels` is composed in exactly one place and reaches an agent **only as argv**; `configure_agent` has **no argv member**. **A dialog whose trigger cannot be spelled cannot be raised.** Verified independently by `epic/KAN-39` — no `launchers.js` import (its three mentions are docblock prose), and the payload carries `path`, `priority`, `launcher`, `prompt`, `mcpServers` and nothing else. A `launchers.js` import added as a mutation turns the premise checks red.

**WHAT CLOSED:** channel-startup supervision under CrabCast. It is a **decision, logged at the listener** — _"a mechanism that is off because somebody decided so is a decision; a mechanism that is off because it cannot find its footing is a defect wearing a decision's clothes."_ Its **premises** are watched by a CI-runnable check, because _"the conclusion is prose and prose cannot go red."_

**⚠ WHAT DID NOT CLOSE:** the hazard that **any send to an agent sitting at any dialog can resolve or kill it, with nothing in the response saying a dialog was there.** `task/KAN-375`'s measurement, living on as [KAN-377](https://wroosbit.atlassian.net/browse/KAN-377) AC2 — **which is why the standing rule below survives this gate closing.**

**⚠ The guard is fragile in a named way.** §1 is an **allow-list** (nothing at all from `launchers.js`). Narrowing it to specific names would make it a **deny-list, which cannot see a name nobody has thought of yet** — `task/KAN-393`'s amendment. **If it is ever narrowed, §2 (the** `configure_agent` frame's keys as a closed set) becomes load-bearing and the header must say so in the same commit. KAN-398 avoided the narrowing entirely, so this has not happened.

**⚠ And the** `pty_*` dependency this ticket recorded stays live. Butchr depends on `pty_init` / `pty_input` / `pty_resize` — an explicitly **uncovered** surface with the notice promise negated in writing — for the sidepanel terminal, and **step 9's canary asserts on it.** Three reshape outcomes are documented, **including which one fails silently**: a changed `pty_output` frame gives an empty terminal, indistinguishable from an idle agent. ⚠ **AND THAT SURFACE IS NOW MEASURED DEFECTIVE — see the gate-candidate note under gate 10.**

**Gate 4 —** `resetWorkspace` unwired at the deletion end. **CLOSED 2026-08-14.** KAN-380, merged as #165.

`daemon/src/workspace-dir.ts` mints a branded `ContainedWorkspaceDir`; exactly one `fs.rmSync`, and the exported delete takes an **address**, never a path. **Skipping the containment check is a compile error rather than a review catch.** Lexical check first so a `../..` key is refused by name; then `realpath` on both sides, because a symlink is a fact about what exists at call time and no type reaches it.

**⚠ THE EDGE, recorded because the module records it about itself:** the brand _"constrains the one_ `rmSync` in this module and nothing else. Any file may still `import fs` and delete whatever it likes … §4 is what covers the gap … and that is a source-text assertion rather than a type, so it is exactly as strong as somebody keeping it running." **Must not be deleted as redundant.**

**Gate 5 — KAN-224's reconnect resync. ✅ CLOSED 2026-08-15.** [KAN-381](https://wroosbit.atlassian.net/browse/KAN-381) merged as #167; leg 1 by [KAN-403](https://wroosbit.atlassian.net/browse/KAN-403) (#188), leg 3 by [KAN-416](https://wroosbit.atlassian.net/browse/KAN-416) (#191), **leg 2 by** [**KAN-456**](https://wroosbit.atlassian.net/browse/KAN-456) **(#198).**

Mirrors re-subscribe, and the discontinuity is opened on the drop — `resync: 'pending'`, `restoredAt`/`windowMs` `null` rather than `0` — and settled under the same `sequence`, **whether or not the repair worked**. Live: `THE GAP: 13:18:57.333Z → 13:19:05.346Z = 8013ms, succeeded`.

**AC3 came out as predicted:** with the signal removed and the resync intact, a mirror that lived through two outages and one that never lost its link report **identically** — `stale=0 fresh=0`. **The assertion carries the disclosure property rather than the repair.**

**Its author declined to tick it on 2026-08-14** — _ticket closed, gate substantially closed, cutover checklist not yet_ — **and was right. All three reasons are now closed, and two of them were closed by falsifying what this register said about them:**

1. **A peer RESTART is unexercised** — ✅ **CLOSED 2026-08-15** by [KAN-403](https://wroosbit.atlassian.net/browse/KAN-403), merged as #188. ⚠ **And the fear was justified: the code did NOT handle it.** After a restart the pane survives but its `sessionId` is re-issued; `pty_init` on the held id is refused `unknown_session` **with the link healthy**; the mirror settles `ended`, which is terminal, so the sweep skips it forever; and `adoptFromCensus` cannot rescue it because the address is held by a session whose `status` is `active`. **It also FALSIFIED this row's own premise — only** `bootId` moves across a restart, not `build.commit`. ⚠ `epic/KAN-39` approved #188 WITHOUT re-running its live proof and said so at the time, so this leg rests on `task/KAN-403`'s measurement plus four structural checks, **not on the approver's own run.**
2. **The errno path is asserted statically only.** ✅ **CLOSED 2026-08-15** by [KAN-456](https://wroosbit.atlassian.net/browse/KAN-456), merged as #198. **Verdict, quoted:** _"Closed, because the distinction cannot exist where it was claimed — and does not need to."_ Measured with its control: a `SIGKILL`ed peer and a clean shutdown deliver **byte-identical** events on both arms. ⚠ **THIS ROW'S REASONING WAS WRONG, not merely incomplete:** it inferred from _"AF_UNIX has no RST"_ that no socket could produce `ECONNRESET`. **It can — write into the teardown window and it arrives.** ⚠ **What moves the drop's errno is whether WE were mid-write, not how the peer died** — two links watching the same death disagree, idle `null` against busy `ECONNRESET`. **A branch on** `event.errno` would key on Butchr's own request timing while reading as though it discriminated the peer, failing toward the comfortable arm; a new §4 gate goes red if one appears. **Closed on _no difference is NEEDED_** — one consumer, a log line — **stronger than _no difference is visible_.**
3. **Its central live assertion is intermittent** — failed **2 of 13** runs. ✅ **CLOSED 2026-08-15** by [KAN-416](https://wroosbit.atlassian.net/browse/KAN-416), merged as #191. ⚠ **THE MECHANISM WAS NOT THE RESYNC — this row was WRONG, not merely stale.** The 45-byte line starting the probe's background job arrives **truncated at \~32 bytes**, leaving bash on a `>` continuation prompt; the job never fires, so the proof read an empty pane and blamed the re-subscription for output **that was never produced.** Separated by reading the pane's own `pty_init` snapshot on an independent connection: on every failing cycle the pane held no marker either and the discontinuity settled `succeeded` — 14 cycles, `shellAlive` aligning with every red. ⚠ **So the resync KAN-381 shipped was working correctly on every run this register spent two days calling a resync failure.** The truncation survives with `writePty` and `CrabCastLink` bypassed, so it is **not Butchr's** — [KAN-452](https://wroosbit.atlassian.net/browse/KAN-452), **not a gate-5 leg, and it outlives this gate.**

**Gate 6 —** `url` and `sessionId` held in memory. **CLOSED 2026-08-12.** KAN-346, merged `12a55d3`. **This is the one that broke the human's terminal.** Closed by **two independent mechanisms** — adoption for `sessionId`, a read of our own durable registry for `url`. **The recurring defect with its sign flipped: not a false claim asserted, but a true one withheld.** And it was never CrabCast-specific: a herdr fleet outliving its daemon reported the same `url: null` and always had.

**Gate 7 — the resume signal is dropped in** `provision()`. [KAN-396](https://wroosbit.atlassian.net/browse/KAN-396). **CLOSED 2026-08-15.**

**AC1 answered NO**, read at served peer `contractVersion: 8`, build `9d4d999cbac6`. **Published contract and wire only.** Three legs, and the third settles it: a dedicated resume-rule section; no resume field in the caller surface; and `resumeCause` is a CLOSED vocabulary — `reboot`, `daemon-restart`, `preempted` — **with no value meaning "the caller asked."** An absent parameter can be an oversight; **a closed enumeration is a decision.**

**⚠ NO IS NOT "EVERY ACTIVATION COLD-STARTS FOREVER."** What is established is that **Butchr cannot ASK** — not that **CrabCast never GRANTS**. Their record governs, so a second activation at a path Butchr has used before may resume with nobody asking, making the cost **one cold start per workspace** rather than a permanent loss. **AC2 then MEASURED exactly that: a second activation at a path CrabCast has run before RESUMES.** Flagged by `epic/KAN-203` against their own finding, and the gate closed on the measurement rather than on the contract read.

**A settable override is not the resolution**, and **probing the wire with an undocumented resume key is refused as a standing answer** — side-effecting, and invariant 10's neighbour.

**Gate 9 —** `.butchr-prompt.md` never written on the CrabCast path. **CLOSED 2026-08-14.** [KAN-400](https://wroosbit.atlassian.net/browse/KAN-400), merged as #173.

The three sites now take the brief's location from **the runtime that delivered it** — `BriefLocation`, a two-arm union. herdr answers with a path, through the same helper its _write_ goes through, so **the file written and the file named are one expression**. CrabCast answers with prose naming the pointer it types, because no path is obtainable: `<dataDir>` is their config knob, the sidecar is keyed by their hash, and `configure_agent` echoes the prompt as a **character count**. **With two arms, _"assume the brief is in the workspace"_ stops being a sentence a call site can say.**

**Proven live with a negative arm** — a real cold-started agent ran **both** wordings: the old found nothing, the new led it to the sidecar. **Nothing in the probe told it where its brief was.**

**⚠ MY TICKET'S PREMISE WAS OVERSTATED and the author corrected it.** I wrote _"every CrabCast agent takes the cold-start path, and that path's first instruction points at a file that is not there."_ **Measured: only** `mcp.ts:125` is reachable under CrabCast today — both resume messages are gated on `resumedConversation`, written in exactly one place `CrabCastRuntime` never reaches. **Two true statements and a "so" that did not connect them.**

**Those two sites are LATENT and go live the moment KAN-396 lands a resume signal.** **So gate 9 was fixed before the trap was armed** — the right order, and not the reason anybody did it. **⚠ Whoever lands KAN-396 switches those messages on for the first time and must VERIFY them, not assume.**

**The gate-9 verdict is** `epic/KAN-39`'s, not its author's — they posted no ruling, and the register says so rather than implying one.

**Gate 10 —** `provision()` drops `resumedExistingConversation`, so after the flip every resumed agent is recorded as already-working and never nudged. **OPENED AND CLOSED 2026-08-14.** [KAN-432](https://wroosbit.atlassian.net/browse/KAN-432), merged as #185.

**The exact incident the nudge exists to prevent, armed by the cutover rather than by a regression.** `provision()` had the field and did not read it; `reconcile.ts` gates both nudge sites on it. **Now read at five sites**, with `ResumedConversation` a three-state union — `restored | fresh | unknown` — **where** `unknown` is an answer rather than a default. `reconcile.ts`'s comment names the incident it descends from: _"precisely how two agents sat idle on the day this ticket was filed until a human retyped their instructions."_

⚠ **This gate did not exist when the list was written.** It was found by `task/KAN-432` while reading the cutover's central file, opened and closed inside one day, and **is the reason a register that only tracks known gates is not enough.**

### ⚠ GATE CANDIDATE, not yet a gate — `pty_input` truncates a typed line

[**KAN-452**](https://wroosbit.atlassian.net/browse/KAN-452), found by `task/KAN-416` 2026-08-15. **A 45-byte line arrives cut at 32–33 bytes — 4 of 17 writes, and 2 of 30 with** `writePty` and `CrabCastLink` bypassed entirely, leaving the shell on a `>` continuation prompt that echoes every later keystroke and executes none; one pane accepted eleven further commands and ran none.

**Gate-shaped because gate 3's row records Butchr depending on** `pty_input` for the SIDEPANEL TERMINAL — the surface a human types into. After the flip, a paste or any long line has a measured chance of silently wedging a person's shell, with no error and a pane that looks healthy. ⚠ **Latent today** — the sidepanel rides herdr's pty while `BUTCHR_AGENT_RUNTIME` is unset; `epic/KAN-39` overstated it as present-tense on #191 and corrected it the same hour. ⚠ **NOT yet listed because the rate is unmodelled: a warm-up condition costs one paste per session, a uniform one costs every long line forever. Those are different gates, and a gate whose severity nobody has bounded is a gate nobody can close.**

## What merged on 2026-08-14, and what it did not buy

**2026-08-14. Seventeen PRs landed. Three gates closed** — 3, 4 and 9. **Two authors explicitly declined to tick their own gate** (KAN-381, KAN-379), and both were right.

**KAN-397 is the one most likely to be misread.** It was never a gate — a defect gate 2's work turned up, which blocked step 8: `confirmAgentPresent` joined the census on the raw `paneName`, so under a flipped daemon **every CrabCast-started** `claude` agent would be reported a failed activation and torn down while it kept running. **Its verdict, adopted rather than paraphrased: _"Only unblocks, and more narrowly than 'unblocks' suggests. It closes nothing."_** And it did **not** prove an extension-driven activation succeeds end to end — **that is step 9's canary and remains unobserved.**

**Step 8's preconditions are still unmet:** ⚠ **gate 2 alone is open** (gates 5 and 7 closed 2026-08-15) **and it cannot close before the flip**, and two preconditions are not code at all — **a named driver who has read the document, and the human's decision in their own words.**

## ⚠ A GREEN GATE IS A CLAIM ABOUT THE REPOSITORY, NOT ABOUT THIS MACHINE

**Recorded 2026-08-15 because it qualifies every row above.** `butchr_staleness_check` at 05:04Z: the shared clone was **7 commits behind** `origin/main`, and the running daemon's newest build input was **two days old**. **Nine PRs merged that night and none of them were executing anywhere.**

**The live cost, that night:** KAN-435's fix for a stale channel self-check verdict was merged and not running, so `story/KAN-117` stayed pinned to the composer — **unreachable over a channel it was holding, for over eight hours, by a defect that had been fixed hours earlier.**

[**KAN-442**](https://wroosbit.atlassian.net/browse/KAN-442) (#192, **live since the deploy**) fixes the **brief** half: templates render from `origin/main` with `git show`, opening no working tree and taking no lock, **so the currency question and the concurrency question stop being the same question**. ⚠ **Its own brief text still applies: _"your brief being current does not make the daemon current."_**

✅ **THE DEPLOY HAPPENED 2026-08-15** — [KAN-461](https://wroosbit.atlassian.net/browse/KAN-461). `daemon/dist` rebuilt at `origin/main` `c5b1d477`, restarted 10:55:37Z; **fourteen commits (#184–#197) went from merged-and-inert to executing**, 8 of 8 agents back inside 3.2s, at a cost [KAN-454](https://wroosbit.atlassian.net/browse/KAN-454) measured. ⚠ **A DEPLOY IS NOT ONE EVENT:** the daemon changed atomically; `mcp.ts` changes only as each agent **RESPAWNS**; the extension needs a human and is still stale. ⚠ **My step said only _rebuild and restart_ — the checkout was 14 commits behind, so it would have built stale source, moved the mtime, satisfied my own acceptance criterion and deployed nothing.** `task/KAN-461` caught it; `butchr_staleness_check` already answered that and nobody ran it — [KAN-463](https://wroosbit.atlassian.net/browse/KAN-463).

## The sequence, which is not a gate and matters more than all of them

[**KAN-378**](https://wroosbit.atlassian.net/browse/KAN-378). The open gates are **work**. The order is not. **Every gate could close tomorrow and a badly ordered flip would still destroy every live conversation on the machine**, because activating under CrabCast starts agents **fresh**. Unsetting the variable restores the runtime; it does not restore conversations.

## The control, and what it corrected

`epic/KAN-203` measured a real daemon restart under **herdr**:

```
daemon MainPID   127201 -> 550667      (a genuine restart)
agents before    epic-kan-39, epic-kan-59, epic-kan-203, task-kan-341
agents after     epic-kan-39, epic-kan-59, epic-kan-203, task-kan-341
```

**A daemon restart drops session records. It does not kill agents.** I had argued the opposite and built a clean-sounding conclusion on it, while being an agent that had survived a restart. **The flip was never catastrophic because of the restart**; it was catastrophic because CrabCast served no sessions afterwards and nothing re-formed them. ⚠ **What this control does NOT establish is the channel half — whether registrations re-establish, and how fast. That is KAN-454.**

## Standing rules for anything under this Story

**The switch stays off by default.** `BUTCHR_AGENT_RUNTIME` is unset and no gate ticket changes that.

**⚠ A MERGED TICKET IS NOT A CLOSED GATE.** Seventeen PRs landed on 2026-08-14 and three gates closed. **Gate 2's two tickets both merged and gate 2 is still open — and cannot close before the flip.** Every row above states what its ticket established and what it did not.

**⚠ NAME THE RESOURCE, NOT THE TICKET THAT HAPPENS TO HOLD IT.** `epic/KAN-203`, against one of my own instructions. A condition written as a PR number expires when that PR merges; one written as the resource stays true as long as the contention does. Their framing, kept verbatim: _**a trigger firing is not the same as its purpose being served, and compressing the second into the first is how a conditional plan does damage while looking like compliance.**_ **And the file form was still too weak** — it measures _open PRs_ while the contention is _work in flight_, so a ticket between staffing and its first push is invisible to it.

**⚠ AND THE SAME AGENT'S SHARPER VERSION, 2026-08-15: A CONDITION YOU CONTROL THE FALSITY OF IS NOT A CONDITION.** _"Not while agents are mid-work"_ was mine, and I made it falser every time I handed the guardian a queue. ⚠ **When two duties conflict and one of them is "wait", re-examine the waiting one before resolving the conflict** — often one side should not exist.

**⚠ ONE** `crabcast-runtime.ts` TICKET IN FLIGHT AT A TIME. Not for merge mechanics: **that file is the cutover's central artifact, four defects have been found in it in two days, and every one was found by somebody reading it carefully.** Two agents editing it at once is how the careful reading stops happening.

**⚠ THE CAPACITY OVERRIDE: disclose it, do not ask permission per-run — and never** `preempt`. `override: true` is permitted for a blocking proof provided it lives in the proof script and **never in** `CrabCastRuntime`; nothing is stood down; and the run says on its ticket that it bypassed, with the figures. **This rule exists because I gave contradictory guidance on two tickets and put the ruling where only one agent would read it. A rule written where one agent will read it is not a rule.**

**⚠** `verify-ci-partition-is-enforced.mjs` IS AUTHORITATIVE ABOUT ROWS AND WAS SILENT ABOUT TOTALS. [KAN-409](https://wroosbit.atlassian.net/browse/KAN-409) closed that gap on 2026-08-14 — the summary block is now checked against the table and against itself. **⚠ AND ON 2026-08-15 IT FIRED ON A REAL TWO-BRANCH COLLISION**: #189 and #190 each added one script from a 123-script base, both correctly wrote 124, the merged tree held 125, and **git merged the file with no conflict**. **Every self-consistency check passed and the document was still wrong** — only the checks comparing it to the **tree** failed. ⚠ **And** [**KAN-451**](https://wroosbit.atlassian.net/browse/KAN-451) **then established the guard cannot tell a hand-edit from a regeneration when the counts match, so a falsified classification rationale passes everything.** Regenerate that file; never hand-merge it.

**⚠ THREE required-set scripts flaked today and two blocked unrelated PRs.** [KAN-418](https://wroosbit.atlassian.net/browse/KAN-418) carries the ruling: **the bundling is not the defect, the flakes are; NO automatic retries** — a job that silently re-runs its failures converts a required check into a suggestion — and the real question is whether two externally-dependent scripts are in the right `ci-partition` class.

**Never read CrabCast's source.** Invariant 10, permanent. **Nor may CrabCast be pressured into a Butchr-shaped interface** — including by probing the wire for undocumented affordances they have deliberately closed. ⚠ **Reporting an observed defect in their PUBLISHED surface is not pressure and is permitted** — KAN-452 is the worked case: the frames, the cut points, the bypass measurement, framed as an observation with no fix demanded and no interface proposed.

**⚠ Reaching a supervisor: comment on its ticket, not** `butchr_send_to_agent`. THIS SURVIVES GATE 3 CLOSING.

**⚠** `daemon.log` GOES UNGREPPABLE — AND THE CAUSE ONCE RECORDED HERE WAS WRONG. It does **not** carry raw pane bytes: **0 ESC, 0 CR, 0 other C0 across 36,271 lines**, measured twice with a positive control. It carries **2,074 NUL bytes** — **ext4 delayed allocation losing an appended tail across an unclean shutdown.** ⚠ **And the silence is ugrep's, not GNU's:** the agent-facing `grep` is bundled **ugrep with** `-I` — nothing on stdout, nothing on stderr, **exit 1**, which reads as _no matches_. GNU warns on **stderr** (discarded by every `$(...)`) and exits **0**. **Use** `grep -a`. [KAN-422](https://wroosbit.atlassian.net/browse/KAN-422) (#193) repairs it **in place** at startup — same-length markers, no rename, so concurrent daemons write identical bytes to identical offsets and byte offsets survive. ⚠ **The false cause began as a code comment, became this Story's ticket premise, and was written here as a fleet rule: a wrong reason attached to a right conclusion travels exactly as far as the conclusion does.**

**⚠ COUNT THE VERDICT, NOT THE WORD.** A proof script prints its own case count; `grep -c 'PASS'` also counts the summary line that says so. `epic/KAN-39` reported 31 and 32 asserted cases on #192 where the truth was 30 and 31, **after writing this exact rule on KAN-451 ninety minutes earlier.** ⚠ **The delta was right and the absolutes were wrong** — and because the new commit added exactly one case, the wrong before-count and the right after-count collided on the same number, so _"nothing landed"_ was the natural misreading. `task/KAN-442` caught it by measuring twice and reporting a disagreement with their approver.

## What is wanted from this Story

1. **Every gate has a ticket.** ✅ Gates 2–5 filed 2026-08-13; gates 7 and 9 filed 2026-08-14; gate 10 filed and closed 2026-08-14. ✅ **Gate 5's leg 2 was the last gate without a ticket; filed as KAN-456 and closed the same day, 2026-08-15.** **⚠ A Task cannot parent to a Story** — both are `hierarchyLevel 0`, and the refusal reads as _"there is no parent to set"_, which orphaned seven tickets on 2026-08-07. `parent` is the epic KAN-39; the Story relationship is a `Blocks` link.
2. **This description is maintained.** A gate that moves is recorded here on the day it moves, by me. ⚠ **AND THE REASON IT GOES STALE IS MECHANICAL, NOT NEGLECT:** Jira replaces a description whole, so moving ONE gate row costs re-emitting all \~24,000 characters through the markdown→ADF converter that [KAN-333](https://wroosbit.atlassian.net/browse/KAN-333) records as **silently dropping content**. **That cost is why it gets deferred, and deferring it is how the tally reaches a human wrong.** The working method, if you must: extract the description to a file, edit it by **verified line anchor** so nothing is retyped, post, then **re-fetch and check every heading survived.**
3. **A gate discovered anywhere is recorded here the same day**, whatever ticket found it.

## The cutover's own status — contested, deliberately unresolved here

Whether the flip is _scheduled_ is in dispute between two accounts: the human's direct answer to `epic/KAN-39` (_prioritise the prep work; the flip is a separate decision not yet made_), and `epic/KAN-203`'s report that the human scheduled it. **Neither is recorded here as fact.** It will be recorded when it comes from the human, verbatim, and not before.

## Provenance

Gates 1–5 are `task/KAN-278`'s findings as recorded in KAN-283's description. Gate 6 is `task/KAN-283`'s, filed by `epic/KAN-203` as KAN-346. The restart control and the gate-3 production quote are `epic/KAN-203`'s, measured rather than recalled. The gate-3 dialog measurement is `task/KAN-375`'s; **the gate-3 structural argument that replaced my sampled one, the** `pty_*` reshape analysis, the allow-list/deny-list amendment and KAN-409 are all `task/KAN-393`'s. Gate 5's unexercised legs and the `error`-handler defect are `task/KAN-381`'s, disclosed unprompted; **its leg-2 closure, the two-links-disagree finding and the correction of this register's own AF_UNIX reasoning are** `task/KAN-456`'s; KAN-416's rate is `task/KAN-408`'s, **and its mechanism — the** `pty_input` truncation — is `task/KAN-416`'s. Gates 7 and 9 are `task/KAN-379`'s findings. Gate 7's AC1 answer is `epic/KAN-203`'s contract read, **with its limit flagged by them against their own result.** Gate 9's premise correction and gate 2's uncovered live leg are their tickets' authors', **both disclosed against their own work.** Gate 2's ruling is `task/KAN-417`'s and gate 10 is `task/KAN-432`'s. **The critique of the deploy condition is** `epic/KAN-203`'s, made against a standing rule of mine. The gate-2, gate-5 and KAN-397 verdicts are their own close-outs, quoted rather than summarised; **the gate-9 verdict is** `epic/KAN-39`'s own inference and is labelled as such, **while gate 5's is** `task/KAN-456`'s, quoted. The observation that gates 2–5 had no tickets is mine, found by accident, and reported with the caveat that the search was over summaries only — **found nothing in range, not there is nothing.**
<!-- ARCHIVE-VERBATIM-END -->
