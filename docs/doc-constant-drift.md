<!-- constant-pin-exempt: CRABCAST_CONTRACT_VERSION — this page describes the pinning
     mechanism and names the constant throughout; it states no value for it, so there is
     nothing here that can drift. The pinned sentences are in docs/crabcast-runtime.md. -->
<!-- constant-pin-exempt: CRABCAST_PIN — same: named as an example of what is guarded,
     never quoted as a value. Its pinned sentence is in docs/crabcast-runtime.md. -->

# Documents, constants, and the two ways they come apart

**KAN-347.** Two failures, related by one relationship — a document and the code
that should keep it honest. Part 1 lets a document go stale. **Part 2 enforces
staleness, and reports success while doing it.**

This page is the scope statement for the part 1 guard and the written result of
the part 2 audit. Both are **dated statements about this tree on 2026-08-12**,
not standing guarantees.

---

## Part 1 — the drift, and what now guards it

### What happened

`docs/crabcast-runtime.md` recorded the CrabCast read-path contract version as
`3`. KAN-324 moved `CRABCAST_CONTRACT_VERSION` to `4` in order to consume
`unreadableRecordsTotal`, and did not move the prose. `daemon-typecheck`,
`verify-script-sweep`, `ci-partition` and `operative-rule-carriage` were green
throughout. It was caught by a person — `task/KAN-283`, mid-PR, going to read
the constant instead of quoting the sentence — and by then the stale `3` had
been relayed to `epic/KAN-59` as a statement about what Butchr consumes.

**A second instance of the same bump was still in the tree when this ticket
started.** `docs/crabcast-runtime.md`'s *What the contract does not hold*
section opened `contractVersion: 3`. KAN-283's hand-correction fixed the version
row at the top of the page and not this one. That is not carelessness; it is the
ordinary reach of a hand-correction, and it is the whole argument for a
mechanism. Corrected here, and pinned.

### The mechanism

Offered in prose by `epic/KAN-59`, who tested KAN-347's generalisation against
their own tree rather than agreeing with it and reported it **false** for their
read-path contract:

> `verify-read-contract.mjs` requires the document's version row to carry a
> **digest of the canonical declaration** — so a bumped constant with unbumped
> prose goes red.

**No CrabCast source was read to build ours.** Invariant 10 is permanent; the
sentence above is the whole of what was taken, and it is fully specifying.

A pinned sentence carries an HTML comment — invisible in the rendered page:

```
<!-- constant-pin: CRABCAST_CONTRACT_VERSION
     src: daemon/src/crabcast-link.ts
     sha256: 7a7595869bf0
     says: **CrabCast read-path contract version:** **`4`** -->
```

`daemon/scripts/verify-doc-constant-pins.mjs` runs on every pull request inside
`verify-runnable-set`. It has three legs that close on each other, because any
one alone leaves a single-file edit that defeats it:

| leg | what it asserts | what it catches |
| --- | --- | --- |
| §2 digest | the declaration hashes to what the pin claims | **constant moves, prose does not** — the measured case |
| §3 says-present | the pin's `says:` appears verbatim in the page | prose rewritten away from the pin |
| §4 says-honest | the declaration's literal value appears inside that `says:` | **the digest refreshed without correcting the sentence** |

§4 is the one that is easy to leave out and is the reason the other two are
worth having. Without it, the cheapest way to make a red go away is to paste in
a fresh digest, which restores the green and leaves the document exactly as
wrong as it was.

### The two directions are not symmetric, and one of them is legitimate

| what you change | result | is that right? |
| --- | --- | --- |
| constant, not the prose | **RED** (§2, and §4 once the value diverges) | Yes. This is KAN-324. |
| the prose's *value*, not the constant | **RED** (§3, or §4 if the marker moved too) | Yes. The document is now claiming something the code does not say. |
| the prose *around* the value, keeping the value | **GREEN** | Yes, deliberately. Rewording, reflowing and re-explaining are ordinary editing, and a guard that fired on them would be turned off within a week. |
| the declaration's formatting or its docblock | **GREEN** | Yes. The digest is over the whitespace-normalised declaration statement only, so a reflow is not a change and a retyping is. |

So the guard is **one-way about prose and two-way about the value**. It has no
opinion on whether the sentence is *right* — only on whether it quotes the
number the code actually holds.

### THE SCOPE, STATED BECAUSE A GUARD THAT READS WIDER THAN IT IS, IS THE DEFECT IT WAS BUILT TO PREVENT

**Covered:** exactly the constants in `GUARDED` in
`verify-doc-constant-pins.mjs` — today `CRABCAST_CONTRACT_VERSION` and
`CRABCAST_PIN` — at the sentences their pins quote, in `docs/*.md`.

**Not covered, and each of these is a real gap rather than a hedge:**

- **Every constant not in `GUARDED`.** There is no discovery. A new constant
  described in prose is unguarded until somebody adds a row and a pin.
- **`prompts/*.md`, `README.md`, source docblocks, Confluence, Jira.** `docs/`
  only. The known live instance outside that boundary is the guardian-poke
  cadence — see part 2 finding **F-1**, which is why it is not simply pinned.
- **Abbreviations and prefixes.** The coverage leg finds a mention by the
  constant's *name* or its *full* literal value. This same page says
  "`CRABCAST_PIN` still reads `8d7348f`" — a seven-character prefix — and
  nothing reads that as a claim about the value.
- **Unpinned sentences inside a pinned file.** The coverage leg is file-level:
  it requires a file mentioning a guarded constant to carry a pin for it, never
  that every mention is itself pinned.
- **Whether the prose is right.** A sentence quoting the correct number and
  describing it wrongly passes every leg.

**Two things a page can do other than pin.** A page may declare
`<!-- constant-pin-exempt: NAME — reason -->` when it names a constant without
quoting its value; a reason is required, and the two exemptions in this file are
the worked examples. And **a marker inside a fenced code block does not count**
— the illustration three headings up is not a pin. That rule is KAN-321's,
borrowed intact: `task/KAN-317` asked for an approval on #139 by pasting the
exact marker inside a fence and `approval-recorded` went green describing an
approval nobody had given. The same thing happened to this script on its first
run against this very page, which is how the rule got here.

**Does it generalise?** The *mechanism* does — a pin is three lines and works on
any `export const` in any `docs/` page. The *coverage* does not generalise by
itself and never will: `GUARDED` is a hand-maintained list, and that is a
deliberate choice rather than a shortcut. Deriving the set from the pins present
would mean deleting a document's last pin also deletes the assertion that would
have noticed it was deleted — the failure `rule-inventory.md` exists to prevent,
which is why this uses the same two-file shape.

`CRABCAST_PIN` was the obvious second pair and is done. The third candidate is
**not** a doc/constant pair at all but a prompt/constant pair, and it is F-1
below.

---

## Part 2 — the audit: does a check here assert a document keeps saying something that has stopped being true?

### The shape being looked for

`epic/KAN-59`'s KAN-345, in their words:

> `docs/supervision.md` says reboot survival is *"Predicted, not observed… the
> unit firing at boot has not been fired."* **It fired at 03:53:22 this
> morning.** And `verify-daemon-foreground.mjs:534` **asserts the document keeps
> saying "predicted"** — so correcting the page to match reality **turns our CI
> red.**

A guard written to stop an honest caveat hardening into a guarantee defends the
caveat past its expiry, with a green check. The contributor who corrects the
document is told they broke the build, and the cheapest way out is to revert the
correction.

**The dangerous kind** asserts a document states a *contingent fact about the
world* — "not yet observed", "nobody has measured", "every 30 minutes". **The
safe kind** asserts a document has a *structural property* — names a required
section, carries a heading, matches a generated file.

### What was searched, and how

Everything below is reproducible from the repository root.

1. **Every `verify-*.mjs` under `daemon/scripts` and `extension/scripts`** —
   137 scripts — filtered to those that read Markdown or treat a file as prose:

   ```bash
   for f in daemon/scripts/verify-*.mjs extension/scripts/verify-*.mjs; do
     grep -l "readFileSync.*\.md\|'docs'\|'prompts'\|README" "$f"; done
   ```

   17 hit. Each was opened and classified.

2. **Every CI job in `.github/workflows/ci.yml`**, six of them, traced to the
   script it runs.

3. **Caveat vocabulary across every script**, on the assumption that the
   dangerous assertion quotes the caveat's own words:

   ```bash
   grep -rniE "includes\(.{0,4}(not yet|predicted|unobserved|never been|has not|untested|unmeasured|no evidence|not observed)|match\(/[^/]*(not yet|predicted|untested|unmeasured|has not been|never fired)" daemon/scripts/*.mjs extension/scripts/*.mjs
   ```

   One hit, `verify-channel-selfcheck.mjs:369`, and it is a false positive: it
   asserts a *runtime* report names two versions, over a synthetic fixture
   version `9.9.999`. No document involved.

4. **Every asserted regex in `verify-operative-rules-are-carried.mjs`** — the
   largest document-content assertion in the tree, 213 patterns over
   `prompts/task.md`, `prompts/story.md` and `prompts/epic.md`, behind the
   **required** `operative-rule-carriage` check — extracted and read one by one:

   ```bash
   grep -oE "/[^/\n]{6,140}/i?m?" daemon/scripts/verify-operative-rules-are-carried.mjs | sort -u
   ```

**What this did not search:** Confluence pages, Jira descriptions, the extension
build, and any assertion expressed as something other than a regex or an
`includes()` over file text. **Read the result as "none found in range", never
as "none exist."**

### Result: two found. Not "none."

#### F-1 — `operative-rule-carriage` pins the guardian-poke cadence to a number

**This is both failures at once, on a required check, and nothing discloses it.**

- `daemon/src/guardian.ts:193` — `export const DEFAULT_POKE_INTERVAL_MS = 30 * 60 * 1000;`
- `prompts/task.md:213`, `prompts/story.md:610`, `prompts/epic.md:1047` — *"the
  daemon pokes you every 30 minutes"*
- `verify-operative-rules-are-carried.mjs`, entry **H-19**, asserts
  `/pokes you every 30 minutes/i` against **all three prompts**.

Change the cadence and:

1. **Part 1 fires.** Three prompt files say 30; nothing notices. Every agent in
   the fleet is briefed with a false number about a message it will receive.
2. **Part 2 fires, and it is the worse half.** Correct the three prompts to
   match the new cadence and `operative-rule-carriage` — **required** — goes
   **red**. The contributor is told they broke the build for fixing a lie, and
   the cheapest way out is to put the lie back.

**It is already slightly over-claiming today.** The interval is operator
overridable (`config.intervalMs`, clamped between `MIN_POKE_INTERVAL_MS` and
`MAX_POKE_INTERVAL_MS`), so "every 30 minutes" is true of the default and of
nothing else. A fleet running a custom interval is briefed wrongly right now.

**Is it this ticket?** **No, and deliberately.** Three reasons:

- The caveat has **not expired**. The constant does read 30 minutes today, so
  there is no correction to make and nothing is currently red or currently
  false-for-the-default. This is latent, not live.
- The fix is a **judgement about wording**, which AC 4 anticipates. The right
  repair is almost certainly to make H-19 assert the *rule* rather than the
  *value* — `/pokes you every \d+ minutes/i`, or better, a pattern about the
  poke being expected and scheduled at all — and then to pin the number
  separately. That is a change to a required check's inventory and to three
  prompts, and it wants its own red drive.
- **Pinning it with part 1's guard would not help and might hurt.** Two checks
  would then assert the same sentence, one demanding it track the constant and
  one demanding it read "30". Moving the constant would produce two
  contradictory required reds with no edit that satisfies both. Loud beats
  silent, but a designed deadlock is not the deliverable.

**Filed as KAN-351**, linked `Relates` to KAN-347.

**The general lesson, which is bigger than the instance:** a document-content
assertion should pin **what must be said**, not **the current value of what is
said**. Every one of H-19's other four patterns does exactly that.

##### Resolved by KAN-351, 2026-08-12 — the pair was deleted, not guarded

Everything above stands as written; this is what happened to it. The audit is
dated and stays that way, so read the finding as the state on 2026-08-12 and
this note as its outcome.

**Part 2 was reproduced first, on `6fc28d9`**, because a defect argued from
inspection is a claim and not an observation: move `DEFAULT_POKE_INTERVAL_MS`
to 45 minutes, correct all three prompts to say 45, and
`verify-operative-rules-are-carried.mjs` exits 1 with three reds — one per
prompt, each `no match for /pokes you every 30 minutes/i`. The required check
punishing the correction is not a prediction. The run is in KAN-351's PR body.

**The decision — should the prompts name an interval at all? No.** Not a looser
pattern, and not a pin. Three reasons, in the order they decided it:

1. **An agent cannot use the number.** The poke is *"neither settable nor
   inspectable by you"*, by that section's own words. Nothing an agent does
   with the brief changes if the cadence is 30 minutes or 45 — it finishes what
   it is doing and sweeps. A number that no reader acts on is carrying risk for
   no work.
2. **It is not true, and was not true before the constant moved.**
   `config.intervalMs` is operator-settable and clamped between
   `MIN_POKE_INTERVAL_MS` and `MAX_POKE_INTERVAL_MS`, so *"every 30 minutes"*
   described the default and every fleet that overrode it was briefed wrongly —
   the over-claim named above, live rather than latent. `butchr_guardian`
   reports the real interval, so the reader who does need it has a route that
   is right by construction.
3. **`/pokes you every \d+ minutes/i` fixes the wrong half.** It unblocks the
   correction — part 2 — and leaves part 1 exactly where it was: a prompt
   reading 45 while the constant reads 30 satisfies it perfectly. It buys the
   lesser of the two failures and keeps a sentence nobody needs.

**So H-19 now asserts the invariant that survives any cadence:**
`/the daemon pokes you on a schedule/i` — expected, scheduled, daemon-sent —
and `/interval is an operator setting/i`, which is the honest replacement for
the number rather than a softer version of it. Five patterns, none pinning a
value.

**What that leaves uncovered, stated because deleting a pair is quieter than
guarding one.** Nothing now connects `DEFAULT_POKE_INTERVAL_MS` to any prompt,
which is correct — there is no claim left to keep true. It is *not* a general
solution for `prompts/`: this script's scope is unchanged, `prompts/` remains
outside it, and the next constant somebody quotes in a prompt is unguarded
exactly as this one was. The reason to prefer deletion here is that the
sentence was not earning its place; where a prompt genuinely must quote a
value, that is a pin's job and this note is not a precedent against one.

**Not touched, and deliberately:** the docblocks in `daemon/src/guardian.ts` and
`daemon/src/daemon.ts` that say *"thirty minutes"*, and `mcp.ts`'s *"defaults to
30 minutes"* in the `butchr_guardian` tool description. They sit beside the
declaration or describe the default as a default, and none is asserted by a
required check, so neither half of the F-1 shape applies to them. `mcp.ts` is
the closest call of the three — it is read by agents, not by contributors — and
it survives because it says *defaults to*, which stays true when the operator
overrides it.

#### F-2 — H-13 pins the "what nobody has measured" list, and says so itself

`verify-operative-rules-are-carried.mjs`, entry **H-13**, asserts against all
three prompts:

- `/one event in one window, not a storm/i`
- `/An interrupted `Edit`/`
- `/An in-flight MCP call/`
- `/Whether a disturbed agent recovers/`

Those pin KAN-219's *"What nobody has measured"* section. **Measure any of the
three and correcting the prompt turns `operative-rule-carriage` red.** It is the
KAN-345 shape exactly.

**It is disclosed in the entry's own comment**, lines 621–627:

> WHAT THIS ENTRY CANNOT CHECK, AND IT IS NOT THE USUAL CAVEAT: it holds the
> sentence *"nobody has measured a burst"* in place, and it has no way to know
> whether that is still true. **If a burst is ever measured, a green run here is
> evidence that the disclaimer is present, never that it is honest** — and the
> pattern would then be actively demanding a sentence that has become false.
> Whoever runs that measurement updates this entry in the same PR; nothing
> mechanical will remind them.

**Is it this ticket?** **No.** It is correctly identified, correctly reasoned
about, and its author chose it knowingly: the section it defends is *itself*
about not over-claiming, and a looser pattern would not defend it. The residual
risk is real but it is **named where the next editor of that entry will meet
it**, which is the standard this ticket is asking for everywhere else. Recorded
here so the audit is complete, and so that the disclosure is discoverable from
somewhere other than line 621 of a 1,767-line script.

### Everything else enumerated, and why each is the safe kind

| script / check | asserts about a document | verdict |
| --- | --- | --- |
| `verify-operative-rules-are-carried` (`operative-rule-carriage`, **required**) | 213 patterns over the three prompts | **Safe except F-1 and F-2.** The rest pin standing instructions — "Approval is a precondition, not an ordering", "the parent is the epic — never the story" — which are rules, not observations. A rule stops being asserted when it is retired, and the `RETIRED` list is the mechanism for that. |
| `sweep-verify-exit-paths` (`verify-script-sweep`, **required**) | every `verify-*` header contains `WHAT FAILURE THIS WOULD CATCH:` | **Safe.** Structural: it requires a section to exist, never that it says a particular thing. The ticket's own example of the harmless kind. |
| `verify-ci-partition-is-enforced` (`ci-partition`, **required**) | `ci-partition.md` agrees with the `CI-RUNNABLE:` headers and with `ci.yml` | **Safe, and the precedent part 1 copies.** It asserts a *derived* file matches its source, so it cannot outlive a truth — when the source moves, the file is regenerated. Same relationship a digest has to a declaration. |
| `verify-rule-inventory-catches-dropped-entry` | that the inventory/sweep disagreement is detected | **Safe.** Its subject is the mechanism, and it writes its own fixtures. |
| `verify-agent-resumption` | a generated prompt contains `NO memory`, `KAN-21`, `not restart the task`, and the brief path its fixture location carries | **Safe.** Instructions to the agent, not observations about the world. The brief path stopped being a literal at KAN-400: the builders take a `BriefLocation` from the runtime, so the assertion is now that the *rendered* message carries the location it was handed — and, on the runtime-owned arm, that it carries no `.butchr-prompt.md` at all. |
| `verify-prompt-poller-seam` | which prompts carry which notification-topology rules | **Safe.** Standing rules. |
| `verify-prompt-provenance-stamp` | the `{{ PROMPT_PROVENANCE }}` substitution | **Safe.** Structural. |
| `verify-prompt-write-refusal` | the refusal names `.butchr-prompt.md` | **Safe.** Asserts behaviour, quotes a path. |
| `verify-approval-recorded` | frozen PR-comment fixtures under `fixtures/kan-321/` | **Safe.** Fixtures are historical records; they are *supposed* to be frozen. |
| `verify-agent-preemption` | reads `prompts/epic.md` | **Safe.** Reads it as input to a spawn, asserts nothing about its text. |
| `verify-channel-meta-renderable`, `verify-agent-runtime-seam`, `verify-tail-async-awaited`, `verify-integration-pluggability`, `verify-jira-nudge-coalescing`, `verify-parentage-in-list-agents`, `verify-atlassian-proxy-read-surface`, `verify-workspace-deps-are-shared`, `verify-pr-watch`, `verify-workspace-reclaim` | read `daemon/src/*.ts` or workspace files as text | **Safe.** Their subject is source, not prose. |
| `daemon-typecheck`, `extension-build` | nothing textual | **Safe.** |

### Is *this ticket's own guard* part-2-shaped?

It has to be asked, because a guard that asserts a document says something is
the shape under audit, and building one to fix part 1 while walking into part 2
would be the joke writing itself.

**It is the shape and it cannot expire, and §4 is why.** The pin does not assert
that the page says a *particular* thing; it asserts the page says what the
**code currently holds**. There is no state of the world in which the pinned
sentence becomes false while the check stays green — if the constant moves, §2
goes red and the *only* repair is to correct the prose. §4 exists precisely to
remove the other repair. The check therefore cannot outlive the truth of what it
pins, because it does not pin a truth: it pins an agreement.

The residual is `GUARDED` and this page — both hand-maintained, both dated. If
`CRABCAST_PIN` is retired, this page and that list are stale until somebody
edits them, and nothing mechanical will say so. That is the honest edge of it.

---

## Filed from this work

- **KAN-351** — H-19 pins the guardian-poke cadence to a literal `30 minutes`
  that a constant owns. `Relates` to KAN-347. **Done 2026-08-12**: resolved by
  deleting the pair rather than guarding it — the prompts no longer name an
  interval and H-19 asserts the rule instead of the value. See *Resolved by
  KAN-351* under F-1.
