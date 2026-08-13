// KAN-339: the PR watcher's most confident sentence — "nothing is blocking it
// except a review that has not happened" — is composed only from facts that were
// positively observed, and the counters beside it distinguish rows polled from
// pull requests outstanding.
//
// WHAT FAILURE THIS WOULD CATCH: the watcher telling an approver that a
// CONFLICTED pull request with ZERO checks at its head was ready to review.
// wroosbit/butchr#153, 2026-08-12T15:58:53Z — "has every other check green and
// NO approval recorded at this head, so nothing is blocking it except a review
// that has not happened" — followed 67 seconds later, at the SAME unmoved head
// 514db76, by "is DIRTY against main". Both halves of the first sentence were
// false: `gh api .../commits/514db76/check-runs` returns `total_count: 0`, so no
// workflow had run at all, and the conflict was blocking it, which no review can
// clear. It would equally catch the second sentence this module got wrong the
// same day: a health line reading "40 pull request(s) matched a ticket, 40 of
// them with no live agent to tell" on a repository with ZERO open pull requests,
// because the `--state all` read window was counted as if every row were work.
//
// AND IT WOULD CATCH THE OBVIOUS WRONG FIX. §3 exists because §1, §2 and §4 are
// all satisfied by a `green-idle` that never fires at all. A watcher that has
// been made silent has not been made correct, and silence is the direction this
// kind of fix degrades in.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts in process,
// with no live daemon, no herdr, no credential, no network and no terminal. §1
// replays a RECORDED fixture; §2-§5 stub the GitHub reader.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145; `prompts/task.md` names it the defect this epic keeps re-finding).
// Per section, and the holes are named rather than left to be inferred:
//
//   §1 SUPPLIES ALMOST NOTHING IT INVENTED. `fixtures/pr-153-defect-head.json`
//   is the real #153 at the real head 514db76, and every field in it is read
//   back from GitHub's commit APIs — which are keyed by sha and therefore still
//   answer for a head the PR has since moved off. The file records the exact
//   command behind each field.
//   THE ONE INFERRED FIELD IS `mergeStateStatus`, and the fixture says so in its
//   own provenance block rather than here: GitHub retains no history of it. What
//   the fixture cannot supply, this section therefore does not claim; §2 covers
//   the inference by replaying the whole observed SEQUENCE instead, where the
//   contradiction is visible without needing to know which value sat in the gap.
//
//   §2-§5 SUPPLY THE WORLD BUT NOT THE MECHANISM. The GitHub reader is a stub
//   and the agents are addresses invented here; the classifier, the readiness
//   decision, the event recognition, the notice text and the health sentence are
//   all the shipped ones, reached through the shipped `PrWatcher.watchOnce`.
//   WHAT THEY DO NOT ESTABLISH: that a notice reaches a running agent over a
//   real carrier. WHO COVERS IT: `verify-pr-watch.mjs` §2-§6, which drive this
//   same watcher over real Unix sockets with a trip-wire herdr — deliberately
//   not duplicated here.
//
//   WHAT NO SECTION HERE COVERS: that the fixed sentence is composed about a
//   REAL pull request by the REAL daemon. That needs this build deployed and an
//   actual PR observed changing state, which is AC3 of KAN-339 and is an
//   observation pasted into the PR body, not an assertion in this file.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

// A private $HOME set BEFORE the product is imported: `ipc.ts` computes
// BUTCHR_DIR from os.homedir() at module load, and this watcher's state file
// lives inside it. Without this the proof would scribble on the live fleet's
// pr-watch.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan339-'));
process.env.HOME = TMP;

const load = (mod) => import(path.join(path.resolve(distDir), mod));
const { snapshotFrom, rollupOf, mergeabilityOf } = await load('github.js');
const { PrWatcher, PrWatchState, readinessOf, prEventNoticeText, describeHealth } =
  await load('pr-watch.js');

let stateSeq = 0;
const nextStateFile = () => path.join(TMP, `pr-watch-${stateSeq++}.json`);

/** A pull request row, defaulted to the shape of a healthy open PR. */
const prRow = (over = {}) => ({
  number: 900,
  title: 'a pull request',
  url: 'https://github.com/wroosbit/butchr/pull/900',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'butchr/KAN-309',
  headRefOid: 'a'.repeat(40),
  mergedAt: null,
  reviewDecision: '',
  mergeStateStatus: 'BLOCKED',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'ci-partition', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'daemon-typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'approval-recorded', state: 'FAILURE' }
  ],
  comments: [],
  ...over
});

const OWN = { agentName: 'task-kan-309', type: 'task', key: 'KAN-309' };
const APPROVER = { agentName: 'epic-kan-39', type: 'epic', key: 'KAN-39' };

/**
 * A watcher over a stubbed GitHub. `reads` is the sequence of worlds it walks
 * through, one per tick, so a case reads as a timeline rather than as mutation.
 *
 * `deliver` records instead of sending: the carrier is not this file's subject
 * and `verify-pr-watch.mjs` already drives the real one over real sockets.
 */
async function harness({ reads, agents = [OWN, APPROVER] }) {
  const sent = [];
  let tickIndex = 0;
  const watcher = new PrWatcher({
    github: {
      listPullRequests: async () => ({
        ok: true,
        prs: reads[Math.min(tickIndex, reads.length - 1)].map((r) =>
          snapshotFrom('wroosbit/butchr', r)
        )
      })
    },
    herdrBridge: new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`TRIP-WIRE: reached herdr.${String(prop)}() — a notice tried to type.`);
        }
      }
    ),
    liveAgents: () => agents,
    issueFacts: () => ({ status: { value: 'In Review', observedAt: new Date().toISOString() }, parentKey: 'KAN-39', linkedKeys: [] }),
    supervisorFor: () => null,
    repos: () => ['wroosbit/butchr'],
    state: new PrWatchState(nextStateFile(), () => Date.now()),
    deliver: async ({ type, key, message }) => {
      sent.push({ to: `${type}/${key}`, message });
      return { delivered: true, transport: 'channel' };
    },
    log: () => {}
  });

  const ticks = [];
  for (let i = 0; i < reads.length; i++) {
    tickIndex = i;
    ticks.push(await watcher.watchOnce());
  }
  return { watcher, ticks, sent };
}

const kindsIn = (ticks) => ticks.flatMap((t) => t.events.map((e) => e.kind));

// ===========================================================================
// 1. The real head that produced the wrong sentence
// ===========================================================================

rule('§1 — wroosbit/butchr#153 at head 514db76, from GitHub\'s own commit APIs');

{
  const fixture = JSON.parse(
    fs.readFileSync(path.join(scriptDir, 'fixtures', 'pr-153-defect-head.json'), 'utf8')
  );
  const pr = snapshotFrom('wroosbit/butchr', fixture.row);

  console.log('\n  What GitHub held at that sha:\n');
  row('check-runs at 514db76', 'total_count: 0 — no workflow ran');
  row('statuses at 514db76', '["approval-recorded"] state=failure');
  console.log('\n  What the shipped parser and classifier now make of it:\n');
  row('snapshot.checks', pr.checks);
  row('snapshot.approval', pr.approval);
  row('snapshot.mergeStateStatus', pr.mergeStateStatus);
  row('mergeabilityOf(mergeStateStatus)', mergeabilityOf(pr.mergeStateStatus));

  const readiness = readinessOf(pr);
  row('readinessOf(pr).ready', String(readiness.ready));
  row('readinessOf(pr).blocker', readiness.blocker ?? '—');
  console.log(`\n  reason: ${readiness.reason ?? '(none — reported ready)'}`);

  // The load-bearing one. A rollup holding ONLY the approval mechanism is a
  // rollup in which nothing was judged, and the old code returned 'success' for
  // it — the exact substitution of absence for presence that produced the notice.
  const checksNotGreen = pr.checks === 'none';
  const notReady = readiness.ready === false;

  verdict(
    checksNotGreen && notReady,
    `a rollup carrying only \`approval-recorded\` reads as '${pr.checks}', and the head is ` +
      `refused (${readiness.blocker}).`,
    `checks read '${pr.checks}' (want 'none') and ready=${readiness.ready} (want false). This is ` +
      'the #153 head; anything but a refusal here is the defect still present.'
  );
}

// ===========================================================================
// 2. The contradiction, replayed as the sequence that was actually observed
// ===========================================================================

rule('§2 — the observed timeline: DIRTY → (base moves, GitHub recomputes) → DIRTY');

{
  // The three ticks the daemon log records around 15:58, at ONE unmoved head.
  // The middle world is the 40-second window after #152 merged to main at
  // 15:58:13Z, in which GitHub had invalidated its cached mergeability and not
  // yet replaced it. The head sha is identical in all three: nothing about the
  // pull request changed, only what GitHub was able to say about it.
  const head = '514db76844b3e8323e53d32e6c2c8b06bf0d6386';
  const only = [{ __typename: 'StatusContext', context: 'approval-recorded', state: 'FAILURE' }];
  const at = (mergeStateStatus) => [
    prRow({
      number: 153,
      headRefName: 'butchr/KAN-343',
      headRefOid: head,
      mergeStateStatus,
      statusCheckRollup: only
    })
  ];

  const { ticks, sent } = await harness({ reads: [at('DIRTY'), at('UNKNOWN'), at('DIRTY')] });

  console.log('\n  tick   mergeStateStatus   events recognised\n');
  ['DIRTY (first sight)', 'UNKNOWN (base just moved)', 'DIRTY (recomputed)'].forEach((label, i) => {
    row(`  ${i + 1}. ${label}`, ticks[i].events.map((e) => e.kind).join(', ') || '(none)');
  });

  const greenIdles = kindsIn(ticks).filter((k) => k === 'green-idle');
  const staleEvents = kindsIn(ticks).filter((k) => k === 'head-stale');
  const claimedReady = sent.filter((s) => /nothing is blocking it except a review/.test(s.message));

  console.log('\n  Messages composed across the whole sequence:');
  if (!sent.length) console.log('    (none)');
  for (const s of sent) console.log(`    → ${s.to}: ${s.message.slice(0, 100)}…`);

  verdict(
    greenIdles.length === 0 && claimedReady.length === 0,
    'no tick in the sequence called this head ready to review.',
    `${greenIdles.length} green-idle event(s) and ${claimedReady.length} ready-to-review ` +
      'sentence(s) were produced about a head that never once merged cleanly. This is the ' +
      '15:58:53Z notice, reproduced.'
  );

  // And the flap does not re-announce the conflict. The pull request was already
  // known DIRTY at tick 1, so tick 3 is not news — it is the same conflict seen
  // through a gap in GitHub's knowledge. A watcher that re-announces a standing
  // fact every time `main` moves is one its readers learn to skip.
  verdict(
    staleEvents.length === 0,
    'the DIRTY → UNKNOWN → DIRTY flap announced the conflict zero further times.',
    `${staleEvents.length} head-stale event(s) from a conflict that was already known at first ` +
      'sight — an uncomputed merge state was written into the memory and erased what was known.'
  );
}

// ===========================================================================
// 3. THE COUNTER-TEST: it still fires when it genuinely should
// ===========================================================================

rule('§3 — green-idle still fires on a PR that IS waiting on nothing but a review');

{
  // Two real checks green, BLOCKED (which on this repository is what an
  // unapproved PR with green CI reads as — blocked by the required
  // `approval-recorded` context), no approval. This is the feature.
  //
  // The PR must arrive NOT-yet-green and then go green, which is the real path:
  // first sight arms `greenIdleSha` as already-announced by design, so that a
  // daemon start does not broadcast every pull request that happens to be
  // sitting green. Written as two identical green ticks this section reports a
  // silence that is the no-replay rule working, and calls the feature broken.
  // (It did, on the first run of this file.)
  const green = prRow({ headRefOid: 'b'.repeat(40) });
  const stillRunning = prRow({
    headRefOid: 'b'.repeat(40),
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'ci-partition', status: 'IN_PROGRESS' },
      { __typename: 'StatusContext', context: 'approval-recorded', state: 'FAILURE' }
    ]
  });
  const { ticks, sent } = await harness({ reads: [[stillRunning], [green]] });
  const fired = kindsIn(ticks).includes('green-idle');
  const toApprover = sent.filter((s) => s.to === 'epic/KAN-39');

  row('green-idle recognised', String(fired));
  row('recipients', sent.map((s) => s.to).join(', ') || '(none)');
  for (const s of toApprover) console.log(`\n  ${s.message}`);

  verdict(
    fired && toApprover.length === 1,
    'a genuinely ready pull request still reaches its approver, once.',
    `green-idle fired: ${fired}; notices to the approver: ${toApprover.length} (want 1). A fix ` +
      'that silences this notice has removed the feature rather than corrected it.'
  );
}

// ===========================================================================
// 4. Two stale states, two different pairs of hands
// ===========================================================================

rule('§4 — DIRTY and BEHIND are told apart, and each names its own remedy');

{
  const words = {};
  for (const [state, sha] of [['DIRTY', 'c'], ['BEHIND', 'd']]) {
    const clean = prRow({ headRefOid: sha.repeat(40), mergeStateStatus: 'CLEAN' });
    const stale = prRow({ headRefOid: sha.repeat(40), mergeStateStatus: state });
    const { ticks } = await harness({ reads: [[clean], [stale]] });
    const event = ticks[1].events.find((e) => e.kind === 'head-stale');
    words[state] = event ? prEventNoticeText([event], 'own', Date.now()) : '(no head-stale event)';
  }

  for (const [state, text] of Object.entries(words)) console.log(`\n  ${state}:\n    ${text}`);

  const dirty = words.DIRTY;
  const behind = words.BEHIND;
  // The remedies are opposite, so each message must name its own and NOT the
  // other's: telling an author to run `update-branch` on a conflicted branch
  // sends them to a command that cannot help.
  const dirtyRight = /resolved by hand/.test(dirty) && !/`gh pr update-branch` fixes it/.test(dirty);
  const behindRight = /`gh pr update-branch` fixes it/.test(behind) && !/resolved by hand/.test(behind);

  verdict(
    dirty !== behind && dirtyRight && behindRight,
    'each state names the remedy that applies to it and not the other.',
    `distinct: ${dirty !== behind}; DIRTY names hand-resolution only: ${dirtyRight}; BEHIND names ` +
      `update-branch only: ${behindRight}.`
  );
}

// ===========================================================================
// 5. Rows polled are not pull requests outstanding
// ===========================================================================

rule('§5 — the health sentence on a repository with nothing open');

{
  // The state the real repository was in when the misleading line was read: a
  // full read window, every row matched to a ticket, none of them open.
  const merged = Array.from({ length: 40 }, (_, i) =>
    prRow({
      number: 100 + i,
      state: 'MERGED',
      headRefName: `butchr/KAN-${200 + i}`,
      headRefOid: String(i).padStart(40, '0'),
      mergeStateStatus: 'UNKNOWN'
    })
  );

  const { watcher, ticks } = await harness({ reads: [merged], agents: [] });
  const health = watcher.healthReport();

  row('rows in the read window that matched a ticket', health.watchedCount);
  row('of those, OPEN', health.openCount);
  row('OPEN with no live agent to tell', health.nobodyLiveCount);
  row('tick.openWatched.length', ticks[0].openWatched.length);
  console.log(`\n  ${health.detail}\n`);

  // The old sentence's exact failure: forty rows reported as forty pull requests
  // nobody can attend to. `40` must not appear as the count of anything wanting
  // attention, and the closed rows must be labelled as not-outstanding.
  const countsRight = health.watchedCount === 40 && health.openCount === 0 && health.nobodyLiveCount === 0;
  const saysSo = /0 OPEN pull request\(s\)/.test(health.detail);
  const disclaimsClosed = /not outstanding work/.test(health.detail);

  verdict(
    countsRight && saysSo && disclaimsClosed,
    'forty merged rows are reported as forty polled rows and zero outstanding pull requests.',
    `counts (40/0/0): ${countsRight}; says "0 OPEN": ${saysSo}; labels the closed rows as not ` +
      `outstanding: ${disclaimsClosed}. Got watched=${health.watchedCount}, open=${health.openCount}, ` +
      `nobodyLive=${health.nobodyLiveCount}.`
  );

  // And the blind case still refuses to report a clean nothing (AC4 of KAN-339:
  // whatever changes, the inert case must keep saying so as clearly as it did).
  const blind = describeHealth(
    { ...health, repos: [], lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0 },
    Date.now()
  );
  console.log(`  Inert case, unchanged:\n  ${blind}\n`);
  verdict(
    /not the same as nothing having changed/.test(blind),
    'the no-repository sentence still discloses that nothing is being observed.',
    'the inert-case disclosure has been damaged — it is the best thing in this module and AC4 ' +
      'of KAN-339 protects it explicitly.'
  );
}

rule(`${failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`}`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
