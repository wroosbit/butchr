// KAN-370: `prWatch`'s `checkout` provenance must name WHICH agent holds the
// checkout, so a reader can falsify the claim from the report instead of
// re-deriving discovery by hand.
//
// WHAT FAILURE THIS WOULD CATCH: the watch set carrying `source: "checkout"`
// with no holder named — the state that shipped in `0f68a90` and cost two
// supervisors a false bug report. `epic/KAN-203` read `wroosbit/butchr (a live
// agent holds a checkout)`, could not tell from it which agent, hand-rolled
// `find workspaces -maxdepth 3 -name .git` to check, and got back one hit that
// was not an agent at all. `epic/KAN-39` verified before filing with the same
// command, so the check confirmed the error rather than catching it. The claim
// was TRUE the whole time — `epic/kan-39` held `review-127` from 2026-08-11 —
// and being true did not help anybody, because nothing in the report could be
// checked against the machine. §1 fails if `heldBy` is dropped or emptied; §2
// fails if the phrase stops naming holders; §4 fails if a checkout belonging to
// no live agent can enter the set, which is the defect as originally alleged.
//
// AND IT WOULD CATCH THE WRONG FIX. §3 exists because §1 and §2 are both
// satisfied by widening the phrase to "a checkout exists somewhere", which is
// true, useless, and explicitly out of bounds: the reader needs to know whether
// anything is watching on purpose. §5 exists because every section above it is
// satisfied by a report that has stopped draining — a set that never lets go is
// not a set that has been made honest.
//
// WHAT THIS SCRIPT WRITES, AND WHAT THAT LEAVES UNCOVERED (per prompts/task.md).
// It builds a workspace tree under a private $HOME in os.tmpdir() and passes its
// own agent list to `discoverRepos`. So it tests that discovery READS the tree
// correctly and names holders — it does NOT test that the daemon hands
// `discoverRepos` the real live-agent census. That wiring is
// `daemon/src/daemon.ts` (`liveAgents: () => daemonRouter.surveyFleet()…`), it
// is unchanged by this ticket, and it is covered here only by an observation of
// the running fleet pasted into the PR body, not by any script. That is the
// KAN-145 gap named rather than left to be inferred: the input is supplied, so
// "the input arrives" is somebody else's evidence.
//
// CI-RUNNABLE: yes — imports the built daemon module and asserts against it in
// process, over a tree it builds in os.tmpdir(); no live daemon, no herdr, no
// credential, no network, no terminal. Nothing is written inside the repository.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(HERE, '..', 'dist', 'github.js');

if (!fs.existsSync(DIST)) {
  // A setup guard, not a verdict — see the sweep rules in prompts/task.md.
  console.error('daemon/dist is missing. Run `npm run build` in daemon/ first.');
  process.exit(1);
}

let failures = 0;
const section = (n, title) => console.log(`\n${'='.repeat(78)}\n  §${n}  ${title}\n${'='.repeat(78)}`);
const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg, detail) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
  if (detail !== undefined) console.log(`        ${detail}`);
};
const check = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

// ---------------------------------------------------------------------------
// A workspace tree, built the way the real one is built.
// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kan370-'));
const HOME = path.join(root, 'home');
const workspaces = path.join(HOME, '.local', 'share', 'butchr', 'workspaces');
const clones = path.join(root, 'code');

process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

/** A shared clone, with the `origin` a real one carries. */
function makeClone(org, repo) {
  const dir = path.join(clones, org, repo);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/${org}/${repo}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  );
  return dir;
}

/**
 * A worktree checkout inside a workspace — `.git` as a FILE holding a `gitdir:`
 * pointer, which is what every task agent actually has. Getting this wrong is
 * how the second hand-rolled verification failed (`[ -d "$path/.git" ]`), so the
 * fixture uses the real shape rather than a convenient one.
 */
function makeWorktree(clone, type, key, name) {
  const checkout = path.join(workspaces, type, key.toLowerCase(), name);
  fs.mkdirSync(checkout, { recursive: true });
  const gitDir = path.join(clone, '.git', 'worktrees', name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${gitDir}\n`);
  return checkout;
}

const butchr = makeClone('wroosbit', 'butchr');
const crabcast = makeClone('wroosbit', 'CrabCast');

// The live fleet, in the shape the daemon passes it.
const epicReview = makeWorktree(butchr, 'epic', 'KAN-39', 'review-127');
const taskWork = makeWorktree(butchr, 'task', 'KAN-370', 'butchr');
const otherWork = makeWorktree(crabcast, 'task', 'KAN-99', 'crabcast');

// The specimen: a checkout belonging to NO live agent, at the workspace root
// rather than in a child directory — the exact shape of `story/kan-107`, which
// this ticket was filed alleging was being counted as a live agent's checkout.
const orphanRoot = path.join(workspaces, 'story', 'kan-107');
fs.mkdirSync(path.join(orphanRoot, '.git'), { recursive: true });
fs.writeFileSync(
  path.join(orphanRoot, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/wroosbit/butchr.git\n'
);

const { discoverRepos, repoSourcePhrase } = await import(DIST);

const LIVE = [
  { type: 'epic', key: 'KAN-39' },
  { type: 'epic', key: 'KAN-203' }, // live, holds nothing
  { type: 'task', key: 'KAN-370' },
  { type: 'task', key: 'KAN-99' }
];

// ---------------------------------------------------------------------------

section(1, 'A checkout cannot enter the set without naming who holds it');

const set = discoverRepos(LIVE, {});
console.log(`  watch set  ${JSON.stringify(set)}\n`);

const butchrEntry = set.find((r) => r.repo === 'wroosbit/butchr');
check(butchrEntry !== undefined, 'wroosbit/butchr is watched');
check(butchrEntry?.source === 'checkout', 'it is watched because a live agent holds a checkout');
check(
  Array.isArray(butchrEntry?.heldBy) && butchrEntry.heldBy.length > 0,
  'the entry names at least one holder',
  `heldBy = ${JSON.stringify(butchrEntry?.heldBy)}`
);

// Every `checkout` in the set, not just the one we went looking for.
for (const entry of set) {
  if (entry.source !== 'checkout') continue;
  check(
    Array.isArray(entry.heldBy) && entry.heldBy.length > 0,
    `${entry.repo}: heldBy is present and non-empty`,
    JSON.stringify(entry)
  );
  for (const holder of entry.heldBy) {
    check(
      Boolean(holder.type && holder.key && holder.path),
      `${entry.repo}: holder names type, key and path`,
      JSON.stringify(holder)
    );
    check(
      fs.existsSync(holder.path),
      `${entry.repo}: the named path exists, so the claim can be checked`,
      holder.path
    );
  }
}

section(2, 'Both holders are named, not whichever was seen first');

const names = (butchrEntry?.heldBy ?? []).map((h) => `${h.type}/${h.key}`).sort();
console.log(`  holders    ${JSON.stringify(names)}\n`);
check(
  names.includes('epic/KAN-39') && names.includes('task/KAN-370'),
  'a repository held by two agents names both',
  JSON.stringify(names)
);
check(
  (butchrEntry?.heldBy ?? []).some((h) => h.path === epicReview),
  'the supervisor’s review worktree is attributed to the supervisor',
  epicReview
);
check(
  (butchrEntry?.heldBy ?? []).some((h) => h.path === taskWork),
  'the task agent’s worktree is attributed to the task agent',
  taskWork
);

section(3, 'The phrase names the holders — it does not widen to "somewhere"');

const phrase = repoSourcePhrase(butchrEntry);
console.log(`  reads      wroosbit/butchr (${phrase})\n`);
check(phrase.includes('epic/KAN-39'), 'the printed phrase names the holding agent', phrase);
check(
  !/exists somewhere|somewhere on disk/i.test(phrase),
  'the phrase was not widened to an unfalsifiable "a checkout exists somewhere"',
  phrase
);
check(
  repoSourcePhrase({ repo: 'x/y', source: 'memory' }).includes('no live agent holds a checkout'),
  'the `memory` phrase still says nobody holds one'
);
check(
  repoSourcePhrase({ repo: 'x/y', source: 'config' }).includes('BUTCHR_PR_WATCH_REPOS'),
  'the `config` phrase still names the override'
);

section(4, 'The specimen: a checkout belonging to no live agent stays out');

// This is the defect as originally alleged. It was never real, and this section
// is what keeps it that way.
const orphanAsLive = discoverRepos([{ type: 'story', key: 'KAN-107' }], {});
console.log(`  story/kan-107 asked as though it were live  ${JSON.stringify(orphanAsLive)}`);
console.log(`  its checkout on disk                        ${orphanRoot}/.git\n`);
check(
  set.every((r) => (r.heldBy ?? []).every((h) => !h.path.startsWith(orphanRoot))),
  'no entry in the live set is attributed to the orphan checkout'
);
check(
  orphanAsLive.length === 0,
  'a checkout at the workspace ROOT is not discovered even for a live agent — ' +
    'discovery reads child directories, which is why this one never entered the set',
  JSON.stringify(orphanAsLive)
);

section(5, 'Discovery still drains: an agent that is not live holds nothing');

const withoutTask = discoverRepos(
  LIVE.filter((a) => a.key !== 'KAN-99'),
  {}
);
console.log(`  without task/KAN-99  ${JSON.stringify(withoutTask.map((r) => r.repo))}\n`);
check(
  !withoutTask.some((r) => r.repo === 'wroosbit/CrabCast'),
  'CrabCast leaves discovery when its only holder is no longer live — ' +
    'retention, not discovery, is what holds it (verify-pr-watch-repo-retention.mjs)'
);

section(6, 'The override path is unchanged and carries no holder');

const configured = discoverRepos(LIVE, { BUTCHR_PR_WATCH_REPOS: 'wroosbit/other' });
console.log(`  configured  ${JSON.stringify(configured)}\n`);
check(
  configured.length === 1 && configured[0].source === 'config',
  'BUTCHR_PR_WATCH_REPOS still overrides discovery entirely',
  JSON.stringify(configured)
);
check(
  configured[0] && !('heldBy' in configured[0]),
  'a configured repository claims no holder, because nobody is claimed to hold it',
  JSON.stringify(configured[0])
);

// ---------------------------------------------------------------------------

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${'='.repeat(78)}`);
console.log(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} CHECK(S) FAILED`);
console.log('='.repeat(78));

process.exit(failures ? 1 : 0);
