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
    id: 'H-5',
    title: "a page write's `success` is a claim about the request, not about the page",
    carriedBy: {
      'prompts/confluence.md': [
        /verify what was stored/i,
        /getConfluencePage/,
        /<li><p \/><\/li>/,
        /blockquote nested inside a list item/i,
      ],
      'prompts/epic.md': [/page write can report success and silently drop content/i, /<li><p \/><\/li>/],
      'prompts/task.md': [/verify what was stored/i, /<li><p \/><\/li>/],
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
    id: 'H-15',
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
