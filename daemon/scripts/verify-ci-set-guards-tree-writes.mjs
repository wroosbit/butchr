// KAN-350: `run-ci-verify-set.mjs` fails any child that writes into the working
// tree — the general claim, for scripts nobody has written yet.
//
// WHAT FAILURE THIS WOULD CATCH: the working-tree guard being removed from the
// runner, weakened into a warning, made opt-out-able, or left silently unarmed —
// any of which would let a `verify-` script acquire the defect KAN-326 fixed and
// be run by CI on every pull request with nothing reporting it.
//
// The defect, so the guard is read as the thing it is rather than as tidiness:
// `extension/scripts/verify-agent-tree.mjs` rendered into
// `extension/kan81-render/` by default. It prints elapsed time from a fixed
// synthetic fixture against the live clock, so it differs on every run forever;
// it rode along unmentioned in six commits across four unrelated tickets on that
// mechanism alone. And `staleness_check` compares mtimes rather than content
// over the whole of `extension/`, so every run made `extension-build` read
// stale — spending the credibility of the one instrument that catches a
// genuinely un-rebuilt extension, which no agent can fix because only a human
// pressing Reload at chrome://extensions deploys one.
//
// KAN-326 moved that one path outside the repository and added
// `verify-render-writes-outside-the-tree.mjs` to hold it there. Its own header
// says what it does not cover: **it asserts about one script**, and a different
// `verify-*` acquiring the same defect would pass it untouched. This file is the
// other half — it does not audit paths script by script, which answers the
// question once for the set as it stands today and begins decaying immediately.
// It establishes a property of the harness, which covers a script added next
// month on the day it is added, by nobody.
//
// WHICH PROPERTY, STATED PRECISELY — THE WIDER READING IS AVAILABLE AND WRONG
//
// The runner takes `git status --porcelain` around every child and fails the one
// that leaves a delta. So:
//
//   * A script that writes into the tree and then DELETES what it wrote passes.
//     It has still written into the working tree. That is a different property,
//     it is not implemented, and **it is covered by nobody** — said here rather
//     than left to be inferred, because "no CI-runnable verify script writes into
//     the working tree" is what the guard looks like it says and is not what it
//     says.
//   * It is a DELTA, not a clean-tree assertion, and §3 below is what pins that
//     down. An agent runs this set immediately before pushing, which is exactly
//     when its tree is full of its own uncommitted work; a check that demanded a
//     clean tree would go red on every one of those runs, and an instrument that
//     cries wolf is the defect KAN-326 was filed about.
//   * `dist/` and `node_modules/` are excluded, for the reason `staleness_check`
//     excludes them: a child that ran a build has not committed this defect.
//   * Writes outside the repository are not the subject at all. That is what the
//     scripts are being asked to do.
//
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
//
// This script writes the fixture scripts it then asserts on, so it does not
// prove that any script in *this* repository is clean today — a proof that
// supplies its own input has not tested that the input arrives. What covers that
// leg is the runner itself: the guard runs against the real set on every pull
// request in the `verify-runnable-set` job, so the live claim about this tree is
// made there, by the harness, on every PR, and not here. This file's job is the
// one that job cannot do for itself — showing that the guard can go red at all,
// which is the only test that separates a verdict that fires from one that
// cannot.
//
// What runs under test is the SHIPPED runner: `run-ci-verify-set.mjs` and
// `lib/ci-partition.mjs` are copied byte-for-byte into a temporary git
// repository at run time, never re-implemented here, and §5 asserts the copy is
// identical. The fixture children are generated, because the defect has to be
// deliberate — the whole point is watching the gate catch it.
//
// CI-RUNNABLE: yes — it builds a throwaway git repository under `os.tmpdir()`
// and spawns the copied runner in it. No live daemon, no herdr, no credential,
// no peer, no terminal, no network; the only external binary is `git`, which the
// checkout already requires. It does not run this repository's own verify set,
// so it does not run the set from inside the set.
//
// NOTHING HERE IMPORTS FROM `dist`. Said explicitly because the house rule is
// that a proof run after a failed build tested the previous build rather than
// your change. This one copies source `.mjs` files and reads the filesystem, so
// its verdict is about the tree as it is now and a failed `npm run build` does
// not invalidate it.
//
// Usage:
//   node daemon/scripts/verify-ci-set-guards-tree-writes.mjs [--verbose]
//
// Exit code 0 means every assertion below held.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const RUNNER = path.join(REPO_ROOT, 'daemon', 'scripts', 'run-ci-verify-set.mjs');
const PARTITION_LIB = path.join(REPO_ROOT, 'daemon', 'scripts', 'lib', 'ci-partition.mjs');

const verbose = process.argv.includes('--verbose');

const failures = [];
let checks = 0;
function check(what, condition, detail) {
  checks += 1;
  const ok = !!condition;
  if (!ok) failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * A child that writes one file into the tree and then exits 0.
 *
 * The path is resolved from `import.meta.url`, exactly as the real defect
 * resolved its output directory. That is the reason the runner's `HOME` sandbox
 * did not bound it and a cwd-based test would not have told the two apart: no
 * environment variable can reach a path a script computes from its own location.
 *
 * Exiting 0 is the other half of the fixture. Its own assertions "hold"; the
 * only thing wrong with it is where it wrote. A guard that only failed children
 * which were already failing would be worth nothing.
 */
const DIRTIES = `// Fixture generated by verify-ci-set-guards-tree-writes.mjs. Not a real proof.
//
// WHAT FAILURE THIS WOULD CATCH: nothing. It is the defect, written on purpose.
//
// CI-RUNNABLE: yes — a fixture written into a temporary tree at run time, never
// part of this repository's swept directories.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(here, '..', 'kan350-fixture-write.txt'), 'rendered at ' + Date.now() + '\\n');

const failures = [];
console.log('fixture: asserted nothing, wrote one file into the tree, exiting 0');
process.exit(failures.length ? 1 : 0);
`;

/** A child that writes nothing and exits 0. */
const CLEAN = `// Fixture generated by verify-ci-set-guards-tree-writes.mjs. Not a real proof.
//
// WHAT FAILURE THIS WOULD CATCH: nothing. It is the control.
//
// CI-RUNNABLE: yes — a fixture written into a temporary tree at run time, never
// part of this repository's swept directories.

const failures = [];
console.log('fixture: wrote nothing, exiting 0');
process.exit(failures.length ? 1 : 0);
`;

/**
 * Build a throwaway repository holding the shipped runner and the named
 * fixtures, committed so the baseline is clean.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.scripts  filename → source, under daemon/scripts
 * @param {boolean} [opts.git]                  initialise and commit (default true)
 * @param {string}  [opts.uncommitted]          a file to leave dirty AFTER the commit
 */
function fixture({ scripts, git = true, uncommitted = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan350-fixture-'));
  fs.mkdirSync(path.join(dir, 'daemon', 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'daemon', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'extension', 'dist'), { recursive: true });

  // The shipped files, copied rather than re-implemented. §5 asserts identity.
  fs.copyFileSync(RUNNER, path.join(dir, 'daemon', 'scripts', 'run-ci-verify-set.mjs'));
  fs.copyFileSync(PARTITION_LIB, path.join(dir, 'daemon', 'scripts', 'lib', 'ci-partition.mjs'));

  // The two build artifacts the runner checks for up front.
  fs.writeFileSync(path.join(dir, 'daemon', 'dist', 'daemon.js'), '// fixture\n');
  fs.writeFileSync(path.join(dir, 'extension', 'dist', 'sidepanel.html'), '<!-- fixture -->\n');

  for (const [name, source] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(dir, 'daemon', 'scripts', name), source);
  }

  if (git) {
    const g = (...args) =>
      spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g(
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'fixture baseline'
    );
  }

  // Written after the commit on purpose: this is the operator's own uncommitted
  // work, which §3 requires the guard to be blind to.
  if (uncommitted) fs.writeFileSync(path.join(dir, uncommitted), 'the operator was mid-change\n');

  return dir;
}

/** Run the copied runner inside a fixture and return its combined output. */
function runIn(dir, { argv = [], env = {} } = {}) {
  const run = spawnSync(process.execPath, [path.join(dir, 'daemon', 'scripts', 'run-ci-verify-set.mjs'), ...argv], {
    cwd: path.join(dir, 'daemon'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (verbose) console.log(out.replace(/^/gm, '        │ '));
  return { status: run.status, out };
}

const cleanup = [];
const build = (opts) => {
  const dir = fixture(opts);
  cleanup.push(dir);
  return dir;
};

console.log('assertions');
console.log('─'.repeat(78));

// ---------------------------------------------------------------------------
// §1 — the guard catches a child that writes into the tree, and it is the
//      child's WRITE rather than its verdict that fails it
// ---------------------------------------------------------------------------
console.log('\n§1  a child that dirties the tree fails, even though it exited 0');

const one = build({
  scripts: {
    'verify-fixture-a-dirties-tree.mjs': DIRTIES,
    'verify-fixture-b-clean.mjs': CLEAN
  }
});
const r1 = runIn(one);

check('the run goes red', r1.status !== 0, `runner exited ${r1.status}`);

check(
  'the dirtying child is reported FAIL',
  /FAIL\s+verify-fixture-a-dirties-tree/.test(r1.out),
  r1.out.match(/^(PASS|FAIL)\s+verify-fixture-a-dirties-tree.*$/m)?.[0]?.trim() ?? 'no verdict line for it'
);

check(
  'the path it wrote is named in the output',
  r1.out.includes('kan350-fixture-write.txt'),
  r1.out.includes('kan350-fixture-write.txt') ? undefined : 'the file it wrote is not mentioned anywhere'
);

// The summary line carries the reason. `wrote 1 path(s)` with no `exit N` beside
// it is the assertion that the child's own verdict was green and the write is
// what failed it — which is the whole property, and is not visible from the exit
// code of the run.
const summaryLine = r1.out.match(/^\s*-\s.*verify-fixture-a-dirties-tree\.mjs\s*\((.*)\)\s*$/m)?.[1] ?? null;
check(
  'it failed for writing, not for its own exit code',
  summaryLine !== null && /wrote 1 path\(s\)/.test(summaryLine) && !/exit \d/.test(summaryLine),
  summaryLine === null ? 'no summary line for the dirtying child' : `summary reads: (${summaryLine})`
);

// Attribution. The baseline advances after every child, so the file the previous
// child left behind must not be charged to this one — without that, one dirtying
// script would fail every script after it and the output would name the wrong
// file to fix.
check(
  'the next child is not blamed for the previous one’s write',
  /PASS\s+verify-fixture-b-clean/.test(r1.out),
  r1.out.match(/^(PASS|FAIL)\s+verify-fixture-b-clean.*$/m)?.[0]?.trim() ?? 'no verdict line for the clean child'
);

const explains = /WROTE INTO THE WORKING TREE/.test(r1.out) && /staleness_check/.test(r1.out);
check(
  'the run says what a working-tree write costs, rather than only that it happened',
  explains,
  explains ? undefined : 'the closing explanation is missing from the runner output'
);

// ---------------------------------------------------------------------------
// §2 — and it does not fire on a set that writes nothing
// ---------------------------------------------------------------------------
console.log('\n§2  a clean set stays green');

const two = build({ scripts: { 'verify-fixture-b-clean.mjs': CLEAN } });
const r2 = runIn(two);

check('the run is green', r2.status === 0, `runner exited ${r2.status}`);
check('the clean child passes', /PASS\s+verify-fixture-b-clean/.test(r2.out));
check('nothing is reported as having written into the tree', !/WROTE INTO THE WORKING TREE/.test(r2.out));

// ---------------------------------------------------------------------------
// §3 — it is a delta across each child, not a clean-tree assertion
// ---------------------------------------------------------------------------
//
// This is the section that pins the property down, and it is the one the
// obvious implementation gets wrong. Asserting `git status --porcelain` is empty
// after the run reads as the stronger check and is unusable: an agent runs this
// set immediately before pushing, with its own work uncommitted, and a guard
// that goes red on that is a guard people learn to ignore.
console.log('\n§3  the operator’s own uncommitted work does not make it red');

const three = build({
  scripts: { 'verify-fixture-b-clean.mjs': CLEAN },
  uncommitted: 'daemon/the-operator-was-mid-change.txt'
});
const r3 = runIn(three);

check(
  'a dirty tree the children did not cause is green',
  r3.status === 0,
  r3.status === 0 ? undefined : `runner exited ${r3.status} on a tree dirtied before it started`
);
check('and it does not name the operator’s file', !r3.out.includes('the-operator-was-mid-change'));

// ---------------------------------------------------------------------------
// §4 — unarmed is a refusal, never a silent pass
// ---------------------------------------------------------------------------
//
// The failure mode this closes is the one KAN-241 names: a required check whose
// strongest leg silently skips. If `git status` cannot answer, the runner must
// not run the set and report a green that says nothing about writes.
//
// `GIT_CEILING_DIRECTORIES` stops git walking up out of the fixture and finding
// some unrelated repository above `os.tmpdir()`. Without it this section would
// pass or fail on where the temp directory happens to live.
console.log('\n§4  with no git to ask, it refuses to run rather than running unwatched');

const four = build({ scripts: { 'verify-fixture-b-clean.mjs': CLEAN }, git: false });
const r4 = runIn(four, { env: { GIT_CEILING_DIRECTORIES: four } });

check('the run goes red', r4.status !== 0, `runner exited ${r4.status}`);
check(
  'it says the guard could not be armed',
  /guard cannot be armed/.test(r4.out),
  r4.out.trim().split('\n').slice(0, 2).join(' / ') || 'no output'
);
check(
  'and it ran nothing — a refusal, not a run with the claim unmade',
  !/PASS\s+verify-fixture-b-clean/.test(r4.out),
  /PASS\s+verify-fixture-b-clean/.test(r4.out) ? 'the set ran anyway' : undefined
);

// ---------------------------------------------------------------------------
// §5 — what was under test is the shipped runner, and no flag turns the guard off
// ---------------------------------------------------------------------------
//
// The first half stops this file drifting into testing a re-implementation: the
// four sections above are only claims about CI if the file they ran is the file
// CI runs. That `ci.yml` invokes this path at all is
// `verify-ci-partition-is-enforced.mjs` §4, not repeated here.
//
// The second half is the escape hatch that already exists. `--no-sandbox` turns
// off the `HOME` relocation, and a reader could reasonably expect it to turn off
// the tree watch with it. It must not: the defect this guards was immune to the
// HOME sandbox in the first place.
console.log('\n§5  the shipped runner, with no way to opt out of the guard');

const identical =
  fs.readFileSync(RUNNER, 'utf8') ===
  fs.readFileSync(path.join(one, 'daemon', 'scripts', 'run-ci-verify-set.mjs'), 'utf8');
check(
  'the runner under test is byte-identical to the shipped one',
  identical,
  identical ? undefined : 'the fixture copy has diverged from daemon/scripts/run-ci-verify-set.mjs'
);

const five = build({
  scripts: {
    'verify-fixture-a-dirties-tree.mjs': DIRTIES,
    'verify-fixture-b-clean.mjs': CLEAN
  }
});
const r5 = runIn(five, { argv: ['--no-sandbox'] });

check(
  '`--no-sandbox` does not disable the working-tree guard',
  r5.status !== 0 && /FAIL\s+verify-fixture-a-dirties-tree/.test(r5.out),
  `runner exited ${r5.status} with --no-sandbox`
);

// ---------------------------------------------------------------------------

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

console.log('');
console.log(failures.length ? `${failures.length} of ${checks} checks FAILED` : `all ${checks} checks passed`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);

process.exit(failures.length ? 1 : 0);
