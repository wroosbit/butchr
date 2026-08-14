// KAN-295: a CI-runnable `verify-` script cannot be added without CI picking it
// up, and a script cannot leave CI without saying so where a reader will meet
// it.
//
// WHAT FAILURE THIS WOULD CATCH: a `verify-` script being added, renamed or
// moved into `daemon/scripts` / `extension/scripts` and never being run by
// anything — the exact condition this repository was in when KAN-295 was filed,
// when 76 such scripts existed and CI evaluated the assertions of one. It also
// catches the two ways that condition comes back after this lands: a script
// with no `CI-RUNNABLE:` line at all (unclassified, so silently unrun), and a
// script quietly downgraded to `no` or `quarantined` with no reason and no
// ticket, which is a deletion wearing an annotation.
//
// Since KAN-409 it also catches a third: `ci-partition.md` carrying a summary
// that disagrees with its own table — the class counts, the total, or the `N of
// M` sentence left behind by a clean git auto-merge that took both sides' new
// rows. That is the state PR #171 was in, and §6 passed it, because §6
// reconciles the rows and never read the numbers above them.
//
// CI-RUNNABLE: yes — builds its fixtures in a temporary directory and reads
// `ci.yml` and the script headers off the checkout; node builtins only, no
// build, no daemon, no herdr, no credential, no network.
//
// THIS SCRIPT IS THE POINT OF ITS OWN TICKET, WHICH IS WHY IT IS BUILT THIS WAY
//
// The defect KAN-295 fixes is *a guard that exists and is not run*. A guard
// against that which is itself not run would be the same defect wearing this
// ticket's name. Two things are done about it, because one was not enough:
//
//   1. This script is annotated `yes`, so the runner discovers it and runs it
//      like any other member of the set.
//   2. `ci.yml` **also** invokes it directly, as its own job, so its execution
//      does not depend on the runner working. Section 4 asserts both of those
//      wirings are present. If the runner were broken to select nothing, the
//      runner's own guard would refuse (it exits non-zero on an empty set) and
//      this script would still run from its own job.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Sections 1-3 build a fixture tree in `os.tmpdir()` and then assert on it, so
// they are open to the objection KAN-145 earned: **a proof that supplies its
// own input has not tested that the input arrives.** Stated plainly, so nobody
// has to infer it:
//
//   * What sections 1-3 establish is that the *selector* is directory-driven —
//     that a newly written file, which no list mentions, is discovered and
//     classified from its own header. That is the mechanism criterion 5 is
//     about, and it is genuinely tested: the fixture scripts are created after
//     the selector was written and are named nothing it could know.
//   * What they do NOT establish is that GitHub Actions really executes any of
//     this. No script can: that is a fact about a runner, not about a
//     repository.
//   * Sections 4-7 do NOT supply their own input: they read `ci.yml`, the
//     script headers and `ci-partition.md` off the checkout, so what they assert
//     on is what a reviewer would find there. §7's own uncovered leg is a
//     different one and is stated at §7: it guards the document against the
//     tree and against itself, and nothing guards either against a generator
//     that is wrong consistently.
//   * WHO COVERS IT: section 4 covers the wiring statically, by reading
//     `ci.yml` and asserting both invocations are there. The remaining leg —
//     that the job ran and went green — is an observation, and the KAN-295 pull
//     request pastes the run. There is no check that closes it, and there
//     cannot be one inside this file.
//
// Usage: node daemon/scripts/verify-ci-partition-is-enforced.mjs [--verbose]

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readPartition,
  partitionProblems,
  REPO_ROOT,
  RUNS_IN_CI,
  SCRIPT_DIRS,
  summaryParts,
  parseSummary
} from './lib/ci-partition.mjs';

const verbose = process.argv.includes('--verbose');
let failures = 0;

function check(ok, what, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  } else if (verbose && detail) {
    console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`);
  }
}

function rule(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// =============================================================================
rule('1. THE SELECTOR IS DIRECTORY-DRIVEN — a script nothing lists is still found');
// =============================================================================
//
// The fixture is a repository-shaped temporary tree holding three scripts this
// codebase has never heard of. Nothing anywhere names them. If the selector
// finds and classifies all three, it is reading the directory and the headers,
// which is what makes "add a script and CI picks it up" true by construction
// rather than by anybody remembering to edit a list.

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kan295-partition-'));
const fixtureScripts = path.join(fixture, 'daemon', 'scripts');
fs.mkdirSync(fixtureScripts, { recursive: true });

/**
 * Write one fixture script.
 *
 * A fixture is header-only, with no body at all. Two reasons, and the second is
 * not obvious:
 *
 *   1. Nothing executes them. `readPartition` reads headers; a body would be
 *      dead weight that a later reader might mistake for part of the test.
 *   2. A body containing `process.exit(0)` puts a *written-out* exit into this
 *      file, and `sweep-verify-exit-paths.mjs` counts `writeFileSync(` calls to
 *      decide which exits belong to a shim rather than to the script's own
 *      control flow. With five such calls and no balancing token, that sweep
 *      classified this script's real verdict exit as a shim and reported that
 *      it could not fail — which it did, on the first run. One helper instead
 *      of five call sites keeps that heuristic reading this file correctly.
 *      The sweep is not wrong to be crude here; it says so in its own header.
 */
function fixtureScript(name, header) {
  fs.writeFileSync(path.join(fixtureScripts, name), `${header}\n`);
}

const NEWLY_ADDED = 'verify-a-script-no-list-mentions.mjs';
fixtureScript(
  NEWLY_ADDED,
  '// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.\n' +
    '//\n' +
    '// CI-RUNNABLE: yes — a fixture written by verify-ci-partition-is-enforced,\n' +
    '// which reads files off the checkout and nothing else.'
);
fixtureScript(
  'verify-a-fixture-that-needs-a-fleet.mjs',
  '// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.\n' +
    '//\n' +
    '// CI-RUNNABLE: no — a fixture that claims to need a real herdr on PATH.'
);
fixtureScript(
  'verify-a-fixture-nobody-classified.mjs',
  '// WHAT FAILURE THIS WOULD CATCH: nothing; this is a fixture.'
);

const found = readPartition(fixture);
const byName = Object.fromEntries(found.map((r) => [r.name, r]));

check(
  found.length === 3,
  'all three fixture scripts were discovered, though nothing lists them',
  `found: ${found.map((r) => r.name).join(', ')}`
);
check(
  byName['verify-a-script-no-list-mentions']?.class === 'yes' &&
    byName['verify-a-script-no-list-mentions']?.runsInCi === true,
  'the newly added CI-runnable script is selected INTO the set from its own header',
  `class: ${byName['verify-a-script-no-list-mentions']?.class}, runsInCi: ${byName['verify-a-script-no-list-mentions']?.runsInCi}`
);
check(
  byName['verify-a-fixture-that-needs-a-fleet']?.class === 'no' &&
    byName['verify-a-fixture-that-needs-a-fleet']?.runsInCi === false,
  'and one that declares it cannot run is selected OUT of it',
  `class: ${byName['verify-a-fixture-that-needs-a-fleet']?.class}`
);

// =============================================================================
rule('2. AN UNCLASSIFIED SCRIPT IS A FAILURE, NOT A DEFAULT');
// =============================================================================
//
// The defect being fixed is silence. A script that names no class must not be
// quietly treated as runnable (it would go red on a runner that cannot run it)
// nor as not-runnable (which is the silent exclusion itself). It has to stop
// the build and ask.

const fixtureProblems = partitionProblems(found);
check(
  fixtureProblems.some((p) => p.rel.endsWith('verify-a-fixture-nobody-classified.mjs')),
  'the unclassified fixture is reported as a problem rather than defaulted either way',
  `problems: ${JSON.stringify(fixtureProblems.map((p) => p.rel))}`
);
check(
  byName['verify-a-fixture-nobody-classified']?.runsInCi === false &&
    byName['verify-a-fixture-nobody-classified']?.class === null,
  'and it is not silently swept into the runnable set on the way',
  `class: ${byName['verify-a-fixture-nobody-classified']?.class}`
);

// =============================================================================
rule('3. THE GRAMMAR REFUSES THE TWO DISHONEST ANNOTATIONS');
// =============================================================================
//
// `CI-RUNNABLE: no` with no reason, and `quarantined` with no ticket. Both are
// how a script leaves CI without anybody being able to see that it did — the
// first deletes the reason, the second deletes the owner.

fixtureScript('verify-a-fixture-excluded-for-no-reason.mjs', '// CI-RUNNABLE: no — x');
fixtureScript(
  'verify-a-fixture-quarantined-by-nobody.mjs',
  '// CI-RUNNABLE: quarantined — it is red and this sentence names no ticket at all.'
);
const dishonest = partitionProblems(readPartition(fixture));
check(
  dishonest.some((p) => p.rel.endsWith('verify-a-fixture-excluded-for-no-reason.mjs')),
  'an exclusion whose reason is a single character is refused',
  `problems: ${JSON.stringify(dishonest.map((p) => p.what))}`
);
check(
  dishonest.some((p) => p.rel.endsWith('verify-a-fixture-quarantined-by-nobody.mjs')),
  'and a quarantine that names no ticket is refused — a quarantine nobody owns is a deletion'
);

fs.rmSync(fixture, { recursive: true, force: true });

// =============================================================================
rule('4. THE WIRING — CI invokes the runner, and invokes this script directly');
// =============================================================================
//
// Sections 1-3 are about a selector. This one is about whether anything calls
// it. Read off `ci.yml` rather than assumed, because the whole ticket is that
// the two had come apart.

const ciPath = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const ci = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, 'utf8') : '';
check(ci.length > 0, 'ci.yml is where this script expects it', ciPath);

// Only the *run* lines count. A path appearing in a comment is not an invocation,
// and this file is full of comments that name these scripts.
const invocations = ci
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

check(
  /run-ci-verify-set\.mjs/.test(invocations),
  'ci.yml invokes the runner, so the whole discovered set is executed on every PR',
  'no uncommented line of ci.yml names daemon/scripts/run-ci-verify-set.mjs'
);
check(
  /verify-ci-partition-is-enforced\.mjs/.test(invocations),
  'and ci.yml invokes THIS script directly too — its own execution does not depend on the runner',
  'no uncommented line of ci.yml names daemon/scripts/verify-ci-partition-is-enforced.mjs'
);

// =============================================================================
rule('5. THIS REPOSITORY — every script classified, and this one in the set');
// =============================================================================

const rows = readPartition();
const real = partitionProblems(rows);
check(
  real.length === 0,
  `all ${rows.length} verify-* scripts under ${SCRIPT_DIRS.join(' and ')} carry an honest CI-RUNNABLE line`,
  real.map((p) => `${p.rel} ${p.what}`).join('\n')
);

const self = rows.find((r) => r.name === 'verify-ci-partition-is-enforced');
check(
  self?.runsInCi === true,
  'and this script is itself in the runnable set — the guard against unrun guards is run',
  `class: ${self?.class ?? '(not found)'}`
);

const counts = {};
for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
console.log(
  `\n  the partition: ` +
    Object.entries(counts)
      .sort()
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') +
    `  (${rows.filter((r) => r.runsInCi).length} of ${rows.length} run in CI)`
);

// =============================================================================
rule('6. THE CHECKED-IN VIEW AGREES WITH THE HEADERS');
// =============================================================================
//
// `ci-partition.md` is a generated view, not a second source of truth — but a
// stale view is read as the truth by whoever reads it instead of 76 files. It
// is regenerated by `node daemon/scripts/run-ci-verify-set.mjs --list`-adjacent
// tooling and checked here against the headers it claims to summarise.

const mdPath = path.join(REPO_ROOT, 'daemon', 'scripts', 'ci-partition.md');
const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
check(md.length > 0, 'ci-partition.md exists', mdPath);

const missingFromMd = rows.filter((r) => !md.includes(r.name));
check(
  missingFromMd.length === 0,
  'every script in the tree appears in ci-partition.md',
  missingFromMd.map((r) => r.rel).join('\n')
);

// The reverse direction: a row for a script that is no longer a file. That is
// how a document goes on describing a partition that has moved.
//
// Rows only, not prose. The prose legitimately names things that are not
// scripts in this tree — `verify-script-sweep` is a *job* in `ci.yml` whose
// script is `sweep-verify-exit-paths.mjs` — and an orphan check that reads
// prose reports those as missing files. It did, on this script's first run.
const declared = [...md.matchAll(/^\|\s*`(verify-[a-z0-9-]+)`\s*\|\s*([a-z]+)\s*\|/gm)];

const orphans = [...new Set(declared.map((m) => m[1]))].filter(
  (n) => !rows.some((r) => r.name === n)
);
check(
  orphans.length === 0,
  'and every script ci-partition.md has a row for still exists',
  `row present but file absent: ${orphans.join(', ')}`
);
const disagree = declared
  .map(([, name, cls]) => ({ name, cls, actual: rows.find((r) => r.name === name)?.class }))
  .filter((d) => d.actual && d.cls !== d.actual);
check(
  disagree.length === 0,
  'and the class it records for each is the class in that script\'s own header',
  disagree.map((d) => `${d.name}: document says ${d.cls}, header says ${d.actual}`).join('\n')
);

// =============================================================================
rule('7. THE SUMMARY BLOCK AGREES WITH THE TABLE BENEATH IT');
// =============================================================================
//
// KAN-409. §6 reconciles the per-script rows and stops there, so the summary
// above them — the class counts, the total, and the `N of M` sentence — was
// unguarded. A clean git auto-merge takes both sides' new rows into the table
// and leaves the summary at the older total: measured rebasing #171 onto #169,
// where the table was correct at 112 rows and the summary still read 111. Both
// the stale file and the regenerated one passed §6.
//
// It matters because the totals are what a reader actually reads. `**91 of
// 111** run on every pull request` is the sentence somebody quotes in a PR or a
// ruling; the 112-row table underneath is what nobody counts. A stale summary
// understates coverage and degrades toward LOOKING FINISHED — plausible,
// well-formed, and wrong in the direction that invites no questions.
//
// TWO ARMS, and they fail independently on purpose:
//
//   (a) Against the tree. Expected is re-derived by `summaryParts`, the same
//       function the generator emits from, so the writer and the checker cannot
//       drift. §6 having already tied the table to the tree, agreement with the
//       tree IS agreement with the table — and the row count is asserted below
//       so that is stated rather than left to be inferred.
//   (b) Against itself, from the document's own numbers alone. The class counts
//       must sum to the total; the sentence's M must be that total and its N the
//       sum of the classes CI runs. This arm holds whatever `summaryParts` does,
//       which is what stops arm (a) from being a function agreeing with itself.
//
// WHAT THIS LEAVES UNCOVERED: nothing here guards the *generator*. Arm (b)
// catches a generator whose summary is internally inconsistent; a generator that
// is wrong CONSISTENTLY — miscounting a class in both the table and the totals —
// produces a document both arms agree with. Regeneration is still trusted, and
// no check in this file changes that. WHO COVERS IT: nobody. Said plainly rather
// than left for a reader to infer a coverage that does not exist.

const expectedSummary = summaryParts(rows);
const foundSummary = parseSummary(md);

check(
  foundSummary.found,
  'ci-partition.md has a `## Totals` block to check at all',
  'no `## Totals` section — a summary that cannot be found is a failure here, not an absence'
);
check(
  foundSummary.classRows.join('\n') === expectedSummary.classRows.join('\n'),
  'the per-class counts in the summary are the classes in the tree',
  `document:\n${foundSummary.classRows.join('\n') || '(none parsed)'}\n` +
    `recomputed:\n${expectedSummary.classRows.join('\n')}`
);
check(
  foundSummary.totalRow === expectedSummary.totalRow,
  'the total row is the number of scripts the tree holds',
  `document: ${foundSummary.totalRow ?? '(none parsed)'}\nrecomputed: ${expectedSummary.totalRow}`
);
check(
  foundSummary.sentence === expectedSummary.sentence,
  'and the `N of M` sentence — the number a reader quotes — is that same pair',
  `document: ${foundSummary.sentence ?? '(none parsed)'}\nrecomputed: ${expectedSummary.sentence}`
);
check(
  declared.length === rows.length,
  'the table itself carries exactly one row per script, so agreeing with the tree is agreeing with the table',
  `${declared.length} row(s) in ci-partition.md, ${rows.length} script(s) in the tree`
);

// Arm (b): internal consistency, computed from the document and nothing else.
const summedClasses = Object.values(foundSummary.counts).reduce((a, b) => a + b, 0);
const summedInCi = RUNS_IN_CI.reduce((a, k) => a + (foundSummary.counts[k] ?? 0), 0);
check(
  foundSummary.total !== null && summedClasses === foundSummary.total,
  'the summary is consistent with itself: its class counts sum to its own total',
  `classes sum to ${summedClasses}, total row says ${foundSummary.total ?? '(none parsed)'}`
);
check(
  foundSummary.sentenceOf !== null && foundSummary.sentenceOf === foundSummary.total,
  'and the M of `N of M` is that same total',
  `sentence says of ${foundSummary.sentenceOf ?? '(none parsed)'}, total row says ${foundSummary.total ?? '(none parsed)'}`
);
check(
  foundSummary.sentenceIn !== null && foundSummary.sentenceIn === summedInCi,
  `and its N is the sum of the classes CI runs (${RUNS_IN_CI.join(' + ')})`,
  `sentence says ${foundSummary.sentenceIn ?? '(none parsed)'}, those classes sum to ${summedInCi}`
);

console.log('');
if (failures) {
  console.log(`== ${failures} CHECK(S) FAILED ==`);
  console.log(
    'The partition and what runs it have come apart. That is the KAN-295 condition\n' +
      'returning: a verify- script that exists and is not run, or one that left CI\n' +
      'without saying so.'
  );
} else {
  console.log(
    `== ALL PASS — ${rows.length} scripts classified, ${rows.filter((r) => r.runsInCi).length} of them run by CI ==\n\n` +
      'This establishes that the selector is directory-driven and that ci.yml calls it.\n' +
      'It does NOT establish that GitHub Actions executed anything — see the header for\n' +
      'what that leaves uncovered and who covers it.'
  );
}
process.exit(failures > 0 ? 1 : 0);
