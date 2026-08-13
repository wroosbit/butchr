// KAN-360: the PR watcher's repository set is built from live agents' checkouts,
// and the approver a PR notification is FOR never holds one — so the set drains
// as the fleet does, and the watcher goes blind exactly when a pull request has
// been left waiting.
//
// WHAT FAILURE THIS WOULD CATCH: a task agent opening a pull request, finishing,
// and standing down — taking the repository out of the watch set with it, while
// its approver is still running and still responsible. Observed as three
// `prWatch` readings 35 minutes apart on 2026-08-12: `repos: crabcast + butchr`
// → `repos: butchr ONLY`, as CrabCast's last live checkout went away. It would
// equally catch the reading that made it look harmless — that with no live agent
// there is nobody to tell — which is false and is measured false here: no
// supervisor holds a checkout at all (`epic/kan-39`, `epic/kan-203`,
// `epic/kan-59`, none), so the watcher's actual consumer is the one participant
// that can never keep a repository in its set.
//
// AND IT WOULD CATCH THE OBVIOUS WRONG FIX, twice over. §6 exists because §2 is
// satisfied by a set that never releases anything — a watcher that pays GitHub
// three rate-limit points a minute forever for every repository anybody ever
// touched has not been made correct, it has been made expensive and permanently
// reassuring. §4 exists because every section above it is satisfied by a report
// that has stopped saying the one thing this module is best at: that when there
// is genuinely nothing to watch, nothing is being observed.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process, over a workspace tree it builds under a private $HOME in
// os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal and
// no network (the GitHub reader is stubbed). Nothing is written inside the
// repository.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145; `prompts/task.md` names it the defect this epic keeps re-finding).
// Per section, and the holes are named rather than left to be inferred:
//
//   §1 SUPPLIES A REAL FILESYSTEM AND INVENTS NOTHING ABOUT IT. The checkout it
//   builds is worktree-shaped the way `prompts/task.md` mandates — `.git` as a
//   FILE holding a `gitdir:` pointer, a `commondir` beside the pointed-at
//   directory, and the `origin` url in the shared clone's config three levels up
//   — and it is read by the shipped `repoForCheckout` and the shipped
//   `discoverRepos`. The drain is therefore reproduced in the product's own
//   discovery rather than described.
//   WHAT IT DOES NOT ESTABLISH: that a real stand-down removes an agent from
//   `surveyFleet()`. This section stands the agent down by dropping it from the
//   live list, which is what `daemon.ts` computes; the census itself is covered
//   by `verify-list-agents-survives-restart.mjs`, not here. Note that the
//   checkout is deliberately LEFT ON DISK when the agent goes: the directory is
//   not what disappears, the agent is, and discovery only reads live agents'
//   workspaces.
//
//   §2-§6 SUPPLY THE WORLD BUT NOT THE MECHANISM. GitHub is a stub and the
//   agents are addresses invented here; the discovery, the retention rule, the
//   event recognition, the recipient resolution and the health sentence are all
//   the shipped ones, reached through the shipped `PrWatcher.watchOnce`. The
//   `herdrBridge` is a TRIP-WIRE whose every method throws, so "nothing was
//   typed" is enforced rather than asserted.
//   WHAT THEY DO NOT ESTABLISH: that a notice reaches a running agent over a
//   real carrier. WHO COVERS IT: `verify-pr-watch.mjs` §2-§6, which drive this
//   same watcher over real Unix sockets — deliberately not duplicated here.
//
//   §5 WRITES THE STATE FILE IT THEN READS BACK, and that is the point of it:
//   the restart is simulated by constructing a SECOND `PrWatchState` over the
//   same path, so what is tested is that the retention survives in the file
//   rather than in a process. WHAT IT DOES NOT ESTABLISH: that a real daemon
//   restart reloads it — `verify-capacity-survives-daemon-restart.mjs` is the
//   pattern for that class of claim and it is not extended to this file.
//
//   WHAT NO SECTION HERE COVERS: that the retained repository is read by a REAL
//   `gh pr list` against a REAL GitHub, and that the approver receives the
//   notice as a live agent. That needs this build deployed to the fleet's
//   daemon, and it is an observation pasted into the PR body rather than an
//   assertion in this file.
//
// Usage:
//   node daemon/scripts/verify-pr-watch-repo-retention.mjs [dist]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(52)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// A private $HOME set BEFORE the product is imported. `workspacesRoot()` and
// `BUTCHR_DIR` are both computed from the home directory, so this is what stops
// the proof reading the live fleet's workspaces or writing its pr-watch.json —
// and it is also what lets §1 build a workspace tree the shipped discovery will
// actually look in.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan360-'));
process.env.HOME = TMP;
// Discovery consults this first, and an operator value leaking in from the
// environment would silently replace everything §1 and §2 are measuring.
delete process.env.BUTCHR_PR_WATCH_REPOS;

const load = (mod) => import(path.join(path.resolve(distDir), mod));
const { snapshotFrom, discoverRepos, repoForCheckout } = await load('github.js');
const { PrWatcher, PrWatchState, describeHealth } = await load('pr-watch.js');

const WORKSPACES = path.join(TMP, '.local', 'share', 'butchr', 'workspaces');
const REPO = 'wroosbit/CrabCast';

/**
 * A worktree-shaped checkout, built the way `git worktree add` builds one.
 *
 * The shape matters rather than the contents: `.git` is a FILE, the remote lives
 * in the shared clone three levels up, and `commondir` is the portable spelling
 * of that hop. `repoForCheckout` follows exactly this, so building anything
 * simpler would be testing a path the fleet does not use.
 */
function makeWorktree({ type, key, repoUrl, cloneName }) {
  const clone = path.join(TMP, 'code', cloneName);
  const worktreeName = key.toLowerCase();
  const gitDir = path.join(clone, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(
    path.join(clone, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${repoUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  );

  const workspace = path.join(WORKSPACES, type, key.toLowerCase(), 'CrabCast');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`);
  return workspace;
}

const TASK = { agentName: 'task-kan-999', type: 'task', key: 'KAN-999' };
const APPROVER = { agentName: 'epic-kan-39', type: 'epic', key: 'KAN-39' };

// ===========================================================================
// 1. The drain itself, in the shipped discovery
// ===========================================================================

rule('§1 — the drain: the checkout stays on disk, the agent goes, the repo leaves the set');

{
  const workspace = makeWorktree({
    type: 'task',
    key: 'KAN-999',
    repoUrl: 'https://github.com/wroosbit/CrabCast.git',
    cloneName: 'crabcast'
  });
  // The approver's workspace, built the way a supervisor's actually is: a
  // directory with no checkout in it. This is the measured fact the whole ticket
  // turns on, reproduced rather than quoted.
  fs.mkdirSync(path.join(WORKSPACES, 'epic', 'kan-39'), { recursive: true });

  row('repoForCheckout(the task worktree)', repoForCheckout(workspace) ?? '(null)');

  const whileLive = discoverRepos([TASK, APPROVER]);
  const afterStandDown = discoverRepos([APPROVER]);

  console.log('');
  row('discoverRepos while the task agent is live', JSON.stringify(whileLive));
  row('the checkout still on disk afterwards', fs.existsSync(path.join(workspace, '.git')));
  row('discoverRepos with only the approver live', JSON.stringify(afterStandDown));

  const discovered = whileLive.length === 1 && whileLive[0].repo === REPO;
  const drained = afterStandDown.length === 0;

  verdict(
    discovered && drained,
    `discovery finds ${REPO} through a live task agent's worktree and finds NOTHING once that ` +
      'agent stands down — the approver contributes no repository, because it holds no checkout.',
    `discovered=${JSON.stringify(whileLive)} (want one entry for ${REPO}), ` +
      `afterStandDown=${JSON.stringify(afterStandDown)} (want empty). If the second is non-empty ` +
      'this proof is no longer reproducing the defect and every section below it is measuring ' +
      'something else.'
  );
}

// ===========================================================================
// 2. The consequence, and the fix: the approver is still told
// ===========================================================================

rule('§2 — a pull request merges AFTER its author has gone. Is the approver told?');

const STATE_FILE = path.join(TMP, 'pr-watch-retention.json');
const timeline = [];

{
  const prRow = (over = {}) => ({
    number: 42,
    title: 'KAN-999: something the approver has to close out',
    url: 'https://github.com/wroosbit/CrabCast/pull/42',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'butchr/KAN-999',
    headRefOid: 'c'.repeat(40),
    mergedAt: null,
    reviewDecision: '',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'approval-recorded', state: 'FAILURE' }
    ],
    comments: [],
    ...over
  });

  // Three ticks, as a timeline rather than as mutation. The fleet shrinks between
  // the first and the second; the pull request merges in the second.
  const stages = [
    { agents: [TASK, APPROVER], rows: [prRow()] },
    { agents: [APPROVER], rows: [prRow({ state: 'MERGED', mergedAt: '2026-08-13T04:00:00Z' })] },
    { agents: [APPROVER], rows: [prRow({ state: 'MERGED', mergedAt: '2026-08-13T04:00:00Z' })] }
  ];

  let stage = 0;
  const sent = [];
  const reads = [];
  const watcher = new PrWatcher({
    github: {
      listPullRequests: async (repo) => {
        reads.push({ stage, repo });
        return { ok: true, prs: stages[stage].rows.map((r) => snapshotFrom(repo, r)) };
      }
    },
    herdrBridge: new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`TRIP-WIRE: reached herdr.${String(prop)}() — a notice tried to type.`);
        }
      }
    ),
    liveAgents: () => stages[stage].agents,
    issueFacts: (key) =>
      key === 'KAN-999'
        ? { status: { value: 'In Review', observedAt: new Date().toISOString() }, parentKey: 'KAN-39', linkedKeys: [] }
        : null,
    supervisorFor: () => null,
    // NO `repos` OVERRIDE, deliberately: the subject of this proof is exactly
    // the set the watcher builds for itself.
    state: new PrWatchState(STATE_FILE, () => Date.now()),
    deliver: async ({ type, key, message }) => {
      sent.push({ stage, to: `${type}/${key}`, message });
      return { delivered: true, transport: 'channel' };
    },
    log: () => {}
  });

  for (stage = 0; stage < stages.length; stage++) {
    const tick = await watcher.watchOnce();
    timeline.push({ tick, health: watcher.healthReport(), sent: sent.filter((s) => s.stage === stage) });
  }

  console.log('\n  tick   live agents            watch set                        events\n');
  ['task+epic', 'epic only', 'epic only'].forEach((who, i) => {
    row(
      `  ${i + 1}. ${who}`,
      `${JSON.stringify(timeline[i].tick.repos.map((r) => `${r.repo}:${r.source}`))}  ` +
        `${timeline[i].tick.events.map((e) => e.kind).join(', ') || '(none)'}`
    );
  });

  const retained = timeline[1].tick.repos.find((r) => r.repo === REPO);
  const readItAnyway = reads.some((r) => r.stage === 1 && r.repo === REPO);
  const mergedSeen = timeline[1].tick.events.some((e) => e.kind === 'merged');
  const toldApprover = timeline[1].sent.filter((s) => s.to === 'epic/KAN-39');
  const saysStillInReview = toldApprover.some((s) => /still In Review/.test(s.message));

  console.log('');
  row('tick 2 watch set holds the repo', retained ? `yes, source=${retained.source}` : '*** NO ***');
  row('…and GitHub was actually read for it', readItAnyway ? 'yes' : '*** NO ***');
  row('the merge was recognised', mergedSeen ? 'yes' : '*** NO ***');
  row('the approver was told', toldApprover.length ? `yes (${toldApprover.length})` : '*** NO ***');
  if (toldApprover.length) console.log(`\n  ${toldApprover[0].message}\n`);

  verdict(
    retained?.source === 'memory' && readItAnyway && mergedSeen && toldApprover.length === 1 && saysStillInReview,
    'the repository is retained from memory once its last checkout goes, the merge is seen, and ' +
      'the approver — the only agent left running — is told that KAN-999 is still In Review.',
    `retained=${retained ? retained.source : 'NOTHING'} (want "memory"), read=${readItAnyway}, ` +
      `merged=${mergedSeen}, notices to the approver=${toldApprover.length}. An empty watch set ` +
      'here is the defect itself: the author has stood down, nobody holds a checkout, and the ' +
      'merge this approver has to act on is announced to nobody.'
  );
}

// ===========================================================================
// 3. AC3 — the report says how each repository got in
// ===========================================================================

rule('§3 — coverage or luck: every repository in the report names its source');

{
  const viaCheckout = timeline[0].health;
  const viaMemory = timeline[1].health;

  console.log(`\n  While the author was live:\n\n    ${viaCheckout.detail}`);
  console.log(`\n  After it stood down:\n\n    ${viaMemory.detail}\n`);

  const checkoutTyped = viaCheckout.repos.every((r) => r.source === 'checkout');
  const namesCheckout = /a live agent holds a checkout/.test(viaCheckout.detail);
  const namesMemory = /from memory/.test(viaMemory.detail);
  const sentencesDiffer = viaCheckout.detail !== viaMemory.detail;

  row('tick 1 sources', JSON.stringify(viaCheckout.repos));
  row('tick 2 sources', JSON.stringify(viaMemory.repos));
  row('the two sentences differ', sentencesDiffer ? 'yes' : '*** NO ***');

  verdict(
    checkoutTyped && namesCheckout && namesMemory && sentencesDiffer,
    'the same repository reads differently depending on why it is being watched, so a reader can ' +
      'tell a set held up by a live checkout from one held up by outstanding work.',
    `sources typed: ${checkoutTyped}; names the checkout: ${namesCheckout}; names the memory: ` +
      `${namesMemory}; the sentences differ: ${sentencesDiffer}. Two identical sentences for two ` +
      'different reasons is the defect KAN-203 observed and could not name.'
  );
}

// ===========================================================================
// 4. AC4 — the inert case still says so, to the byte
// ===========================================================================

rule('§4 — with genuinely nothing to watch, the disclosure is unchanged');

{
  // Pinned as a literal rather than asserted by regex, in BOTH directions: this
  // sentence is the best thing in the module, KAN-339's AC4 and KAN-360's AC4
  // both protect it, and a softening of it would pass every `/not the same as/`
  // test anybody would think to write.
  const INERT =
    'No repository is being watched: no live agent holds a checkout with a GitHub ' +
    '`origin`, and BUTCHR_PR_WATCH_REPOS is unset. Nothing about any pull request is ' +
    'being observed, which is not the same as nothing having changed.';

  const base = {
    repos: [],
    releasedRepos: [],
    lastAttemptAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastError: null,
    degraded: false,
    watchedCount: 0,
    openCount: 0,
    nobodyLiveCount: 0,
    unmatched: []
  };

  const nothingEverSeen = describeHealth(base, Date.now());
  const seenButReleased = describeHealth({ ...base, releasedRepos: [REPO] }, Date.now());

  console.log(`\n  Nothing ever seen:\n\n    ${nothingEverSeen}`);
  console.log(`\n  Nothing outstanding, but ${REPO} seen before:\n\n    ${seenButReleased}\n`);

  const identical = nothingEverSeen === INERT;
  const appendedNotReplaced = seenButReleased.startsWith(INERT);
  const namesTheRepo = seenButReleased.includes(REPO);

  row('byte-identical to the sentence it always was', identical ? 'yes' : '*** NO ***');
  row('the released case appends rather than replaces', appendedNotReplaced ? 'yes' : '*** NO ***');

  verdict(
    identical && appendedNotReplaced && namesTheRepo,
    'the inert-case reason string is untouched, and the "seen before" disclosure is added after ' +
      'it rather than in place of it.',
    `identical: ${identical}; appended: ${appendedNotReplaced}; names the repo: ${namesTheRepo}. ` +
      'AC4 of this ticket forbids touching this string, and AC4 of KAN-339 forbade it first.'
  );
}

// ===========================================================================
// 5. The retention is in the FILE, which is why a restart does not lose it
// ===========================================================================

rule('§5 — a daemon restart: a second state object over the same file retains the same repo');

{
  // The plain in-process sticky set was one of the three candidates, and its
  // stated weakness is that a daemon restart empties it. This section is the
  // measurement that made that candidate UNNECESSARY: retention read out of the
  // durable memory has no restart hole to begin with.
  //
  // IT IS NOT THE SECTION THAT REFUTES THAT CANDIDATE, and saying so here is the
  // point of the sentence. Moving the retention onto a field of the watcher
  // leaves `PrWatchState` intact and merely stops consulting it, so this section
  // goes on passing — §6 is what catches it, because a set that lives for the
  // daemon's life never releases. `red-drive-kan360.sh` mutation 5 is that
  // demonstration, and it is red in §6 and green here on purpose.
  const before = new PrWatchState(STATE_FILE, () => Date.now());
  before.load();
  const openWhileMerged = before.reposWithOpenPr();

  // The same file as §2 left it — the pull request has MERGED there, so nothing
  // is outstanding. Re-open it with a row that is still OPEN and re-read from a
  // FRESH object, which is what a restart is.
  const withOpen = path.join(TMP, 'pr-watch-restart.json');
  fs.writeFileSync(
    withOpen,
    JSON.stringify({
      version: 1,
      prs: {
        [`${REPO}#42`]: {
          state: 'OPEN',
          reviewDecision: '',
          approval: 'absent',
          checks: 'success',
          mergeStateStatus: 'BLOCKED',
          headRefOid: 'c'.repeat(40),
          commentIds: [],
          greenIdleSha: '',
          seenAt: new Date().toISOString()
        }
      }
    })
  );

  const restarted = new PrWatchState(withOpen, () => Date.now());
  restarted.load();

  row('after §2, the memory holds an OPEN PR in', JSON.stringify(openWhileMerged));
  row('a fresh state object over a file with one', JSON.stringify(restarted.reposWithOpenPr()));
  row('…and every repo it has ever seen', JSON.stringify(restarted.knownRepos()));

  const mergedReleases = openWhileMerged.length === 0;
  const restartRetains = restarted.reposWithOpenPr().includes(REPO);

  verdict(
    mergedReleases && restartRetains,
    'retention is read out of the durable memory, so it survives a process that does not — and a ' +
      'merged pull request retains nothing.',
    `merged releases: ${mergedReleases} (want true — §2 merged it); restart retains: ` +
      `${restartRetains}. A retention that lives in the process is the candidate this ticket ` +
      'rejected, and it fails exactly here.'
  );
}

// ===========================================================================
// 6. It releases, and says that it did
// ===========================================================================

rule('§6 — the set is not made monotonic: a merged pull request lets the repository go');

{
  const afterMerge = timeline[2];

  console.log(`\n  Tick 3, one tick after the merge:\n\n    ${afterMerge.health.detail}\n`);

  row('watch set', JSON.stringify(afterMerge.tick.repos));
  row('released', JSON.stringify(afterMerge.tick.releasedRepos));
  row('GitHub reads this tick', afterMerge.tick.repos.length);

  const released = afterMerge.tick.releasedRepos.includes(REPO);
  const notWatched = !afterMerge.tick.repos.some((r) => r.repo === REPO);
  const disclosed = afterMerge.health.detail.includes(REPO);

  verdict(
    released && notWatched && disclosed,
    'the repository leaves the set on the tick after the merge it was retained for, and the ' +
      'report names it as released rather than dropping it silently.',
    `released: ${released}; no longer watched: ${notWatched}; named in the report: ${disclosed}. ` +
      'A set that only ever grows costs three rate-limit points a minute, forever, for every ' +
      'repository anybody has ever touched — and reports full coverage while doing it.'
  );
}

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
