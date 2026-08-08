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
    title: 'the approver is read off the Jira hierarchy (parent story, else parent epic), never off `activatedBy`',
    carriedBy: Object.fromEntries(
      ['prompts/epic.md', 'prompts/story.md', 'prompts/task.md'].map((f) => [
        f,
        [/read off the Jira hierarchy/i, /never off `activatedBy`/i, /parent epic's agent/i],
      ])
    ),
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
    title: 'the terminating case: when the hierarchy names nobody, say so and do not merge',
    carriedBy: {
      'prompts/task.md': [/hierarchy names nobody/i, /filing defect, not a licence/i, /quietly invents an approver/i],
    },
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
