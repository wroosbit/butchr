# Does a message arriving mid-tool-call disturb that call?

**Finding for KAN-219 — the destructive question KAN-217 made reachable and did
not answer.** Repository read at `51e8fc2`. Probe run 2026-08-08, Claude Code
**`2.1.226`**, model `sonnet`, on a real Butchr agent under a herdr pane.

---

## The answer, plainly

Two carriers, the same in-flight window, the same agent, the same work, and the
same sentence delivered. They do not behave the same way.

> **A Claude Code channel event arriving mid-tool-call does NOT disturb that
> call.** The tool call ran to completion, its result reached the model intact,
> and the event was acted on afterwards — at the turn boundary, not through it.
>
> **`butchr_send_to_agent` arriving in the same window DOES.** The tool call was
> killed partway through, its side effects were left on the filesystem, its
> result never reached the model, and **the model then reported a refusal nobody
> had made.**

That second sentence is KAN-150's fourth defect — *"an interrupt leaving a tool
call half-applied while reporting total rejection"* — reproduced and, for the
first time, **measured rather than inferred**. It has never been testable
before, because until KAN-217 there was no non-destructive delivery mechanism to
compare against. There is now.

**The window was widened and this document says so.** The tool call is genuine —
the product's own Bash tool, started by the model's own decision, with real side
effects — but its duration is the probe's: it runs a script that sleeps between
steps. A real `butchr` MCP call answers in ~20ms, and KAN-167 hit the same wall.
What the widening buys is the thing a 20ms window cannot give: **certainty that
the event landed inside it**, measured rather than assumed. See
[the window](#the-window-observed-not-assumed).

---

## One condition of this ticket had already lapsed when it was picked up

KAN-219's premise is that the question "is testable now" because KAN-217
established delivery. KAN-217 states its finding is *"a fact about
`notifications/claude/channel` on client `2.1.224`, and about nothing else"*,
and the reference warns the flag syntax and protocol contract may move during
the research preview.

**This machine is on `2.1.226`.** So the premise was unverified at today's
client rather than established, and this run had to re-establish it as a
by-product. It did:

| KAN-217 observation | At `2.1.226` |
| --- | --- |
| `--dangerously-load-development-channels` raises a blocking dialog **twice** for the shipped `--continue \|\| claude …` command | **Still true.** Two dialogs raised and dismissed, on all four runs. |
| The startup notice *"Channels (experimental) … inject directly in this session"* appears | **Still true.** |
| A real daemon broadcast reaches the model as a channel event, echoed back over the channel's own `reply` tool | **Still true.** |

**What was NOT re-run**, and therefore remains a statement about `2.1.224`
alone: print mode (configuration A), the negative control (N), and the failure
path (F). Those are `probe-channel-delivery.mjs`'s and were not re-executed
here.

---

## What was measured, and how it avoids asking the model

The ticket's second acceptance criterion is that the tool call's outcome be
recorded **independently of the model's own account of it**. So the in-flight
work writes its own lifecycle to disk as it goes, with no model, no MCP server,
and no pane in the path:

```
step-1 <ms>            written immediately  — the call really started
(sleep)
step-2 <ms>            written halfway      — the call survived the fire
(sleep)
step-3 <ms> <TOKEN>    written at the end   — the call ran to completion
token file             the same TOKEN, minted from /dev/urandom AT STEP 3
```

Three things follow, and each answers one clause of the ticket's *"did it
complete, did it return, was its result correct"*:

- **Half-application is literal.** Steps 1..k with k < 3 on disk is a tool call
  that did part of its work and stopped. Nothing has to be inferred from prose.
- **The result token cannot be obtained any other way.** It does not exist until
  the final step; it is not in the script, not in the brief, not in any message
  the probe types. **A model can only produce it by having received the tool
  result.**
- **Even that reading does not scrape a pane.** The model sends the token back
  through the channel's `reply` tool, which the channel server logs with its own
  timestamp.

The model's account is recorded too — **second, and never as a primary
reading**, because the whole point of arm X is that the two disagree.

### The window, observed not assumed

Nothing is fired until the work itself has stamped that it began:

1. the probe sends the run instruction and then **waits for `step-1` to appear**;
2. it fires a fixed lead (4s) after that stamp;
3. `step-2`'s stamp brackets the event on the other side.

So the finding can say **which sleep the event landed in**, not "during,
probably". Every fire in every run landed in the **first** sleep, ~4.2-4.4s
into a ~28s window.

### The three arms

| | | |
| --- | --- | --- |
| **U** | **Undisturbed** | Nothing fired. The baseline. Without it, *"the channel did not disturb the call"* is unfalsifiable. |
| **C** | **Channel** | A real daemon broadcast becomes a channel event inside the window. **The question.** |
| **X** | **Composer** | `send_to_agent` — the daemon action `butchr_send_to_agent` invokes — fired into the same window. **The comparison, which is the point.** |

**X is also the positive control on the instrument**, and that is the
load-bearing part of the design. If the probe cannot see the composer path
disturb a tool call — behaviour the product documents in its own source at
`daemon/src/herdr.ts:1335` — then its silence about the channel path is worth
nothing, and a clean, plausible, entirely wrong *"channels are safe"* is exactly
what would ship. A run where X shows no disturbance therefore **exits 1** and
names both readings: either the probe is blind, or composer sends have stopped
being destructive, and the second would demolish the premise of migrating.

**Both carriers deliver the same sentence.** The channel server composes
`[Butchr] agent_reset_event for task/<key> :: echo the token <T> back to me by
calling the butchrprobe reply tool now…` from the daemon broadcast; arm X sends
that same sentence down the composer. Only the carrier and the token differ.

Arms run **U, C, X against one agent** — destructive last, so it cannot
contaminate what precedes it. The confound that leaves is real and is stated in
[what this does not cover](#what-this-does-not-cover).

---

## The comparison

**Run 4** — the run produced by the code in this PR, two rounds per arm. Runs
1–3 reached the same headline answer with detectors that were wrong in ways
[recorded in full below](#the-probe-caught-itself-over-claiming-five-times).

| | U1 | U2 | C1 | C2 | X1 | X2 |
| --- | --- | --- | --- | --- | --- | --- |
| fired inside the window | n/a | n/a | **YES** | **YES** | **YES** | **YES** |
| steps completed, on disk | 3/3 | 3/3 | **3/3** | **3/3** | **1/3** | **1/3** |
| ran to completion | YES | YES | **YES** | **YES** | **NO** | **NO** |
| result reached the model | YES | YES | **YES** | **YES** | **NO** | **NO** |
| the message itself reached the model | n/a | n/a | YES | YES | YES | YES |
| **the tool call was disturbed** | NO | NO | **NO** | **NO** | **YES** | **YES** |

Verbatim from the run (`--rounds=2`, exit 0):

```
--- the controls, which is what decides whether any of this can be read ---
  U undisturbed ran clean every round      : YES
  X composer fired inside the window       : YES
  X composer DISTURBED the call            : YES

--- the question ---
  DOES A CHANNEL EVENT ARRIVING MID-TOOL-CALL DISTURB THAT CALL?  NO
    every arm-C fire landed inside a genuine in-flight window : YES
    the tool call ran to completion in every arm-C round      : YES
    its result still reached the model                        : YES
    the event itself reached the model                        : YES
    it was acted on before the tool call ended                : NO
      (NO here is the documented behaviour: events queue and are
       delivered at the turn boundary. Measured, not quoted.)

  AND THE COMPARISON, which is the point:
    composer path — tool call ran to completion  : NO
    composer path — half-applied on disk         : YES
    composer path — result reached the model     : NO
    composer path — model reported a rejection   : YES
    composer path — reported a rejection while 1/3 of the work HAD run:
      that is KAN-150 defect 4 — a tool call left half-applied while the
      recipient reports total rejection, and it is measured here rather
      than inferred, because the steps are on disk and the claim is on the pane.

TRUSTWORTHY: every arm that ran (U, C, X) reached a verdict and both controls behaved.
```

**The `says-interrupted` column of the raw table is ADVISORY and reads YES for
the channel rounds.** That is the keyword flag tripping on the model's own
sentence *"The reset event did not interrupt or abort the Bash command"* — see
[the conclusion drawn from defects 3, 4 and 5](#and-the-conclusion-drawn-from-defects-3-4-and-5).
It is used in no verdict and no exit code.

**Six rounds, four runs, one answer.** The two carriers separate on every
measurement that is taken off a filesystem rather than a terminal:

- the **channel** rounds are indistinguishable from the undisturbed baseline;
- the **composer** rounds killed the work at `step-1` every single time.

---

## The composer arm, in the model's own words

The disk says the script ran and was killed during its first sleep. Here is what
the agent said about the same event, verbatim off its pane in run 4:

```
● Echoed XCMP0B502754 via the butchrprobe reply tool — returned sent.

  Faithful report on round X1: the command did not run. I issued the Bash call
  for .../rounds/X1 14 14, but the tool use was rejected before execution and
  the request was interrupted. It produced no output and no IN-FLIGHT RESULT
  TOKEN — so there is no in-flight token for X1 to report.
```

`/tmp/kan219-probe-lhaMAK/rounds/X1/work.log` at that moment:
`step-1 1786208593743`.

**Three claims, and the first two are false.**

1. *"the command did not run"* — **it ran.** `step-1` is on disk, stamped ~4.2s
   before the interrupt arrived.
2. *"the tool use was rejected"* — **nobody rejected anything.** The daemon sent
   one Ctrl+C (`daemon/src/herdr.ts:1355`). No human was present, no permission
   prompt was raised, and the session runs `bypassPermissions`.
3. *"no output and no IN-FLIGHT RESULT TOKEN"* — **true**, and it is true
   *because* the call was killed before step 3 could mint one.

The report is offered under the heading *faithful report*, and it is faithful —
to the model's context. The client told it the tool use was rejected. **That the
work half-landed is not in the model's context at all. Only the filesystem has
it.**

**It is not a one-off — it happened in every composer round of every run**, in
different words each time, always with `step-1` and only `step-1` on disk:

| Run / round | What the model said | What the disk said |
| --- | --- | --- |
| 1 / X1 | *"was rejected — the Bash tool use was denied **before the script ran**"* | `step-1` present |
| 2 / X1 | *"the tool use was **rejected before execution**"* | `step-1` present |
| 2 / X2 | *"the command … **did not run** — the tool use was rejected before execution"* | `step-1` present |
| 3 / X1 | *"**was rejected** — the tool use was denied and the request interrupted **before the command executed**"* | `step-1` present |
| 4 / X1 | *"**the command did not run**. … the tool use was rejected before execution"* | `step-1` present |
| 4 / X2 | *"**the command did not run**. The Bash call … was rejected before execution and the request was interrupted"* | `step-1` present |

**Six for six.** This is the shape the prompts already warn about — *"an
interrupt that surfaces as 'the user rejected this tool call' may be another
agent's nudge landing mid-call, not the human declining anything"* — and it is
now measured rather than reported anecdotally.

**That asymmetry is the finding most likely to be skipped over**, because the
headline — channels don't interrupt — reads like the good news it is.

---

## Ordering: the reference's sentence, measured rather than quoted

The channels reference says:

> *"Events queue into the session and are processed in order. If several
> notifications arrive while Claude is busy, they're delivered together on the
> next turn and Claude handles them as a group."*

KAN-219's ticket says plainly not to let that stand in for the observation, and
it does not here. The observation is the ordering of the model's two `reply`
calls, timestamped by the channel server:

- the **result token** first — the tool call had returned;
- the **channel nonce** afterwards, a couple of seconds later.

**The event was not acted on through the tool call; it was acted on after it.**
That is what the reference predicts, and it is now a measurement on `2.1.226`
rather than a sentence on a page.

It is also visible on the pane, which is worth showing because it is the whole
answer in five lines — the inbound channel line is drawn **while the shell
command is still running**, and the run continues:

```
● Running 1 shell command…
  ⎿  $ bash /tmp/kan219-probe-…/inflight-work.sh …/C1 14 14

← butchrprobe: [Butchr] agent_reset_event for task/KAN-219-INFLIGHT-IFNF94…

· Caramelizing… (34s · ↓ 130 tokens · thinking with high effort)
```

---

## The probe caught itself over-claiming, five times

Recorded in full, because a proof that has only ever passed is evidence of
nothing. **Both defects were false NOs, and neither changed a headline — which
is precisely what would have let them ship.**

### 1. A vacuous all-clear over a run that measured nothing

The very first invocation was refused a capacity slot by the daemon, ran no arm
at all, and printed:

```
TRUSTWORTHY: every arm reached a verdict and both controls behaved.
```

…and exited **0**. Two causes, both worth naming: *"every arm"* over an empty
list is **vacuously true**, and the `process.exitCode = 1` set at the block site
was overwritten by the `process.exit(failures ? 1 : 0)` at the end. The
emptiness is now checked **before** the behaviour rather than trusted to the
quantifier, a `blocked` reason is carried to the exit, and the sentence names
which arms it is vouching for.

### 2. The detector stopped watching, and reported that as "nothing arrived"

Run 1 printed `the disturbance itself arrived: NO` for the channel arm. **That
was false.** The wait loop stopped the moment the *result* token appeared, and
the reply log — read afterwards, straight off the channel server — shows what
actually happened:

```
16:41:20  INFLE65EFC5793   arm U1 result token
16:42:04  INFLFE8B831AEA   arm C1 result token   (the tool call completed)
16:42:06  IFNF94869DCB6    arm C1 CHANNEL NONCE  (two seconds later)
16:42:20  XCMPFC034D15     arm X1 composer token
```

The nonce arrived. The probe had stopped looking two seconds early. **A NO that
means "we stopped watching" is worse than no reading at all** — this is
KAN-217's defect 4 in a new costume, and the shape it keeps taking is the same:
the detector fails toward *"looks measured"*. The predicate now requires **every
echo the round expects**, so a NO costs the full 180s window, and there is a
final re-read after the settle so a straggler is counted.

### 3. The most important line in the finding was scored as not having happened

Also run 1: `composer path — model reported a rejection : NO`, while the pane
read *"The X1 command was rejected — the Bash tool use was denied before the
script ran."*

The pattern was a list of Claude Code's own interrupt **chrome** —
`Interrupted by user`, `rejected this tool` — and the model had described the
refusal in its own prose instead. So *the model reported a rejection nobody
made*, which is the sharpest observation in this document, came out as a NO.

Two fixes, and the second matters more: the pattern now matches the **vocabulary
of refusal** rather than one client's chrome, and **the model's account is
printed verbatim every round**, so the classification can be checked by a reader
instead of trusted. A regex over model prose is a guess; the transcript beside
it is not.

### 4. Then the widened pattern over-matched, and the printed transcript caught it

Run 2, arm C. The model wrote:

> *"The command ran to completion, **uninterrupted**, printing: IN-FLIGHT RESULT
> TOKEN: INFLDB577B4D2B."*

`/interrupt/` is a substring of `uninterrupted`, so a round in which **nothing
whatsoever went wrong** was scored as the model claiming an interruption. **A
false YES here is as bad as the false NO it replaced, and on this comparison it
is worse: it makes the channel arm look like the composer arm.** Negations are
now struck out before the pattern runs.

It was caught for exactly the reason defect 3's fix existed — the verbatim
transcript is printed directly beneath the classification, and the two visibly
disagreed. **That is the fix doing its job on the very next run**, which is the
only reason to believe it.

### 5. The pane contains a prompt the model never wrote, and it was being read as the model's

Run 3, arm U — an **undisturbed** round — still reported refusal keywords. The
transcript printed beneath it showed why, and it was not the model:

```
● The command ran to completion with no interruption.
  IN-FLIGHT RESULT TOKEN: INFL7B2A332C8D
────────────────────────────────────────────────────────────
❯ did the command finish or get interrupted?          <- NOT the model. Chrome.
────────────────────────────────────────────────────────────
```

That last line is the **client's suggested next prompt** sitting in the composer
(see [text appearing in the composer that nobody typed](#text-appearing-in-the-composer-that-nobody-typed)),
and it was inside the captured region. **Every reading taken off a pane was
reading the client's suggestions as if they were the model's output.**

Worse, the suggestion sometimes carries the run tag — one was
`[RUN RF84531] retry: run the X1 command now` — so `lastIndexOf(runTag)` landed
on the *suggestion* and **sliced away the model's real account entirely**. That
is why run 2's arm X1 printed a near-empty account for a round in which the
model had said a great deal.

The chrome is now cut off **first** — everything from the composer box's top
border — and the run tag is looked for only in what remains. Getting that order
backwards is what produced the second failure.

### And the conclusion drawn from defects 3, 4 and 5

**Classifying model prose with a pattern is the wrong shape of instrument, and
this probe stopped pretending otherwise.** Three attempts, three failures, in
both directions; and run 3's channel arm ended with the model writing *"Nothing
was rejected or refused"*, which trips any keyword search that would also catch
a real refusal. Each negation added to the exclusion list is evidence of the
same thing.

So the flag is now labelled **ADVISORY** in the output, is **never used in a
verdict and never in the exit code** — it never was — and the transcript that
decides it is printed beneath it every round. **Every claim in this document
about what a model said is quoted, not classified.**

**The very next run proved the point rather than the fix.** Run 4's channel arm
ends:

> *"The reset event **did not interrupt or abort** the Bash command; it completed
> normally."*

The advisory flag reads YES on that sentence. It is the plainest possible
statement that nothing went wrong, and no exclusion list short of understanding
the sentence would get it right. **That is why the flag is labelled rather than
trusted**, and why this document quotes.

The **capture** fix is different in kind and is a genuine correctness fix: the
client's suggested prompt is not the model's output, full stop.

### The self-check, and it is watched failing

`--self-check` runs both readers against **real captures** — no agent, no
daemon, no capacity slot:

```
$ node scripts/probe-inflight-disturbance.mjs --self-check
modelAccount() — the client's chrome must not reach the account:

  pass  the client's suggested prompt must not reach the model's account
  pass  a suggestion carrying the run tag must not swallow the account

saysRefused() against real transcripts — both directions:

  pass  expected true  got true   arm X (composer) — the model claims a refusal that never happened
  pass  expected false got false  arm C (channel) — the model says UNINTERRUPTED, which must not match
  pass  expected true  got true   the interrupt chrome the first version matched, kept so it still does
  pass  expected false got false  an ordinary clean round, which must stay quiet
  pass  expected false got false  arm C run 3 — "Nothing was rejected or refused", which must not match

all cases pass
```

**A check that has only ever passed is evidence of nothing**, so here it is run
against the versions this probe actually shipped and that were actually wrong.
Each goes red, and the two prose versions go red on *different* cases — which is
what "two-sided" has to mean:

```
v1 — the chrome list (run 1 shipped this)
  FAIL  expected true  got false  arm X (composer) claims a refusal
  pass  expected false got false  arm C (channel) says UNINTERRUPTED
  => 1 case(s) FAILED — this version would have exited 1

v2 — widened, no negation strip (run 2 shipped this)
  pass  expected true  got true   arm X (composer) claims a refusal
  FAIL  expected false got true   arm C (channel) says UNINTERRUPTED
  => 1 case(s) FAILED — this version would have exited 1

modelAccount v0 — the capture runs 1-3 shipped:
  FAIL  suggested prompt must not reach the account
  FAIL  a suggestion carrying the run tag must not swallow the account
  => 2 case(s) FAILED — this version would have exited 1
```

**Runs 1–3 are kept and quoted here rather than quietly replaced.** Every
headline answer was identical in all four runs; five secondary readings were
wrong across them, every one of them a reading taken off a pane, and not one of
them touched a number measured on disk. **That is the pattern worth carrying
forward: the filesystem readings never moved, and every reading that moved came
from a terminal.**

---

## What this does not cover

Stated plainly, because a proof that supplies its own input has not tested that
the input arrives.

**What the probe supplies itself:**

- **It writes the in-flight work and asks for it.** The agent is told, down the
  composer, to run the script; the window would not exist otherwise. Nothing
  here shows that fleet agents make long tool calls — they plainly do, but that
  is an observation about the fleet, not a result of this run.
- **It causes the broadcast** arm C turns into a channel event, by resetting a
  scratch workspace it created. Inherited from KAN-217 configuration D along
  with its limit: it does **not** establish that production events fire
  unprompted. KAN-167 established that by citation (`router.ts:1412`, `:1601`,
  `:1683`, `:1747`, `:2003`).
- **Arm X's carrier is the product's own.** It calls the daemon's
  `send_to_agent` action — what `butchr_send_to_agent` calls — so the Ctrl+C is
  real (`router.ts:1972` → `router.ts:1990` → `herdr.ts:1355`), and it is
  **exactly one**, with no retry: the confirm-and-retry wrapper lives in
  `nudge.ts` and is not on this path. The message *content* is the probe's.

**Not covered by this or by anything else:**

- **One tool.** The in-flight call is **Bash**. Whether an interrupted `Edit`, or
  an in-flight MCP call, half-applies the same way is untested — and Bash is the
  *friendly* case, because its side effects are files the probe chose. An
  interrupted `Edit` half-applying would be a worse defect and nobody owns
  measuring it.
- **One client, one model, one machine.** `2.1.226`, `sonnet`, this host.
- **Recovery.** This records what the model says after a disturbance; it does not
  follow up on whether an agent retries, resumes, or silently abandons the work.
- **Arm ordering.** Later arms see an agent with more prior context than earlier
  ones. Destructive-last is the right trade for one activation, but it is a
  confound and not a controlled variable.

### Text appearing in the composer that nobody typed

Three times across the two runs, the probe agent's composer held an unsent line
the probe never sent and which appears nowhere in this repository:

```
❯ [RUN R97C0AC] retry that exact command now       (run 1, after arm X)
❯ [RUN RF84531] retry: run the X1 command now      (run 2, after arm X1)
❯ Summarize what happened across all six rounds    (run 2, after arm X2)
```

Worth chasing, because *"another process is typing at agent panes"* would matter
a great deal to this fleet. It is not that:

- **it carries no `[from …]` tag**, and the daemon stamps every message it
  delivers (`handleSendToAgent`), so it did not come through the daemon;
- **the daemon log shows no delivery** to that agent besides the probe's own;
- **the wording differs every time and tracks the conversation** — a retry after
  a refused command, a summary request after exactly six rounds — so it is
  generated, not templated;
- **it is never submitted.** It never appears as a turn, and the model never
  acts on it.

**The most plausible explanation is a client-side next-prompt suggestion
rendered into the composer**, which `capture-pane` cannot distinguish from typed
text. Stated as the most plausible explanation and not as a verified one: the
feature was not confirmed in `2.1.226`'s behaviour, only inferred from these
three samples.

It cannot account for any arm-X result — those rest on the on-disk record and the
fire timestamp, both of which precede it.

### And the product is already defended against it, which this document first got wrong

**An earlier draft of this section said the suggestion was "a live hazard for
anything that reads a pane, which `nudge.ts`'s `messageLanded` does". That
overstated it, and the overstatement is corrected here rather than left to
propagate.** Read at `51e8fc2`:

```ts
// daemon/src/nudge.ts:237 — landedCount, which messageLanded (:222) returns on
const composerAt = COMPOSER_MARKERS.reduce(
  (furthest, marker) => Math.max(furthest, tail.lastIndexOf(marker)), -1);
const submitted = composerAt === -1 ? tail : tail.slice(0, composerAt);
return flatten(submitted).split(needle).length - 1;
```

**It cuts at the last composer marker and counts only above it** — which is
precisely the defence this probe lacked and had to add. A suggested prompt is
rendered *in* the composer, so it falls in the discarded slice. `landedCount`
was written that way for a different reason (KAN-79's stranded-message case,
where the unsent text *is* in the buffer and a naive `includes` passes on the
very frame that proves the failure), and that reason happens to cover this one
exactly.

So the accurate statement is narrower and worth having: **any pane reader that
does not cut at the composer marker is fooled by the client's suggestions. This
probe was one. `nudge.ts` is not.**

What remains genuinely open, and is *not* observed: if the client ever renders a
suggestion **above** the composer, or a suggestion happens to reproduce a sent
message's first 60 characters into the transcript region, `landedCount` would
count it. Neither was seen in four runs. **That is a hypothesis, and it is not
filed as a defect**, because filing one would be this epic's named failure —
claiming more than the mechanism shows — committed in the act of warning about it.

---

## What this means for the design (KAN-234)

Not a design, and this ticket does not build the migration. **KAN-234 reached In
Review while this was still running**, so its interruption section was written
without a finding to cite — which is what its own AC 4 told it to do, and it was
right to do it. This is the answer that section was owed; it does not require
KAN-234 to be reopened, only to be read alongside.

The measurements name what an interruption section may now assume, and one thing
it must not:

1. **The interruption premise for migrating holds.** The channel path delivers
   without cancelling in-flight work; the composer path cancels it and
   misreports the cancellation. That is a real difference, measured on the
   shipped path, and it is the strongest argument the migration has.
2. **The storm guards were built around a destructive send.** *"Never send two
   nudges in a row"*, *"a nudge you receive must never itself generate nudges"*,
   *"notify on meaningful transitions only"* — those exist because
   `butchr_send_to_agent` begins with a Ctrl+C. **Re-derive them against a
   carrier that costs the recipient nothing; do not carry them forward
   unexamined, and do not relax them further than this finding licenses.** What
   is measured here is *one* event in *one* window, not a storm.
3. **Delivery is still not compliance.** KAN-217's refusal finding stands and is
   load-bearing here too: the probe agent was briefed by `.butchr-prompt.md`
   that the channel is expected. Without that priming an agent may correctly
   treat an arriving event as untrusted content.
4. **The composer path does not disappear** — it is still how a human types at a
   pane — so the half-applied-with-a-false-rejection defect above remains live
   for whatever keeps using it.

---

## Reproducing this

```bash
cd daemon && npm install && npm run build      # needs dist/launchers.js
node scripts/probe-inflight-disturbance.mjs                    # U, C, X once each
node scripts/probe-inflight-disturbance.mjs --rounds=2         # as reported here
node scripts/probe-inflight-disturbance.mjs --arms=C           # the question alone
```

**It activates a real agent on this machine.** It takes a capacity slot for
several minutes, comes up interactive in a herdr pane, and is stood down and its
workspace deleted in a `finally`. If the daemon refuses for want of capacity it
**waits rather than passing `override: true`** — overriding would push the
machine past its own guard while other agents are working, and every timing here
is read off a loaded machine. If you interrupt a run, check for a leftover
`task/KAN219-PROBE-*` workspace.

**Run it with all three arms before quoting the conclusion — the summary polices
that itself.** It refuses to answer from an arm that did not run, withholds the
answer when the controls did not hold, and exits non-zero when the run cannot be
trusted, whichever way the channel arm came out. **"Channels disturb" and
"channels do not" are both passing results.**

To watch the trust gate go red rather than take its word for it, and to exercise
the two pane readers without spending a capacity slot at all:

```bash
node scripts/probe-inflight-disturbance.mjs --arms=Q       # no arm runs → exit 1
node scripts/probe-inflight-disturbance.mjs --self-check   # no agent, no daemon
```

**The probe is deliberately outside the `verify-` namespace** (do not rename it),
for the same reason `probe-channel-delivery.mjs` is: it drives a live `claude`
CLI and a real model, so it is an experiment, not a deterministic proof of
product behaviour that CI can re-run. Its exit code reports whether the run could
be **trusted**, not which way the verdict went.

**The harness is shared, not copied.** `daemon/scripts/lib/channel-probe.mjs`
holds the channel server, the stdio tee, the scaffolding and the real-agent
bring-up; it was extracted from `probe-channel-delivery.mjs` by this ticket, and
both probes import it. Two copies of the launcher splice and the identity
stamping would have been the second place for them to drift, which is KAN-145's
defect exactly.
