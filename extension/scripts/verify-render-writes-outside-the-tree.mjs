// KAN-326: `verify-agent-tree.mjs` renders to a directory outside the
// repository, so running the CI verify set does not dirty the working tree.
//
// WHAT FAILURE THIS WOULD CATCH: the render's default output path moving back
// inside the repository — which is not a tidiness regression but the return of
// two specific costs, both of which were paid before this script existed. The
// render prints elapsed time from a fixed synthetic fixture against the live
// clock, so it is guaranteed to differ on every run forever, at roughly one
// diff per hour elapsed; it rode along unmentioned in six commits across four
// unrelated tickets on that mechanism alone. And `staleness_check` compares
// mtimes rather than content over the whole of `extension/`, so a write here
// makes `extension-build` read stale even when the bytes are identical —
// spending the credibility of the one instrument that catches a genuinely
// un-rebuilt extension, which no agent can fix because only a human pressing
// Reload at chrome://extensions deploys one.
//
// CI-RUNNABLE: yes — it spawns `verify-agent-tree.mjs`, which needs only the
// extension's own node_modules and its own vite build; no live daemon, no
// herdr, no credential, no peer, no terminal. It runs the real script with the
// real argv the runner gives it, so what is under test is the shipped default
// and not a path this file constructs.
//
// WHAT THIS DOES NOT COVER, AND WHO COVERS IT
//
// This script asserts about ONE script's output path. It is not a sweep: a
// different `verify-*` script writing into the working tree would pass this
// file untouched.
//
// WHO COVERS THAT NOW: KAN-350, which landed after this file and closed the
// hole this paragraph used to name. `run-ci-verify-set.mjs` takes `git status
// --porcelain` around every child and fails the one that leaves a delta, so the
// general claim is a property of the harness rather than of any script — and
// `daemon/scripts/verify-ci-set-guards-tree-writes.mjs` is what holds that
// guard to account. This file is not thereby redundant: §1 and §2 below assert
// about the shipped default output PATH, which the harness guard cannot see —
// a script that never runs, or that is moved out of the CI set, would still
// pass the harness by writing nothing.
//
// What neither covers, stated so nobody reads the pair as complete: a script
// that writes into the tree and then DELETES what it wrote. It has still
// written into the working tree; both guards pass it.
//
// It also does not assert that the child wrote NOTHING else anywhere. §1
// checks the path the child reports and that a file is really at it; §2 checks
// the old in-tree location is absent afterwards. A child that wrote a second
// file elsewhere and did not mention it would pass both, and is caught only by
// §3 — which compares `git status` across the run and so sees anything that
// appeared under `extension/`, named or not. §3 is a DELTA and not a
// clean-tree assertion, deliberately; the comment on `snapshot()` says why,
// and the short version is that a check which goes red on your own
// uncommitted work is the cry-wolf defect this ticket exists to fix.
//
// Outside `extension/` is uncovered by all three.
//
// NOTHING HERE IMPORTS FROM `dist`. Said explicitly because the house rule is
// that a proof run after a failed build tested the previous build rather than
// your change, and the remedy is to know which kind of proof you ran. This one
// spawns a source `.mjs` and reads the filesystem, so its verdict is about the
// tree as it is now and a failed `npm run build` does not invalidate it. The
// child it spawns runs vite in-process; a vite failure there surfaces as the
// child's own non-zero exit, which is the first thing asserted below.
//
// Usage:
//   node extension/scripts/verify-render-writes-outside-the-tree.mjs
//
// Exit code 0 means every assertion below held.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const CHILD = path.join(REPO_ROOT, 'extension', 'scripts', 'verify-agent-tree.mjs');
const OLD_PATH = path.join(REPO_ROOT, 'extension', 'kan81-render');

const failures = [];
let checks = 0;
function check(what, condition, detail) {
  checks += 1;
  const ok = !!condition;
  if (!ok) failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Is `child` inside `parent`? Both are resolved first, so a path that only
 * looks outside because of `..` does not slip through.
 */
const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// ---------------------------------------------------------------------------
// Run the real script the way the CI runner runs it
// ---------------------------------------------------------------------------
//
// Matched to `run-ci-verify-set.mjs` deliberately: no argv beyond the script
// path, cwd at `daemon/`, and HOME relocated to a fresh temp directory. The cwd
// matters — the defect being guarded resolved its output from
// `import.meta.url`, so it was immune to cwd, and a test that ran from
// `extension/` would not have told them apart. The HOME sandbox matters for the
// opposite reason: it is the sandbox the runner already applies, and this is the
// script that escaped it.

/**
 * `git status --porcelain` over `extension/`, as a comparable snapshot.
 *
 * Taken before and after the child runs, and compared as a DELTA rather than
 * asserted empty. That distinction is the whole design of §3 and it is
 * deliberate: an agent runs the CI verify set immediately before pushing, which
 * is exactly when its tree is full of its own uncommitted work. A check that
 * demanded a clean tree would go red on every one of those runs, and an
 * instrument that cries wolf is the defect this script's own ticket was filed
 * about. So it reports what the child changed, and is blind to what you
 * changed.
 */
const snapshot = () => {
  const r = spawnSync('git', ['status', '--porcelain', '--', 'extension'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Build output. Excluded for the reason `staleness_check` excludes it: an
    // `npm run build` between snapshots is not the defect being guarded.
    .filter((l) => !/\/(dist|node_modules)\//.test(l));
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kan326-'));
const before = fs.existsSync(OLD_PATH);
const statusBefore = snapshot();

console.log(`spawning: node ${path.relative(REPO_ROOT, CHILD)}  (cwd=daemon/, HOME sandboxed)`);
const run = spawnSync(process.execPath, [CHILD], {
  cwd: path.join(REPO_ROOT, 'daemon'),
  env: { ...process.env, HOME: home },
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 64 * 1024 * 1024
});
fs.rmSync(home, { recursive: true, force: true });

const stdout = run.stdout ?? '';

console.log('\nassertions');
console.log('─'.repeat(78));

// A child that failed for its own reasons has not told us anything about where
// it writes, so read its exit code before reading its output.
check(
  'the render script itself exited 0',
  run.status === 0,
  run.status === 0
    ? undefined
    : `status ${run.status}${run.signal ? `, signal ${run.signal}` : ''}` +
      `\n--- child stderr ---\n${(run.stderr ?? '').slice(-2000)}`
);

// §1 — the path it reports is outside the repository, and something is at it.
const reported = stdout.match(/^rendered HTML: (.+)$/m)?.[1]?.trim() ?? null;

check('the run reports where it rendered to', reported !== null, reported ?? 'no "rendered HTML:" line in stdout');

check(
  'the reported output path is outside the repository',
  reported !== null && !isInside(REPO_ROOT, reported),
  reported ? `reported ${reported}` : undefined
);

// Reporting a path proves nothing about having written to it. This is the half
// that makes §1 an observation rather than a reading of the child's own claim.
check(
  'a file really exists at the reported path',
  reported !== null && fs.existsSync(reported),
  reported ? `exists=${fs.existsSync(reported)}` : undefined
);

// §2 — the location it used to write to is not there afterwards.
check(
  'nothing was written to the old in-tree location',
  !fs.existsSync(OLD_PATH),
  `extension/kan81-render existed before=${before}, after=${fs.existsSync(OLD_PATH)}`
);

// §3 — the whole-tree claim, which is the one that would catch a write neither
// §1 nor §2 thought to look for.
//
// Scoped to `extension/`: that is the subtree this child could plausibly write
// into, and the subtree `staleness_check` scans for `extension-build`.
const statusAfter = snapshot();
const appeared = (statusAfter ?? []).filter((l) => !(statusBefore ?? []).includes(l));

check(
  'git could be asked what changed, before and after',
  statusBefore !== null && statusAfter !== null,
  statusBefore === null || statusAfter === null ? 'git status did not exit 0' : undefined
);

check(
  'the run changed nothing under extension/ that was not already changed',
  appeared.length === 0,
  appeared.length ? `\n${appeared.map((l) => `        ${l}`).join('\n')}` : undefined
);

console.log(
  `\n${failures.length ? `${failures.length} of ${checks} checks FAILED` : `all ${checks} checks passed`}`
);
process.exit(failures.length ? 1 : 0);
