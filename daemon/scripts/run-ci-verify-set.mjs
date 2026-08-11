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
import { readPartition, partitionProblems, REPO_ROOT, RUNS_IN_CI, CLASSES } from './lib/ci-partition.mjs';

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
  const ok = run.status === 0;
  results.push({ ...r, ok, status: run.status, signal: run.signal, timedOut, seconds, run });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(48)} ${seconds.toFixed(1).padStart(6)}s` +
      (r.class === 'partial' ? '   (partial — see its header for what CI does not reach)' : '')
  );
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
  const counts = {};
  for (const r of rows) counts[r.class] = (counts[r.class] ?? 0) + 1;
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
  out.push('## Totals');
  out.push('');
  out.push('| class | count |');
  out.push('| --- | --- |');
  for (const k of Object.keys(CLASSES)) out.push(`| \`${k}\` | ${counts[k] ?? 0} |`);
  out.push(`| **total** | **${rows.length}** |`);
  out.push('');
  out.push(`**${set.length} of ${rows.length}** run on every pull request.`);
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
const wall = results.reduce((s, r) => s + r.seconds, 0);

console.log('');
console.log(`${results.length - failed.length}/${results.length} passed in ${wall.toFixed(1)}s of child wall clock.`);
console.log('');
announceTheRest();

if (failed.length) {
  console.log(`\n${failed.length} script(s) FAILED:`);
  for (const r of failed) {
    console.log(`  - ${r.rel} (exit ${r.status}${r.timedOut ? ', timed out' : ''})`);
  }
  console.log(
    '\nA failure here is a proof that no longer holds. Fix the behaviour it names, or —\n' +
      'if the script itself has rotted — repair the script and drive it red again by hand.\n' +
      'Do not quarantine it to get green without a ticket that owns it: the annotation\n' +
      'grammar refuses a quarantine that names nobody.'
  );
}

process.exit(failed.length > 0 ? 1 : 0);
