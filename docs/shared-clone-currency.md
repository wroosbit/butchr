# Who keeps the shared clone current — and why the answer is "nobody"

`docs/prompt-staleness.md` (KAN-242) made a stale brief *checkable*: every brief
carries the commit it was rendered from and two commands that answer *has this
rule moved?* It closed with a sentence naming what it had not fixed:

> **the daemon's own checkout can be behind `origin/main`**, so a brief rendered
> one second ago can still carry a superseded rule.

This is that. KAN-442.

---

## The defect

`~/code/wroosbit/butchr` is a **shared clone**. Every task agent fetches it and
creates a worktree in it; the daemon runs from it; and `PromptLoader` read
`prompts/*.md` out of its **working tree** at every activation.

Nothing advances that working tree, and this is not an oversight.
`prompts/task.md` says, correctly:

> Do **not** run `checkout` or `pull` in the shared clone — other agents may be
> using it concurrently; `fetch` is all you need.

So every agent fetches, `origin/main` advances, and `main` never moves — because
moving it is exactly what the rule forbids. The working tree drifts **by
design**, one commit per merge, monotonically, and nothing ever reduces it.

### Measured, not predicted

| moment | shared clone's `main` |
| --- | --- |
| last advanced before KAN-437 | 2026-08-13 10:24 |
| when KAN-437 repaired it, 2026-08-14 | **22 commits behind**, `prompts/task.md` +96 lines out of date |
| ~1 hour after the repair | `[behind 1]` |
| ~6 hours after the repair | `[behind 7]` |

At `[behind 7]` the working tree served a 665-line `prompts/task.md` while
`origin/main` held 699. Every agent activated in that window was briefed on
governance that had moved — including the agent that fixed this, whose own brief
was a specimen.

---

## The decision

**Nobody advances the shared clone's working tree, and nothing needs to.** The
working tree was never the right source.

Git reads a file at a ref without touching the working tree at all:

```bash
git show origin/main:prompts/task.md
```

That read takes no index lock, writes nothing, and cannot change a file under a
concurrent reader. **So the hazard that made `pull` unsafe does not arise,
rather than being mitigated** — the currency question and the concurrency
question stop being the same question, which is what made every candidate in the
ticket a trade-off and this one not.

### What was on the table

| candidate | verdict |
| --- | --- |
| **`git show` at `origin/main`** (this) | **Adopted.** No working-tree write exists to be unsafe. |
| the daemon `pull --ff-only` on a timer | **Rejected.** Moves files under readers; demonstrated to do so, below. |
| the board reconciler pulls before activating | **Rejected.** Same hazard, plus a network round trip on the path an agent waits on. |
| `pull` at activation, guarded against concurrent use | **Rejected.** The guard is the hard part and it fails open: an agent that is *reading* takes no lock to detect. |
| no automation, the banner is the mechanism | **Rejected, though AC1 permitted it.** The banner already existed and the drift still reached every brief. A checkable defect is better than a silent one and worse than an absent one. |

### Who owns what, concretely

| thing | owner | how |
| --- | --- | --- |
| the ref briefs are rendered from | **the daemon** — `PromptSourceKeeper` | `git fetch` every `FETCH_INTERVAL_MS`, never on the activation path |
| the bytes of a brief | `PromptLoader` | `git show <sha>:<path>`, falling back to the working tree and saying so |
| the working tree's `main` | **nobody, deliberately** | it stays behind forever; nothing reads it for prompts any more |
| noticing this regress | `butchr_staleness_check` | the `prompt-source` item |

**The daemon is the owner because it is the only long-lived process here.** The
board reconciler runs at activation — too late, and on a path an agent waits on.
A human is not a mechanism.

**`fetch` is the only write this design permits**, and it is safe for a reason
worth stating rather than assuming: it moves `refs/remotes/origin/*` and adds
objects, and touches neither the working tree, the index, nor `HEAD`. Every task
agent already runs it in this clone concurrently because the existing rule tells
them to, so the daemon joins an operation the repository already sustains.

---

## What this deliberately does **not** do

- **It does not make the shared clone current.** `git status` there will go on
  saying `[behind N]` forever. What changed is that the number stops reaching
  the briefs.
- **It does not deploy anything.** Out of scope on the ticket and on
  `epic/KAN-39`'s standing decision. The daemon still runs the build it was
  started from.
- **It does not reach a briefed agent.** Nothing on this machine can — that is
  KAN-242's finding and it is permanent.

### The honest cost, stated because a trade nobody can see is a defect

Briefing from `origin/main` while the daemon runs an older build means **a brief
can describe a mechanism this install has not got**. That gap is real and it is
reported rather than left to be discovered: `describeBuildGap` puts a line in
the provenance block when `origin/main` is ahead of the running checkout's
`HEAD`, saying which half is current and which is not.

The trade is deliberate. Governance — who approves you, what you may merge — is
the load-bearing half of a brief, and a stale approver rule has cost this board
measured hours (KAN-234, 2h28m). A mechanism described slightly early has cost
it nothing, and the prompts already teach agents to verify a mechanism against
the world rather than against a sentence.

---

## What is proved, and by what

`daemon/scripts/verify-prompt-source-is-fetched-ref.mjs` — 30 cases, CI-runnable.

| claim | section |
| --- | --- |
| the render reads the ref, not the working tree, when they differ | §2 |
| the stamp names the **ref's** commit for that path, so the embedded check answers "current" | §3 |
| **AC2** — a concurrent reader sees the working tree never move across 40 renders | §4a |
| **AC2 control** — the same reader watching `pull --ff-only` sees it move | §4b |
| a render succeeds while another process holds `index.lock`; a `pull` against it fails | §4c |
| the fallback renders and discloses itself rather than claiming the ref | §5 |
| **AC3** — the `prompt-source` staleness item goes red on that fallback | §6 |

### The control is the point

§4b is what makes §4a mean anything. It runs the **same reader process** against
the option this design rejected, and the reader watches the file change
underneath it. On one run it observed a third state: `ERROR:ENOENT` — **a reader
that got no file at all** while the fast-forward was in flight. That is the
hazard `prompts/task.md` cites, reproduced rather than repeated.

It is also why §4b asserts `> 1` distinct state and not `== 2`. The `== 2` form
was written first and driven red: a fast-forward is not atomic from a reader's
point of view, so the count varies run to run. A flaky control is worse than
none — it teaches the next reader to re-run until green.

### What none of it covers

- **That the daemon's `repoRoot` really is the shared clone.** No fixture can
  say so; `daemon.ts` resolves it as `path.resolve(__dirname, '../../')`.
  Covered by an observation of the running system pasted into the PR.
- **That a real activation produces a brief carrying a ref-sourced block.** The
  script never activates anything. Covered by a `grep` of a live workspace's
  `.butchr-prompt.md`, by hand, as KAN-242 covered the same edge.
- **Whether an already-briefed agent re-reads anything.** Covered by nobody,
  permanently. See `docs/prompt-staleness.md`.
