// KAN-186 / KAN-237: every operative rule must live where an agent will meet
// it, and no *retired* rule may still be taught there.
//
// WHAT FAILURE THIS WOULD CATCH: an operative rule — one an agent must satisfy
// *at the moment it acts* — existing only in a Jira description or a Confluence
// page, with no `prompts/<type>.md` carrying it. That is not hypothetical: on
// `main` @ `39cd158`, `grep -rniE "secret|token|credential" prompts/` matched
// nothing in any of the four prompts, so an agent handed a token met no
// instruction not to echo it; and `prompts/epic.md` referred twice to a
// "polling loop below" that no section below defined, while its Cadence section
// read as a prohibition against polling. Run with `--ref 39cd158` — KAN-186's
// merge base, pinned so the recipe keeps working after it lands — to watch this
// script go red on exactly that, with all four prompts missing every word of
// H-3 and H-4.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// (This used to quote "23 failures". The count is not a fact about `39cd158` —
// it is a fact about how many entries this file had on the day it was written,
// and it rises every time a rule is added: it was 60 by 2026-08-10. KAN-241
// replaced the number with the claim it was standing in for. A recipe that
// quotes a count invites a reader to treat a different count as a broken
// recipe, and the same rot is why the two counts below went too.)
//
// AND (KAN-237) THE SAME DEFECT WITH THE SIGN FLIPPED: a rule that has been
// *superseded* still sitting in the prompts, which is worse than a missing one,
// because the agent meets it and obeys it. On `main` @ `51e8fc2` the human had
// changed merge governance to **the story agent approves, the task agent
// merges** (2026-08-08), KAN-39's description had been updated, and all three
// `prompts/*.md` still taught the 2026-08-03 rule — `prompts/task.md` said "Do
// not merge — review and merge belong to your epic agent", `prompts/epic.md`
// had a whole section titled "You review and merge this epic's PRs". By KAN-39's
// own "when the two disagree, the prompt wins" test the operative text was the
// stale one, and the rule was diverged from twice in one day in opposite
// directions. Run with `--ref 51e8fc2` — KAN-237's merge base, pinned for the
// same reason — to watch both halves go red: H-8 unmet in all three prompts,
// and R-1 matching the retired rule taught straight, with no retirement marker
// in any of those sentences.
//
// AND (KAN-239) THE SAME DEFECT ONE CLAUSE DOWN, WHICH IS THE INTERESTING ONE:
// a rule can be retired while the rule it sits inside stays current. KAN-237's
// merge rule is right; its *fallback* was wrong. All three prompts said a task
// with **no parent story** is approved by its **supervisor of record — the
// agent that activated you**, and `activatedBy` is `null` for every agent the
// board reconciler starts (correctly — nothing staffed them), which since
// KAN-221/222 is most of the fleet. So the clause resolved to **nobody**: those
// tasks had no approver, and under *approval is a precondition* could never
// legitimately merge. KAN-207, KAN-218, KAN-219, KAN-230 and KAN-233 were all
// in that hole. R-2 retires the fallback; H-10 requires the correction.
//
// **The red for R-2 needs no merge base and no mutation, which is unusual.**
// `origin/main` still teaches the retired clause verbatim in all three prompts,
// so at the time KAN-239 was written:
//   node daemon/scripts/verify-operative-rules-are-carried.mjs --ref origin/main
// goes red on exactly the sentences this entry exists to catch — R-2 firing
// unmarked across `prompts/{epic,story,task}.md`, plus H-10 missing from all
// three. Once KAN-239 lands, `origin/main` moves and that recipe goes green;
// pin it to KAN-239's merge base, `efde3cb`, to keep reproducing it.
//
// (Two counts have been taken out of this paragraph, and the second is the
// instructive one. "10 failures" was a total, and totals rise with the
// inventory — it is 26 as of 2026-08-10. But "seven R-2 hits" looked stable and
// was not: R-2 has gained patterns since, so the same unchanged commit now
// yields 11. A count is a claim about *this file* wearing the costume of a
// claim about the ref. H-10's "all three" survives because it counts prompts,
// which is what the entry is actually about.)
//
// R-2 FENCES WORDINGS, NOT THE CONCEPT — AND THAT LIMIT HAS ALREADY LET ONE
// THROUGH, SO DO NOT READ A GREEN R-2 AS "NO PROMPT MISDIRECTS APPROVAL".
// Every pattern below matches a *form of words*. A sentence that says the same
// thing in different words passes. That is not hypothetical: while this file
// was green, `prompts/task.md` still read "**Done** on {{KEY}} is *your
// supervisor's* to set" — the retired concept, none of the retired phrases,
// resolving to nobody for a board-started task exactly as the clause beside it
// did. `epic/KAN-39` found it by reading the file, not by running this script.
// Two patterns for that specific attribution have since been added, which
// closes *that* sentence and does not close the class.
//
// The class cannot be closed by pattern here, and the reason is structural
// rather than a want of effort: after KAN-230, `supervisor` is a **correct**
// name for the `activatedBy` relation, so the retired thing is a *claim about*
// the word and not the word. Distinguishing "the supervisor that activated you"
// (correct) from "your supervisor sets Done" (retired) is a reading, and this
// script does not read. **What covers the class is a human or an approver
// reading the prompts** — the same coverage note H-8 carries below, for the
// same reason. Nothing else covers it; do not infer that anything does.
//
// R-2 IS ALSO WHERE THIS FILE'S RETIREMENT MECHANISM IS EASIEST TO GET WRONG,
// so its docblock below is longer than R-1's: the retired thing is a *claim
// about* "supervisor of record", not the phrase itself, which is still the
// correct name for who staffed a run and appears correctly in every prompt's
// notification-topology paragraphs. A pattern matching the bare phrase would
// go red on three correct sentences and be "fixed" by deleting them.
//
// THAT MERGE-BASE RED IS THE WEAKEST EVIDENCE HERE, AND IT LOOKS LIKE THE
// STRONGEST. It shows only that the script reacts to a wholly different file.
// The first version of R-1 produced that same 22-failure red while being unable
// to fire anywhere the merge rule was actually discussed — `epic/KAN-39` found
// that in review by reinserting the old sentence into `prompts/task.md` and
// watching this script stay green. The test that means something is therefore:
// **put the retired rule back where the rule lives, and watch it go red there.**
//   printf '\n- **Do not merge — review and merge belong to your epic agent.**\n' >> prompts/task.md
//   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1
//   git checkout -- prompts/task.md
// Do that after any change to RETIRED or to `sentences()`. A green run of this
// script has been wrong before; a red one at that spot is what earns it back.
//
// AND (KAN-249) A RULE THAT HAS TO BE MET BEFORE THE FIRST EVENT, NOT AFTER THE
// FIRST FAILURE. H-12 requires the channel brief in all four prompts. KAN-217
// measured an unbriefed session **correctly refusing** a channel event as
// probable prompt injection — delivery was perfect, the brief was missing, and
// from outside the two look identical. So this is the unusual case where the
// prompt is not documentation of a mechanism but a **precondition of it**: the
// carrier does not work on an agent that has not read this, and no code path
// anywhere can tell you so. Run with `--ref fa84f07` — KAN-249's merge base — to
// watch it go red on all four prompts, which is what `origin/main` looked like
// before channels were ever enabled for anybody.
//
// AND (KAN-250) A RULE WHOSE SUBJECT IS OVER-CLAIMING, WHICH IS WHY IT IS HERE
// AT ALL. H-13 requires the storm guards to be carried **per carrier** in all
// four prompts: KAN-219 measured that *a send is a preemption* — the premise
// three of the four rested on — is true of the composer and false of the
// channel, so *"never send two in a row"* was **narrowed rather than deleted**.
// The rule it now teaches is that nobody has measured a burst on either
// carrier, and the way that rule dies is not deletion: it is a later editor
// keeping the carrier table, which looks like the content, and dropping the
// limits hung off it. Every check on this repository would stay green.
//
// This entry was NOT in KAN-250's acceptance criteria. `story/KAN-150` found
// the hole while approving — it ran this sweep at the merge base expecting red,
// got green, and worked out why — and left the call to the author rather than
// adding a criterion at review time. It landed in the same PR because a
// follow-up nobody staffs is how an unpoliced rule stays unpoliced.
//
// WHAT THIS SCRIPT DOES NOT COVER, STATED BECAUSE THE HEADER IS WHERE THE EDGE
// GOES:
//
//   - It checks that a sentence is **present in a file**. It cannot check that
//     the sentence is *correct*, that it is *placed* where the agent is at the
//     moment it acts, or that an agent reading it *does* the thing. A rule
//     pasted into the wrong section passes this sweep and is still a rule the
//     agent will not meet. Placement is a review question and this script does
//     not answer it — the PR's grep output, which shows the enclosing section
//     of each hit, is what a reviewer reads for that.
//   - **For H-8 that gap is the whole of the enforcement, and it is load-bearing
//     rather than incidental.** Merge governance is kept by agents choosing to
//     keep it: GitHub cannot tell author from reviewer (one shared account), so
//     it refuses a formal review verdict on our own PRs and leaves the merge
//     button open to the author. Nothing mechanical gates a merge on an
//     approval. So this script can prove the three prompts *say* the rule and
//     can never prove an agent *kept* it. **Nothing else covers that either**,
//     and no script can — the observation that would is a human or a supervisor
//     reading a merged PR and asking whether an approval comment preceded the
//     merge. It is named here so nobody infers a coverage that does not exist.
//   - It reads the real `prompts/*.md` off the checkout. It does **not** write
//     the files it then asserts on, which is the KAN-145 failure mode; but the
//     input it verifies is a file, not a running system, so it proves nothing
//     about the daemon delivering these prompts to an agent.
//     `daemon/scripts/verify-prompt-write-refusal.mjs` is the script that
//     exercises the loader against a real activation.
//   - Its subject is `prompts/` only. `docs/butchr.md` and code comments can
//     restate a rule and go stale independently; both did for KAN-237, and both
//     were fixed by hand in the same PR rather than by this sweep.
//   - **For H-12 specifically, the gap is a model.** This proves the four files
//     say the brief. Whether a real agent that has read it then *acts* on a
//     channel event — the thing KAN-217 watched fail — is a question about a
//     model and cannot be asked by a regex.
//     WHO COVERS IT: `daemon/scripts/probe-briefed-channel-compliance.mjs`,
//     which runs two real channelled agents, briefs one and not the other, and
//     reads the outcome off the filesystem. It is a live experiment, not a CI
//     check, so this sweep staying green is never evidence that the brief works
//     — only that it is present.
//   - **Nor does anything here check the OTHER half of the brief.** The MCP
//     server's `instructions` string (`daemon/src/mcp.ts`) carries the same
//     rule into the client's system prompt, and this sweep's subject is
//     `prompts/` only, so the two can drift. The probe above reads the
//     `instructions` off the negotiated `initialize` result and asserts the
//     same four halves are in it, which is the only thing that ties them
//     together; nothing does it at PR time.
//
// AND (KAN-212) A RULE THAT NEVER REACHED A PROMPT AT ALL. The convention
// *every Story and Task carries a parent epic* was a human decision of
// 2026-08-07 that existed only as a backfill of the board — 74 tickets
// re-parented, and no sentence anywhere an agent reads. Four more unparented
// tickets were filed within the day by four different agents, one of them while
// the backfill was still running; the heaviest filer on the board later
// disclosed three of its own, two already closed under its own merges with
// nothing having gone red. It is **H-14**, and it has now been renumbered
// twice: written as H-12, moved to H-13 when KAN-249 landed its channel-brief
// entry under that id first, and moved again to H-14 at `2a24912` when KAN-250's
// storm guards turned out to be on `main` under H-13 already. Each time the id
// went to the incumbent and the one still in review moved, which is the cheaper
// half. Recorded because a reader meeting "H-12" or "H-13" in KAN-212's PR
// history should not go looking for a rule that moved.
//
// **AND BECAUSE THE SECOND RENUMBER IS ITSELF AN INSTANCE OF THIS TICKET'S
// DEFECT** (KAN-241): `2a24912` changed the `id:` field and left this docblock
// and the two sentences below still saying H-13. The rule was carried, the
// entry was present, every check was green, and the prose beside it named an id
// that no longer existed. Presence is mechanical; agreement between an entry
// and the paragraph explaining it is not, and nothing checks it.
//
// Run with `--ref` KAN-212's original merge base `1fc6407` to watch H-14 go red
// in all three prompts at once — that red
// is honest here in a way the R-1 merge-base red was not, because the rule is
// genuinely absent from those files rather than merely discussed elsewhere.
// The narrower test, and the one to repeat after any edit to H-14's phrases:
//   perl -0pi -e 's/Epics have no parent, and that is correct//' prompts/story.md
//   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, story.md only
//   git checkout -- prompts/story.md
//
// AND (KAN-241) THE HOLE THIS SCRIPT HAS IN *ITSELF*, WHICH IS A DIFFERENT KIND
// OF GAP FROM ALL OF THE ABOVE. Every entry above guards a rule in `prompts/`.
// The entries themselves were guarded by nothing — and **the entries are the
// checking**, so a dropped one removes the assertion that would have noticed it
// was dropped, and the sweep passes *harder* afterwards. Within an hour of this
// becoming a required check (KAN-240, `ff6d068`) it reported success over three
// separate defects in the files it guards, and on 2026-08-08 `epic/KAN-39` hit
// the merge hazard for real: a conflict in the `RULES` region between KAN-212's
// parent-epic entry and KAN-250's storm guards, **both numbered `H-13`**. It
// resolved by keeping both and renumbering (`2a24912`). Taking either side would
// have dropped a live rule with `node --check`, this sweep and every other check
// staying green; the collision was caught by a person grepping on a hunch.
// Section 5 below is the answer, `rule-inventory.md` is its declared half, and
// `verify-rule-inventory-catches-dropped-entry.mjs` stages a real conflict and
// watches the pre-KAN-241 sweep go green over it before this one goes red.
//
// KAN-241's SECOND QUESTION — CAN "CARRIED SOMEWHERE" BE NARROWED TO "CARRIED
// WHERE THE RULE BELONGS"? DECISION: NO, AND THE MEASUREMENT IS WHY.
//
// The weakness is real: H-10 was green on KAN-239's PR #100 (`61355c0`) while
// `prompts/epic.md:510` still read *"the parent story's agent, or the parent
// epic's"* in the ticket-writing checklist, because H-10's phrases were carried
// in the merge-governance section and this sweep only asks whether a file
// carries them *somewhere*.
//
//   1. **Section-scoping the phrases is not tractable, measured rather than
//      asserted.** Of the 36 rule×file pairs on this commit, 5 have no single
//      section at any heading depth containing all of a rule's phrases, and 1
//      has none even at `##` depth: H-13 in `prompts/epic.md`, where seven
//      phrases sit under *## The coordination model* and two — `you never
//      select one and never infer one`, `capability rather than a hazard` — sit
//      under *## Steering running agents*. That spread is **correct**: epic.md
//      discusses carrier selection where an epic steers agents. So the check
//      would go red on a correct file today, on the entry whose whole subject
//      is over-claiming, and the fix would be a growing exception list.
//   2. **And it would not have caught the instance anyway**, which is the part
//      that settles it. At `61355c0` H-10's epic.md phrases are at lines 64–73
//      and the contradicting sentence is at line 510. A section-scoped H-10 is
//      satisfied at 64–73 and never looks at 510. Section-scoping asks *are the
//      phrases together*; the defect was *another passage says the opposite*.
//      They are different questions and only the second one was ever the bug.
//
// WHAT WOULD HAVE CAUGHT IT IS A `RETIRED` ENTRY, AND IT IS NOT FREE — TESTED,
// NOT GUESSED. A pattern for the superseded wording, `/parent story'?s\*{0,2}
// agent/i`, run through this file's own `sentences()` and `RETIREMENT_MARKERS`:
// at `61355c0` it fires **unmarked** on `prompts/epic.md:510` — the instance —
// while the correct quotation at line 81 is waved through. But on this commit
// it also fires unmarked on `prompts/task.md:58`, a **correct** sentence that
// retires the wording in words no marker lists: *"Its successor was wrong too,
// in the opposite direction."* So the obstacle is not the pattern; it is that
// `RETIREMENT_MARKERS` is itself a closed wording fence with exactly the limit
// R-2's docblock describes. Adding the entry means either widening that list or
// rewording that sentence, and **adding to `RULES`/`RETIRED` is out of KAN-241's
// scope** — it belongs to whichever ticket changes the rule. Filed as KAN-254
// (`Relates` to KAN-241) with this measurement, so the finding is not lost.
//
// Usage:
//   node daemon/scripts/verify-operative-rules-are-carried.mjs [--verbose]
//   node daemon/scripts/verify-operative-rules-are-carried.mjs --ref origin/main
//   node daemon/scripts/verify-operative-rules-are-carried.mjs --require-baseline
//   node daemon/scripts/verify-operative-rules-are-carried.mjs --baseline <ref>
//
// `--ref` reads the prompts out of a git ref instead of the working tree, which
// is how the pre-fix red is reproduced without checking anything out.
//
// **`--ref` SWAPS THE PROMPT FILES, NOT THE ENTRY TABLE, SO A GREEN `--ref
// origin/main` IS NOT A STATEMENT ABOUT `origin/main`.** The `RULES` and
// `RETIRED` arrays always come from the running copy of this script, and
// section 5 always reads the working tree; only the `prompts/*.md` under test
// move. So `--ref origin/main` answers *"do the trunk's prompts satisfy the
// entries I have here"*, never *"is the trunk's own entry table sound".*
//
// That distinction is not pedantic — it was live on 2026-08-10. `origin/main`
// at `91b73a3` carried **two** duplicate id pairs (`H-14`, `H-15`), its own
// sweep exited 0 over both, and `--ref origin/main` from the branch that fixes
// them also exited 0. Nothing about either green touched the collision.
//
// **And a collision is a property of a merge result, not of either parent**,
// which is why no single-ref check could have caught these: each branch was
// internally consistent and correct in isolation, and the duplicate came into
// existence only when both had landed. The duplicate-id leg in section 5 runs
// against the merged working tree for exactly that reason — it is the only
// place the defect exists. KAN-268 asks whether the id can be made
// collision-proof rather than collision-detected.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const refIndex = process.argv.indexOf('--ref');
const ref = refIndex === -1 ? null : process.argv[refIndex + 1];

const PROMPTS = ['epic', 'story', 'task', 'confluence'].map((t) => `prompts/${t}.md`);

/**
 * Every rule this ticket found homeless, with the files that must carry it and
 * the phrases that prove each one does.
 *
 * The phrases are deliberately the distinctive part of a sentence rather than a
 * whole sentence: a wording pass that keeps the rule should keep the sweep
 * green, and a deletion should not.
 */
const RULES = [
  {
    id: 'H-1',
    title: 'a restart can eat in-flight nudges; re-check expected handbacks afterwards',
    carriedBy: {
      'prompts/epic.md': [/restart can eat in-flight nudges/i, /re-check every handback you were waiting on/i],
      'prompts/story.md': [/After a restart, the sweep is mandatory/i, /re-check every handback you were waiting on/i],
    },
  },
  {
    id: 'H-2',
    title: 'the self-paced supervision loop: defined, and distinguished from the daemon poller',
    carriedBy: {
      'prompts/epic.md': [/^## The supervision sweep$/m, /not the daemon's Jira poller/i, /self-paced, not clock-paced/i],
      'prompts/story.md': [/^## The supervision sweep$/m, /not the daemon's Jira poller/i, /self-paced, not clock-paced/i],
    },
  },
  {
    id: 'H-3',
    title: 'secrets never enter a transcript',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [f, [/Secrets never enter a transcript/i, /referenced by path, never echoed/i]])
    ),
  },
  {
    id: 'H-4',
    title: 're-check the justification at the moment of starting, not at approval',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [/authorisation whose condition has lapsed is not an authorisation/i, /moment of starting/i, /not at approval/i],
      ])
    ),
  },
  {
    // KAN-334 generalised this entry out of the page. It used to be a
    // *Confluence page write* rule carried by three prompts, and `prompts/
    // story.md` carried nothing — while the write every agent here actually
    // makes, all day, is a **Jira comment**. Measured 2026-08-12:
    // `addCommentToJiraIssue` with `contentFormat: "markdown"` stored one of
    // three probe markers and dropped two, including a list item's own text,
    // status 200 (comment `11611` on KAN-39). So the rule was right, homed in
    // one place, and absent from the surface it mattered most on.
    //
    // THE PATTERNS DELIBERATELY NO LONGER REQUIRE THE MECHANISM, and that is
    // the point of the ticket rather than a relaxation of the check. Requiring
    // `<li><p /></li>` and `blockquote nested inside a list item` made this
    // sweep the thing that kept a dated converter defect alive in four prompts
    // — a required check enforcing precisely what R-3 below now forbids. Each
    // prompt still *cites* those instances, with their dates; none may state
    // them as the rule, and nothing here obliges one to keep them. What is
    // required is the claim and the act it asks for.
    id: 'H-5',
    title: 'a write that reports success is not a write that stored what you sent — read it back and compare',
    carriedBy: {
      ...Object.fromEntries(
        PROMPTS.map((f) => [
          f,
          [
            /reports success is not a write that stored what you sent/i,
            /read (it|the (stored )?(body|page)) back and compare/i,
          ],
        ])
      ),
      // The page agent additionally owes the *recipe* — reading it back is its
      // job rather than a step in someone else's, and the other three prompts
      // point at this file for it.
      'prompts/confluence.md': [
        /reports success is not a write that stored what you sent/i,
        /read (it|the (stored )?(body|page)) back and compare/i,
        /getConfluencePage/,
      ],
    },
  },
  {
    id: 'H-7',
    title: 'a handoff describing future work is a plan, not evidence that it happened',
    carriedBy: {
      'prompts/epic.md': [/handoff describing future work is a plan, not evidence that it happened/i, /Re-derive it before you repeat it/i],
      'prompts/story.md': [/handoff describing future work is a plan, not evidence that it happened/i, /Re-derive it before you repeat it/i],
    },
  },
  {
    // KAN-237. Three phrases, because the rule has three halves and shipping
    // one without the others is the failure this entry exists to catch:
    // *who does what*, *approval is a precondition and green CI is not it*,
    // and *nothing mechanical enforces it*. A prompt stating only the first
    // teaches a rule that sounds guarded and is not.
    id: 'H-8',
    title: 'merge governance (2026-08-08): the story agent approves, the task agent merges',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /story agent approves; the task agent merges/i,
          /Approval is a precondition, not an ordering/i,
          /Green CI is not approval/i,
          /merge button (is )?open to the author/i,
        ],
      ])
    ),
  },
  {
    // KAN-239, correcting a clause of KAN-237's. The rule has two halves and
    // the second is what makes it answerable: naming the parent epic is the
    // *rule*, and "never off `activatedBy`" is the *refutation of the wording
    // it replaced*. A prompt carrying only the first leaves an agent that has
    // read the old wording — on its own ticket, or in a sibling prompt — with
    // two readings and no way to choose.
    id: 'H-10',
    title: 'the approver: the story by issue LINK, else the parent epic, and never off `activatedBy`',
    // Three things every prompt has to carry, because dropping any one of them
    // reintroduces a defect that has already shipped once:
    //   - `hierarchyLevel` — WHY the story is a link. Without it the next
    //     author "simplifies" the rule back to the hierarchy, which is how the
    //     second wrong version got written.
    //   - `parent epic's agent` — the branch-2 answer.
    //   - the `activatedBy` negation — the refutation of the first wrong
    //     version, which an agent will still meet on older tickets.
    carriedBy: {
      'prompts/task.md': [/hierarchyLevel/, /never by your `parent` field/i, /parent epic's agent/i, /never consulted for this branch/i],
      'prompts/story.md': [/hierarchyLevel/, /never by its `parent` field/i, /parent epic's agent/i, /never off `activatedBy`/i],
      'prompts/epic.md': [/hierarchyLevel/, /issue \*link\*/i, /parent epic's agent/i, /never off `activatedBy`/i],
    },
  },
  {
    // KAN-238's AC3, absorbed here because KAN-238 is a duplicate of KAN-239
    // and this is the one requirement of it that KAN-239 did not already have.
    // A chain of fallbacks needs a stated end, and the end has to be *stop*.
    // The failure mode of an unstated terminating case is not an agent that
    // halts — it is an agent that quietly appoints an approver and merges,
    // which is the one thing nothing mechanical would catch. It is `task/`
    // only: the epic-side duty is filing a parent, not stopping, and that
    // sentence lives in the ticket-writing checklist instead.
    id: 'H-11',
    title: 'the terminating case: when nothing names an approver, say so and do not merge',
    carriedBy: {
      'prompts/task.md': [/nobody names you an approver/i, /filing defect, not a licence/i, /quietly invents an approver/i],
    },
  },
  {
    // KAN-249 (T6 of KAN-150). The rule an agent has to have met BEFORE the
    // first channel event arrives, because KAN-217 measured what happens when
    // it has not: an unbriefed session **correctly refuses** a channel message
    // as probable prompt injection, and that refusal is indistinguishable from
    // a broken transport to whoever sent it.
    //
    // FOUR PHRASES, BECAUSE THE RULE HAS FOUR HALVES AND ANY THREE IS A TRAP:
    //   - `source="butchr"` — the frame an agent must recognise. Without it the
    //     brief describes a thing the agent cannot match to what it sees.
    //   - *structural vs convention* — WHY the channel tag is worth more than
    //     KAN-149's `[from …]`, which is the upgrade design §3 claims.
    //   - *names the server, never the sender* + *never the human speaking* —
    //     the honest limit, and the half most likely to be dropped as
    //     redundant. A brief carrying only the upgrade teaches an agent that a
    //     channel frame authenticates its sender, which is false and worse than
    //     saying nothing: it would license acting on a forged payload because
    //     the frame around it was genuine.
    //   - *no dedicated channel reply tool* + *makes a reply owed* — the reply
    //     path described without being urged. §3 is explicit that a brief which
    //     tells agents to reply through the channel manufactures traffic, so
    //     the sentence that limits the obligation is as operative as the one
    //     that names the path.
    //
    // WATCH IT GO RED, at the spot that means something. R-1's docblock argues
    // why a merge-base red is the weak evidence — it shows only that the script
    // reacts to a wholly different file — so the test that counts is the
    // *plausible regression*: an author tightening the brief keeps the upgrade
    // and drops the limit on it. `--ref fa84f07` gives the weak red (all four
    // prompts, KAN-249's merge base); this gives the strong one:
    //   perl -0pi -e 's/\* \*\*And it buys exactly one sentence.*?same limit as above\.\n//s;
    //                 s/\*\*A channel message is never the human speaking\.\*\*.*?durable\.\n\n//s'
    //     prompts/task.md
    //   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, task.md only
    //   git checkout -- prompts/task.md
    // Two patterns fail and four pass, in the one file, with the "the frame
    // cannot be forged" bullet still sitting there — which is exactly the shape
    // of the brief that would be worse than no brief at all.
    id: 'H-12',
    title: 'the channel brief: an expected carrier, what its frame is worth, and a reply path described rather than urged',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          /source="butchr"/,
          /is structural; the sender tag inside it is a convention/i,
          /names the \*\*server\*\*, never the sender/i,
          /never the human speaking/i,
          /no dedicated channel reply tool/i,
          /makes a reply owed/i,
        ],
      ])
    ),
  },
  {
    // KAN-212. WHY THIS ONE IS IN THE SWEEP — the ticket asked for the decision
    // to be made deliberately rather than by default, so here it is, with the
    // counter-argument kept rather than dropped.
    //
    // FOR: it is an operative rule by this script's own test — an agent
    // satisfies it at the moment it calls `createJiraIssue`, and its failure
    // mode is a wrong action in the next thirty seconds. The rule went missing
    // the first time because it existed *only* as a backfill of the board — 74
    // tickets re-parented and no sentence anywhere an agent reads — and four
    // more orphans were filed within the day by four different agents, one of
    // them while the backfill was still running. Since KAN-240 this sweep is a
    // required check, so a rewrite that drops the rule goes red before review
    // instead of in it. That is the whole argument, and it stands on its own.
    //
    // WHAT THIS PARAGRAPH USED TO ARGUE, AND WHY THE CORRECTION IS KEPT RATHER
    // THAN SWALLOWED: it said a merge rule *depends* on this one, because
    // KAN-239's approver lookup had "no third branch" and so a parentless
    // ticket would name nobody and merge anyway. Both halves were wrong within
    // the hour. KAN-239 landed a permanent terminating branch — nothing names
    // an approver → the ticket is mis-filed, say so, do not merge, appoint no
    // substitute — pinned by H-11; and its primary branch reads the Story off
    // an issue *link*, never off `parent`, since a task's `parent` is always an
    // Epic. So a parentless ticket does **not** silently name nobody: its agent
    // stops. That removes a reason for this entry and not the entry, which is
    // why the argument above no longer leans on another ticket's rule at all.
    // Recorded because an argument quietly repaired reads as one that was
    // always right, and because this docblock survived the same correction
    // being applied to all three prompts — the audit was scoped to `prompts/`
    // and this file is not in it. `task/KAN-239` caught it; no check did.
    //
    // AGAINST, AND IT IS NOT WEAK: this sweep proves **presence in a file**,
    // and the whole of KAN-212 is that the convention existed and no agent
    // *met* it. Presence is the weaker of the two claims, and pasting these
    // sentences into a section no filer reads would keep this entry green while
    // reproducing the original defect exactly. So placement is the load-bearing
    // half and it is a review question: the PR's `grep -n` output, which shows
    // the enclosing section of each hit, is what answers it. Recorded here so
    // nobody reads a green H-13 as "agents now parent their tickets".
    //
    // Four phrases, because the rule has four parts and the one most likely to
    // be dropped in a rewrite is *epics are parentless* — it reads like an
    // aside and is the reason a diligent agent does not retry a refused write.
    id: 'H-14',
    title: 'every Story and Task filed carries a parent epic — the epic, never the story',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /carries a parent epic/i,
          /set (it )?at creation/i,
          /never the story/i,
          /[Ee]pics have no parent, and that is correct/,
          /invisible in its epic's org chart/i,
        ],
      ])
    ),
  },
  {
    // KAN-250 (T7 of KAN-150). The storm guards, re-derived per carrier after
    // KAN-219 measured that *a send is a preemption* — the premise three of
    // them rested on — is true of the composer and false of the channel.
    //
    // WHY THIS ONE IS POLICED HARDER THAN ITS SIZE SUGGESTS: its subject IS
    // over-claiming. Every other entry here guards a rule about how to work;
    // this one guards a rule about **not writing a sentence that claims more
    // than its mechanism covers**, in the file that teaches agents to avoid
    // exactly that. The failure mode is not deletion — it is a later editor
    // tidying the section, keeping the carrier table because the table looks
    // like the content, and dropping the limits hung off it. That leaves a
    // prompt which reads as "the channel is the safe carrier" while nobody has
    // ever measured a burst on either. It degrades toward looking finished,
    // which is why a reviewer would pass it.
    //
    // NINE PATTERNS, BECAUSE ANY EIGHT IS A TRAP. Each names a half the rule
    // cannot ship without:
    //   - the carrier heading — without it the guards read as one-size-fits-all
    //     again, which is the state KAN-250 found them in.
    //   - `narrowed, not deleted` — the disposition. Catches the editor who
    //     resolves the tension by deleting the rule instead.
    //   - **the burst sentence** — the load-bearing one. Strip it and the table
    //     alone reads as a safety claim about the channel column.
    //   - KAN-219's limit, quoted — the *evidence* for the narrowing. Without
    //     it the narrowing is an assertion, and the next author has nothing to
    //     re-derive it from.
    //   - `you never select one and never infer one` — what makes the narrowing
    //     unusable as a licence: a sender cannot opt into the cheap carrier, so
    //     it must decide as though every send were a composer send. Drop this
    //     and the channel column becomes actionable advice, which it is not.
    //   - the three uncovered cases, **matched individually** — dropping one of
    //     three is the plausible tidy-up, and a single pattern over the section
    //     heading would not see it.
    //   - `capability rather than a hazard` — §5.1 case 5 stated positively.
    //     The design says a migration that retired the composer would have
    //     removed the fleet's only stop-now signal "without noticing"; this is
    //     the sentence that keeps anyone from noticing too late.
    //
    // WATCH IT GO RED AT THE SPOT THAT MEANS SOMETHING. R-1's docblock argues
    // why a merge-base red is weak evidence — it shows only that the script
    // reacts to a wholly different file — so the test that counts is the
    // plausible regression above, which keeps the table and strips the limits:
    //   perl -0pi -e 's/\*\*Nothing written here says a burst is safe.*\z//s' prompts/task.md
    //   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, task.md only
    //   git checkout -- prompts/task.md
    // Four patterns fail and four pass, in the one file, with the carrier table
    // still sitting there — the shape that is worse than not doing the work.
    //
    // WHAT THIS ENTRY CANNOT CHECK, AND IT IS NOT THE USUAL CAVEAT: it holds
    // the sentence *"nobody has measured a burst"* in place, and it has no way
    // to know whether that is still true. **If a burst is ever measured, a
    // green run here is evidence that the disclaimer is present, never that it
    // is honest** — and the pattern would then be actively demanding a sentence
    // that has become false. Whoever runs that measurement updates this entry
    // in the same PR; nothing mechanical will remind them.
    id: 'H-13',
    title: 'the storm guards, per carrier: "never two in a row" narrowed rather than deleted, and no claim of burst safety',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          /Storm guards — narrowed to their carrier, never relaxed/i,
          /narrowed, not deleted/i,
          /Nothing written here says a burst is safe, on either carrier/i,
          /one event in one window, not a storm/i,
          /you never select one and never infer one/i,
          /An interrupted `Edit`/,
          /An in-flight MCP call/,
          /Whether a disturbed agent recovers/,
          /capability rather than a hazard/i,
        ],
      ])
    ),
  },
  {
    // KAN-252. THE RULE THIS ENTRY EXISTS TO STOP GOING MISSING is not the
    // paragraph — it is the *expectation* the paragraph sets, and the mechanism
    // that depends on it is invisible from the prompt.
    //
    // The scheduled channel liveness probe (`daemon/src/channel-liveness.ts`) is
    // the only thing in the fleet that reaches leg 5 of the channel loop, and it
    // reaches it by asking a model to print a token. Every agent's brief already
    // says that `[butchr daemon]` messages are notifications expecting no reply
    // — correctly — so without this paragraph the probe asks for something the
    // brief has told the agent not to give, and every run comes back a
    // non-answer. The mechanism would go on running, logging honestly, and
    // learning nothing, with every check in this repository green. That is
    // precisely the shape of defect this sweep exists for: prose is a
    // *precondition* of a mechanism and the mechanism cannot tell you it is
    // missing.
    //
    // THE THREE PATTERNS ARE THE THREE PARTS, and dropping any one of them is a
    // different failure:
    //   * the probe is NAMED — an agent that cannot tell this message from an
    //     unexpected one is back to judging it cold, which is KAN-217's refusal;
    //   * what it ASKS FOR — a paragraph that names the probe and not the ask
    //     leaves the agent knowing something arrives and not what to do;
    //   * that DECLINING IS NOT A FAULT — the half most likely to be cut as an
    //     aside, and the one that keeps this from being an obligation. Without
    //     it the brief manufactures pressure to comply, which is exactly what
    //     `docs/channel-briefing.md` establishes backfires: KAN-217's model
    //     quoted the pre-authorising sentence as the red flag that decided it.
    //
    // NOT IN THE `instructions` STRING, deliberately, and that asymmetry is the
    // one thing this entry cannot enforce. Every token of `instructions` is paid
    // on every request of every agent forever, and this probe runs a handful of
    // times a day; a session that has drifted from its brief and declines is
    // reported as a non-answer, which is the designed-for outcome rather than a
    // wrong one. So H-12's "if you change one, read the other" does not extend
    // here — recorded so nobody reads the gap as an oversight.
    //
    // WATCH IT GO RED AT THE SPOT THAT MEANS SOMETHING — delete the half an
    // editor would call redundant, not the whole section:
    //   perl -0pi -e 's/\*\*Declining is recorded as a non-answer.*?expected\.\n//s' prompts/task.md
    //   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, task.md only
    //   git checkout -- prompts/task.md
    // One pattern fails and two pass, in the one file, with the probe still
    // named and still described — which is the version of this brief that turns
    // a described probe into an obligation.
    //
    // WHAT IT CANNOT CHECK: whether an agent that has read it then answers. That
    // is a question about a model. WHO COVERS IT:
    // `daemon/scripts/probe-channel-liveness.mjs`, a live experiment rather than
    // a CI check, and the drought counter on the running daemon's own record —
    // which is the mechanism noticing its own brief has stopped working, and is
    // indistinguishable there from the client having broken. A green run here is
    // never evidence that agents answer.
    //
    // THIS ENTRY WAS `H-15` ON `main` AND COLLIDED WITH KAN-262'S (KAN-241,
    // renumbered here to H-17). The second such pair on the trunk in one day —
    // KAN-262's landed at `2a259d6`, this one at `91b73a3` — and the id stays
    // with whichever landed first. Two collisions in a day is not bad luck: the
    // next free number is read off a file that several branches are extending
    // at once, and each is correct in isolation. Filed as KAN-268.
    id: 'H-17',
    title: 'the channel liveness probe is named in the brief, with its ask and with declining held open',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          /channel\s*\n?\s*liveness probe/i,
          /two halves of a token/i,
          /recorded as a non-answer and not as a fault/i,
        ],
      ])
    ),
  },
  {
    // KAN-306. Two halves, and the sweep insists on both in every prompt
    // because carrying either one alone produces a false belief:
    //
    //   - The MARKER, without which the rule is unusable. An approver that does
    //     not know the grammar posts prose, the gate stays red, and the task
    //     agent is blocked by a check nobody can satisfy.
    //   - The FORGERY LIMIT, without which the rule is over-trusted. This epic's
    //     defect has a shape — *an artifact whose sentence claims more than its
    //     mechanism covers* — and "approval is now enforced" is exactly that
    //     sentence. It is enforced against omission and staleness and against
    //     nothing else, because every agent is the same GitHub user.
    //
    // The second is the one that will get dropped by a future editor tidying
    // for length, which is precisely why it is inventoried rather than trusted
    // to survive on its own.
    // KAN-321 ADDED THE FOURTH PATTERN, and it is the one whose absence is
    // silent rather than loud. The other three fail visibly: an approver that
    // does not know the grammar posts prose and the check stays red, which
    // somebody chases. This one fails the other way — an approver that fences
    // its marker, as every prompt here used to SHOW the marker fenced, gets a
    // red check about a comment that visibly contains the line. Without the rule
    // in the prompt, the mechanism is stricter than the documentation, which is
    // this epic's own defect shape pointed backwards.
    id: 'H-18',
    title: 'the approval marker: head-pinned, signed, required, asserted not quoted — and blind to forgery by construction',
    //
    // Three prompts and not `PROMPTS`: a `confluence` workspace writes pages,
    // opens no pull request and approves nobody's, so requiring the marker
    // there would be inventorying a rule its reader can never act on.
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [/BUTCHR-APPROVAL:/, /BUTCHR-APPROVER:/, /approval-recorded/, /forgery/i, /code fence/i],
      ])
    ),
  },
  {
    // The half of KAN-237 that is specific to the agent who now presses the
    // button: dozens of tickets predate the change and were deliberately not
    // mass-edited, so a task agent will meet the old rule on its own ticket and
    // has to be told which wins.
    // KAN-242 added the third pattern, and it is a limit rather than a
    // restatement. *"The prompt wins"* is true of a stale ticket and false of a
    // stale prompt, and this bullet is where an agent meets the sentence — so
    // the bullet is where the limit has to sit, not only in the snapshot
    // section above it. Without it the two rules read as agreeing while
    // pointing opposite ways: H-9 says trust this file, H-16 says this file is
    // the copy nobody refreshes. They are reconciled by the scope of the
    // comparison — a *ticket*, never the repository — and that clause is the
    // reconciliation.
    id: 'H-9',
    title: "an older ticket's standing rules are stale; the prompt wins over the ticket, and not over `origin/main`",
    carriedBy: {
      'prompts/task.md': [
        /when the two disagree, the prompt wins/i,
        /you merge after approval/i,
        /a comparison against a ticket, never against the repository/i,
      ],
    },
  },
  {
    // KAN-242. The rule about the file the rules are written in — and the only
    // entry here whose subject is this sweep's own blind spot. Every other rule
    // is kept honest by `prompts/*.md` being read; this one exists because
    // being *present in the file* and being *in the agent's head* came apart.
    //
    // A brief is rendered at activation (router.ts, inside `if (!session)`) and
    // written once (herdr.ts). Nothing refreshes it while the agent lives, and
    // — the half that makes refreshing it useless — nothing makes the agent
    // re-read it if something does. `task/KAN-234` sat In Review for two and a
    // half hours obeying a merge rule superseded 81 minutes earlier. It was not
    // disobeying its prompt; it was obeying it exactly.
    //
    // WHY THIS IS POLICED AT ALL, GIVEN THE FIX IS PROSE. Because the fix *is*
    // prose: there is no mechanism to break, so there is nothing that goes red
    // when it is removed. Deleting this section restores the two-hour defect in
    // full and every other check in this repository stays green — including,
    // before this entry existed, the sweep whose entire job is keeping the
    // prompts honest.
    //
    // SIX PATTERNS, AND THE SECOND IS THE ONE THAT MATTERS. `{{PROMPT_PROVENANCE}}`
    // is what the daemon substitutes the commit and the two-command check into
    // (`PROVENANCE_VARIABLE`, daemon/src/prompt.ts). Strip *only* that line and
    // the section still reads perfectly — the story, the trigger, the authority
    // ordering, all intact — while "run that check" now names no check and no
    // commit. That is this epic's recurring defect wearing its best costume: an
    // artifact whose sentence claims more than its mechanism covers, degrading
    // toward looking finished. A reviewer skimming for the argument would pass
    // it.
    //
    // The other four are each a half the rule cannot ship without:
    //   - the heading — without it there is no section to point `resume.ts` at.
    //   - `nothing refreshes it while you run` — the fact. Everything else here
    //     is advice hanging off it.
    //   - the trigger, quoted in full. "Check sometimes" is not actionable, and
    //     an agent that reads it as "check on every action" will stop working;
    //     the sentence names the exact moment, which is what makes the cost two
    //     commands rather than a habit.
    //   - `It does **not** extend to` + `origin/main` — the correction to *"this
    //     file wins"*. THIS IS THE COMPOUNDING FACTOR AND IT IS WHY THE TICKET
    //     WAS URGENT: without it the prompt still directs an agent to trust the
    //     one copy nobody refreshes over a ticket that may well be newer, and
    //     the mitigation for stale tickets goes on pointing at the stale thing.
    //     H-9 is the bullet it corrects; the two entries have to move together.
    //   - `not evidence about you` — the mtime trap, and the aside a tidier
    //     drops first. Every activation re-renders this file, so a restart
    //     rewrites it under a running agent that will never re-read it: the
    //     disk copy is fresh, the context is stale, and `stat` reports the
    //     restart. Drop this sentence and the next post-mortem re-runs
    //     KAN-242's own `stat` recipe and concludes the fleet is fine.
    //
    // WATCH IT GO RED AT THE SPOT THAT MEANS SOMETHING. R-1's docblock argues
    // why a merge-base red is the weak evidence — it shows only that the script
    // reacts to a wholly different file. The strong red is the plausible
    // regression: an editor keeps the whole argument and drops the mechanism.
    //   perl -0pi -e 's/^\{\{PROMPT_PROVENANCE\}\}\n\n//m' prompts/task.md
    //   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, task.md only
    //   git checkout -- prompts/task.md
    // One pattern fails and five pass, in one file, with the section still
    // sitting there reading as though the job were done.
    //
    // WHAT THIS ENTRY CANNOT CHECK, and it is the same gap H-12 has: it proves
    // the four files carry the section. Whether an agent that has read it then
    // *runs the check and follows the newer rule* is a question about a model
    // and cannot be asked by a regex. WHO COVERS IT:
    // `daemon/scripts/probe-stale-rule-compliance.mjs`, which activates two
    // real agents, moves a governance rule under both after they were briefed,
    // and reads which rule each obeyed off the filesystem. It is a live
    // experiment, not a CI check, so a green run here is never evidence that
    // the section works — only that it is present.
    //
    // THIS ENTRY WAS `H-14` ON `main` AND COLLIDED WITH KAN-212'S, WHICH WAS
    // ALREADY THERE (KAN-241, renumbered here to H-16). Both were live on
    // `origin/main` at once — KAN-212's from `3578774`, this one from
    // `4e7183a` — and every check in the repository was green over it. It is
    // the third instance of this collision in three days and the first that no
    // human caught: `2a24912` was found by `epic/KAN-39` grepping on a hunch,
    // and this one by the duplicate-id leg added below. Where both sides are
    // already on the trunk the id stays with whichever landed first, which is
    // also the cheaper edit here — KAN-212's number is quoted throughout its
    // own docblock and this one appeared only in the `id:` field.
    id: 'H-16',
    title: 'the brief is a snapshot: the commit it came from, when to re-check, and that it does not outrank `origin/main`',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          /^## This brief is a snapshot, and it can be out of date$/m,
          /\{\{\s*PROMPT_PROVENANCE\s*\}\}/,
          /nothing refreshes it while\s+you run/i,
          /at the moment a rule in this file is about to decide what you\s+do/i,
          /It does \*\*not\*\* extend\s+to `origin\/main`/i,
          /not evidence about you/i,
        ],
      ])
    ),
  },
  {
    // KAN-262. The disk half of the story KAN-151: every worktree ran its own
    // `npm install` for an identical lockfile, so 119 workspaces held 119
    // private copies of the same two trees — 15G, against 296M per workspace of
    // which twelve kilobytes was the agent's own state.
    //
    // WHY THIS NEEDS A CARRIAGE RULE AT ALL, when the mechanism is a script
    // somebody could just run: the mechanism is only ever reached by an agent
    // *following the prompt*. Nothing in the daemon installs dependencies —
    // `spawnSession` creates the workspace directory and stops — so the worktree
    // and the install are the agent's own doing, out of this file. Delete the
    // step here and every assertion in
    // `daemon/scripts/verify-workspace-deps-are-shared.mjs` stays green while
    // every new workspace silently goes back to a private 296M copy, because
    // that script links its own fixtures and never observes an agent. This
    // entry is the half that watches the instruction, and it is why that script
    // names H-15 in its header as its coverage.
    //
    // TASK ONLY, DELIBERATELY. `prompts/story.md` tells a story agent to read
    // the shared clone directly and that it needs "no worktree of your own";
    // `prompts/epic.md` carries no repository setup. Requiring the step in
    // either would be requiring an instruction its reader can never act on —
    // and would be "fixed" by pasting an install step into a prompt whose agent
    // must not install anything.
    //
    // Three phrases, because the rule has three halves and shipping the first
    // alone teaches a step without the two facts that make it safe to follow:
    // run it *instead of* `npm install`, deletion is cheap, and an in-place
    // edit is refused rather than silently shared.
    id: 'H-15',
    title: 'workspace dependencies are linked from the shared store, not installed privately',
    carriedBy: {
      'prompts/task.md': [
        /link-workspace-deps\.mjs/,
        /Run it instead of `npm install`, not after it/i,
        /read-only/i,
      ],
    },
  },
  {
    // KAN-314. The prompt mandated the red drive at `:96` — *break the thing it
    // guards, watch it go red* — and said nothing about the one way a red drive
    // silently does not happen. `epic/KAN-203` grepped for it (stale dist,
    // build must succeed, rebuild before, failed build, `npm run build`) and
    // found nothing in any of the four prompts.
    //
    // FOUR PHRASES, BECAUSE THE RULE HAS FOUR HALVES AND ANY THREE MISLEADS:
    //   - `did not run on your mutation` — the rule itself. Without it there is
    //     no rule, only a worked example.
    //   - `both outcomes mislead` — the half that makes this worse than a
    //     wasted step. An agent that keeps only the rule assumes a *failed*
    //     proof after a failed build is still a failure it can trust, and it is
    //     not: the fail is about the old build too.
    //   - `older than `src`` — the STALE-DIST case, which had no failed build
    //     at all. Drop it and the rule reads as being about compile errors,
    //     which is the smaller and louder half; the #127 incident would still
    //     pass every word of what remained.
    //   - `the compiler did` — the worked case's actual point. The misleading
    //     outcome there was a *red* that credited the wrong mechanism, and that
    //     is the case people do not anticipate. A prompt that keeps the story
    //     and drops this clause has kept an anecdote and lost its moral.
    //
    // All three PR-opening prompts and not `PROMPTS`: a `confluence` workspace
    // writes pages, builds nothing and runs no proof, so inventorying it there
    // would be requiring a rule its reader can never act on. It is in the two
    // reviewer prompts as emphatically as in `task.md` because both recorded
    // incidents happened to a reviewer at the moment of approving, not to an
    // author at the moment of proving.
    // THREE MORE PATTERNS, ADDED AT `epic/KAN-39`'s REVIEW OF #136, and they
    // are the rule's own defect turned into assertions. As first written the
    // rule said a proof after a failed build is a verdict about the old build,
    // *whatever it prints* — which is true of a proof that imports from `dist`
    // and FALSE of one that reads source as text. That is this epic's signature
    // defect (a sentence claiming more than its mechanism covers) committed by
    // the rule about not committing it, and it was found by applying the rule
    // to a real PR and watching it give the wrong answer: at review of #137 a
    // failed build would have sent a valid red from a text-reading proof
    // (`verify-notifications-never-type.mjs`) into the bin.
    //
    //   - `reads source as text` — the qualifier. Without it the rule imposes a
    //     re-run on every static proof in the tree, and the cost of THAT error
    //     is invisible, because discarding good evidence looks like caution.
    //   - `--static-only` — the MIXED case, which is the one that fails toward
    //     false confidence rather than away from it. 17 of 81 scripts under
    //     `daemon/scripts` both import `dist` and read `src`; after a failed
    //     build their overall exit code is a blend of a real verdict and a
    //     stale one. An agent that has the qualifier and not this reads the
    //     blend as static and trusts it.
    //   - `PIPESTATUS` — the trapdoor. The rule tells you to confirm the build
    //     exited 0, and the obvious idiom (`npm run build | tail -5`) reports
    //     `tail`'s status instead. Measured twice on this board in one day, and
    //     once by this ticket's own implementer. An instruction whose standard
    //     idiom silently defeats it is not an instruction.
    id: 'H-22',
    title: 'a proof run after a failed build — or over a stale `dist` — is a verdict about the old build',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /did not run on your mutation/i,
          /both outcomes mislead/i,
          /is not older than `src`/i,
          /the compiler did/i,
          /reads source as text/i,
          /--static-only/,
          /PIPESTATUS/,
        ],
      ])
    ),
  },
  {
    // KAN-314, second half — `epic/KAN-203`'s framing, which was written down
    // nowhere. Inventoried despite being explicitly *guidance rather than a
    // rule*, and the distinction is worth stating because it changes what this
    // entry asserts: it pins that the guidance is PRESENT and that it is
    // SCOPED, never that any particular change obeyed it. A future editor
    // tidying for length would drop the scoping clause first — it reads like
    // hedging — and what is left is an absolute instruction to type things that
    // cannot be typed, which is a worse artifact than the one we started with.
    //
    // Hence the third pattern. The first two are the guidance; `guidance, not a
    // rule` is the limit, and the limit is the part being protected.
    id: 'H-21',
    title: 'check the instrument answered the question you asked — filter the CI run by workflow and head',
    // KAN-314, added at `epic/KAN-39`'s review of #136. The third shape of
    // H-22's failure, and the one that is not about builds: `gh run list
    // --limit 1` reads the newest run of ANY workflow, and this repository has
    // three. `epic/KAN-203` deployed on a false green off that row.
    //
    // (Both references here said H-19 until the merge of 2026-08-11: KAN-284
    // landed that id first, so KAN-314's entry moved to H-22 and every
    // reference outside it moved with it, per the `2a24912` precedent recorded
    // in `rule-inventory.md`.)
    //
    // DELIBERATELY NOT FOLDED INTO H-22, and not generalised into one rule
    // about epistemics. The approver's own framing at review — *"a sharp rule
    // about builds beats a vague rule about epistemics"* — is the reason. The
    // shared shape is worth one sentence and no more, because the FIX differs
    // every time and is always specific: name the build, name the workflow,
    // name the head. A single abstract rule would be obeyed by nobody at the
    // moment it mattered, which is the only moment a rule is worth anything.
    //
    // The `--workflow=ci.yml` pattern is the concrete instruction and would be
    // the first casualty of a rewrite toward the abstract; `false green` names
    // the outcome, so a prompt keeping the command and losing the reason cannot
    // pass either.
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [/--workflow=ci\.yml/, /the question you asked/i, /false green/i],
      ])
    ),
  },
  {
    id: 'H-20',
    title: 'prefer the type to the assertion where the choice exists — scoped, not absolute',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /Prefer the type to the assertion/i,
          /unrepresentable state cannot be introduced at all/i,
          /guidance, not a rule/i,
        ],
      ])
    ),
  },
  {
    // KAN-284. THE GUARDIAN POKE IS AN OPERATIVE RULE BECAUSE IT ARRIVES
    // UNANNOUNCED OTHERWISE, AND AN UNANNOUNCED SCHEDULED MESSAGE IS ONE A
    // MODEL IS RIGHT TO REFUSE.
    //
    // KAN-217 is the measurement: a channel probe pushed at a session that had
    // not been told to expect one was named as probable prompt injection and
    // declined — correctly, and from outside indistinguishable from a broken
    // transport. For a guardian that failure is expensive in a way the probe's
    // was not: the poke fires every thirty minutes, the guardian declines every
    // one of them on the merits, the delivery record stays green because the
    // frames really are being delivered, and NOBODY SWEEPS THE FLEET. Every
    // surface reads healthy throughout. That is the feature shipping silently
    // dead, which KAN-284's own description names as the risk that decides
    // whether it is real.
    //
    // Carried by all three because the guardian is a POINTER at any existing
    // agent — the human, 2026-08-11: "pointed to an existing agent, not a whole
    // new agent" — so an epic, a story or a task can be it, and the poke tells
    // its recipient the expectation is "in your own brief". A prompt without
    // this section makes that sentence a promise the brief does not keep, which
    // is worse than not pointing at it.
    //
    // The patterns are the clauses that carry weight, not the prose around
    // them: that the poke is expected and daemon-sent; that its cadence is an
    // operator setting rather than a number the brief can promise; that it is
    // ADDITIONAL rather than a replacement for a loop the human separately
    // asked for (`epic/KAN-203`'s correction, 2026-08-11); and that a delivered
    // poke is not evidence the sweep was right, which is the limit the
    // recipient has to hold as much as the board does.
    //
    // KAN-351 TOOK THE CADENCE OUT OF THIS ENTRY, AND THE REASON IS THE ENTRY'S
    // OWN SHAPE RATHER THAN A DISLIKE OF NUMBERS. Until 2026-08-12 the second
    // pattern read `/pokes you every 30 minutes/i` — a literal that
    // `DEFAULT_POKE_INTERVAL_MS` in `daemon/src/guardian.ts` owns. That pins a
    // *value* where every other pattern here pins a *rule*, and it fails in
    // both directions at once (`docs/doc-constant-drift.md`, F-1). Move the
    // constant and leave the prompts, and nothing notices: the whole fleet is
    // briefed with a false number. Move the constant and CORRECT the prompts,
    // and this required check goes red at the contributor who fixed the lie —
    // whose cheapest way out is to put the lie back. That second half is not a
    // prediction; it was reproduced on `6fc28d9` before the repair, three reds
    // for three corrected prompts, and the run is in KAN-351's PR body.
    //
    // The repair is not a looser pattern for the number (`/every \d+ minutes/`
    // would still let a wrong number sit unnoticed, and still pins a shape the
    // rule does not need). The prompts stopped naming an interval at all, which
    // is the honest sentence anyway: `config.intervalMs` is operator-settable
    // and clamped, so "every 30 minutes" was true of the default and of no
    // fleet that overrode it. THE PAIR IS GONE RATHER THAN GUARDED — there is
    // now no prompt sentence for the constant to drift from, which is why this
    // needed no new pin and why `verify-doc-constant-pins.mjs` still stops at
    // `docs/`. What the entry asserts instead is the invariant that survives
    // any cadence: the poke is scheduled, it comes from the daemon, and how
    // often is a setting you read with `butchr_guardian` rather than a fact the
    // brief carries.
    // RENUMBERED FROM H-18 TO H-19 ON 2026-08-11, and the collision is the point
    // rather than an inconvenience. KAN-306 landed its own `H-18` on `origin/main`
    // while this branch was in flight, which is the fifth such collision and
    // exactly what `rule-inventory.md` exists to catch — KAN-268 is the ticket
    // for the fact that detecting it is not preventing it, since the next free
    // number is read off a file several branches are extending at once and each
    // author is correct alone. KAN-306 landed first and keeps the number.
    id: 'H-19',
    title: 'the guardian poke is expected, is additional, and proves only that it was delivered',
    carriedBy: {
      'prompts/epic.md': [
        /### The guardian poke/,
        /the daemon pokes you on a schedule/i,
        /interval is an operator setting/i,
        /additional to that work and does not outrank it/i,
        /retires any other loop you were told to run/i,
        /says nothing about whether your decisions were right/i,
      ],
      'prompts/story.md': [
        /### The guardian poke/,
        /the daemon pokes you on a schedule/i,
        /interval is an operator setting/i,
        /additional to that work and does not outrank it/i,
        /retires any other loop you were told to run/i,
        /says nothing about whether your decisions were right/i,
      ],
      'prompts/task.md': [
        /### The guardian poke/,
        /the daemon pokes you on a schedule/i,
        /interval is an operator setting/i,
        /additional to that work and does not outrank it/i,
        /retires any other loop you were told to run/i,
        /says nothing about whether your decisions were right/i,
      ],
    },
  },

  // ------------------------------------------------------------------ KAN-399
  //
  // THE FIVE ENTRIES BELOW ARE ONE TICKET'S WORK AND ARE DELIBERATELY NOT ONE
  // ENTRY. H-19 above says what the guardian poke **is** — scheduled,
  // daemon-sent, additional, proving only its own delivery. Every word of it is
  // about trusting the message, and a guardian that has read all of it knows
  // nothing about **what to look at**. These five are that half, and they are
  // separable in the way that matters to this file: each one can be dropped by
  // a later editor without disturbing the other four, and each drop produces a
  // different wrong sweep. Folding them into a single entry would mean one
  // `carriedBy` list where losing any phrase reads as losing "the triage",
  // which tells whoever meets the red nothing about which judgement went
  // missing.
  //
  // ALL THREE PROMPTS, FOR H-19'S OWN REASON AND NOT A NEW ONE: the guardian is
  // a *pointer* at an existing agent of any type, so an epic, a story or a task
  // can hold the role, and a rule it must have read **before it acts** has to
  // be in the file it actually reads. A cross-reference to a sibling prompt is
  // a second read that will not happen under a poke. `prompts/confluence.md` is
  // excluded for the same reason H-18 and H-22 exclude it — a page workspace
  // holds no `butchr_*` tooling and can sweep nobody, so inventorying it there
  // would require a rule its reader can never act on.
  {
    // KAN-399 §1. THE RULE IS NOT "THE STATUS FIELD IS WRONG" — IT IS THAT THE
    // FIELD CANNOT SEPARATE THE TWO CASES, WHICH IS WHY THE MEASUREMENT IS
    // PINNED ALONGSIDE IT. `epic/KAN-203` swept nine agents on 2026-08-14: two
    // idle at a prompt while the board reported them staffed, seven genuinely
    // mid-turn, and `herdrStatus` reading `done` for both idle ones — where
    // `done` is also what an agent reads while legitimately awaiting review.
    //
    // FOUR PHRASES, AND THE SECOND IS THE ONE A TIDIER DROPS FIRST. It reads as
    // an aside about a field name; without it the rule reads as *the status
    // field is unreliable*, which a reasonable editor "fixes" by reaching for a
    // better field. There is no better field: the pane is the instrument, and
    // the reason is that `done` is ambiguous rather than wrong.
    //   - `the pane does` — the rule.
    //   - `herdrStatus` + the ambiguity of `done` — why no field substitutes.
    //   - `esc to interrupt` — the actual tell, without which the rule names an
    //     instrument and not a reading of it.
    //   - `tail every agent` — the act. A rule stated and never asked for is a
    //     paragraph.
    id: 'H-23',
    title: 'the status field cannot separate idle from mid-turn; the pane can — so tail every agent',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /The status field does not tell you; the pane does/i,
          /herdrStatus/,
          /also what an agent reads while legitimately awaiting review/i,
          /esc to interrupt/,
          /tail every agent/i,
          /never substitute the status field for it/i,
        ],
      ])
    ),
  },
  {
    // KAN-399 §2, AND THE ONE THE TICKET NAMES AS SAFETY RATHER THAN DILIGENCE.
    // A sweep is a read followed by a send, and the send is the dangerous half:
    // a composer send to an agent sitting at a selection dialog **answers the
    // dialog** with whatever option is highlighted. CrabCast's `task/KAN-375`
    // reproduced it with a discriminating second arm — highlight moved, *"No,
    // exit"* selected, agent terminated. Tailing is not care taken before a
    // message; it is the only thing standing between a nudge and a kill.
    //
    // NINE PHRASES, BECAUSE THIS ENTRY GUARDS THREE THINGS THAT DIE SEPARATELY:
    //
    //   * THE FRAMING (`SAFETY rule, not diligence`, `terminated the agent`,
    //     `only thing between a nudge and a kill`). The ticket's AC3 is that a
    //     reader must come away knowing a send can kill an agent, and framing
    //     is exactly what a length-tidy removes: the mechanism survives as
    //     "tail before you send", which reads as politeness and is obeyed like
    //     politeness.
    //   * HAZARD (b), THE COMPOSER SUGGESTION (`client-suggested composer
    //     text`, `rotate the LaunchDarkly token now`, `crossed by a **reader**
    //     rather than by a caller`). An idle pane holds the client's guess at
    //     what the agent needs next, and it is not the human. The specimen is
    //     load-bearing rather than colour: `epic/KAN-59`'s idle composer
    //     proposed rotating a live production credential — the one action the
    //     human has reserved to themselves — so the failure here is not a
    //     wasted turn, it is a guardian performing a reserved action and
    //     reporting it as done work. The `reader rather than caller` clause is
    //     what ties it to *credentials stop at the daemon*: that invariant is
    //     enforced in code against callers, and this is the leg nothing
    //     enforces. Drop the clause and the hazard reads as ordinary
    //     misdirection.
    //   * THE POSITIVE SPECIMEN (`human mid-sentence in their composer`,
    //     `taught only by its violations reads as paranoia`). This was a real
    //     defect in the ticket as filed and `epic/KAN-39` corrected it in
    //     comment `12120`: every other specimen in the brief is somebody
    //     getting it wrong, and a rule taught only by its violations reads as
    //     blame-avoidance rather than as a judgement with a correct form.
    //     `story/KAN-117` re-checked a pane before sending, saw the human
    //     mid-sentence — half a word, cut off — and held, twice, unprompted.
    //     It is pinned because it is the half that looks like an anecdote and
    //     is the only demonstration of the rule succeeding.
    //
    // WHAT THIS ENTRY CANNOT CHECK, and it is the gap H-12 and H-16 have in the
    // same shape: it proves the three files carry the hazards. Whether a
    // guardian that has read them *tails before sending* is a question about a
    // model, and no regex asks it. WHO COVERS IT: nobody mechanical, and there
    // is no live probe for this one — the observation that would settle it is a
    // reader comparing a guardian's sweep comment against the panes it swept.
    // The sweep summary H-19 already requires is what makes that possible, and
    // it is the whole of the coverage. Do not infer more.
    id: 'H-24',
    title: 'tail-first is a safety rule: a composer send can answer a dialog and kill an agent, and idle composer text is the client, not the human',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /SAFETY rule, not diligence/,
          /answers the dialog/i,
          /terminated the agent/i,
          /only thing between a nudge and a kill/i,
          /client-suggested composer text, and it is not the human/i,
          /rotate the LaunchDarkly token now/i,
          /crossed by a \*\*reader\*\* rather than by a caller/i,
          /human mid-sentence in their composer/i,
          /taught only by its violations reads as paranoia/i,
        ],
      ])
    ),
  },
  {
    // KAN-399 §3. THE TRIAGE, AND THE REASON IT IS NOT "IDLE VERSUS WORKING".
    // The human's instruction had two halves given three days apart — *"if they
    // are waiting, tell them to continue"* and then, after watching the first
    // over-applied, *"if it makes sense for them to be idle, then you should
    // still check in, but you don't have to poke them into working"*. The
    // second is the whole content of this entry: the question is not whether an
    // agent is moving, it is whether it has an **unowned next action it does
    // not know about**.
    //
    // FIVE PHRASES. The table is what a tidier keeps — it looks like the
    // content — so the two sentences hung off it are pinned separately:
    //   - `unowned next action it does not know about` — the question itself,
    //     and the only part that is portable to a case the table does not list.
    //   - `CORRECTLY IDLE` + `poke, and say what changed` — the two columns,
    //     matched individually so that losing one column is not read as a
    //     wording change to the other.
    //   - `correctly-idle agent is not a failure` — the half that makes the
    //     rule *stop* somebody. Without it the table is a diagnostic and the
    //     default is still to send.
    //   - `manufactures churn` — the cost, which is what the human's third
    //     sentence was actually about.
    id: 'H-25',
    title: 'the triage is not idle-versus-working: does this agent have an unowned next action it does not know about',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /unowned next action it does not know about/i,
          /CORRECTLY IDLE/,
          /poke, and say what changed/i,
          /correctly-idle agent is not a failure/i,
          /manufactures churn/i,
        ],
      ])
    ),
  },
  {
    // KAN-399 §4. The smallest of the five and the one with the least prose to
    // hide behind, which is why it is inventoried rather than trusted: it is a
    // single sentence, and a single sentence is what a length pass deletes.
    //
    // An agent idles because it believes it is finished. A generic *"continue"*
    // is answered generically — it asks the agent to re-derive its own state,
    // which is the state that produced the idle. Four phrases: the instruction,
    // the reason it is needed, the failure mode of the generic version, and the
    // thing a poke has to actually say.
    id: 'H-26',
    title: 'when you do poke, name the actual work — a generic "continue" produces a generic answer',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /name the actual work/i,
          /believes it is finished/i,
          /produces a generic answer/i,
          /why it is now theirs/i,
        ],
      ])
    ),
  },
  {
    // KAN-399 §5. THE SENTENCE THE TICKET ASKS TO BE CARRIED ABOVE THE OTHERS,
    // and it is `epic/KAN-203`'s, volunteered from a failure it measured on
    // itself rather than observed on somebody else. It applied the human's
    // first instruction before the human had given it the third and got
    // `epic/KAN-39` wrong: that agent had just finished a turn having filed
    // three tickets and would have picked the PRs up when they appeared. The
    // check-in was warranted — a ruling was genuinely owed — and the
    // prioritised worklist sent with it was noise. The same sweep got
    // `story/KAN-117` right by *asking* whether it was finished or blocked and
    // offering to carry a blocker.
    //
    // FOUR PHRASES, AND THE LAST IS THE ONE THAT KEEPS THIS FROM BEING
    // UNFALSIFIABLE. *"A sweep that finds nothing to poke is the sweep
    // working"* is what stops a guardian reading an empty sweep as a sweep that
    // failed and going looking for something to send — which is precisely the
    // pressure that produced the work order. It pairs with H-19's requirement
    // to post a summary *including when the sweep finds nothing*: that entry
    // makes the empty sweep visible, this one makes it correct.
    //   - `check-in is always right; the work order usually is not` — the rule.
    //   - `prioritised worklist` — the specimen's actual defect, named. Without
    //     it the rule has no worked case and reads as a preference.
    //   - `That is a check-in. The other was a work order` — the distinction
    //     made operable. A reader who has the rule and not this cannot tell
    //     which of their own two messages was which.
    //   - `sweep that finds nothing to poke is the sweep working` — the
    //     outcome the triage is for.
    id: 'H-27',
    title: 'the check-in is always right; the work order usually is not — and a sweep that finds nothing to poke is the sweep working',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [
          /check-in is always right; the work order usually is not/i,
          /prioritised worklist/i,
          /That is a check-in\. The other was a work order/i,
          /sweep that finds nothing to poke is the sweep working/i,
        ],
      ])
    ),
  },
  {
    // KAN-388. THE CLASS THE OTHER ENTRIES HERE ARE INSTANCES OF: an instrument
    // structurally incapable of returning the answer it was asked for, whose
    // null result is then read as an answer about the world. Two faces, one
    // defect — **an empty result is a claim about your search**, and **a green
    // is a claim about your check**.
    //
    // WHY A PROMPT RULE. Eight instances across three agents in roughly
    // twenty-four hours on 2026-08-13/14, every one of them already on the board
    // as a ticket comment or a PR thread, which is the problem rather than the
    // record: the rule was being re-derived from incidents at the cost of an
    // incident each time. Its failure mode is an agent drawing a wrong
    // conclusion in the next thirty seconds from a well-formed empty output, so
    // by `prompts/epic.md`'s own boundary test — *must an agent have read it
    // before it acts, or it acts wrongly?* — it is `prompts/<type>.md` and not a
    // design-doc page. The incident belongs on a page; the rule belongs here.
    //
    // ALL FOUR PROMPTS, AND THE COUNTER-ARGUMENT IS THE TICKET'S OWN: *three
    // copies of a rule is three things that drift.* Decided for four anyway,
    // deliberately:
    //   - The class is instrument-shaped rather than role-shaped. An epic greps
    //     the board, a story greps the repo, a task greps the source tree, a
    //     confluence agent runs CQL against a space, and all four read a green
    //     off a check they wrote. There is no agent type here whose reader
    //     cannot act on it — which is the test every file-set decision in this
    //     array is made by, and the reason H-15 and H-11 are `task.md` only.
    //   - **All four already carry two narrower members of this same family** —
    //     H-5's write side (*a response is a claim about the request*) and the
    //     read-side pagination paragraph beside it. A file set smaller than four
    //     would leave a prompt carrying the instances and not the class.
    //   - Drift is exactly what this entry buys. The phrases are pinned in all
    //     four, so a rewrite that drops the rule from one file goes red before
    //     review. That is the same answer already given for H-3, H-4, H-5, H-12,
    //     H-13, H-16 and H-17.
    //
    // PLACEMENT — a review question this script cannot answer, so it is recorded
    // rather than asserted: the rule sits immediately after H-5's section in all
    // four files, next to the two narrower siblings above, as its own `###`
    // section in `epic`/`story`/`confluence` and as the closing bullet of
    // *3. Task Execution & Resolution* in `task.md`, which is that file's form
    // at that depth and puts it directly before the proof rules of section 4
    // that are the green-face instances.
    //
    // SEVEN PATTERNS, EACH A HALF THE RULE CANNOT SHIP WITHOUT:
    //   - `claim about your search` / `claim about your check` — the two faces.
    //     Either alone is a rule half the size it claims to be, and dropping the
    //     second is the likelier tidy-up: it is what extends this from greps to
    //     proofs, which is where instances 3, 4 and 7 lived.
    //   - `what the instrument would have printed` — **the act**, and without it
    //     this is exhortation. The ticket is explicit that the operative form
    //     must be actionable rather than exhortative, and an entry that pinned
    //     only the claim would hold a sentiment in place while the instruction
    //     evaporated.
    //   - `could have reached you` — the half that makes the act answerable by
    //     the world rather than by imagination. "Say what it would have printed"
    //     is satisfiable by inventing a plausible string; confirming that string
    //     could have arrived is the part that fails when the instrument is the
    //     wrong shape.
    //   - `no failing branch` — the dangerous sub-shape, and the first casualty
    //     of an edit for length because it reads as rhetoric. A check that could
    //     only ever return the hoped-for answer is not a weak check; it is a
    //     check that does not exist while appearing to. Instances 3, 4 and 7
    //     were all of this kind and none of them looked broken.
    //   - `runs as its own command` — INSTANCE #9's sub-shape, contributed by
    //     `epic/KAN-203` on this ticket and taken because the eight do not cover
    //     it. Instances 3, 4 and 7 are checks with no failing branch reachable
    //     by the world; this is a check with no branch reachable at all, because
    //     it never ran — `cmd-a && your-check || echo "not there"` fires the
    //     reassuring branch off `cmd-a`'s exit status, so an unrelated upstream
    //     failure is rendered as a substantive finding about the filesystem, and
    //     it fails toward *absent*, which is the comfortable answer. It is the
    //     same defect as H-22's `PIPESTATUS` trapdoor — an exit status read off
    //     the wrong process — and the generative cause is an economy: bundling
    //     the check onto another command to save a round trip. Pinned separately
    //     because it is the one half here that is a *procedure* rather than a
    //     claim, and a tidier cutting for length would take the procedure first.
    //   - `does not replace the sharp rule` — THE LIMIT, and it is load-bearing
    //     rather than a hedge. `epic/KAN-39` ruled at review of #136 that H-21
    //     must NOT be folded into H-22 nor either generalised into one rule
    //     about epistemics, because *a sharp rule about builds beats a vague
    //     rule about epistemics* and the fix differs every time. This entry does
    //     not disturb that ruling and must not be read as superseding it: what
    //     KAN-388 asks for is a floor for the instruments that have no sharp
    //     rule yet. Drop this clause and a later editor reads H-21 and H-22 as
    //     redundant with the general one and deletes them, which is a strictly
    //     worse artifact than the one we started with — and is this epic's own
    //     defect shape, committed by the rule against committing it.
    //
    // DELIBERATELY NOT PINNED: the two measurements in the prose. Every pattern
    // here pins a *rule*; a pattern over `270` or `-maxdepth 3` would pin a
    // *value* that the workspace tree owns, which is the failure KAN-351 removed
    // from H-19 and which fails in both directions at once — move the thing and
    // nothing notices, correct the prompt and this required check goes red at
    // the contributor who fixed it. The numbers are dated instance citations, of
    // the same species as H-22's "13 source files" and R-3's, and no assertion
    // depends on them.
    //
    // WATCH IT GO RED, AND FOR THIS ENTRY THAT IS AN ACCEPTANCE CRITERION RATHER
    // THAN A HABIT, BECAUSE A RULE ABOUT SELF-SATISFYING CHECKS MUST NOT BE
    // VERIFIED BY A SELF-SATISFYING CHECK. Two reds, and they answer different
    // questions:
    //
    //   1. The plausible regression — an editor keeps the claim and drops the
    //      instruction, which is the shape that degrades toward looking
    //      finished:
    //        perl -0pi -e 's/say what the instrument would have printed had the thing\nbeen there, and confirm that exact output could have reached you/say so/s'
    //          prompts/epic.md
    //        node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, epic.md only
    //        git checkout -- prompts/epic.md
    //      Two patterns fail and four pass, in one file, with the section
    //      heading and both faces of the claim still sitting there.
    //
    //   2. The self-satisfaction test, which is the one this entry owes. The
    //      rule's text also exists in THIS DOCBLOCK and in `rule-inventory.md`.
    //      Delete the rule from all four prompts, leave both of those intact,
    //      and the sweep must still go red in all four — proving the assertion
    //      is answered by `prompts/` and by nothing the machinery says about
    //      itself. Section 1 reads only the four `PROMPTS` paths, so this is
    //      structurally true; it was nonetheless run rather than reasoned, and
    //      the output is in KAN-388's PR body. Separately, all six patterns were
    //      confirmed to have **zero** matches across the four prompts at
    //      `origin/main` before the rule was written, so nothing pre-existing
    //      answers them either.
    //
    // WHAT THIS ENTRY CANNOT CHECK, AND THE TICKET IS EXPLICIT THAT IT MUST NOT
    // IMPLY OTHERWISE: that the class is closed. A prompt rule lowers the rate
    // and makes the defect no less reachable — six of the eight instances were
    // caught by another agent or by luck, and the prompt cannot make an agent
    // run the positive control any more than H-12 can make one act on a channel
    // event. WHO COVERS THE REST: nobody mechanical. It is the reviewer, and the
    // red drive, which is the only method on this board with a record of
    // catching this class — it caught instance #7.
    //
    // ID: H-23 THROUGH H-27 WERE ALREADY CLAIMED by `butchr/KAN-399` (PR #166)
    // while this branch was being written, so this is H-28. Read off that branch
    // rather than off the next free number in the inventory, which is the read
    // that produced five collisions in three days — KAN-268 is the ticket for
    // the fact that detecting a collision is not preventing one. Per the
    // `2a24912` precedent the id stays with whichever lands first; if KAN-399
    // lands after this, nothing moves, because nothing here overlaps it.
    id: 'H-28',
    title:
      'an empty result is a claim about your search and a green is a claim about your check — say what the instrument would have printed, and confirm it could have reached you',
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          /claim about your search/i,
          /claim about your check/i,
          /what the instrument would have printed/i,
          /could have reached you/i,
          /no failing branch/i,
          /runs as its own command/i,
          /does not replace the sharp rule/i,
        ],
      ])
    ),
  },
  {
    // KAN-466. `gh pr merge`'s exit code is not the merge's verdict, and the
    // fleet's two habitual ways of checking it are ONE reading taken twice.
    //
    // KAN-467 CORRECTED THE MECHANISM SENTENCE, NOT THE INSTRUCTIONS. The
    // original read as though every `gh pr merge` attempts a local branch
    // switch. It does not: `--delete-branch` is what adds the local step, and
    // it is the whole trigger. Measured 2026-08-15 with two throwaway PRs from
    // worktrees of the shared clone differing only in the flag — with `-d`,
    // exit 1 and `fatal: '<base>' is already checked out`; without it, exit 0
    // and no output. Two consequences worth keeping here, because both were
    // being taught wrongly:
    //   - A SURVIVING BRANCH IS THE ORDINARY OUTCOME OF A PLAIN MERGE. The old
    //     "a bad exit predicts a surviving branch" has the causality backwards
    //     and tells an agent its own correct reading is impossible.
    //   - THE 128 IS CAUSED BY THE BASE BRANCH BEING CHECKED OUT ELSEWHERE IN
    //     THE SAME CLONE, never by a worktree count. "201 worktrees" was a
    //     census of one machine, not a threshold.
    // Of the five instances originally cited, #180 passed no `-d`, printed
    // nothing and failed in no way; #183 and #194 reported `0` only because
    // they piped `gh` into `tail`. None of that weakens `.merged`, which is
    // why `only authority` stays pinned below.
    //
    // THE CORRECTED MECHANISM IS PINNED, AND IT TOOK A REVIEWER TO NOTICE IT
    // WAS NOT. KAN-467 first landed the correction with the original seven
    // patterns untouched — and every one of those seven lives in a paragraph
    // the correction did not touch. `epic/KAN-39` deleted the entire corrected
    // paragraph in review and this check still reported H-29 carried, while
    // the `title` above had begun *asserting* the corrected mechanism. An
    // inventory claiming a rule that nothing verifies is the exact defect this
    // ticket was filed about, reproduced one level up. The four patterns added
    // below guard the two new paragraphs so that deleting either fails at
    // least two of them:
    //   - `the whole trigger` + `checked out in another worktree of the same
    //     clone` — the mechanism paragraph: what causes the local step, and
    //     what makes it fail.
    //   - `ordinary outcome of a plain merge` + `never the number of
    //     worktrees` — the corollary paragraph: the half that kills the
    //     backwards causality, and the half that stops "201" being read as a
    //     threshold.
    // This is KAN-466's own argument for pinning both `not two votes` and
    // `one cause read twice` applied to KAN-467's text: a paragraph that reads
    // as background to instructions pinned elsewhere is what a length pass
    // removes first.
    //
    // WHY THIS IS `prompts/task.md` ONLY, AND THAT IS NOT AN OVERSIGHT: under
    // the 2026-08-08 governance the **task** agent merges. `prompts/epic.md`
    // §"You review and approve this epic's PRs; you do not merge them" and
    // `prompts/story.md`'s "the task agent merges its own PR" both say so, so
    // neither an epic nor a story agent ever runs this command. Listing them
    // here would require carrying merge mechanics in prompts whose own text
    // forbids the action — an entry green only because somebody pasted an
    // irrelevant paragraph. The *class* clause is a different question and is
    // argued on the ticket; H-28, its sibling, IS carried by all four.
    //
    // SEVEN PHRASES, AND THE SPLIT IS DELIBERATE — the ticket named three
    // things the wording must carry and observed that the third is the one
    // usually dropped, so the third gets two patterns of its own:
    //   - `only authority` — `.merged` off REST, the positive instruction. A
    //     rule that only says "the exit code lies" leaves the agent with no
    //     instrument at all.
    //   - `not two votes` + `one cause read twice` — the finding itself, which
    //     is the half `epic/KAN-203`'s eleven staffing briefs did NOT carry.
    //     Their wording ("a bad exit predicts a surviving branch") stated the
    //     link and read as a second symptom to expect. Both patterns are
    //     pinned because a tidier who keeps one reads the other as a restatement
    //     and cuts it, and it is the restatement that does the work.
    //   - `coherent wrong story` — `task/KAN-459`'s own sentence, quoted. The
    //     specimen; without it the rule has no worked case.
    //   - `never bundled into the invocation that deleted it` + `would 404 on
    //     anything` — the delete-and-prove half, item 3 on the ticket and the
    //     one it predicted would be dropped. The first is the measured trap (a
    //     chained probe returned 200 for a ref already gone); the second is the
    //     positive control, without which the 404 is a claim about the query.
    //   - `share an upstream cause` — the general class, whose inclusion was
    //     item 3 on the ticket and is argued in the PR body rather than
    //     assumed. Pinned so that a later length pass cannot quietly reduce
    //     this back to a `gh`-only symptom, which is the state it was filed
    //     from.
    //
    // WHAT THIS ENTRY DOES NOT COVER, said plainly because an inventory line
    // looks total: it asserts the sentences are PRESENT, never that any agent
    // followed them. Nothing mechanical can see an agent read `.merged` and
    // believe it. The only evidence of that is an agent reporting its own merge
    // honestly — which is what KAN-466's AC6 required of its author, and what
    // its PR body records.
    id: 'H-29',
    title:
      "gh pr merge's exit code is not the verdict — `--delete-branch` is the trigger for the local failure: read `.merged` off REST as the only authority, and on that path the exit code and the surviving branch are one cause read twice, not two votes",
    carriedBy: {
      'prompts/task.md': [
        /only authority/i,
        /not two votes/i,
        /one cause read twice/i,
        /coherent wrong story/i,
        /never bundled into the invocation that deleted it/i,
        /would 404 on anything/i,
        /share an upstream cause/i,
        // KAN-467's four. See "THE CORRECTED MECHANISM IS PINNED" above.
        /the whole trigger/i,
        /checked out in another worktree of the same clone/i,
        /ordinary outcome of a plain merge/i,
        /never the number of worktrees/i,
      ],
    },
  },
  {
    // KAN-471. A long ticket's comment history is a window, and the fields
    // that say so sit after the payload that hides them.
    //
    // WHAT WAS MEASURED, because the rule is worthless without the numbers:
    // on KAN-39, 2026-08-15, `getJiraIssue(fields: ["comment"])` returned
    // **100 of 211** comments and the JQL search route returned **20 of 211**.
    // Both containers carried `total`, `maxResults` and a non-zero `startAt`,
    // and `startAt + returned === total` held exactly on both. The cap is real
    // and the reporting of it is complete.
    //
    // WHY IT IS CARRIED BY ALL FOUR PROMPTS RATHER THAN task.md ALONE, which
    // is the question H-29's docblock had to answer in the opposite direction:
    // H-29 is task-only because only task agents merge, and an epic prompt
    // teaching merge mechanics would be green only because somebody pasted an
    // irrelevant paragraph. Nothing like that applies here. **Every agent type
    // reads tickets, and supervisors read the longest ones** — KAN-39 is the
    // epic whose history is already past the cliff, and an epic agent
    // reconstructing a ruling off it is the exact reader this rule is for. Its
    // sibling H-28 is carried by all four for the same reason.
    //
    // THE FILING IS THE SPECIMEN, AND THAT IS WHY IT IS QUOTED RATHER THAN
    // TIDIED AWAY. KAN-471 reported "no `total`, no `maxResults`, no marker of
    // any kind" for fields that were present. It was not careless — it checked
    // the confound it could think of, that the spilled file was truncated, and
    // ruled it out correctly because the file parses clean. But truncation was
    // the wrong confound: the document was complete and the *reading* was
    // partial, and at 99.3% of a 310 KB payload the difference is invisible.
    // A rule that only said "the read is capped" would leave the next agent
    // making the same mistake, so the positional half is pinned too.
    //
    // FIVE PHRASES ACROSS TWO PARAGRAPHS, SPLIT SO THAT DELETING EITHER
    // PARAGRAPH FAILS AT LEAST TWO — KAN-467's lesson, applied at the time of
    // writing rather than after a reviewer catches it:
    //   - `startAt is what says how much fell off the back` + `after the
    //     entire array` + `reads the array and never the container` — the
    //     mechanism paragraph. The first is the instrument, the second is why
    //     it is missed, the third is the failure mode in the reader's own
    //     terms. Pinned separately because a length pass that keeps "the read
    //     is capped" and drops the positional half leaves the rule true and
    //     useless.
    //   - `no comment-listing tool` + `a claim about the newest hundred` — the
    //     reachability paragraph. The first is the fact that nothing pages
    //     back; the second is the consequence for the sentence agents actually
    //     write. Without the second this reads as trivia about an API.
    //
    // WHAT THIS ENTRY DOES NOT COVER, said plainly: it asserts the sentences
    // are present, never that any agent read the container before the
    // comments. Nothing mechanical can see that. And it says nothing about
    // whether the proxy operation this ticket added is *enabled* — it is off
    // by default, which is why the prompt text tells the reader to check
    // rather than to assume.
    id: 'H-30',
    // The title said the fields "sit after the array that hides them" until
    // review round 2. That is true of one envelope and false of the other, and
    // an inventory line is read as a statement about the rule rather than
    // about the payload one agent happened to hold — the overclaim this epic
    // keeps re-finding, caught here in the title rather than in the text.
    title:
      "a long ticket's comment history is a window: read the container by parsing rather than grepping, and where the envelope strips it an absent `total` means not-self-describing rather than short — no route on the official MCP pages back to the rest",
    carriedBy: Object.fromEntries(
      PROMPTS.map((f) => [
        f,
        [
          // Backtick-tolerant: the prompts write `startAt` as inline code, and
          // a pattern that breaks when a wording pass adds or removes the
          // backticks would be guarding the markup rather than the rule.
          /startAt`? is what says how much fell off the back/i,
          /after the entire array/i,
          /reads the array and never the container/i,
          /no comment-listing tool/i,
          /a claim about the newest hundred/i,
          // The how-to-read paragraphs, added over two review rounds.
          //
          // ROUND 1: `epic/KAN-39` withheld the marker reporting the fields
          // ABSENT. The rule said "read the container" without saying how, and
          // the how is what their review earned.
          //
          // ROUND 2, AND IT REFUTED THE MECHANISM ROUND 1 INFERRED. The first
          // explanation offered was a partial read — plausible, because each
          // field really does occur once at 71.6% of a 342 KB payload and a
          // half-file grep really does return zero. **It was wrong.** They
          // re-ran over a COMPLETE 1.19 MB file and still measured zero. A
          // second guess, that the container is stripped on large payloads,
          // was refuted too: a 910 KB adf read of KAN-39 carries
          // `total: 220, maxResults: 100, startAt: 120`.
          //
          // ROUND 3 REFUTED THE REPLACEMENT EXPLANATION TOO, and is why this
          // entry names no cause at all. The reconciliation offered in round 2
          // — that the two agents were on different envelopes and had
          // therefore made different calls — was withdrawn by its own author
          // sixteen minutes later, after they watched the envelope CHANGE
          // under them: one key at 14:48, the full container at 15:04, same
          // tool and same ticket. So the shape is a property of the client at
          // the moment of the call.
          //
          // THREE EXPLANATIONS WERE OFFERED FOR ONE MEASUREMENT AND ALL THREE
          // WERE WRONG — a partial read, two different calls, a size-dependent
          // strip. The measurements were never in doubt. That is the shape
          // this epic keeps arriving at, in its sharpest form yet: a correct
          // finding with a wrong `because` attached, where the `because` is
          // the part nobody re-checks, and where each author had to withdraw
          // their own. So the rule tells the reader what an absent `total`
          // MEANS and what to do about it, and says the cause is
          // unestablished. Both agents' measurements are in the text as
          // measurements; none of the three explanations is.
          //
          // `fails toward absent` was the obvious phrase for this and is
          // DELIBERATELY NOT USED: it already appears twice in task.md and
          // once in confluence.md under H-28, so it would be saturated by
          // neighbouring prose and match with this paragraph deleted. Checked
          // rather than assumed.
          /parse the saved JSON/i,
          /returns zero of them/i,
          // Round 2's paragraph. This is the one an agent on the stripping
          // envelope actually needs, and it is the half that survives however
          // the cause turns out.
          /strips the container/i,
          // ROUND 3, and it is the reason the rule is written without a cause
          // at all. `epic/KAN-39` retracted their own explanation after
          // measuring the envelope CHANGE under them: one key at 14:48, the
          // full container at 15:04, same tool and same ticket. So the shape
          // is a property of the client at the moment of the call, and an
          // agent cannot establish it once and rely on it. That is what makes
          // this a per-read check rather than a per-session one, and it is the
          // single most actionable sentence in the entry.
          /change under you mid-session/i,
          // And the count itself moves — 211/214/216/221 in one afternoon — so
          // a figure quoted without its time is a claim about a ticket that
          // has since moved. Pinned separately because it is the half a length
          // pass reads as an anecdote about one ticket.
          /reading with a timestamp on it/i,
          // Two phrases for the timestamp paragraph, because the red drive
          // caught it failing only ONE: a single-pin paragraph is what
          // KAN-467's lesson is about, and a length pass that reworded the
          // opening sentence would have taken the whole thing with the check
          // still green. `has since moved` was the obvious second and is NOT
          // used — it already appears elsewhere in epic.md, so it would be
          // saturated. Checked, not assumed, for the second time in this entry.
          /quoted without its time/i,
        ],
      ])
    ),
  },
  {
    // KAN-521. THE RULE IS UNCHANGED AND THE WORD IT TURNED ON WAS WRONG.
    // `prompts/story.md` said *"one and only one agent staffs a given ticket —
    // its parent"*, and never said which parent. Measured at `e7ac6bf`: of the
    // 38 occurrences of `parent` in that file, every one but this clause meant
    // the Jira `parent` field — including a section headed *the task's parent
    // is your epic — and this is where agents give up*, written to make that
    // meaning stick, and `:955`'s own *"its parent"*, ~400 lines below, meaning
    // the Jira field again. So the natural reading resolved to the **epic**,
    // which is the one agent that must not staff a story's task.
    //
    // WHAT MAKES IT INVENTORY-WORTHY RATHER THAN A TYPO. The paragraph was
    // never wrong: the next clause — *you staff the tasks you filed* — is the
    // correct rule, sitting in the same sentence. It was **correct under a
    // reading it never stated**, and one gloss lost to a file-wide convention
    // pushing the other way. `story/KAN-117` put the counter-case fairly and it
    // is the reason this is nine patterns rather than one: a reader who
    // finishes the sentence has the answer, so a length pass sees redundancy
    // and takes the disambiguation out, and the file returns to the state that
    // produced the misreading with nothing red.
    //
    // THE PATTERNS ARE CHOSEN SO THAT NO SINGLE ONE CARRIES TWO HALVES.
    //   - `one and only one agent staffs` + `anti-race property is untouched` —
    //     the property itself. This ticket was about naming which agent, never
    //     about how many, and an edit that "simplifies" by dropping the count
    //     is the regression this pins.
    //   - `the agent that filed it` + `staffing follows whoever filed the
    //     ticket` — the answer, twice, once in the rule sentence and once
    //     portably. AC1: the reader gets it from `story.md` alone.
    //   - `the word was already spoken for` + `never names that agent` — why
    //     the fix is a removal rather than a definition. Defining `parent` in
    //     place would leave the collision and add a gloss to lose.
    //   - `KAN-518` + `staffs it` + `names the one agent that must not activate
    //     it` — the worked example, and it is pinned in three pieces because
    //     AC3 is the half most easily hollowed out: an example where the Jira
    //     parent and the filer AGREE demonstrates nothing, and swapping in a
    //     tidier one is the edit that looks like housekeeping.
    //
    // SCOPED TO `prompts/story.md` DELIBERATELY, AND THE CHECK IS RECORDED
    // RATHER THAN ASSUMED: the anti-race clause exists in no other prompt —
    // `grep -n "anti-race\|staffs\|global coordinator\|orphaned workspace"` over
    // `prompts/{epic,task}.md` at `4d4933a` returns nothing — and neither file
    // uses `parent` for anything but the Jira field. `prompts/epic.md:876` is
    // the nearest thing and is not an instance: *"its story agent where it has
    // one, and **you** for a task you parented directly to {{KEY}}"* is
    // disambiguated by its own next sentence, which forbids the epic from
    // closing a task hanging off one of its stories.
    id: 'H-31',
    title:
      'who staffs a ticket is the agent that FILED it, never its Jira `parent` — the two diverge on every task a story files, and the worked example must be one where they do',
    carriedBy: {
      'prompts/story.md': [
        /one and only one agent staffs/i,
        /the agent that filed it/i,
        /the word was already spoken for/i,
        /staffing follows whoever filed the ticket/i,
        /never names that agent/i,
        /KAN-518/,
        /staffs it/i,
        /names the one agent that must not activate it/i,
        /anti-race property is untouched/i,
      ],
    },
  },
  {
    // KAN-597. The bullet this pins is the one that used to name
    // `createJiraIssue` bare, and naming it bare is how three tickets were born
    // unassigned in the ninety minutes after the proxy's assignee guard
    // deployed. All three prompts that file tickets carry it, because a caution
    // on one prompt while two others route agents to the unguarded tool is the
    // same defect this ticket is about, one level up.
    //
    // ⚠ THE LAST PATTERN IS THE LOAD-BEARING ONE AND IS NOT DECORATION. It
    // requires each prompt to say the rule is NOT the mechanism and to name the
    // field that is. `task/KAN-552` had read the staffing rule at activation
    // and filed two unassigned tickets hours apart anyway — *"knowing the rule
    // did not help, which is the argument for the default rather than for more
    // care."* A prompt caution that presented itself as the fix would be this
    // sweep enforcing precisely the belief that evidence refutes, so the sweep
    // requires the disclaimer rather than merely tolerating it.
    id: 'H-32',
    title:
      'the assignee guard is on the proxy door only — prefer it when filing, and read `boardControl.health.unstaffable` rather than trusting the rule',
    carriedBy: Object.fromEntries(
      ['prompts/task.md', 'prompts/story.md', 'prompts/epic.md'].map((f) => [
        f,
        [
          /atlassian_create_issue/,
          /only one of them assigns the ticket/i,
          /can never be staffed/i,
          /assignee_account_id/,
          // Deliberately tolerant of a qualifier between the noun and the verb
          // ("the rule above is not the mechanism"): what must be present is the
          // disclaimer, and pinning its exact word order makes this entry a
          // style check that goes red on a rewrite that says the same thing.
          /(rule|bullet)[^.]{0,24}\bis not the mechanism/i,
          /boardControl\.health\.unstaffable/,
        ],
      ])
    ),
  },
];

/**
 * Rules that have been **retired**, and must no longer be taught.
 *
 * A missing rule is a hole; a retired rule still sitting in a prompt is worse,
 * because the agent meets it and obeys it. That is not hypothetical — it is
 * exactly what KAN-237 was filed for.
 *
 * The subtlety that makes this more than a `grep -v`: **retiring a rule well
 * means naming it.** `prompts/task.md` has to quote *"do not merge — review and
 * merge belong to your epic agent"* in order to tell an agent reading an older
 * ticket which text wins, and `prompts/epic.md` has to say the epic *does not
 * merge*. A flat ban on the words would forbid the very sentences that do the
 * retiring, and the natural way to satisfy it — delete the mention — deletes
 * the warning and leaves the agent to resolve the contradiction alone.
 *
 * So a match is a violation **unless a retirement marker sits in the same
 * sentence**. Naming the old rule as old is allowed; teaching it is not.
 *
 * THE SCOPE IS ONE SENTENCE, AND THAT IS THE WHOLE DESIGN — IT WAS A CHARACTER
 * WINDOW FIRST AND THE WINDOW DID NOT WORK.
 *
 * The first version of this check allowed a marker anywhere within 500
 * characters. `epic/KAN-39` refuted it in review by reinserting *"Do not merge —
 * review and merge belong to your epic agent"* into `prompts/task.md`, **where
 * the merge rule is actually discussed**, and watching this script stay green:
 * four patterns matched and all four were waved through, because a good rewrite
 * of this rule cites `2026-08-08` and *superseding* in nearly every paragraph.
 * **The rewrite saturated its own detector.** The check could only fire ~21kB
 * away from the passage it existed to guard, which is nowhere a real regression
 * would ever appear — the closing line claimed something about `prompts/`, and
 * the mechanism measured proximity to a date string.
 *
 * A sentence cannot be saturated by neighbouring prose, so the marker now has to
 * be in the same breath as the thing it excuses. The practical constraint on
 * whoever edits these prompts: **if you mention the old rule, say it is old in
 * the same sentence.** That is what a quotation reads like anyway.
 *
 * The patterns are also narrower than they were. `/do not merge/i` on its own
 * matched `prompts/epic.md`'s heading *"…you do not merge them"* — a statement
 * of the **current** rule — so a bare verb phrase is not evidence of anything.
 * Every pattern below carries the old rule's *attribution*: who was said to own
 * the merge, or who was said never to do it.
 */
const RETIRED = [
  {
    id: 'R-1',
    title: 'the 2026-08-03 rule: the epic agent reviews and merges; story and task agents never merge',
    since: '2026-08-08',
    patterns: [
      /do not merge\s*[—–-]+\s*review and merge/i,
      /review and merge belong\w*\s+to/i,
      /merge belong\w*\s+to/i,
      /belong\w*\s+to (your|the) epic agent/i,
      /review[- ]and[- ]merge duty/i,
      /reviews? and merges? (its|their|your) own/i,
      // The shape epic.md actually used — "Review and merge **of** your own
      // epic's pull requests is your standing duty". A mutation test caught
      // this one missing: the preposition made it slip past every pattern
      // above, which is the difference between a check and a check that works.
      /reviews? and merges? of (its|their|your) own/i,
      /review and merge[^.]{0,60}standing duty/i,
      /(story|task) agents?[^.]{0,40}never merge/i,
      /you review and merge this epic/i,
      /the epic agent (reviews and merges|merges) it/i,
    ],
  },
  {
    // KAN-239. Retiring one clause of a rule whose other clauses are current,
    // which is why every pattern here carries **both** halves of the old
    // clause: the fallback it applied to (`no parent story`) and the answer it
    // gave (`supervisor of record`, or `activatedBy` as the thing you read the
    // approver off). "Supervisor of record" on its own is NOT retired and must
    // not be matched — it is still the correct name for who staffed a run, and
    // all three prompts use it that way when describing the poller's
    // notification topology (`prompts/story.md`'s "Jira-linked, or the
    // supervisor of record" is the live example). What is retired is the claim
    // that it is who *approves* you.
    //
    // That distinction is the whole difficulty of this entry. A pattern of
    // `/supervisor of record/i` would go red on three correct sentences today
    // and push whoever met it into deleting the word from the topology
    // paragraphs, which is the failure mode R-1's docblock describes in the
    // other direction: a check that forbids the sentences that do the work.
    id: 'R-2',
    title: 'the pre-2026-08-08 fallback: a task with no parent story is approved by its supervisor of record (`activatedBy`)',
    since: '2026-08-08',
    patterns: [
      /no parent story[^.]{0,80}supervisor of record/i,
      /supervisor of record[^.]{0,80}no parent story/i,
      /supervisor of record[^.]{0,40}approves/i,
      /approved by (its|their|your) \*{0,2}supervisor of record/i,
      // These two are deliberately anchored on the *affirmative attribution* —
      // approver **read off / visible as** `activatedBy` — and not on the two
      // words appearing near each other. The loose version, `/approver
      // is[^.]{0,120}activatedBy/i`, was written first and went red on this
      // ticket's own correction: *"Your approver is read off the Jira
      // hierarchy, never off `activatedBy`"* is the sentence that retires the
      // rule, and a check that forbids it is a check that forbids being fixed.
      // Same defect as the 500-character window R-1's docblock describes, in
      // mirror image. The negated form must pass; only the sourcing form fails.
      /approver[^.]{0,80}visible as (your|its|their) \*{0,2}`?activatedBy/i,
      /(approver|approves|approval)[^.]{0,60}(read|taken|derived|worked) (off|out of|from) (your |its |their |the )?\*{0,2}`?activatedBy/i,
      /(approver|approves|approval)[^.]{0,60}the agent that activated you/i,
      /the agent that activated you[^.]{0,60}(approver|approves|approval)/i,
      // THIS PAIR EXISTS BECAUSE THE REST OF R-2 MISSED A LIVE INSTANCE.
      // `epic/KAN-39` found `prompts/task.md`'s "**Done** on {{KEY}} is *your
      // supervisor's* to set" while this file was green: it says the retired
      // *concept* — the closer/approver identified as whoever staffed you —
      // without any of the retired *phrases*. For a board-started task that
      // resolves to nobody, exactly as the clause beside it did.
      //
      // These two are anchored on the attribution (Done / to-set attributed to
      // "your supervisor") and NOT on the bare word, deliberately: after
      // KAN-230, `supervisor` is a *correct* poller relation meaning
      // `activatedBy`, and both `prompts/task.md` and `prompts/story.md` use
      // "because your supervisor told you to" correctly in their storm guards.
      // A bare /supervisor/ would fire on those and be "fixed" by deleting them.
      /\bDone\b[^.]{0,80}\byour supervisor'?s?\b/i,
      /\byour supervisor'?s\b[^.]{0,30}\bto set\b/i,
    ],
  },
  {
    // KAN-334. The workaround, never the rule. *"Do not nest a blockquote
    // inside a list item"* was true of one converter on 2026-08-05, and
    // `prompts/confluence.md` instructed it until this ticket — step 4 of its
    // recipe told an agent to *"un-nest the offending block (promote the
    // blockquote to a sibling paragraph, or flatten the list)"*.
    //
    // It is retired from `prompts/` because it carries a date, and `epic/
    // KAN-203`'s founding-rule test is what settles that: *"an instruction
    // carrying a date loses it when written into a permanent home, and nobody
    // re-examines an invariant, so it goes unquestioned and load-bearing at
    // once. Ask of any invariant: is there a date hiding in this?"* Six months
    // on, this one is a prompt forbidding a structure that works, nobody knows
    // why it is there, and removing it means proving a negative. H-5 is what
    // replaces it: it asks an agent to **check**, and checking outlives every
    // converter that will ever be at fault.
    //
    // THE PATTERNS MATCH THE INSTRUCTION FORM ONLY, and that limit is the whole
    // design of this entry rather than a shortfall in it. All four prompts
    // still cite the 2026-08-05 page loss and the 2026-08-12 Jira probe as
    // **instances**, with their dates, and a citation is exactly what this
    // ticket ruled allowed. So nothing below fires on a described symptom — a
    // dropped list item, an empty `<li><p /></li>`, a signature worth grepping
    // for. Every pattern is an imperative aimed at the shape of the markdown
    // the agent is about to send.
    //
    // WHICH MEANS A GREEN R-3 IS NOT "NO PROMPT TEACHES THE WORKAROUND", for
    // the same structural reason R-2's docblock gives: a paraphrase passes.
    // What covers the class is a reviewer reading the prompt diff. Nothing
    // else does; do not infer that anything else does.
    id: 'R-3',
    title: 'the 2026-08-05 workaround: avoid nesting a blockquote inside a list item',
    since: '2026-08-12',
    patterns: [
      /(do|does) not nest (a )?blockquotes?/i,
      /never nest (a )?blockquotes?/i,
      /avoid nesting (a )?blockquotes?/i,
      /(promote|lift|move|raise) the blockquote to a sibling/i,
      /un-?nest the offending/i,
      /keep (your |the )?quotes? at (the )?top level/i,
      /blockquotes? (must|should) not (be nested|sit) (in|inside|within)/i,
    ],
  },
];

/**
 * Words that mark a sentence as *retiring* a rule rather than teaching it.
 */
const RETIREMENT_MARKERS = [
  /supersed/i,
  /retired/i,
  /the old rule/i,
  /2026-08-08/,
  /2026-08-03/,
  /no longer/i,
  /used to (state|say|read|be)/i,
  /changed on/i,
  /this file wins/i,
  /the prompt wins/i,
];

// ---------------------------------------------------------------- file reads

function read(file) {
  if (!ref) return fs.readFileSync(path.join(repoRoot, file), 'utf8');
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd: repoRoot, encoding: 'utf8' });
}

/**
 * These prompts are hard-wrapped at ~78 columns, so almost every rule's
 * sentence is split across two lines and a naive phrase regex misses it. That
 * is not a hypothetical: three of this script's six rules failed on its first
 * run for exactly this reason while the rules themselves were present, which is
 * a false red — the direction that wastes a reviewer's time rather than the
 * direction that ships a hole, but still wrong.
 *
 * So a phrase is matched against the source with all runs of whitespace
 * collapsed to one space, and `lineAt` maps each collapsed character back to
 * the line it came from, so a hit still reports a real `file:line`.
 */
function unwrap(source) {
  const lineAt = [];
  let text = '';
  source.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (text.length) {
      text += ' ';
      lineAt.push(i + 1);
    }
    for (const ch of trimmed) {
      text += ch;
      lineAt.push(i + 1);
    }
  });
  return { text, lineAt };
}

/**
 * Does the file carry this phrase? Anchored patterns (`^## …$`) are tested
 * against the raw source, where line structure still exists; everything else
 * against the unwrapped text.
 */
function carries(source, re) {
  return re.test(source) || re.test(unwrap(source).text);
}

/** `grep -n` for a regex, so the output of this script is the evidence itself. */
function hits(source, re) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    if (re.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  if (out.length) return out;

  // Wrapped: locate it in the unwrapped text and map back to a line number.
  const { text, lineAt } = unwrap(source);
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(text);
  if (!m) return [];
  const line = lineAt[m.index] ?? 1;
  return [{ line, text: source.split('\n')[line - 1].trim() }];
}

let failures = 0;
const sources = new Map();
for (const file of PROMPTS) {
  try {
    sources.set(file, read(file));
  } catch (err) {
    // A prompt that cannot be read is a real failure of this sweep's subject,
    // not a setup problem: the loader reads these same four paths.
    console.log(`✗ ${file} — could not be read at ${ref ?? 'the working tree'}: ${err.message}`);
    sources.set(file, '');
    failures += 1;
  }
}

const where = ref ? `git ref ${ref}` : 'the working tree';
console.log(`Operative-rule carriage, read from ${where}\n${'='.repeat(60)}\n`);

// ------------------------------------------------- 1. each rule is quotable

for (const rule of RULES) {
  console.log(`${rule.id} — ${rule.title}`);
  for (const [file, patterns] of Object.entries(rule.carriedBy)) {
    const source = sources.get(file) ?? '';
    const missing = patterns.filter((re) => !carries(source, re));
    if (missing.length) {
      failures += 1;
      console.log(`  ✗ ${file} — no match for ${missing.map(String).join(', ')}`);
      continue;
    }
    const first = hits(source, patterns[0]);
    const at = first.length ? `:${first[0].line}` : '';
    console.log(`  ✓ ${file}${at}`);
    if (verbose && first.length) console.log(`      ${first[0].text}`);
  }
  console.log('');
}

// ------------------------------- 2. no reference dangles, and none is stale

console.log(`Dangling references\n${'-'.repeat(60)}`);

for (const file of PROMPTS) {
  const source = sources.get(file) ?? '';

  // The old name is retired: it collided with the daemon's Jira poller and with
  // every prompt's own "do not poll" instruction, which is half of why the
  // references read as dangling in the first place.
  for (const { line, text } of hits(source, /polling loop/i)) {
    failures += 1;
    console.log(`  ✗ ${file}:${line} — "polling loop" is the retired name: ${text}`);
  }

  // A forward reference must land in a file that defines the section.
  const forward = hits(source, /supervision sweep[^.]{0,40}\bbelow\b/i);
  if (forward.length && !/^## The supervision sweep$/m.test(source)) {
    failures += forward.length;
    forward.forEach(({ line, text }) =>
      console.log(`  ✗ ${file}:${line} — points "below" but this file defines no sweep: ${text}`)
    );
  } else if (forward.length) {
    console.log(`  ✓ ${file} — ${forward.length} forward reference(s), all resolved in-file`);
  }
}
console.log('');

// ------------------------------ 3. Cadence does not contradict the sweep

console.log(`Cadence reconciled with the sweep\n${'-'.repeat(60)}`);

for (const file of ['prompts/epic.md', 'prompts/story.md']) {
  const source = sources.get(file) ?? '';
  const idx = source.indexOf('\n## Cadence');
  if (idx === -1) {
    failures += 1;
    console.log(`  ✗ ${file} — no Cadence section`);
    continue;
  }
  const cadence = source.slice(idx);
  const forbidsPolling = /Do not busy-loop/i.test(cadence);
  const namesSweep = /run the supervision sweep/i.test(cadence);
  if (forbidsPolling && !namesSweep) {
    failures += 1;
    console.log(
      `  ✗ ${file} — Cadence forbids polling and never says the sweep is the exception's shape;\n` +
        `      that is the contradiction KAN-186 exists to remove.`
    );
  } else {
    console.log(`  ✓ ${file} — Cadence names the sweep and bounds it`);
  }
}
console.log('');

// --------------------------------- 4. no retired rule is still being taught

console.log(`Retired rules are named, never taught\n${'-'.repeat(60)}`);

/**
 * Cut the file into sentences, each carrying the line each character came from.
 *
 * Two joins, in this order. First **blocks**: a heading, a list item, a
 * blockquote, a fence or a blank line starts a new one, so a bullet cannot
 * borrow the sentence of the bullet above it. Then within a block the
 * hard-wrapped lines are joined — these prompts wrap at ~78 columns, so almost
 * every sentence is split across lines and any line-based scope would be wrong.
 * Finally each block is split on sentence terminators, allowing for markdown
 * emphasis riding on the full stop (`arrived.** ` ends a sentence).
 */
function sentences(source) {
  const isBlockStart = (l) =>
    /^\s*#{1,6}\s/.test(l) || /^\s*([-*+]|\d+\.)\s/.test(l) || /^\s*>/.test(l) || /^\s*```/.test(l);

  const blocks = [];
  let cur = null;
  source.split('\n').forEach((raw, i) => {
    if (/^\s*$/.test(raw)) {
      cur = null;
      return;
    }
    if (cur === null || isBlockStart(raw)) {
      cur = { text: '', lineAt: [] };
      blocks.push(cur);
    }
    const trimmed = raw.trim();
    if (cur.text.length) {
      cur.text += ' ';
      cur.lineAt.push(i + 1);
    }
    for (const ch of trimmed) {
      cur.text += ch;
      cur.lineAt.push(i + 1);
    }
  });

  const out = [];
  for (const block of blocks) {
    const boundary = /(?<=[.!?])["'*`)\]]*\s+/g;
    let start = 0;
    let m;
    while ((m = boundary.exec(block.text)) !== null) {
      const end = m.index + m[0].length;
      out.push({ text: block.text.slice(start, end), lineAt: block.lineAt.slice(start, end) });
      start = end;
    }
    if (start < block.text.length) {
      out.push({ text: block.text.slice(start), lineAt: block.lineAt.slice(start) });
    }
  }
  return out;
}

/** Every occurrence of `re`, with the sentence it sits in. */
function occurrences(source, re) {
  const found = [];
  for (const sentence of sentences(source)) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = global.exec(sentence.text)) !== null) {
      found.push({
        line: sentence.lineAt[m.index] ?? 1,
        matched: m[0],
        passage: sentence.text,
      });
      if (m.index === global.lastIndex) global.lastIndex += 1; // zero-width guard
    }
  }
  return found;
}

for (const retired of RETIRED) {
  console.log(`${retired.id} — ${retired.title}\n     retired ${retired.since}`);
  let taught = 0;
  let marked = 0;

  for (const file of PROMPTS) {
    const source = sources.get(file) ?? '';
    for (const re of retired.patterns) {
      for (const { line, matched, passage } of occurrences(source, re)) {
        if (RETIREMENT_MARKERS.some((marker) => marker.test(passage))) {
          marked += 1;
          if (verbose) console.log(`  · ${file}:${line} — named as retired: "${matched}"`);
          continue;
        }
        taught += 1;
        failures += 1;
        console.log(
          `  ✗ ${file}:${line} — teaches the retired rule: "${matched}"\n` +
            `      in: "${passage.trim().slice(0, 150)}${passage.trim().length > 150 ? '…' : ''}"\n` +
            `      Nothing in THAT SENTENCE marks the rule as retired. Either state the\n` +
            `      current rule, or keep the mention and say it is superseded in the same\n` +
            `      sentence — quoting an old rule as old is allowed, teaching it is not.`
        );
      }
    }
  }

  if (!taught) {
    console.log(`  ✓ no prompt teaches it; ${marked} mention(s), each marked as retired`);
    if (!verbose && marked) console.log('      (run with --verbose to list them)');
  }
  console.log('');
}

// ------------------------------------------- 5. the inventory itself is whole
//
// KAN-241. Everything above asks whether `prompts/` carries each entry. Nothing
// above asks whether the entries are all still here — and **the entries are the
// checking**, so a dropped one removes the assertion that would have noticed it
// was dropped. The sweep then passes *harder*: one fewer assertion to satisfy.
//
// Three legs, because each catches a case the other two do not. They are listed
// with what each cannot see, since that is the half a reader would otherwise
// assume:
//
//   - **Declared vs present**, against `rule-inventory.md`. Catches a drop
//     whenever that file merged cleanly — a conflict confined to the `RULES`
//     region does not touch it. Blind to a resolution that hits both files and
//     takes the same side in each.
//   - **Unique ids.** Catches the 2026-08-08 collision directly: two entries
//     independently numbered `H-13` (KAN-212's and KAN-250's), resolved by hand
//     at `2a24912` after a person grepped for it on a hunch. A count would not
//     have seen it — two entries named `H-13` count as two.
//   - **The baseline leg**, against the script at `origin/main`. Catches an id
//     that existed on the trunk and has vanished, and it is the only leg with
//     nothing to hand-maintain, so it survives the both-files case the first
//     leg does not. Blind to a drop between two branches where the lost entry
//     had never reached the trunk — which the first leg does see.
//
// WHAT NONE OF THEM SEES, STATED BECAUSE THE LIST LOOKS COMPLETE: an entry
// whose id survives while its *patterns* are gutted. A merge resolution that
// keeps `id: 'H-13'` and takes one side's nine regexes passes all three legs.
// Only the emptiest form of that — an entry with no patterns or no files at all
// — is checked below. WHO COVERS THE REST: nobody mechanical. It is the
// reviewer reading the diff of the `RULES` array.
//
// The baseline leg is the one that can be absent rather than false: a shallow
// clone has no `origin/main`. It says so loudly and, under `--require-baseline`
// (which CI passes), a baseline it cannot read is a failure rather than a skip.
// A required check that silently skips its own strongest leg is the defect this
// whole ticket is about.

console.log(`Inventory integrity\n${'-'.repeat(60)}`);

const INVENTORY_FILE = 'daemon/scripts/rule-inventory.md';
const SELF_FILE = 'daemon/scripts/verify-operative-rules-are-carried.mjs';
// Anchored to the start of a line, so it reads `id:` **fields** and not the
// same text quoted in a comment. The unanchored version matched this file's own
// header — "a resolution that keeps `id: 'H-13'` and takes one side's patterns"
// — which would invent an id at the baseline and then report it as vanished.
// Caught on the KAN-241 branch itself, by its ids not matching its own arrays.
const ID_IN_SOURCE = /^\s*id:\s*'([HR]-\d+)'/gm;

const baselineIndex = process.argv.indexOf('--baseline');
const baseline = baselineIndex === -1 ? 'origin/main' : process.argv[baselineIndex + 1];
const requireBaseline = process.argv.includes('--require-baseline');

/** The ids the sweep actually defines right now, in declaration order. */
const present = [...RULES.map((r) => r.id), ...RETIRED.map((r) => r.id)];

/** Pull one marker-delimited block out of the inventory; `null` if absent. */
function block(text, name) {
  const m = new RegExp(`<!-- ${name}:BEGIN -->([\\s\\S]*?)<!-- ${name}:END -->`).exec(text);
  return m ? m[1] : null;
}

/** Every `- \`H-1\` — KAN-186 — title` line in a block. */
function idsIn(blockText) {
  return [...blockText.matchAll(/^\s*-\s*`([HR]-\d+)`/gm)].map((m) => m[1]);
}

let declared = null;
let removed = [];
try {
  const raw = fs.readFileSync(path.join(repoRoot, INVENTORY_FILE), 'utf8');
  const inv = block(raw, 'INVENTORY');
  const rem = block(raw, 'REMOVED');
  if (inv === null || rem === null) {
    failures += 1;
    console.log(`  ✗ ${INVENTORY_FILE} — missing an INVENTORY or REMOVED marker block`);
  } else {
    declared = idsIn(inv);
    removed = idsIn(rem);
    if (!declared.length) {
      failures += 1;
      console.log(`  ✗ ${INVENTORY_FILE} — declares no ids; an empty inventory asserts nothing`);
      declared = null;
    }
  }
} catch (err) {
  failures += 1;
  console.log(`  ✗ ${INVENTORY_FILE} — could not be read: ${err.message}`);
  console.log('      This file is what makes a dropped entry visible, so an unreadable one is');
  console.log('      a failure of this sweep and never a skip.');
}

/** Ids appearing more than once in a list. */
const duplicates = (ids) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

for (const id of duplicates(present)) {
  failures += 1;
  console.log(`  ✗ two entries in ${SELF_FILE} both claim id "${id}"`);
  console.log('      Two independently written rules given the same number — the 2026-08-08');
  console.log('      collision (`2a24912`), and again on `main` at `4e7183a`. Renumber the one');
  console.log('      not yet on `main`; where BOTH are already on the trunk the id stays with');
  console.log('      whichever landed first. Check you have not just dropped one of them, and');
  console.log('      renumber the `id:` field AND every mention of it in its own docblock —');
  console.log('      `2a24912` moved the field and left the prose behind.');
}

if (declared) {
  for (const id of duplicates(declared)) {
    failures += 1;
    console.log(`  ✗ ${INVENTORY_FILE} declares "${id}" twice`);
  }
  for (const id of declared.filter((id) => !present.includes(id))) {
    failures += 1;
    console.log(`  ✗ "${id}" is declared in ${INVENTORY_FILE} and no longer exists in the sweep`);
    console.log('      A DROPPED ENTRY IS THE CASE THIS LEG EXISTS FOR — most often a merge');
    console.log('      conflict in the RULES array resolved by taking one side. Restore the');
    console.log('      entry. Deleting the inventory line silences the alarm and keeps the');
    console.log('      hole; if the rule is genuinely retired, move it to "Removed from the');
    console.log('      inventory" with a reason instead.');
  }
  for (const id of present.filter((id) => !declared.includes(id))) {
    failures += 1;
    console.log(`  ✗ "${id}" exists in the sweep and is not declared in ${INVENTORY_FILE}`);
    console.log('      Add a line for it. An inventory that lags the sweep cannot be trusted');
    console.log('      to notice the next thing that goes missing from it.');
  }
  for (const id of removed.filter((id) => present.includes(id))) {
    failures += 1;
    console.log(`  ✗ "${id}" is listed as removed from the inventory and is still in the sweep`);
  }
  if (!duplicates(present).length && !declared.filter((id) => !present.includes(id)).length &&
      !present.filter((id) => !declared.includes(id)).length) {
    console.log(`  ✓ ${present.length} entries, ids unique, inventory and sweep agree`);
  }
}

// The emptiest husk: an entry that survived a merge as a shell with nothing in
// it. This is deliberately not a pattern *count* — counts change legitimately
// every time somebody tightens a rule, and a check that has to be edited on
// every honest change is one that gets edited on the dishonest ones too.
for (const rule of RULES) {
  const carried = Object.entries(rule.carriedBy ?? {});
  if (!carried.length) {
    failures += 1;
    console.log(`  ✗ ${rule.id} names no file that must carry it — an entry that asserts nothing`);
  }
  for (const [file, patterns] of carried) {
    if (!patterns?.length) {
      failures += 1;
      console.log(`  ✗ ${rule.id} lists ${file} with no phrases — an entry that asserts nothing`);
    }
  }
}
for (const retired of RETIRED) {
  if (!retired.patterns?.length) {
    failures += 1;
    console.log(`  ✗ ${retired.id} has no patterns — a retirement that forbids nothing`);
  }
}

// The baseline leg. Reads ids straight out of the script's source at the ref, so
// it needs no inventory file to have existed there — which is what lets it run
// on the commit that introduces this section, and on every commit before it.
let baselineSource = null;
try {
  baselineSource = execFileSync('git', ['show', `${baseline}:${SELF_FILE}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  baselineSource = null;
}

if (baselineSource === null) {
  if (requireBaseline) {
    failures += 1;
    console.log(`  ✗ baseline "${baseline}" could not be read, and --require-baseline was given`);
    console.log('      In CI this means the checkout is shallow. Fetch enough history for the');
    console.log('      baseline to resolve — do not drop the flag, which would leave the leg');
    console.log('      silently skipped and the job green over exactly the defect it guards.');
  } else {
    console.log(`  ⚠ baseline "${baseline}" not readable — vanished-id leg SKIPPED, not passed`);
    console.log('      (pass --require-baseline to make this a failure, as CI does)');
  }
} else {
  const baselineIds = [...new Set([...baselineSource.matchAll(ID_IN_SOURCE)].map((m) => m[1]))];
  const vanished = baselineIds.filter((id) => !present.includes(id) && !removed.includes(id));
  if (vanished.length) {
    for (const id of vanished) {
      failures += 1;
      console.log(`  ✗ "${id}" is in the sweep at ${baseline} and is gone from the working tree`);
      console.log('      An entry that reached the trunk has disappeared. If a merge dropped it,');
      console.log('      restore it; if it was retired on purpose, say so under "Removed from');
      console.log(`      the inventory" in ${INVENTORY_FILE} and give the reason.`);
    }
  } else {
    console.log(`  ✓ all ${baselineIds.length} ids present at ${baseline} are still here`);
  }
}
console.log('');

// ----------------------------------------------------------------- verdict

if (failures) {
  console.log(`✗ ${failures} check(s) failed — an operative rule has nowhere an agent will meet it,`);
  console.log('  or a retired one is still being taught where an agent will meet it.');
} else {
  console.log('✓ every rule KAN-186 and KAN-237 inventoried is carried by a prompt, no reference');
  console.log('  dangles, no Cadence section contradicts the sweep it now defines, and no retired');
  console.log('  rule is taught anywhere in prompts/ — only named as retired.');
}

process.exit(failures ? 1 : 0);
