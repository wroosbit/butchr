// KAN-527: a script under `daemon/scripts` or `extension/scripts` must be
// readable by the tools people read it with, and a fallback constant must not be
// able to make an assertion unfalsifiable.
//
// WHAT FAILURE THIS WOULD CATCH: `verify-send-transport-claims.mjs` as it stood
// at `origin/main` on 2026-08-18 — an 800-line proof carrying one raw `\x00`, so
// `file(1)` called it `data`, no text tool would print a line of it without `-a`,
// and every maintenance sweep over that directory silently skipped it while
// reporting success. It would equally have caught the four in
// `verify-task-agent-write-list.mjs` that KAN-515 removed, which were found only
// because a reviewer noticed their own greps coming back empty on a file they
// had just watched run.
//
// AND THE HALF THE BYTES ARE ONLY THE SYMPTOM OF. Both instances were the same
// idiom — `x ?? '<a raw control byte>'` — and the byte is not what makes it
// dangerous. It sits in a position where the constant decides whether the test
// can fail at all:
//
//     String(basis).includes(id ?? '<NUL>')     `''.includes` is TRUE of every
//     `${n}|${word ?? '<NUL>'}`                 string; `(4|)` matches EVERY one
//
// Strip the byte — a formatter, an editor, a `.gitattributes` rule, a paste
// through anything that drops control characters — and what is left is `?? ''`,
// which is unfalsifiable now rather than one edit away from it. Measured on
// instance 1 by KAN-527's reporter: with the empty alternative restored, four of
// that script's count assertions read PASS against a document deliberately
// quoting the wrong counts. So §2 reads the idiom and not only the bytes, which
// is acceptance criterion 4.
//
// `sweep-` RATHER THAN `verify-`, for the reason `sweep-verify-exit-paths.mjs`
// and `sweep-ambient-dependence.mjs` are: it proves no product behaviour. It is
// a static reading of files in this repository, so it has no business in the
// namespace it polices, and the CI partition and the exit-path sweep both key
// off the `verify-` prefix.
//
// ---------------------------------------------------------------------------
// WHAT IT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// It supplies none of its input: it reads the real tree off the checkout, which
// is the whole of what it is for. It is therefore NOT subject to KAN-145's
// "a proof that supplies its own input has not tested that the input arrives".
//
// What it does not cover, named rather than left to be inferred:
//
//   * §2 is a static reading, so a fallback assembled at runtime — a constant
//     out of a variable, a value off a config — is invisible to it. It reads
//     the two shapes the two known instances took and the deliberate `?? ''`
//     that AC4 names, and nothing beyond them.
//   * It says nothing about whether any assertion in any swept script is
//     capable of being false. That is `sweep-verify-exit-paths.mjs`'s first
//     three levels and the fourth level nothing automates — watching the script
//     go red. Passing here is necessary and nowhere near sufficient.
//   * Its own red is covered by `daemon/scripts/red-drive-kan527.sh`, which
//     mutates real files in the tree and watches this sweep fail on each. It is
//     covered by nothing else, and a green here that has never been seen red is
//     the thing this repository keeps filing tickets about.
//
// Usage: node daemon/scripts/sweep-script-text-hazards.mjs [--verbose]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sweepTree } from './lib/sweep-sources.mjs';
import { forbiddenBytes, nameByte, vacuousFallbacks } from './lib/script-text-hazards.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const SCRIPT_DIRS = ['daemon/scripts', 'extension/scripts'];

/**
 * Files §1 is permitted to hold a control byte.
 *
 * IT IS EMPTY, AND IT IS PRINTED EVEN WHEN IT IS EMPTY, because an exception
 * list nobody sees is how a guard is routed around one entry at a time. There
 * is also, today, nothing to put in it: every file under these two trees is
 * text, the JSON fixtures included — and JSON *cannot* legally hold a raw
 * control byte inside a string, so a fixture that needs one is already obliged
 * to write the six characters `\u0000` rather than the byte. If a genuinely
 * binary fixture ever arrives, adding it here is a visible, reviewable edit to
 * a guard rather than a marker inside a file that `grep` cannot read.
 *
 * @type {string[]} repository-relative paths
 */
const BINARY_FILES = [];

// =============================================================================
// §1 — no file in these trees carries a byte that hides it from text tools
// =============================================================================

const byteHits = [];
const coverage = [];
const sweepUnproven = [];
let filesScanned = 0;

for (const dir of SCRIPT_DIRS) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) continue;
  // Every file, not `*.mjs`: the defect is about what a maintenance sweep over
  // the directory silently skips, and a sweep skips whatever is unreadable
  // regardless of its extension. `sweepTree` is the shared recursive walk, so
  // this reports the coverage it reached rather than asking to be trusted.
  const sweep = sweepTree(abs, { match: () => true, label: dir, what: 'file(s)' });
  coverage.push(sweep.coverage);
  if (!sweep.reachedEverything) sweepUnproven.push(`${dir}: ${sweep.detail}`);

  for (const name of sweep.files) {
    const rel = path.join(dir, name);
    filesScanned += 1;
    if (BINARY_FILES.includes(rel)) continue;
    const hits = forbiddenBytes(path.join(abs, name));
    if (hits.length) byteHits.push({ rel, hits });
  }
}

// =============================================================================
// §2 — no fallback constant sits where it would disarm a match
// =============================================================================

const SOURCE = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
const vacuousHits = [];
let sourcesScanned = 0;

for (const dir of SCRIPT_DIRS) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) continue;
  const sweep = sweepTree(abs, { match: (name) => SOURCE.test(name), label: dir, what: 'source file(s)' });
  if (!sweep.reachedEverything) sweepUnproven.push(`${dir} (sources): ${sweep.detail}`);
  for (const name of sweep.files) {
    const rel = path.join(dir, name);
    sourcesScanned += 1;
    // Read as bytes and decode explicitly. A file §1 has already condemned is
    // still read here rather than skipped, so one file cannot hide the other
    // reading by failing the first.
    const src = fs.readFileSync(path.join(abs, name)).toString('utf8');
    const found = vacuousFallbacks(src);
    if (found.length) vacuousHits.push({ rel, found });
  }
}

// =============================================================================
// Report
// =============================================================================

for (const line of coverage) console.log(`  ${line}`);
console.log(
  `\n§1 read ${filesScanned} file(s) as BYTES for C0 control characters (tab, newline and\n` +
    `   carriage return excepted) and DEL.`
);
console.log(
  `   permitted-binary list: ${BINARY_FILES.length ? BINARY_FILES.join(', ') : '(empty)'}`
);
console.log(`§2 read ${sourcesScanned} source file(s) for a fallback constant in a matching position.\n`);

if (byteHits.length) {
  console.log(`${byteHits.length} file(s) carry a byte that hides them from text tools:`);
  for (const { rel, hits } of byteHits) {
    console.log(`  - ${rel}`);
    for (const h of hits) {
      console.log(`      ${nameByte(h.byte)} at offset ${h.offset} (line ${h.line}, col ${h.col})`);
    }
    // Deliberately not "grep returns nothing": the greps on this machine differ.
    // GNU grep 3.7 exits 0 and prints `binary file matches` INSTEAD of the line;
    // ugrep 7.5, which is what `grep` resolves to at an agent's prompt, exits 1
    // with no output at all, which reads exactly like "the string is not there".
    // What both share is the part worth stating, so the part worth stating is
    // what this says.
    console.log(`      \`file(1)\` calls this \`data\`, so no text tool will print a line of it without \`-a\`.`);
  }
  console.log('');
} else if (verbose) {
  console.log('§1 PASS — every file in both trees is text.\n');
}

if (vacuousHits.length) {
  console.log(`${vacuousHits.length} file(s) fall back to a constant that disarms the test around it:`);
  for (const { rel, found } of vacuousHits) {
    console.log(`  - ${rel}`);
    for (const f of found) {
      const why =
        f.kind === 'empty'
          ? 'the fallback is EMPTY — the test around it cannot fail'
          : 'the fallback is CONTROL CHARACTERS ONLY — one normalisation from empty';
      console.log(`      line ${f.line}: ${f.operator} fallback in ${f.where}`);
      console.log(`        ${why}`);
      console.log(`        ${f.text}`);
    }
    console.log(
      `      Build the value from what exists rather than defaulting it — KAN-515's shape,\n` +
        `      \`[a, b].filter(Boolean).join('|')\`, or an explicit check that the operand is a\n` +
        `      non-empty string. Then there is no sentinel to strip.`
    );
  }
  console.log('');
} else if (verbose) {
  console.log('§2 PASS — no fallback constant sits in a matching position.\n');
}

if (sweepUnproven.length) {
  console.log(
    'the sweep could not prove it reached every file — its own coverage is in doubt, so\n' +
      'both verdicts above are claims about a SUBSET of the tree:'
  );
  for (const line of sweepUnproven) console.log(`  - ${line}`);
  console.log('');
}

const failures = byteHits.length + vacuousHits.length + sweepUnproven.length;

if (!failures) {
  console.log(
    `ALL PASS — ${filesScanned} file(s) are text, and none of the ${sourcesScanned} source file(s)\n` +
      'defaults a matched value to a constant that cannot be false.\n\n' +
      'This does NOT establish that any assertion in any of them can be false. That is\n' +
      "`sweep-verify-exit-paths.mjs`'s question and, past it, the one nothing automates:\n" +
      'break the behaviour under test and watch the script go red.'
  );
}

process.exit(failures > 0 ? 1 : 0);
