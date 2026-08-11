// Live proof that the KAN-30 staleness check reports each way an installation
// can silently stop being the code that was merged — and, just as important,
// that it stays quiet when nothing is wrong.
//
// WHAT FAILURE THIS WOULD CATCH: a staleness check that stops reporting a real
// gap — an unpulled main, a dist older than its sources, a rebuilt dist the
// running daemon never loaded — or that starts crying wolf over an agent
// building in its own worktree, an unrelated branch moving on origin, or a
// deliberate feature-branch checkout. Every case below is a real clone damaged
// one way at a time, and every one asserts the verdict it must produce.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
// It does `git clone` this checkout into a scratch directory and then
// `checkout -B main origin/main` inside the clone, so the checkout it runs
// from needs a **local** `main` branch — a clone resolves `origin/*` from the
// local branches of its source, and `actions/checkout` leaves a detached HEAD
// with none. The `verify-runnable-set` job creates one; see the comment there.
//
// Every case is manufactured against a *real* clone of this repository with a
// real `origin`, not a mock: the repo under test is cloned to a temp directory,
// then deliberately damaged one way at a time. Nothing touches the live install
// at ~/code/wroosbit/butchr, and nothing here fetches, pulls, builds or
// restarts anything.
//
// Usage: node daemon/scripts/verify-staleness-check.mjs [repoToClone]
//
//   repoToClone  defaults to the checkout this script lives in.
//
// Run it after `npm run build` in daemon/ — it imports the compiled check, so
// what it exercises is what the daemon runs.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { getStalenessReport, resetStalenessCache, formatStalenessReport } from '../dist/staleness.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRepo = process.argv[2] ?? path.resolve(scriptDir, '..', '..');

const scratch = mkdtempSync(path.join(tmpdir(), 'kan30-staleness-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Set a path's mtime, in seconds relative to now. */
const touch = (p, offsetSeconds) => {
  const when = new Date(Date.now() + offsetSeconds * 1000);
  utimesSync(p, when, when);
};

/**
 * Age every source file in the tree.
 *
 * `git clone`, `git checkout` and `git reset --hard` all stamp the files they
 * write with the current time, which would leave every source newer than any
 * build fixture and make all three cases look stale at once. Backdating puts
 * the fixture in the state a real install is in — sources from the last pull,
 * builds from after it — so each case can be damaged one at a time.
 */
const backdateSources = (root, agoSeconds, rel = '') => {
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'dist' || entry.name === 'node_modules') continue;
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) backdateSources(root, agoSeconds, childRel);
    else if (entry.isFile()) touch(path.join(root, childRel), -agoSeconds);
  }
};

// --- verdicts ---------------------------------------------------------------
//
// Each case below states the verdict it must produce, and a case that produces
// anything else is a failure carried to the exit code. Printing the report is
// not the proof; the expectation next to it is.

const failures = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

let caseNumber = 0;
/**
 * Run the check against `repoRoot` and hold its answer to `expect`.
 *
 * `expect.stale` is the alarm the whole report raises; `expect.items` names the
 * state each individual item must be in, keyed by StalenessItemId. Naming the
 * items rather than only the boolean is what makes a case fail when the right
 * alarm is raised for the wrong reason.
 */
function report(title, repoRoot, opts = {}, expect = null) {
  caseNumber++;
  console.log(`\n${'='.repeat(78)}`);
  console.log(`case ${caseNumber}: ${title}`);
  console.log('='.repeat(78));
  resetStalenessCache();
  const r = getStalenessReport({ repoRoot, force: true, ...opts });
  console.log(`  stale: ${r.stale}   summary: ${r.summary ?? '(none — nothing to say)'}`);
  console.log(formatStalenessReport(r).slice(1).join('\n'));

  if (!expect) return r;
  console.log('');
  check(
    `case ${caseNumber}: stale is ${expect.stale}`,
    r.stale === expect.stale,
    `got stale: ${r.stale}${r.summary ? ` (${r.summary})` : ''}`
  );
  for (const [id, state] of Object.entries(expect.items ?? {})) {
    const item = r.items.find((i) => i.id === id);
    check(
      `case ${caseNumber}: ${id} is ${state}`,
      item?.state === state,
      item ? `got ${item.state} — ${item.headline}` : 'no such item in the report'
    );
  }
  if (expect.headline) {
    const item = r.items.find((i) => i.id === expect.headline.id);
    check(
      `case ${caseNumber}: ${expect.headline.id} headline says ${expect.headline.match}`,
      expect.headline.match.test(item?.headline ?? ''),
      `got: ${item?.headline ?? '(no item)'}`
    );
  }
  return r;
}

// ---------------------------------------------------------------------------
// A clone with a real origin, brought to a state where everything is current:
// on the default branch, level with origin/main, both dist/ directories newer
// than every source under them. That is the baseline the damage is applied to.
// ---------------------------------------------------------------------------
const repo = path.join(scratch, 'butchr');
console.log(`cloning ${sourceRepo} -> ${repo}`);
run('git', ['clone', '--quiet', sourceRepo, repo]);
run('git', ['-C', repo, 'checkout', '--quiet', '-B', 'main', 'origin/main']);
// Cloning a *worktree* leaves origin/HEAD pointing at that worktree's branch.
// The real install is cloned from GitHub, where origin/HEAD is origin/main;
// set it so the fixture models the install rather than the scratch clone.
run('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
// A fetch so FETCH_HEAD exists and our knowledge of origin/main is recent
// rather than never — exactly the state a working clone is in.
run('git', ['-C', repo, 'fetch', '--quiet', 'origin']);

// Fake builds. Content is irrelevant to the check — mtimes are the evidence —
// so this stays a fixture rather than a five-minute npm install.
const buildFixture = (rel, agoSeconds) => {
  const dir = path.join(repo, rel);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bundle.js');
  writeFileSync(file, '// pretend build output\n');
  touch(file, -agoSeconds);
  touch(dir, -agoSeconds);
};

/** Sources from an hour ago, builds from a minute ago: a healthy install. */
const restoreBaseline = () => {
  backdateSources(repo, 3600);
  buildFixture('daemon/dist', 60);
  buildFixture('extension/dist', 60);
};
restoreBaseline();

// ---------------------------------------------------------------------------
report('clean install — everything current, the check should stay quiet', repo, {}, {
  stale: false,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'fresh' }
});

// ---------------------------------------------------------------------------
// (a) local main behind origin. Move the clone's main back two commits; origin
//     is untouched, so this is precisely "two PRs merged and were never pulled".
// ---------------------------------------------------------------------------
run('git', ['-C', repo, 'reset', '--hard', '--quiet', 'origin/main~2']);
// `git reset --hard` rewrites the mtimes of every file it changes, which would
// otherwise make the builds look stale too. Isolating the git case is the
// point — one fault at a time, or the proof proves nothing.
restoreBaseline();
// Only git is damaged, so only git may go stale: an alarm that also fired on
// the builds here would be reporting damage this case did not do.
report('(a) local main is behind origin/main', repo, {}, {
  stale: true,
  items: { git: 'stale', 'daemon-build': 'fresh', 'extension-build': 'fresh' },
  headline: { id: 'git', match: /2 commits behind origin\/main/ }
});

run('git', ['-C', repo, 'reset', '--hard', '--quiet', 'origin/main']);
restoreBaseline();

// ---------------------------------------------------------------------------
// (b) daemon source newer than daemon/dist.
// ---------------------------------------------------------------------------
touch(path.join(repo, 'daemon/src/router.ts'), 0);
report('(b) daemon/src is newer than daemon/dist', repo, {}, {
  stale: true,
  items: { git: 'fresh', 'daemon-build': 'stale', 'extension-build': 'fresh' },
  headline: { id: 'daemon-build', match: /daemon\/dist is older than daemon\/src/ }
});
touch(path.join(repo, 'daemon/src/router.ts'), -3600);

// ---------------------------------------------------------------------------
// (c) extension source newer than extension/dist.
// ---------------------------------------------------------------------------
touch(path.join(repo, 'extension/sidepanel.jsx'), 0);
report('(c) extension sources are newer than extension/dist', repo, {}, {
  stale: true,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'stale' },
  headline: { id: 'extension-build', match: /extension\/dist is older than extension/ }
});
touch(path.join(repo, 'extension/sidepanel.jsx'), -3600);

// ---------------------------------------------------------------------------
// (d) the fourth gap: dist rebuilt while the daemon kept running. Only reported
//     when the caller is the daemon and can say when it started.
// ---------------------------------------------------------------------------
buildFixture('daemon/dist', 0); // just rebuilt
// The build on disk is current — it is the *process* that is behind it. So
// daemon-build must stay fresh while daemon-process alone raises the alarm.
report('(d) daemon/dist rebuilt after the running daemon started', repo, {
  daemonStartedAt: new Date(Date.now() - 3 * 3600 * 1000)
}, {
  stale: true,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'daemon-process': 'stale' },
  headline: { id: 'daemon-process', match: /started before the build it is meant to be running/ }
});
buildFixture('daemon/dist', 60);

// ---------------------------------------------------------------------------
// No-false-alarm 1: an agent building in its own worktree.
//
// The worktree is created *inside* the checkout, which is the worst case — a
// task agent's worktree normally lives under ~/.local/share/butchr/workspaces
// and is not even on the same path. Its sources and its dist are both rewritten
// with mtimes far newer than anything in the parent, and the parent must stay
// fresh regardless.
// ---------------------------------------------------------------------------
const worktree = path.join(repo, 'agent-worktree');
run('git', ['-C', repo, 'worktree', 'add', '--quiet', '-b', 'butchr/KAN-99', worktree, 'origin/main']);
touch(path.join(worktree, 'daemon/src/router.ts'), 0);
touch(path.join(worktree, 'extension/sidepanel.jsx'), 0);
mkdirSync(path.join(worktree, 'daemon/dist'), { recursive: true });
writeFileSync(path.join(worktree, 'daemon/dist/bundle.js'), '// agent build\n');
report('no false alarm: an agent is building in a worktree inside this checkout', repo, {}, {
  stale: false,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'fresh' }
});
run('git', ['-C', repo, 'worktree', 'remove', '--force', worktree]);

// ---------------------------------------------------------------------------
// No-false-alarm 2: origin moved on an unrelated branch.
//
// A branch is pushed to origin and fetched. origin/main has not moved, so
// nothing here is behind anything — and the check must not notice at all.
// ---------------------------------------------------------------------------
run('git', ['-C', sourceRepo, 'update-ref', 'refs/heads/kan30-unrelated-branch', 'HEAD']);
try {
  run('git', ['-C', repo, 'fetch', '--quiet', 'origin']);
  report('no false alarm: origin gained an unrelated branch (origin/main unmoved)', repo, {}, {
    stale: false,
    items: { git: 'fresh' }
  });
} finally {
  run('git', ['-C', sourceRepo, 'update-ref', '-d', 'refs/heads/kan30-unrelated-branch']);
}

// ---------------------------------------------------------------------------
// No-false-alarm 3: the checkout is deliberately on a feature branch.
//
// Every agent worktree and every human mid-feature is in this state and is
// permanently "behind origin/main". Calling that stale daily is how a warning
// gets ignored, so it is reported without alarm instead.
// ---------------------------------------------------------------------------
run('git', ['-C', repo, 'checkout', '--quiet', '-b', 'feature/some-work', 'origin/main~3']);
restoreBaseline();
// `not-applicable`, not `fresh`: the checkout genuinely is behind, and the
// check must say so without alarm rather than pretend it is level.
report('no false alarm: checkout is on a feature branch, 3 behind origin/main', repo, {}, {
  stale: false,
  items: { git: 'not-applicable' },
  headline: { id: 'git', match: /on branch feature\/some-work, not main/ }
});

// ---------------------------------------------------------------------------
// And the live install, read-only, exactly as the daemon sees it.
//
// Deliberately NOT asserted, and this is the one case where that is the honest
// choice: whatever it says is a fact about this machine at this moment, not
// about the code under test. Whether ~/code/wroosbit/butchr happens to be level
// with origin right now is not something this script may pass or fail on — an
// assertion here would go red when a colleague pulls, which is a check that
// cries wolf, and green-by-luck the rest of the time. It is printed because
// seeing the real installation judged is worth something; it is excluded from
// the count because it proves nothing about the checker.
// ---------------------------------------------------------------------------
const liveRoot = path.join(process.env.HOME, 'code', 'wroosbit', 'butchr');
try {
  report(`the live install at ${liveRoot} (read-only, informational — not asserted)`, liveRoot);
} catch (err) {
  console.log(`\n(skipped live install: ${err.message})`);
}

console.log(
  failures.length
    ? `\n${failures.length} FAILED: ${failures.join(', ')}`
    : `\nALL PASS — ${caseNumber - 1} asserted cases, every verdict as specified.`
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
