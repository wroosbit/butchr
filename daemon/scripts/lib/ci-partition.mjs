//
// The CI partition — which `verify-` scripts CI can run, and why the rest it
// cannot. KAN-295.
//
// WHY THIS MODULE EXISTS. Before KAN-295 this repository held 76 `verify-*`
// scripts and CI evaluated the assertions of exactly one of them
// (`verify-operative-rules-are-carried`, via the `operative-rule-carriage`
// job). `verify-script-sweep` swept all 76, but only for *verdict-driven
// exits* — that each script **could** report failure, never what any of them
// asserted. So every "made to go red" proof on this board was a one-time,
// hand-driven demonstration at review time: real the day it landed, and never
// re-evaluated after merge.
//
// The answer is not "run all 76". Many genuinely cannot run unattended — they
// need a real herdr on PATH, a live daemon, an Atlassian credential, a CrabCast
// peer, a terminal, or minutes of wall clock. **A partition with reasons is
// worth more than a job that runs forty scripts and skips thirty-four without
// saying which**, so the classification is the deliverable and the CI job is
// downstream of it.
//
// WHERE THE CLASSIFICATION LIVES: in each script's own header, on a
// `CI-RUNNABLE:` line, where the next reader of that script meets it. Not in a
// list in this file and not in `ci.yml` — a list is a second place to drift,
// and a script that is moved, renamed or added carries its own answer with it.
// `ci-partition.md` beside this file is a generated *view* of those headers,
// not a second source of truth; `verify-ci-partition-is-enforced.mjs` is what
// keeps the two honest.
//
// This module is `lib/` rather than `verify-`/`sweep-` deliberately: it has no
// top-level side effects and asserts nothing on its own. It is imported by the
// runner, by the guard, and by `sweep-verify-exit-paths.mjs`.
//

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

/** The two directories the sweep polices, kept identical to it on purpose. */
export const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/**
 * The four classes. `yes` and `partial` are what CI runs; `quarantined` and
 * `no` are what it does not, for two very different reasons.
 */
export const CLASSES = {
  yes: 'runs in CI; every section asserts',
  partial: 'runs in CI and asserts a real subset — named sections need something CI has not got',
  quarantined: 'CI-runnable but currently RED — excluded loudly, with a reason and a ticket',
  no: 'cannot run unattended in CI'
};

/** The classes the CI job actually executes. */
export const RUNS_IN_CI = ['yes', 'partial'];

/**
 * `CI-RUNNABLE: <class> — <reason>`, in a `//` comment.
 *
 * The em dash is required rather than decorative: it is what forces a reason to
 * exist. `CI-RUNNABLE: no` on its own is precisely the silent exclusion this
 * ticket was filed about, so the grammar refuses it.
 */
const ANNOTATION = /^\s*\/\/\s*CI-RUNNABLE:\s*(yes|partial|quarantined|no)\s*—\s*(.+?)\s*$/;

/** A quarantine must name the ticket that owns getting it green again. */
const TICKET = /\b[A-Z][A-Z0-9]*-\d+\b/;

/**
 * Read one script's annotation.
 *
 * The reason may continue onto following `//` lines, so that a reason long
 * enough to be useful does not have to fit on one line. Continuation stops at
 * the first line that is not a comment, or at a blank comment line.
 */
export function parseAnnotation(source) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ANNOTATION);
    if (!m) continue;
    const [, cls, firstLine] = m;
    const reason = [firstLine];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].match(/^\s*\/\/\s?(.*)$/);
      if (!cont || cont[1].trim() === '') break;
      // A new top-level header key ends the reason.
      if (/^[A-Z][A-Z -]{3,}:/.test(cont[1].trim())) break;
      reason.push(cont[1].trim());
    }
    return { class: cls, reason: reason.join(' ').trim(), line: i + 1 };
  }
  return null;
}

/** Every `verify-*.mjs` under the swept directories, with its annotation. */
export function readPartition(repoRoot = REPO_ROOT) {
  const rows = [];
  for (const dir of SCRIPT_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (!name.startsWith('verify-') || !name.endsWith('.mjs')) continue;
      const rel = path.join(dir, name);
      const source = fs.readFileSync(path.join(abs, name), 'utf8');
      const annotation = parseAnnotation(source);
      rows.push({
        rel,
        name: name.replace(/\.mjs$/, ''),
        dir,
        annotation,
        class: annotation?.class ?? null,
        reason: annotation?.reason ?? null,
        runsInCi: annotation ? RUNS_IN_CI.includes(annotation.class) : false,
        namesTicket: annotation ? TICKET.test(annotation.reason) : false
      });
    }
  }
  return rows;
}

/**
 * The summary block of `ci-partition.md` — the per-class counts, the total, and
 * the `N of M` sentence — derived from the rows, in one place.
 *
 * KAN-409. The generator emitted these lines inline and nothing ever read them
 * back, so `ci-partition.md` could carry a summary that disagreed with its own
 * table and still pass the guard. That is measured, not hypothetical: rebasing
 * #171 onto #169, git auto-merged the file **cleanly**, took both sides' new
 * rows into the table, and left all three summary numbers a release behind.
 * Both files passed.
 *
 * Returned as three named parts rather than one blob so the guard can say WHICH
 * of them disagrees, and shared with the generator's `emitMarkdown()` so the
 * thing that writes the summary and the thing that checks it cannot drift.
 *
 * WHAT SHARING ONE DEFINITION COSTS, stated because it is a real trade: a guard
 * that re-derives from this function cannot audit this function. If the formula
 * here were wrong, the generator would emit a wrong summary and the guard would
 * agree with it. §7 of `verify-ci-partition-is-enforced.mjs` covers part of that
 * with a second arm computed from the document's own numbers alone — the counts
 * must sum to the total, the sentence must agree with both — which holds
 * whatever this function does. What is left is a generator wrong *consistently*,
 * and nothing checks that.
 */
export function summaryParts(rows) {
  const counts = {};
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const inCi = rows.filter((r) => r.runsInCi).length;
  return {
    classRows: Object.keys(CLASSES).map((k) => `| \`${k}\` | ${counts[k] ?? 0} |`),
    totalRow: `| **total** | **${rows.length}** |`,
    sentence: `**${inCi} of ${rows.length}** run on every pull request.`
  };
}

/**
 * Read the summary block back out of a checked-in `ci-partition.md`. The
 * inverse of `summaryParts`, kept beside it so one file knows the format.
 *
 * A field this cannot find is `null`, and **null is a failure for the caller,
 * never agreement**: "no summary found" is a claim about this parser, not about
 * the document, and a check that reads a failed parse as a pass is a check that
 * does not exist while appearing to.
 */
export function parseSummary(md) {
  const section = md.split(/^## /m).find((s) => /^Totals\b/.test(s));
  if (!section) {
    return {
      found: false,
      classRows: [],
      counts: {},
      totalRow: null,
      total: null,
      sentence: null,
      sentenceIn: null,
      sentenceOf: null
    };
  }

  const lines = section.split('\n').map((l) => l.trim());
  const CLASS_ROW = /^\|\s*`([a-z]+)`\s*\|\s*(\d+)\s*\|$/;

  const classRows = lines.filter((l) => CLASS_ROW.test(l));
  const counts = {};
  for (const l of classRows) {
    const [, cls, n] = l.match(CLASS_ROW);
    counts[cls] = Number(n);
  }

  const totalRow = lines.find((l) => /^\|\s*\*\*total\*\*/.test(l)) ?? null;
  const total = totalRow?.match(/\*\*total\*\*\s*\|\s*\*\*(\d+)\*\*/)?.[1] ?? null;

  const sentence = lines.find((l) => /run on every pull request/.test(l)) ?? null;
  const nOfM = sentence?.match(/^\*\*(\d+) of (\d+)\*\*/) ?? null;

  return {
    found: true,
    classRows,
    counts,
    totalRow,
    total: total === null ? null : Number(total),
    sentence,
    sentenceIn: nOfM ? Number(nOfM[1]) : null,
    sentenceOf: nOfM ? Number(nOfM[2]) : null
  };
}

/**
 * The problems that make a partition dishonest rather than merely incomplete.
 * Shared so the sweep, the guard and the runner all call the same thing false.
 */
export function partitionProblems(rows) {
  const problems = [];
  for (const r of rows) {
    if (!r.annotation) {
      problems.push({
        rel: r.rel,
        what: 'has no `CI-RUNNABLE:` line — it is classified neither way, so CI silently ignores it'
      });
      continue;
    }
    if (!r.reason || r.reason.length < 12) {
      problems.push({ rel: r.rel, what: `states class \`${r.class}\` with no usable reason` });
    }
    if (r.class === 'quarantined' && !r.namesTicket) {
      problems.push({
        rel: r.rel,
        what: 'is quarantined without naming a ticket — a quarantine nobody owns is a deletion'
      });
    }
  }
  return problems;
}
