// KAN-367: a pull request notice must not claim the PRESENT from evidence about
// the PAST — and when a look was missed, it must say so.
//
// WHAT FAILURE THIS WOULD CATCH: the notice `epic/KAN-59` received at 02:45Z on
// 2026-08-13 — "`wroosbit/CrabCast#86` has MERGED, and KAN-361 is still In
// Review" — where KAN-361 had been Done since 23:53:58Z, 27 seconds after the
// merge and two hours fifty-one minutes before the sentence was composed. Both
// halves were derived from stale evidence and one of them was phrased as though
// it were being observed as it was said. It would equally catch the two wrong
// fixes: making the claim honest with a better COMMENT (the docblock on
// `jiraStatus` already claimed the value was "at most one poll interval old",
// and that claim was false for exactly the population the event exists for), and
// qualifying EVERY notice as possibly-stale, which is a qualification a reader
// stops seeing and is then not read on the notice that meant it.
//
// AND IT WOULD CATCH THE REGRESSION THAT LOOKS LIKE A FIX: §1 exists because a
// reader who sees KAN-360 shipped may conclude this ticket is closed. It is not,
// and §1 measures exactly which half of it KAN-360 closed rather than asserting
// either way.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process, over a workspace tree it builds under a private $HOME in
// os.tmpdir(); no live daemon, no herdr, no credential, no peer, no terminal and
// no network (the GitHub reader is stubbed). Every clock is injected, so nothing
// here reads the wall clock and nothing is timing-dependent.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145; `prompts/task.md` names it the defect this epic keeps re-finding).
// Per section, and the holes are named rather than left to be inferred:
//
//   §1 SUPPLIES A REAL FILESYSTEM. The checkout is worktree-shaped the way
//   `prompts/task.md` mandates and is read by the shipped `discoverRepos` and
//   the shipped `PrWatcher.resolveRepos`, so the retention verdict is the
//   product's rather than this file's reading of it.
//   WHAT IT DOES NOT ESTABLISH: that a real stand-down removes an agent from
//   `surveyFleet()`. WHO COVERS IT: `verify-list-agents-survives-restart.mjs`.
//
//   §2 WRITES THE STATE FILE IT THEN READS BACK, and that is the point of it:
//   the outage is simulated by constructing a SECOND `PrWatcher` over the same
//   `pr-watch.json` with a clock three hours later, so what is tested is that
//   the gap is recognised from the DURABLE memory rather than from a variable in
//   a process that never went away.
//   WHAT IT DOES NOT ESTABLISH: that a real daemon restart reloads that file, or
//   that a real outage lasts long enough to matter. WHO COVERS THE FIRST:
//   `verify-capacity-survives-daemon-restart.mjs` is the pattern for that class
//   of claim and it is deliberately not extended here. THE SECOND IS COVERED BY
//   NOBODY, and it does not need to be: the fleet deploys several times a day
//   and every deploy is a restart.
//
//   §3 DRIVES THE SHIPPED `JiraPollState.factsFor`, not a stub of it — the
//   staleness is produced by writing a memory row with an old `seenAt` and
//   letting the product decide what to hand out. That is the mechanism of the
//   02:45Z notice reproduced rather than described.
//   WHAT IT DOES NOT ESTABLISH: that `JiraPoller` stops polling an issue when
//   its agent stands down. That is read off `pollable` in the tick — live
//   agents' keys only — and asserted by nobody automatically. It is a four-line
//   code read, cited in the PR body, and it is the one link in this chain that
//   is a claim rather than a measurement.
//
//   §4 AND §5 SUPPLY THE WORLD BUT NOT THE MECHANISM. GitHub is a stub and the
//   agents are addresses invented here; the recognition, the gap measurement,
//   the recipient resolution and every word of the notice are the shipped ones,
//   reached through the shipped `PrWatcher.watchOnce`. The `herdrBridge` is a
//   TRIP-WIRE whose every method throws, so "nothing was typed" is enforced
//   rather than asserted.
//   WHAT THEY DO NOT ESTABLISH: that a notice reaches a running agent over a
//   real carrier. WHO COVERS IT: `verify-pr-watch.mjs` §2-§6, over real Unix
//   sockets — deliberately not duplicated here.
//
//   WHAT NO SECTION HERE COVERS: that "no third option" holds against a future
//   author. This file can only drive the branches that exist. The property is
//   carried by the TYPE — `ObservedState` has no untimed spelling and
//   `PrEvent.observation` is required — and it is the compiler that refuses,
//   demonstrated as mutations 4 and 5 of `red-drive-kan367.sh`.
//
// Usage:
//   node daemon/scripts/verify-pr-watch-notice-tense.mjs [dist]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(56)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// A private $HOME set BEFORE the product is imported. `workspacesRoot()` and
// `BUTCHR_DIR` are both computed from the home directory, so this is what stops
// the proof reading the live fleet's workspaces or writing its pr-watch.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan367-'));
process.env.HOME = TMP;
// Discovery consults this first, and an operator value leaking in from the
// environment would silently replace everything §1 measures.
delete process.env.BUTCHR_PR_WATCH_REPOS;

const load = (mod) => import(path.join(path.resolve(distDir), mod));
const { snapshotFrom } = await load('github.js');
const {
  PrWatcher,
  PrWatchState,
  describeObservedState,
  describeDuration,
  PRESENT_TENSE_LIMIT_MS
} = await load('pr-watch.js');
const { JiraPollState } = await load('jira-poll.js');

const WORKSPACES = path.join(TMP, '.local', 'share', 'butchr', 'workspaces');
const REPO = 'wroosbit/CrabCast';

// The incident's own times, to the second, so the numbers this proof prints can
// be compared against the ticket rather than resembling it.
const OPENED = Date.parse('2026-08-12T23:37:04Z'); // KAN-361 -> In Review
const MERGED_AT = '2026-08-12T23:53:31Z'; // PR #86 MERGED
const NOTICED = Date.parse('2026-08-13T02:45:00Z'); // the notice that was wrong

// TWO DIFFERENT DURATIONS, KEPT APART ON PURPOSE. Collapsing them is this
// ticket's own subject in miniature — a number that is nearly right, attached to
// the wrong claim, in a sentence nobody re-checks.
//
//   GAP_MS  how long the pull request went UNOBSERVED: last look -> this look.
//           That is what the AC4 disclosure is about, and it is the number the
//           watcher can actually measure.
//   LATE_MS how long after the MERGE the news arrived. That is what it cost the
//           approver, and it is shorter — the merge happened partway through
//           the blind window, not at the start of it.
const GAP_MS = NOTICED - OPENED; // 3h 7m 56s
const LATE_MS = NOTICED - Date.parse(MERGED_AT); // 2h 51m 29s

const TASK = { agentName: 'task-kan-361', type: 'task', key: 'KAN-361' };
const APPROVER = { agentName: 'epic-kan-59', type: 'epic', key: 'KAN-59' };

/** A herdr that CANNOT be typed at: every method throws. */
const tripWireHerdr = new Proxy(
  {},
  {
    get: (_t, prop) => () => {
      throw new Error(`TRIP-WIRE: reached herdr.${String(prop)}() — a notice tried to type.`);
    }
  }
);

/**
 * A worktree-shaped checkout, built the way `git worktree add` builds one:
 * `.git` is a FILE holding a `gitdir:` pointer, `commondir` is beside the
 * pointed-at directory, and the `origin` url lives in the shared clone.
 * `repoForCheckout` follows exactly this hop.
 */
function makeWorktree(key) {
  const clone = path.join(TMP, 'code', 'crabcast');
  const gitDir = path.join(clone, '.git', 'worktrees', key.toLowerCase());
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(
    path.join(clone, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/wroosbit/CrabCast.git\n`
  );
  const workspace = path.join(WORKSPACES, 'task', key.toLowerCase(), 'CrabCast');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`);
  return workspace;
}

/** PR #86, as `gh pr list` returns it. */
const prRow = (over = {}) => ({
  number: 86,
  title: 'KAN-361: the thing the approver has to close out',
  url: 'https://github.com/wroosbit/CrabCast/pull/86',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'butchr/KAN-361',
  headRefOid: 'a'.repeat(40),
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

const MERGED_ROW = prRow({ state: 'MERGED', mergedAt: MERGED_AT });

/**
 * A watcher over a given state file and clock.
 *
 * NO `repos` OVERRIDE anywhere in this file: the watch set the product builds
 * for itself is the subject of §1, and handing it one would answer the question
 * §1 is asking.
 */
function makeWatcher({ stateFile, now, agents, rows, jiraFacts, sent }) {
  return new PrWatcher({
    github: {
      listPullRequests: async (repo) => ({ ok: true, prs: rows().map((r) => snapshotFrom(repo, r)) })
    },
    herdrBridge: tripWireHerdr,
    liveAgents: agents,
    issueFacts: jiraFacts,
    supervisorFor: () => null,
    state: new PrWatchState(stateFile, now),
    now,
    deliver: async ({ type, key, message }) => {
      sent.push({ to: `${type}/${key}`, message });
      return { delivered: true, transport: 'channel' };
    },
    log: () => {}
  });
}

// ===========================================================================
// 1. The premise check: which half of this did KAN-360 close?
// ===========================================================================

rule('§1 — the KAN-360 trigger, re-driven on THIS build: the repository is retained');

{
  makeWorktree('KAN-361');
  // The approver's workspace, built the way a supervisor's actually is: a
  // directory with no checkout in it. That is the measured fact KAN-360 turned
  // on, and it is why the approver can never hold the set open itself.
  fs.mkdirSync(path.join(WORKSPACES, 'epic', 'kan-59'), { recursive: true });

  const stateFile = path.join(TMP, 'pr-watch-s1.json');
  const sent = [];
  let agents = [TASK, APPROVER];
  let rows = [prRow()];

  const watcher = makeWatcher({
    stateFile,
    now: () => OPENED,
    agents: () => agents,
    rows: () => rows,
    jiraFacts: () => ({
      status: { value: 'In Review', observedAt: new Date(OPENED).toISOString() },
      parentKey: 'KAN-59',
      linkedKeys: []
    }),
    sent
  });

  // Tick 1: the task agent is live and holds the only CrabCast checkout.
  const before = await watcher.watchOnce();
  const beforeHealth = watcher.healthReport();

  // The task agent stands down. Its worktree is deliberately LEFT ON DISK — the
  // directory is not what disappears, the agent is, and discovery reads only
  // live agents' workspaces.
  agents = [APPROVER];
  rows = [MERGED_ROW];
  const after = await watcher.watchOnce();
  const afterHealth = watcher.healthReport();

  console.log('');
  row('BEFORE  prWatch.repos', JSON.stringify(before.repos));
  row('BEFORE  watchedCount', beforeHealth.watchedCount);
  row('        live agents', '[task/KAN-361, epic/KAN-59]');
  console.log('');
  row('AFTER   prWatch.repos', JSON.stringify(after.repos));
  row('AFTER   watchedCount', afterHealth.watchedCount);
  row('        live agents', '[epic/KAN-59] — the task agent stood down');
  row('        checkout still on disk', fs.existsSync(path.join(WORKSPACES, 'task', 'kan-361', 'CrabCast', '.git')));
  console.log('');
  row('the merge was recognised', after.events.some((e) => e.kind === 'merged'));
  row('…and seen LIVE rather than backfilled', after.events.find((e) => e.kind === 'merged')?.observation?.live);

  const retained = after.repos.length === 1 && after.repos[0].source === 'memory';
  const sawMergeLive =
    after.events.find((e) => e.kind === 'merged')?.observation?.live === true;

  verdict(
    retained && sawMergeLive,
    'the repository does NOT leave the set when its last checkout goes: KAN-360\'s retention ' +
      'holds it on `memory` provenance because #86 was open, so the merge is seen on the very ' +
      'next look. THE COVERAGE HALF OF KAN-367 NO LONGER REPRODUCES BY THIS TRIGGER, and that ' +
      'is reported as a finding rather than worked around. §2 is the half that remains.',
    `retained on memory provenance: ${retained}; merge seen live: ${sawMergeLive}. If this fails, ` +
      "KAN-360's retention has regressed and the three-hour blind window is back."
  );
}

// ===========================================================================
// 2. The half that remains: a look lost to something retention cannot hold
// ===========================================================================

rule('§2 — the re-announcement still reproduces through a gap retention cannot close');

let backfilledNotice = '';

{
  const stateFile = path.join(TMP, 'pr-watch-s2.json');
  const sent = [];
  const jiraFacts = () => ({
    // Frozen at the last poll before the agent stood down — the shipped
    // `factsFor` produces exactly this shape, and §3 drives it rather than
    // asserting it.
    status: { value: 'In Review', observedAt: new Date(OPENED).toISOString() },
    parentKey: 'KAN-59',
    linkedKeys: []
  });

  // Tick 1, at 23:37:04Z: #86 is open and is recorded. First sight announces
  // nothing, which is the no-replay rule and not a defect.
  const first = makeWatcher({
    stateFile,
    now: () => OPENED,
    agents: () => [TASK, APPROVER],
    rows: () => [prRow()],
    jiraFacts,
    sent
  });
  const before = await first.watchOnce();
  const beforeHealth = first.healthReport();

  // ... and then nothing looks at anything for two hours and fifty-one minutes.
  // A SECOND watcher over the SAME state file is what makes this a restart
  // rather than a variable: the memory has to come back off disk for the gap to
  // be measurable at all.
  const second = makeWatcher({
    stateFile,
    now: () => NOTICED,
    agents: () => [APPROVER],
    rows: () => [MERGED_ROW],
    jiraFacts,
    sent
  });
  const after = await second.watchOnce();
  const afterHealth = second.healthReport();

  const merged = after.events.find((e) => e.kind === 'merged');
  backfilledNotice = sent.find((s) => s.to === 'epic/KAN-59')?.message ?? '';

  console.log('');
  row('BEFORE  prWatch.repos', JSON.stringify(before.repos));
  row('BEFORE  watchedCount', beforeHealth.watchedCount);
  row('BEFORE  at', new Date(OPENED).toISOString());
  console.log('');
  row('AFTER   prWatch.repos', JSON.stringify(after.repos));
  row('AFTER   watchedCount', afterHealth.watchedCount);
  row('AFTER   at', new Date(NOTICED).toISOString());
  console.log('');
  row('the merge is announced on the first look back', !!merged);
  row('observation.live', merged?.observation?.live);
  row('observation.gapMs  (unobserved window)', `${merged?.observation?.gapMs} (${describeDuration(merged?.observation?.gapMs ?? 0)})`);
  row('how late the approver heard, after the merge', describeDuration(LATE_MS));
  row('mergedAt carried from GitHub', merged?.mergedAt ?? '(none)');

  console.log(`\n  What the approver reads:\n\n    ${backfilledNotice || '*** NOTHING ***'}\n`);

  const reproduced = !!merged && merged.observation.live === false;
  const gapIsRight = Math.abs((merged?.observation?.gapMs ?? 0) - GAP_MS) < 1000;

  verdict(
    reproduced && gapIsRight,
    `the merge is announced ${describeDuration(LATE_MS)} after it happened, on the first look ` +
      `after a ${describeDuration(GAP_MS)} gap — retention keeps a repository in the set, it ` +
      'does not make anybody look at it. The announcement is correct and late, which is the ' +
      'case the disclosure is for.',
    `backfilled event produced: ${reproduced}; gap measured as ${merged?.observation?.gapMs} ` +
      `against an expected ${GAP_MS}. A gap the watcher cannot measure is one it cannot disclose.`
  );
}

// ===========================================================================
// 3. Where the stale `In Review` came from — the shipped factsFor, not a stub
// ===========================================================================

rule('§3 — AC2: the mechanism, driven through the shipped JiraPollState.factsFor');

{
  const state = new JiraPollState(path.join(TMP, 'jira-poll-s3.json'), () => NOTICED);
  state.load();
  // The row as the poller left it: read at 23:37:04Z, when KAN-361 was In
  // Review, and never read again because `task/KAN-361` stood down and the
  // poller reads only live agents' issues.
  state.set('KAN-361', {
    status: 'In Review',
    maxCommentId: '0',
    seenAt: new Date(OPENED).toISOString(),
    parentKey: 'KAN-59',
    linkedKeys: []
  });

  const facts = state.factsFor('KAN-361');
  const ageMs = NOTICED - Date.parse(facts.status.observedAt);

  console.log('');
  row('factsFor("KAN-361").status.value', facts.status.value);
  row('factsFor("KAN-361").status.observedAt', facts.status.observedAt);
  row('age at the moment the notice was composed', describeDuration(ageMs));
  row('the real KAN-361 status at that moment', 'Done (since 2026-08-12T23:53:58Z)');
  console.log('');
  console.log('  The sentence that WAS sent, and the sentence this build composes:\n');
  console.log('    was:  KAN-361 is still In Review');
  console.log(`    now:  ${describeObservedState('KAN-361', facts.status, NOTICED)}`);

  const carriesTime = typeof facts.status?.observedAt === 'string';
  const isTheFrozenRead = facts.status.observedAt === new Date(OPENED).toISOString();
  const composed = describeObservedState('KAN-361', facts.status, NOTICED);
  const noLongerPresentTense = !composed.includes('is still');

  verdict(
    carriesTime && isTheFrozenRead && noLongerPresentTense,
    'the status comes out of the poller CARRYING the moment it was read, and the moment is the ' +
      'frozen one — so the staleness is now a measurable property of the value rather than an ' +
      'invisible property of the world. Candidate 1 of the ticket ("state captured when the PR ' +
      'row was first seen") is ruled out by construction: the status is read where the event is ' +
      'built, on the tick that recognises the merge. It was a fresh read of a stale memory.',
    `observedAt present: ${carriesTime}; equals the frozen read: ${isTheFrozenRead}; ` +
      `past tense: ${noLongerPresentTense}.`
  );
}

// ===========================================================================
// 4. AC3 — present-tense-and-fresh, or past-tense-and-timestamped
// ===========================================================================

rule('§4 — AC3: both branches, and the timestamp is in BOTH of them');

{
  const now = NOTICED;
  const cases = [
    ['0s', 0],
    ['60s (one poll interval)', 60_000],
    [`${describeDuration(PRESENT_TENSE_LIMIT_MS)} (the limit exactly)`, PRESENT_TENSE_LIMIT_MS],
    [`${describeDuration(PRESENT_TENSE_LIMIT_MS + 1000)} (one second past it)`, PRESENT_TENSE_LIMIT_MS + 1000],
    [`the incident's gap: ${describeDuration(GAP_MS)}`, GAP_MS]
  ];

  console.log('');
  let everyClaimTimed = true;
  let tenseFollowsAge = true;
  for (const [label, age] of cases) {
    const observed = { value: 'In Review', observedAt: new Date(now - age).toISOString() };
    const text = describeObservedState('KAN-361', observed, now);
    const present = text.includes('is still');
    console.log(`  ${label.padEnd(38)} ${present ? 'PRESENT' : 'past   '}  ${text}`);
    if (!text.includes(observed.observedAt) && !text.includes(describeDuration(age))) {
      everyClaimTimed = false;
    }
    if (present !== age <= PRESENT_TENSE_LIMIT_MS) tenseFollowsAge = false;
  }

  // The input that could smuggle the third option back in. `NaN <= limit` is
  // false, so this must fall to the PAST branch — but a condition written the
  // other way round (`age > limit` for stale) would have let it through as
  // fresh, which is the present tense on the least trustworthy input there is.
  const malformed = describeObservedState('KAN-361', { value: 'In Review', observedAt: 'not a date' }, now);
  const future = describeObservedState(
    'KAN-361',
    { value: 'In Review', observedAt: new Date(now + 3_600_000).toISOString() },
    now
  );
  console.log('');
  row('an unparseable observedAt', malformed.includes('is still') ? '*** PRESENT ***' : 'past');
  row('an observedAt in the future', future.includes('is still') ? '*** PRESENT ***' : 'past');

  const degradesToPast = !malformed.includes('is still') && !future.includes('is still');

  verdict(
    everyClaimTimed && tenseFollowsAge && degradesToPast,
    'every sentence carries when it was true — the present-tense branch says how long ago it ' +
      'was read and the past-tense branch names the timestamp itself — and the tense follows ' +
      'the age at the boundary rather than near it. A timestamp the watcher cannot parse, or ' +
      'one from the future, degrades to the PAST branch: uncertainty must not buy confidence.',
    `all timed: ${everyClaimTimed}; tense follows age: ${tenseFollowsAge}; ` +
      `malformed and future degrade to past: ${degradesToPast}.`
  );
}

// ===========================================================================
// 5. AC4 — a backfilled notice says so, and a live one does not
// ===========================================================================

rule('§5 — AC4: a reader can tell a live announcement from a backfilled one');

{
  const stateFile = path.join(TMP, 'pr-watch-s5.json');
  const sent = [];
  const jiraFacts = (key) =>
    key === 'KAN-361'
      ? { status: { value: 'Done', observedAt: new Date(NOTICED).toISOString() }, parentKey: 'KAN-59', linkedKeys: [] }
      : null;

  // The same merge, seen on the very next tick instead of three hours later.
  const live = makeWatcher({
    stateFile,
    now: () => OPENED,
    agents: () => [TASK, APPROVER],
    rows: () => [prRow()],
    jiraFacts,
    sent
  });
  await live.watchOnce();

  const nextTick = makeWatcher({
    stateFile,
    now: () => OPENED + 60_000,
    agents: () => [APPROVER],
    rows: () => [MERGED_ROW],
    jiraFacts,
    sent
  });
  const liveTick = await nextTick.watchOnce();
  const liveNotice = sent.find((s) => s.to === 'epic/KAN-59')?.message ?? '';

  console.log('\n  A merge seen on the next look (60s):\n');
  console.log(`    ${liveNotice || '*** NOTHING ***'}`);
  console.log(`\n  The same merge, first seen after a ${describeDuration(GAP_MS)} gap (from §2):\n`);
  console.log(`    ${backfilledNotice || '*** NOTHING ***'}`);

  console.log('');
  row('live notice says BACKFILLED', liveNotice.includes('BACKFILLED'));
  row('backfilled notice says BACKFILLED', backfilledNotice.includes('BACKFILLED'));
  row('backfilled notice names the last look', backfilledNotice.includes(new Date(OPENED).toISOString()));
  row('backfilled notice names the gap', backfilledNotice.includes(describeDuration(GAP_MS)));
  row('both name when the merge happened', liveNotice.includes(MERGED_AT) && backfilledNotice.includes(MERGED_AT));

  const quietWhenLive = !liveNotice.includes('BACKFILLED') && liveTick.events.some((e) => e.kind === 'merged');
  const loudWhenNot =
    backfilledNotice.includes('BACKFILLED') &&
    backfilledNotice.includes(new Date(OPENED).toISOString()) &&
    backfilledNotice.includes(describeDuration(GAP_MS));
  const bothTimestampTheMerge = liveNotice.includes(MERGED_AT) && backfilledNotice.includes(MERGED_AT);

  verdict(
    quietWhenLive && loudWhenNot && bothTimestampTheMerge,
    'the two are distinguishable in the words themselves: the backfilled one names the window ' +
      'it could not see and how long it was, and the live one adds nothing — because a ' +
      'qualification on every notice is one a reader stops seeing, and would then not be read ' +
      'on the notice that meant it. Both name when the merge actually happened.',
    `live notice quiet: ${quietWhenLive}; backfilled notice discloses the window: ${loudWhenNot}; ` +
      `both timestamp the merge: ${bothTimestampTheMerge}.`
  );
}

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
