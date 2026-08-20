// KAN-295: run every `verify-` script the partition says CI can run.
//
// This is the job that turns one-time, hand-driven demonstrations into checks
// that are evaluated on every pull request. When KAN-295 was filed there were
// 76 `verify-*` scripts and CI evaluated the assertions of exactly one of them.
// That pair of numbers is a fact about 2026-08-11 and is safe to quote; the
// size of today's runnable set is not, so it is printed at run time and never
// written down here. (`rule-inventory.md` has the same rule and the same
// reason: a quoted count invites a reader to treat a different count as a
// broken recipe.)
//
// `run-` rather than `verify-`, deliberately, and for the same reason
// `sweep-verify-exit-paths.mjs` is `sweep-`: this file proves no product
// behaviour of its own. It is a harness. Putting it in the `verify-` namespace
// would make it police itself, and would put it in its own runnable set.
//
// WHAT IT SELECTS AND WHY IT SCANS RATHER THAN LISTS
//
// The set is discovered by reading the `CI-RUNNABLE:` line out of every
// `verify-*.mjs` in the swept directories — never from a list here, and never
// from a list in `ci.yml`. That is the whole mechanism behind KAN-295's
// criterion 5: **a CI-runnable script cannot be added without CI picking it
// up**, because nothing has to be edited for it to be picked up. A list would
// have reintroduced, one layer up, exactly the defect this ticket was filed
// about — a guard that exists and is not run.
//
// `verify-ci-partition-is-enforced.mjs` is what holds that claim to account.
//
// WHY IT SANDBOXES `HOME`
//
// Every child runs with `HOME` pointed at a fresh temporary directory. In CI
// that changes nothing — there is no daemon and no herdr on a runner. Run
// locally it is what stops a script from reading, or writing, the live fleet's
// `~/.local/share/butchr`: `BUTCHR_DIR` and `SOCKET_PATH` are both derived from
// `os.homedir()`, so relocating `HOME` relocates the daemon these scripts can
// see. This is not a nicety — the partition was measured this way, and a run
// that did not sandbox would be measuring a different thing than CI runs.
//
// Pass `--no-sandbox` to run against the real `HOME`. Nothing in CI does.
//
// WHY IT ALSO WATCHES THE WORKING TREE
//
// KAN-350. The `HOME` sandbox above bounds where a child can reach through the
// environment, and that is not the same as bounding where it writes.
// `verify-agent-tree.mjs` resolved its output directory from `import.meta.url`,
// so no environment variable could have reached it: it wrote into
// `extension/kan81-render/` on every run, rode along unmentioned in six commits
// across four unrelated tickets, and made `staleness_check` — which compares
// mtimes over the whole of `extension/` — report the extension stale each time.
// KAN-326 moved that one path out of the repository and added
// `extension/scripts/verify-render-writes-outside-the-tree.mjs` to hold it
// there. That guard asserts about one script; this one is the general claim,
// and it is here rather than in a `verify-` script because a property of the
// harness covers scripts nobody has written yet, on the day they are added, by
// nobody.
//
// WHICH PROPERTY THIS IS, STATED PRECISELY, BECAUSE A WIDER READING IS AVAILABLE
// AND WRONG:
//
//   * It is a DELTA across each child, not a clean-tree assertion. An agent runs
//     this set immediately before pushing, which is exactly when the tree is
//     full of its own uncommitted work; a check that demanded a clean tree would
//     go red on every one of those runs, and an instrument that cries wolf is
//     the defect this ticket was filed about. The baseline advances after every
//     child, so each child is blamed for its own writes and never its
//     predecessor's.
//   * It therefore does NOT catch a script that writes into the tree and then
//     deletes what it wrote. That script has still written into the working
//     tree, and this guard would pass it. Covered by nobody today, and named
//     here rather than left to be inferred — `verify-ci-set-guards-tree-writes.mjs`
//     §1 asserts the property that IS implemented, and its header says the same.
//   * `dist/` and `node_modules/` are excluded, for the reason `staleness_check`
//     excludes them: a child that runs a build has not committed the defect this
//     is guarding.
//
// The guard is a precondition rather than a nicety: if `git status` cannot be
// taken at the repository root, the run REFUSES to start rather than running the
// set with the claim silently unmade. A required check that quietly skips its
// strongest leg is KAN-241's defect, and this file already takes the same line
// on a partition that does not parse.
//
// Usage:
//   node daemon/scripts/run-ci-verify-set.mjs [--verbose] [--no-sandbox]
//   node daemon/scripts/run-ci-verify-set.mjs --list        # print the set, run nothing
//   node daemon/scripts/run-ci-verify-set.mjs --markdown > daemon/scripts/ci-partition.md
//
// `--markdown` regenerates the checked-in view of the partition. That file is a
// view and never a source of truth — the headers are — and
// `verify-ci-partition-is-enforced.mjs` §6 is what stops the two drifting.
//
// Requires `daemon/dist` and `extension/dist` to be built — several scripts in
// the set import the built modules. The runner checks for them up front and
// says so rather than reporting 40 confusing failures.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { readPartition, partitionProblems, REPO_ROOT, RUNS_IN_CI, CLASSES, summaryParts } from './lib/ci-partition.mjs';
import { EXIT_INCOMPLETE } from './lib/verdict-exit.mjs';

const verbose = process.argv.includes('--verbose');
const listOnly = process.argv.includes('--list');
const markdown = process.argv.includes('--markdown');
const sandbox = !process.argv.includes('--no-sandbox');

/** Per-script ceiling. Nothing in the runnable set came near this when measured. */
const TIMEOUT_MS = 300_000;

const rows = readPartition();
const problems = partitionProblems(rows);

// A partition that does not parse is not a partition. Refuse to run a set
// selected from it rather than quietly running the part that did parse.
if (problems.length) {
  console.error('the CI partition is not readable, so the runnable set cannot be trusted:\n');
  for (const p of problems) console.error(`  - ${p.rel} ${p.what}`);
  console.error('\nRun `node daemon/scripts/verify-ci-partition-is-enforced.mjs` for the full account.');
  process.exit(1);
}

const set = rows.filter((r) => r.runsInCi);
const quarantined = rows.filter((r) => r.class === 'quarantined');
const excluded = rows.filter((r) => r.class === 'no');

// A runner that selects nothing passes trivially, which is the failure mode
// this whole ticket is about wearing the runner's clothes. There is no honest
// state of this repository in which the runnable set is empty.
if (set.length === 0) {
  console.error(
    `no script is annotated ${RUNS_IN_CI.map((c) => `\`${c}\``).join(' or ')}, out of ${rows.length} swept.\n` +
      'That is not a green run — it is a broken selector or a mis-annotated tree.'
  );
  process.exit(1);
}

if (markdown) {
  emitMarkdown();
  process.exit(0);
}

console.log(`the CI-runnable set: ${set.length} of ${rows.length} verify-* scripts\n`);

if (listOnly) {
  for (const r of set) console.log(`${r.class.padEnd(8)} ${r.rel}`);
  console.log('');
  announceTheRest();
  process.exit(0);
}

// The builds several of these import. Checked once, up front.
const missing = [
  ['daemon/dist/daemon.js', 'npm ci && npm run build, in daemon/'],
  ['extension/dist/sidepanel.html', 'npm ci && npm run build, in extension/']
].filter(([rel]) => !fs.existsSync(path.join(REPO_ROOT, rel)));
if (missing.length) {
  console.error('the runnable set needs builds that are not here:\n');
  for (const [rel, how] of missing) console.error(`  - ${rel}   (${how})`);
  process.exit(1);
}

/**
 * `git status --porcelain` over the whole repository, as a comparable snapshot.
 *
 * Returns `null` when git cannot answer — which is what arms or refuses the
 * guard below, and is never treated as "nothing changed".
 */
function treeSnapshot() {
  const r = spawnSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .filter((l) => !/(^|\/)(dist|node_modules)\//.test(l));
}

// Armed before the first child, and a failure to arm stops the run. See the
// header: a claim this file cannot make is one it must not appear to have made.
let baseline = treeSnapshot();
if (baseline === null) {
  console.error(
    'the working-tree guard cannot be armed: `git status --porcelain` did not exit 0 at\n' +
      `  ${REPO_ROOT}\n\n` +
      'Every child is watched for writes into the working tree (KAN-350), and that check\n' +
      'needs git. Refusing to run the set rather than running it with the claim unmade.'
  );
  process.exit(1);
}

const results = [];
for (const r of set) {
  const home = sandbox ? fs.mkdtempSync(path.join(os.tmpdir(), 'kan295-')) : process.env.HOME;
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, r.rel)], {
    cwd: path.join(REPO_ROOT, 'daemon'),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  const seconds = (Date.now() - started) / 1000;
  const timedOut = run.signal === 'SIGTERM' && seconds * 1000 >= TIMEOUT_MS - 1000;

  // What this child, and only this child, left behind. The baseline advances
  // below so the next one is not blamed for it.
  const after = treeSnapshot();
  const dirtied = after === null ? null : after.filter((l) => !baseline.includes(l));
  if (after !== null) baseline = after;

  // KAN-373: exit 2 is INCOMPLETE — nothing failed, and something did not run.
  // See `lib/verdict-exit.mjs`. On a `partial` script that is the expected
  // outcome here: the class means "some sections need what CI has not got", CI
  // has no CrabCast peer, and those sections skip. It is NOT a failure.
  //
  // ⚠ IT IS ALSO NOT A PASS, AND THAT IS THE WHOLE POINT OF COUNTING IT. The
  // tempting one-line alternative was to hand every `partial` child
  // `--allow-skipped` and let it exit 0 — which would have rebuilt the exact
  // defect KAN-373 was filed about, one level up: a green job that cannot
  // distinguish "all 139 ran" from "134 ran and 5 skipped". So an incomplete
  // child is reported as INCOMPLETE, counted separately, and named in the
  // summary.
  //
  // On a `yes` script exit 2 IS a failure — that class asserts it needs nothing
  // CI lacks, so a skip there means the header is wrong about its own script.
  const incomplete = run.status === EXIT_INCOMPLETE && r.class === 'partial';
  const ok = (run.status === 0 || incomplete) && dirtied !== null && dirtied.length === 0;
  results.push({
    ...r,
    ok,
    incomplete,
    status: run.status,
    signal: run.signal,
    timedOut,
    seconds,
    run,
    dirtied
  });
  console.log(
    `${ok ? (incomplete ? 'SKIP' : 'PASS') : 'FAIL'}  ${r.name.padEnd(48)} ${seconds.toFixed(1).padStart(6)}s` +
      (incomplete ? '   (INCOMPLETE — a section did not run; exit 2, not a pass)' : '') +
      (r.class === 'partial' ? '   (partial — see its header for what CI does not reach)' : '') +
      (dirtied === null ? '   (DIRTIED? — git status stopped answering mid-run)' : '') +
      (dirtied?.length ? `   (WROTE INTO THE WORKING TREE — ${dirtied.length} path(s))` : '')
  );
  if (dirtied === null || dirtied.length) {
    console.log(
      dirtied === null
        ? '      git status did not exit 0 after this child, so what it wrote is unknown'
        : dirtied.map((l) => `      ${l}`).join('\n')
    );
  }
  if (sandbox) fs.rmSync(home, { recursive: true, force: true });
  if (!ok || verbose) {
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd();
    const tail = out.split('\n').slice(verbose && ok ? -3 : -25).join('\n');
    console.log(tail.replace(/^/gm, '      '));
    if (timedOut) console.log(`      (killed at the ${TIMEOUT_MS / 1000}s ceiling)`);
    console.log('');
  }
}

/** The checked-in view. Regenerated with `--markdown`; never hand-edited. */
function emitMarkdown() {
  const out = [];
  out.push('# The CI partition of the `verify-` scripts');
  out.push('');
  out.push('**Generated — do not hand-edit.** Regenerate with:');
  out.push('');
  out.push('```bash');
  out.push('node daemon/scripts/run-ci-verify-set.mjs --markdown > daemon/scripts/ci-partition.md');
  out.push('```');
  out.push('');
  out.push('One row per `verify-*.mjs`. The **source of truth is the `CI-RUNNABLE:` line in');
  out.push("each script's own header**, where the next reader of that script meets it; this");
  out.push('file is a view of those lines and nothing more.');
  out.push('`verify-ci-partition-is-enforced.mjs` §6 goes red when the two disagree, in');
  out.push('either direction.');
  out.push('');
  out.push('## Why this file exists');
  out.push('');
  out.push('KAN-295. On 2026-08-11 this repository held 76 `verify-*` scripts and CI');
  out.push('evaluated the assertions of **one**. `verify-script-sweep` swept all 76, but');
  out.push('only for');
  out.push('verdict-driven exits — that each *could* report failure, never what any of them');
  out.push('asserted. Every "made to go red" proof on the board was therefore a one-time,');
  out.push('hand-driven demonstration at review time: real the day it landed, and never');
  out.push('re-evaluated after merge.');
  out.push('');
  out.push('The answer is not "run all 76" — many genuinely cannot run unattended. So the');
  out.push('classification is the deliverable and the CI job is downstream of it.');
  out.push('');
  out.push('## The classes');
  out.push('');
  out.push('| class | meaning | run by CI |');
  out.push('| --- | --- | --- |');
  for (const [k, v] of Object.entries(CLASSES)) {
    out.push(`| \`${k}\` | ${v} | ${RUNS_IN_CI.includes(k) ? '**yes**' : 'no'} |`);
  }
  out.push('');
  // KAN-409: the three summary lines come from `summaryParts`, which the guard
  // re-derives from too. Emitted inline here, they were a second place for the
  // totals to live, and a clean auto-merge left them behind the table below.
  const summary = summaryParts(rows);
  out.push('## Totals');
  out.push('');
  out.push('| class | count |');
  out.push('| --- | --- |');
  out.push(...summary.classRows);
  out.push(summary.totalRow);
  out.push('');
  out.push(summary.sentence);
  out.push('');
  for (const cls of Object.keys(CLASSES)) {
    const group = rows.filter((r) => r.class === cls);
    if (!group.length) continue;
    out.push(`## \`${cls}\` — ${CLASSES[cls]}`);
    out.push('');
    out.push('| script | class | reason |');
    out.push('| --- | --- | --- |');
    for (const r of group) {
      out.push(`| \`${r.name}\` | ${r.class} | ${r.reason.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }
  console.log(out.join('\n'));
}

function announceTheRest() {
  // Printed on every run, pass or fail. A quarantine nobody is reminded of is
  // the silent exclusion this ticket exists to end.
  if (quarantined.length) {
    console.log(`${quarantined.length} script(s) QUARANTINED — CI-runnable, currently red, not run here:`);
    for (const r of quarantined) console.log(`  - ${r.name}: ${r.reason.slice(0, 150)}`);
    console.log('');
  }
  console.log(`${excluded.length} script(s) cannot run unattended in CI; each says why in its own header.`);
  if (verbose) for (const r of excluded) console.log(`  - ${r.name}: ${r.reason.slice(0, 120)}`);
}

const failed = results.filter((r) => !r.ok);
// KAN-373: counted apart from the passes, because "passed" and "did not run"
// are the two things this whole ticket exists to keep separable.
const incompletes = results.filter((r) => r.ok && r.incomplete);
const wall = results.reduce((s, r) => s + r.seconds, 0);

console.log('');
console.log(
  `${results.length - failed.length - incompletes.length}/${results.length} passed` +
    (incompletes.length ? `, ${incompletes.length} INCOMPLETE` : '') +
    ` in ${wall.toFixed(1)}s of child wall clock.`
);
if (incompletes.length) {
  console.log(
    `\n${incompletes.length} script(s) exited ${EXIT_INCOMPLETE} — INCOMPLETE. Nothing failed, and a\n` +
      'section did not run. Each is `partial`, and CI has no CrabCast peer, so this is the\n' +
      'expected outcome here — but it is NOT a pass, and these are the sections no runner on\n' +
      'this machine has ever exercised:'
  );
  for (const r of incompletes) console.log(`  - ${r.name}`);
}
console.log('');
announceTheRest();

const dirtiedTheTree = results.filter((r) => r.dirtied === null || r.dirtied?.length);

if (failed.length) {
  console.log(`\n${failed.length} script(s) FAILED:`);
  for (const r of failed) {
    const why = [
      r.status === 0 ? null : `exit ${r.status}`,
      r.timedOut ? 'timed out' : null,
      r.dirtied === null ? 'tree state unknown' : r.dirtied.length ? `wrote ${r.dirtied.length} path(s)` : null
    ].filter(Boolean);
    console.log(`  - ${r.rel} (${why.join(', ')})`);
  }
  console.log(
    '\nA failure here is a proof that no longer holds. Fix the behaviour it names, or —\n' +
      'if the script itself has rotted — repair the script and drive it red again by hand.\n' +
      'Do not quarantine it to get green without a ticket that owns it: the annotation\n' +
      'grammar refuses a quarantine that names nobody.'
  );
}

if (dirtiedTheTree.length) {
  console.log(
    `\n${dirtiedTheTree.length} script(s) WROTE INTO THE WORKING TREE (KAN-350).\n\n` +
      'That is a failure whatever the script asserted, and it is not a tidiness rule:\n' +
      'a file written on every run rides along unmentioned in unrelated commits, and\n' +
      '`staleness_check` compares mtimes rather than content — so a write under\n' +
      '`extension/` makes `extension-build` read stale even when the bytes are\n' +
      'identical, spending the credibility of the one instrument that catches a\n' +
      'genuinely un-rebuilt extension.\n\n' +
      'The fix is in the script: send its output outside the repository, the way\n' +
      '`extension/scripts/verify-agent-tree.mjs` does. Note that a `HOME` sandbox will\n' +
      'not do it — that defect resolved its path from `import.meta.url`, which no\n' +
      'environment variable can reach.'
  );
}

process.exit(failed.length > 0 ? 1 : 0);
