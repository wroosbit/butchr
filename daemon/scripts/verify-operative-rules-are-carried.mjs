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
// anywhere near it.
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
 * So a match is a violation **unless a retirement marker sits near it** in the
 * same passage. Naming the old rule as old is allowed; teaching it is not.
 */
const RETIRED = [
  {
    id: 'R-1',
    title: 'the 2026-08-03 rule: the epic agent reviews and merges; story and task agents never merge',
    since: '2026-08-08',
    patterns: [
      /review[- ]and[- ]merge/i,
      /reviews? and merges? (its|their|your) own/i,
      /(story and task agents|task agents?|story agents?)[^.]{0,20}never merge/i,
      /do not merge/i,
      /merge belongs? to/i,
      /belongs? to your epic agent/i,
      /the epic agent (reviews and )?merges it/i,
    ],
  },
];

/**
 * Words that mark a passage as *retiring* a rule rather than teaching it. The
 * window is deliberately generous: these prompts are hard-wrapped prose and the
 * marker is usually in the neighbouring sentence, not the matched one.
 */
const RETIREMENT_MARKERS = [
  /supersed/i,
  /retired/i,
  /the old rule/i,
  /2026-08-08/,
  /no longer/i,
  /used to (state|say|read|be)/i,
  /changed on/i,
  /this file wins/i,
  /the prompt wins/i,
];
const MARKER_WINDOW = 500;

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
 * Every occurrence of `re` in the unwrapped text, each with the line it came
 * from and the surrounding passage used for the marker test.
 */
function occurrences(source, re) {
  const { text, lineAt } = unwrap(source);
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const found = [];
  let m;
  while ((m = global.exec(text)) !== null) {
    found.push({
      line: lineAt[m.index] ?? 1,
      matched: m[0],
      passage: text.slice(Math.max(0, m.index - MARKER_WINDOW), m.index + m[0].length + MARKER_WINDOW),
    });
    if (m.index === global.lastIndex) global.lastIndex += 1; // zero-width guard
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
          `  ✗ ${file}:${line} — teaches the retired rule with nothing marking it retired: "${matched}"\n` +
            `      Either state the current rule, or keep the mention and say in the same\n` +
            `      passage that it was superseded — naming an old rule as old is allowed.`
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
