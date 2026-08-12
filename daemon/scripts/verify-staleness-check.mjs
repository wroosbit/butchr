// Live proof that the KAN-30 staleness check reports each way an installation
// can silently stop being the code that was merged — and, just as important,
// that it stays quiet when nothing is wrong.
//
// WHAT FAILURE THIS WOULD CATCH: a staleness check that stops reporting a real
// gap — an unpulled main, a dist older than its sources, a rebuilt dist the
// running daemon never loaded — or that starts crying wolf over an agent
// building in its own worktree, an unrelated branch moving on origin, or a
// deliberate feature-branch checkout. Since KAN-305 it also catches both ways
// the build items can misjudge their own inputs: a file that is *not* a build
// input (anything under `daemon/scripts/` or `extension/scripts/`) reported as
// staleness no rebuild could clear, and — the opposite error, and the one a
// careless fix for the first introduces — a real input dropped from the set and
// therefore never compared, which reports fresh over a dist that is behind it.
// Every case below is a real clone damaged one way at a time, and every one
// asserts the verdict it must produce.
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
 *
 * `expect.notStale` is the weaker form, for a case whose point is "this item is
 * not what was damaged" rather than any particular verdict — see case (a),
 * which checks out an older commit whose tree this build of the check may not
 * be able to classify. `expect.detail` asserts against the evidence line rather
 * than the headline, for the cases where *which file* was named is the claim.
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
  for (const id of expect.notStale ?? []) {
    const item = r.items.find((i) => i.id === id);
    check(
      `case ${caseNumber}: ${id} is not stale`,
      item !== undefined && item.state !== 'stale',
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
  if (expect.detail) {
    const item = r.items.find((i) => i.id === expect.detail.id);
    check(
      `case ${caseNumber}: ${expect.detail.id} evidence names ${expect.detail.match}`,
      expect.detail.match.test(item?.detail ?? ''),
      `got: ${item?.detail ?? '(no item)'}`
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
//
// `notStale` rather than `fresh` for the two build items, and the reason is
// worth keeping: this case is the one that runs the *current* check against an
// *older* tree, which no real install is ever in — the daemon runs the build
// made from the checkout it is reading. `origin/main~2` still holds
// `extension/kan81-render/`, deleted in 3615c21, so the extension item
// correctly reports that it cannot classify that tree. Asserting `fresh` here
// would tie this case to whatever the last two commits happened to delete.
report('(a) local main is behind origin/main', repo, {}, {
  stale: true,
  items: { git: 'stale' },
  notStale: ['daemon-build', 'extension-build'],
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
  headline: { id: 'daemon-build', match: /daemon\/dist is older than daemon's build inputs/ },
  detail: { id: 'daemon-build', match: /daemon\/src\/router\.ts/ }
});
touch(path.join(repo, 'daemon/src/router.ts'), -3600);

// ---------------------------------------------------------------------------
// (c) extension source newer than extension/dist.
// ---------------------------------------------------------------------------
touch(path.join(repo, 'extension/sidepanel.jsx'), 0);
report('(c) extension sources are newer than extension/dist', repo, {}, {
  stale: true,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'stale' },
  headline: { id: 'extension-build', match: /extension\/dist is older than extension/ },
  detail: { id: 'extension-build', match: /extension\/sidepanel\.jsx/ }
});
touch(path.join(repo, 'extension/sidepanel.jsx'), -3600);

// ---------------------------------------------------------------------------
// (c2) every *other* class of real extension build input, one at a time.
//
// This is the half a careless narrowing breaks, so each input class is damaged
// separately rather than trusting that one representative covers the rest. A
// fix that pointed the check at `extension/src` alone would pass (c) and this
// case's first row, and go quietly green on the other three.
// ---------------------------------------------------------------------------
for (const rel of [
  'extension/src/components/StalenessBanner.jsx', // a component, nested
  'extension/public/manifest.json', // publicDir, copied verbatim into dist
  'extension/vite.config.js', // the build's own configuration
  'extension/sidepanel.css' // a root stylesheet an entry point pulls in
]) {
  touch(path.join(repo, rel), 0);
  report(`(c2) ${rel} is newer than extension/dist`, repo, {}, {
    stale: true,
    items: { 'daemon-build': 'fresh', 'extension-build': 'stale' },
    headline: { id: 'extension-build', match: /extension\/dist is older than extension's build inputs/ },
    // The evidence must name the file that was damaged. Without this the case
    // would pass on any stale verdict, including one reached via a different
    // input — which is how a narrowing that dropped this class could hide.
    detail: { id: 'extension-build', match: new RegExp(rel.replace(/[.]/g, '\\.')) }
  });
  touch(path.join(repo, rel), -3600);
}

// ---------------------------------------------------------------------------
// (c3) KAN-305: a verify script is not a build input, and must not read as one.
//
// The defect this case exists for: `extension-build` compared extension/dist
// against the newest file anywhere under extension/, so editing a verify script
// reported a stale extension build — with a remedy asking a human to reload the
// extension, for a change no rebuild could ever contain. The cost is the row
// below it: while the item was red for this, a genuinely stale build was
// indistinguishable from it.
// ---------------------------------------------------------------------------
touch(path.join(repo, 'extension/scripts/verify-sidepanel-survives-daemon-restart.mjs'), 0);
report('(c3) a verify script under extension/scripts is not a build input', repo, {}, {
  stale: false,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'fresh' }
});
// ...and the true positive is still visible while that script is the newest
// file in the tree. This row is the point of the case: the false red used to
// mask exactly this.
touch(path.join(repo, 'extension/src/components/StalenessBanner.jsx'), 0);
report('(c3) a real stale build is still caught with that script newer still', repo, {}, {
  stale: true,
  items: { 'extension-build': 'stale' },
  detail: { id: 'extension-build', match: /extension\/src\/components\/StalenessBanner\.jsx/ }
});
touch(path.join(repo, 'extension/src/components/StalenessBanner.jsx'), -3600);
touch(path.join(repo, 'extension/scripts/verify-sidepanel-survives-daemon-restart.mjs'), -3600);

// ---------------------------------------------------------------------------
// (c4) the same shape on the daemon side. `daemon/scripts/` grew by dozens of
//      files under KAN-295; tsc compiles `src/**` and nothing else.
// ---------------------------------------------------------------------------
touch(path.join(repo, 'daemon/scripts/verify-staleness-check.mjs'), 0);
report('(c4) a verify script under daemon/scripts is not a build input', repo, {}, {
  stale: false,
  items: { git: 'fresh', 'daemon-build': 'fresh', 'extension-build': 'fresh' }
});
touch(path.join(repo, 'daemon/scripts/verify-staleness-check.mjs'), -3600);

// ---------------------------------------------------------------------------
// (c5) an entry under extension/ that is classified neither way.
//
// The check narrowed from "the whole tree" to a declared input set, and the
// failure mode of any such list is the entry added after it was written: not
// scanned, so a build genuinely behind it reports fresh. This case is what
// makes that impossible to do quietly — an unclassified entry is `unknown`,
// names itself, and says where to classify it.
// ---------------------------------------------------------------------------
mkdirSync(path.join(repo, 'extension/newly-added-thing'), { recursive: true });
writeFileSync(path.join(repo, 'extension/newly-added-thing/thing.js'), '// added after the input set\n');
report('(c5) an unclassified entry under extension/ is unknown, not assumed harmless', repo, {}, {
  // `unknown` raises no alarm — it is not a claim that anything is behind —
  // but the Agents banner renders unknown alongside stale, so it is seen.
  stale: false,
  items: { 'extension-build': 'unknown', 'daemon-build': 'fresh' },
  headline: { id: 'extension-build', match: /cannot classify/ }
});
rmSync(path.join(repo, 'extension/newly-added-thing'), { recursive: true, force: true });

// ---------------------------------------------------------------------------
// (c6) ...and the false alarm the case above could easily have become.
//
// An entry holding no files contributes no timestamp, so no classification of
// it could change the verdict — reporting a doubt there would be a new false
// alarm of exactly the kind this ticket removed. The live install has carried
// an empty, untracked extension/sidepanel/ since 2026-07-30, which is how this
// case came to be written rather than imagined.
// ---------------------------------------------------------------------------
mkdirSync(path.join(repo, 'extension/empty-leftover'), { recursive: true });
report('(c6) an empty unclassified directory is not a doubt worth raising', repo, {}, {
  stale: false,
  items: { 'extension-build': 'fresh', 'daemon-build': 'fresh' }
});
// It becomes reportable the moment it holds something, which is the moment it
// could matter — the carve-out is about emptiness, not about the name.
writeFileSync(path.join(repo, 'extension/empty-leftover/now-it-has-a-file.js'), '// no longer empty\n');
report('(c6) the same directory, once it holds a file, is unknown again', repo, {}, {
  stale: false,
  items: { 'extension-build': 'unknown' },
  headline: { id: 'extension-build', match: /cannot classify/ }
});
rmSync(path.join(repo, 'extension/empty-leftover'), { recursive: true, force: true });

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
