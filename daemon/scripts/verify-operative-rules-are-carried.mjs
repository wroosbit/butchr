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
// script go red on exactly that: 23 failures, including all four prompts
// missing every word of H-3 and H-4.
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
// goes red on exactly the sentences this entry exists to catch — 10 failures:
// seven R-2 hits across `prompts/{epic,story,task}.md`, plus H-10 missing from
// all three. Once KAN-239 lands, `origin/main`
// moves and that recipe goes green; pin it to KAN-239's merge base, `efde3cb`,
// to keep reproducing it.
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
// nothing having gone red. It is **H-13**, not H-12: this entry was written as
// H-12 and renamed when KAN-249 landed its channel-brief entry under that id
// first. The id is the incumbent's; renaming the one still in review is the
// cheaper half, and it is recorded here because a reader meeting "H-12" in
// KAN-212's PR history should not go looking for a rule that moved.
// Run with `--ref` KAN-212's original merge base `1fc6407` to watch H-13 go red
// in all three prompts at once — that red
// is honest here in a way the R-1 merge-base red was not, because the rule is
// genuinely absent from those files rather than merely discussed elsewhere.
// The narrower test, and the one to repeat after any edit to H-13's phrases:
//   perl -0pi -e 's/Epics have no parent, and that is correct//' prompts/story.md
//   node daemon/scripts/verify-operative-rules-are-carried.mjs   # exit 1, story.md only
//   git checkout -- prompts/story.md
//
// Usage:
//   node daemon/scripts/verify-operative-rules-are-carried.mjs [--verbose]
//   node daemon/scripts/verify-operative-rules-are-carried.mjs --ref origin/main
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
    // The half of KAN-237 that is specific to the agent who now presses the
    // button: dozens of tickets predate the change and were deliberately not
    // mass-edited, so a task agent will meet the old rule on its own ticket and
    // has to be told which wins.
    id: 'H-9',
    title: "an older ticket's standing rules are stale; the prompt wins",
    carriedBy: {
      'prompts/task.md': [/when the two disagree, the prompt wins/i, /you merge after approval/i],
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
