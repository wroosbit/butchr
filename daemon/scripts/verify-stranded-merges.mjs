// KAN-260: an approved pull request that has not merged is REPORTED, whoever
// holds the ticket and whether or not anybody is live to press the button.
//
// WHAT FAILURE THIS WOULD CATCH: four approved pull requests sitting unmerged
// for hours with every instrument on the board reading healthy. On 2026-08-10
// `epic/KAN-39` approved #112 (KAN-251), #113 (KAN-241), #114 (KAN-252) and
// #115 (KAN-255); all four sat. The board said In Review, which is true and
// reads as progressing; `gh pr list` said CLEAN; the census said the agents were
// on standby, which reads as deliberate. `prompts/task.md` permits exactly one
// party to press the button, so each was stuck on one agent and nothing anywhere
// said so. It was found by a supervisor reading the census for an unrelated
// reason, hours late.
//
// AND IT WOULD CATCH THE FIX THIS TICKET WAS FILED ASKING FOR, WHICH IS THE
// WRONG ONE. KAN-260's own title says *"whose task agent has been stood down"*,
// and `epic/KAN-39` corrected that framing an hour later on the evidence:
// #115's agent was LIVE and idle and had not merged. It was not stood down and
// not at capacity — it simply did not know, because an approval lands as a
// GitHub comment and the Jira poller watches Jira. A report that fired only on
// standby would be green on the very pull request that disproved the diagnosis.
// §2 is that arm and it is the reason this script exists rather than a count.
//
// §3 IS THE OTHER HALF, AND IT IS WHY §1 AND §2 ARE NOT ENOUGH. Both of them
// are satisfied by a report that fires on every open pull request, or on every
// stood-down agent — a signal that says "something is wrong" continuously has
// not been shown to distinguish anything. §3 drives the three states that must
// come back CLEAN: a stood-down agent with no open pull request, an open pull
// request nobody has approved, and one that merged.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts in process,
// with no live daemon, no herdr, no credential, no network and no terminal. The
// GitHub reader is stubbed; every classification, the report and the health
// sentence are the shipped ones, reached through the shipped
// `PrWatcher.watchOnce`.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145; `prompts/task.md` names it the defect this epic keeps re-finding).
//
//   IT SUPPLIES THE WORLD AND NOT THE MECHANISM. The pull request rows and the
//   live-agent addresses are invented here. `snapshotFrom`, `readinessOf`,
//   `approvalAtHead`, `mergeHoldOf`, `strandedMergeOf`, the accumulation inside
//   `watchOnce` and `describeHealth` are all the shipped ones.
//
//   WHAT IT THEREFORE DOES NOT ESTABLISH — three holes, named rather than left
//   to be inferred:
//
//   (a) THAT THE REPORT REACHES `butchr_list_agents`. That is `router.ts`
//       assembling `prWatch: prWatcher.healthReport()` and the MCP response
//       budget not dropping the section. WHO COVERS IT: nobody, in this file.
//       `verify-list-agents-response-budget.mjs` governs the ladder that may
//       clip `prWatch`, and the end-to-end read is an observation of the running
//       daemon pasted into the pull request body, not an assertion here.
//
//   (b) THAT A REAL APPROVAL PRODUCES `approval: 'recorded'`. That is KAN-306's
//       `approval-recorded` status and `github.ts`'s parser. WHO COVERS IT:
//       `verify-approval-recorded-gate.mjs` and `verify-pr-watch-readiness.mjs`
//       §1, which replays the real #153 head off GitHub's own commit APIs.
//
//   (c) THAT ANY OF THIS CHANGES WHAT AN AGENT DOES. It is a report and nothing
//       else — see the ticket comment on KAN-260 for why "report only" was
//       chosen over refusing a stand-down. Deliberately uncovered: there is no
//       behaviour to cover.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(46)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// A private $HOME set BEFORE the product is imported: `ipc.ts` computes
// BUTCHR_DIR from os.homedir() at module load and this watcher's state file
// lives inside it. Without this the proof would scribble on the live fleet's
// pr-watch.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan260-'));
process.env.HOME = TMP;

const load = (mod) => import(path.join(path.resolve(distDir), mod));
const { snapshotFrom } = await load('github.js');
const { PrWatcher, PrWatchState, describeHealth, mergeHoldOf, approvalAtHead, readinessOf } =
  await load('pr-watch.js');

let stateSeq = 0;
const nextStateFile = () => path.join(TMP, `pr-watch-${stateSeq++}.json`);

const GREEN = [
  { __typename: 'CheckRun', name: 'ci-partition', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'daemon-typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' }
];
const APPROVED = [...GREEN, { __typename: 'StatusContext', context: 'approval-recorded', state: 'SUCCESS' }];
const UNAPPROVED = [...GREEN, { __typename: 'StatusContext', context: 'approval-recorded', state: 'FAILURE' }];

/** A pull request row, defaulted to an OPEN, green, APPROVED one on KAN-255. */
const prRow = (over = {}) => ({
  number: 115,
  title: 'KAN-255: something that was approved and never landed',
  url: 'https://github.com/wroosbit/butchr/pull/115',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'butchr/KAN-255',
  headRefOid: 'b'.repeat(40),
  mergedAt: null,
  reviewDecision: '',
  // CLEAN, not BLOCKED: an approved head that GitHub positively says merges.
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: APPROVED,
  comments: [],
  ...over
});

const OWN = { agentName: 'task-kan-255', type: 'task', key: 'KAN-255' };
const APPROVER = { agentName: 'epic-kan-39', type: 'epic', key: 'KAN-39' };

/**
 * A watcher over a stubbed GitHub. `reads` is the sequence of worlds it walks
 * through, one per tick, so a case reads as a timeline rather than as mutation.
 * A read may be `{ error }` instead of an array, which fails that repository.
 */
async function harness({ reads, agents = [APPROVER], repos = ['wroosbit/butchr'], now }) {
  let tickIndex = 0;
  const clock = now ?? (() => Date.now());
  const watcher = new PrWatcher({
    github: {
      listPullRequests: async (repo) => {
        const world = reads[Math.min(tickIndex, reads.length - 1)];
        const forRepo = Array.isArray(world) ? world : (world[repo] ?? []);
        if (forRepo && forRepo.error) return { ok: false, error: forRepo.error, backOff: false };
        return { ok: true, prs: forRepo.map((r) => snapshotFrom(repo, r)) };
      }
    },
    herdrBridge: new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`TRIP-WIRE: reached herdr.${String(prop)}() — a report tried to type.`);
        }
      }
    ),
    liveAgents: () => agents,
    issueFacts: () => ({
      status: { value: 'In Review', observedAt: new Date(clock()).toISOString() },
      parentKey: 'KAN-39',
      linkedKeys: []
    }),
    supervisorFor: () => null,
    repos: () => repos,
    state: new PrWatchState(nextStateFile(), clock),
    deliver: async () => ({ delivered: true, transport: 'channel' }),
    log: () => {},
    now: clock
  });

  const ticks = [];
  for (let i = 0; i < reads.length; i++) {
    tickIndex = i;
    ticks.push(await watcher.watchOnce());
  }
  return { watcher, ticks, last: ticks[ticks.length - 1] };
}

/** Two ticks: first sight is silent, so every case reads the SECOND one. */
const twice = (world) => [world, world];

// ===========================================================================
// 1. KAN-260 as filed: approved, and nobody is live to press the button
// ===========================================================================

rule('§1 — the four of 2026-08-10: approved, agent stood down, board says In Review');

{
  // The approver is live. The agent that must MERGE is not — that is exactly
  // what "standbyAgents: butchr-task-kan-255" meant on the day.
  const { last } = await harness({ reads: twice([prRow()]), agents: [APPROVER] });
  const report = last.strandedMerges;

  row('report.answered', String(report.answered));
  row('report.scannedRepos', JSON.stringify(report.scannedRepos));
  row('pulls.length', report.pulls?.length ?? '(no pulls key)');
  const found = report.answered ? report.pulls[0] : null;
  row('pulls[0].issueKey', found?.issueKey ?? '—');
  row('pulls[0].hold', found?.hold ?? '—');
  row('pulls[0].approvalSource', found?.approvalSource ?? '—');
  row('pulls[0].liveMergers', JSON.stringify(found?.liveMergers ?? null));
  if (found) console.log(`\n  detail: ${found.detail}`);

  // What every OTHER instrument said about this same world, so that "nothing
  // reported it" is measured here rather than quoted from the ticket.
  row('', '');
  row('tick.openWatched (what `gh pr list` sees)', JSON.stringify(last.openWatched));
  row('tick.nobodyLive (the old count)', JSON.stringify(last.nobodyLive));
  row('tick.events (what anybody was told)', JSON.stringify(last.events.map((e) => e.kind)));

  verdict(
    report.answered &&
      report.pulls.length === 1 &&
      report.pulls[0].issueKey === 'KAN-255' &&
      report.pulls[0].hold === 'nobody-has-pressed-it' &&
      report.pulls[0].liveMergers.length === 0,
    'the pull request is named, with an EMPTY `liveMergers` saying nothing on this box can ' +
      'land it. Note that `tick.events` is empty: no notice fired, because nothing CHANGED — ' +
      'this is a standing condition and a report is the only shape that can carry it.',
    `got answered=${report.answered}, ${report.pulls?.length} row(s), ` +
      `hold=${found?.hold}, liveMergers=${JSON.stringify(found?.liveMergers)}. ` +
      'An approved pull request with nobody live to merge it must be a row here.'
  );
}

// ===========================================================================
// 2. THE ARM THAT EXISTS TO FAIL — #115: the agent is LIVE and has not merged
// ===========================================================================

rule('§2 — #115: agent LIVE, idle, approved, unmerged. A standby-only report is GREEN here.');

{
  const { last } = await harness({ reads: twice([prRow()]), agents: [OWN, APPROVER] });
  const report = last.strandedMerges;
  const found = report.answered ? report.pulls[0] : null;

  console.log(
    '\n  `epic/KAN-39` on KAN-260, an hour after filing it:\n' +
    '    "KAN-255\'s agent is running, idle, and has not merged an approved PR. It is not\n' +
    '     stood down. It is not at capacity. It simply does not know."\n'
  );
  row('live agents holding KAN-255', JSON.stringify([OWN].map((a) => `${a.type}/${a.key}`)));
  row('report.pulls.length', report.pulls?.length ?? '(no pulls key)');
  row('pulls[0].liveMergers', JSON.stringify(found?.liveMergers ?? null));
  if (found) console.log(`\n  detail: ${found.detail}`);

  verdict(
    report.answered &&
      report.pulls.length === 1 &&
      JSON.stringify(report.pulls[0].liveMergers) === JSON.stringify(['task/KAN-255']),
    'still reported, with the live agent NAMED rather than filtered out. `liveMergers` is a ' +
      'field on the row, not the predicate that produces it — which is the whole difference ' +
      'between this and the diagnosis KAN-260 was filed with.',
    `got ${report.pulls?.length ?? 0} row(s) and liveMergers=` +
      `${JSON.stringify(found?.liveMergers)}. A report that goes quiet the moment an agent is ` +
      'live has encoded the superseded diagnosis and is green on the case that refuted it.'
  );
}

// ===========================================================================
// 3. THE DISCRIMINATING ARMS — three worlds that must come back CLEAN
// ===========================================================================

rule('§3 — clean: standby with no open PR; open but unapproved; merged. None is a row.');

{
  const cases = [
    {
      what: 'stood-down agent, NO open pull request (only a merged one)',
      world: [prRow({ state: 'MERGED', mergedAt: '2026-08-10T21:00:00Z' })],
      agents: [APPROVER],
      why: 'if this were a row, the signal would just be "standby is bad"'
    },
    {
      what: 'OPEN pull request, stood-down agent, NOBODY has approved it',
      world: [prRow({ statusCheckRollup: UNAPPROVED, mergeStateStatus: 'BLOCKED' })],
      agents: [APPROVER],
      why: 'nothing is stranded — it is waiting on a review, which `green-idle` announces'
    },
    {
      what: 'OPEN, approved, and the agent merged it on the next tick',
      world: null, // driven as a two-world timeline below
      agents: [OWN, APPROVER],
      why: 'the row must disappear when the button is pressed'
    },
    {
      what: 'DRAFT pull request carrying an approval',
      world: [prRow({ isDraft: true })],
      agents: [APPROVER],
      why: 'a draft was never merge-able; `mergeHoldOf` returns null for it'
    }
  ];

  let allClean = true;
  for (const c of cases) {
    const reads =
      c.world === null
        ? [[prRow()], [prRow()], [prRow({ state: 'MERGED', mergedAt: '2026-08-10T21:00:00Z' })]]
        : twice(c.world);
    const { last } = await harness({ reads, agents: c.agents });
    const report = last.strandedMerges;
    const clean = report.answered && report.pulls.length === 0;
    if (!clean) allClean = false;
    row(c.what, clean ? 'clean (0 rows)' : `⚠ ${report.pulls?.length ?? '?'} row(s) — ${c.why}`);
  }

  // The positive control, and it is the point of this section rather than a
  // flourish. Four worlds coming back empty establishes nothing on its own —
  // a report that returns `[]` unconditionally passes every line above. So the
  // SAME harness is run once more on §1's world, and it must NOT be clean.
  const { last: control } = await harness({ reads: twice([prRow()]), agents: [APPROVER] });
  const controlFired = control.strandedMerges.answered && control.strandedMerges.pulls.length === 1;
  row('POSITIVE CONTROL — §1\'s world on this harness', controlFired ? 'FIRES (1 row)' : '⚠ silent');

  verdict(
    allClean && controlFired,
    'all four are clean AND the control fires, so the four zeros are a discrimination rather ' +
      'than a report that never says anything.',
    allClean
      ? 'the four are clean but the control did NOT fire — this harness cannot produce a row at ' +
        'all, so the zeros above measured nothing.'
      : 'a world that is not stranded was reported as stranded.'
  );
}

// ===========================================================================
// 4. AN UNANSWERABLE TICK HAS NO `pulls` KEY AT ALL
// ===========================================================================

rule('§4 — GitHub unreadable: `answered: false`, and no empty list to mistake for a clean fleet');

{
  const { last } = await harness({
    reads: [{ 'wroosbit/butchr': { error: 'tls: failed to verify certificate' } }],
    agents: [APPROVER]
  });
  const report = last.strandedMerges;

  row('report.answered', String(report.answered));
  row("'pulls' in report", String('pulls' in report));
  row('report.scannedRepos', JSON.stringify(report.scannedRepos));
  console.log(`\n  because: ${report.because ?? '(none)'}`);

  // The positive control for the branch itself: the same watcher, a read that
  // succeeds, DOES carry `pulls`. Without this, `'pulls' in report === false`
  // would be satisfied by a build that never emits the key at all.
  const { last: ok } = await harness({ reads: twice([prRow()]), agents: [APPROVER] });
  row('POSITIVE CONTROL — successful tick has `pulls`', String('pulls' in ok.strandedMerges));

  verdict(
    report.answered === false &&
      !('pulls' in report) &&
      typeof report.because === 'string' &&
      report.because.includes('tls: failed to verify certificate') &&
      'pulls' in ok.strandedMerges,
    "the failing branch names the error and carries no `pulls`; the succeeding branch does. " +
      'A reader that forgets to check `answered` cannot reach a list that is not there.',
    `answered=${report.answered}, 'pulls' in report=${'pulls' in report}, ` +
      `because=${JSON.stringify(report.because)}. An unreadable tick that answers with an empty ` +
      'list says "the fleet is clean" in the same bytes as "I could not look".'
  );
}

// ===========================================================================
// 5. AN EMPTY SCOPE IS A COMPLETE ANSWER ABOUT NOTHING, AND SAYS SO
// ===========================================================================

rule('§5 — no repository in the watch set: answered, scannedRepos empty, and the words say why');

{
  const { last, watcher } = await harness({ reads: [[]], agents: [APPROVER], repos: [] });
  const report = last.strandedMerges;
  const sentence = watcher.healthReport().detail;

  row('report.answered', String(report.answered));
  row('report.scannedRepos', JSON.stringify(report.scannedRepos));
  row('report.pulls.length', report.pulls?.length ?? '(no pulls key)');

  verdict(
    report.answered === true && report.scannedRepos.length === 0 && report.pulls.length === 0,
    '`scannedRepos: []` is the positive control on the row: a reader comparing it against the ' +
      'repositories it expected learns the SCOPE was empty, which no count of stranded pull ' +
      'requests could have told it.',
    `answered=${report.answered}, scannedRepos=${JSON.stringify(report.scannedRepos)}. ` +
      'A tick that asked about nothing must not report a clean fleet.'
  );

  // And the sentence a supervisor actually reads must not claim otherwise.
  const claimsClean = /No approved pull request is sitting unmerged in any repository\./.test(sentence);
  console.log(`\n  health.detail: ${sentence}`);
  verdict(
    !claimsClean,
    'the health sentence does not assert a clean fleet from an empty scope.',
    'the health sentence reports "no approved pull request is sitting unmerged in any ' +
      'repository." from a tick that scanned none — the exact collapse §5 exists to prevent.'
  );
}

// ===========================================================================
// 6. IT RIDES THE SENTENCE, NOT ONLY A FIELD
// ===========================================================================

rule('§6 — `health.detail` carries it, so it is not a key you have to know about');

{
  const { watcher } = await harness({ reads: twice([prRow()]), agents: [APPROVER] });
  const sentence = watcher.healthReport().detail;
  console.log(`\n  ${sentence}\n`);

  verdict(
    /APPROVED PULL REQUEST\(S\) HAVE NOT MERGED/.test(sentence) &&
      sentence.includes('wroosbit/butchr#115') &&
      sentence.includes('KAN-255'),
    'the sentence names the pull request and its ticket. The KAN-260 four were missed by a ' +
      'supervisor who was reading this census — for something else. A field nobody knows to ' +
      'ask for would have been missed the same way.',
    'the health sentence does not mention the stranded pull request, so the report is only ' +
      'reachable by a reader who already knows the field exists.'
  );
}

// ===========================================================================
// 7. `waitingMs` IS EITHER MEASURED OR NULL — NEVER A COMFORTABLE ZERO
// ===========================================================================

rule('§7 — the age of an approval: measured when witnessed, NULL when it is not')

{
  let t = Date.parse('2026-08-10T20:00:00Z');
  const clock = () => t;

  const mk = (state, world) =>
    new PrWatcher({
      github: {
        listPullRequests: async (repo) => ({ ok: true, prs: world().map((r) => snapshotFrom(repo, r)) })
      },
      herdrBridge: new Proxy({}, { get: () => () => { throw new Error('TRIP-WIRE'); } }),
      liveAgents: () => [APPROVER],
      issueFacts: () => ({ status: null, parentKey: 'KAN-39', linkedKeys: [] }),
      supervisorFor: () => null,
      repos: () => ['wroosbit/butchr'],
      state,
      deliver: async () => ({ delivered: true, transport: 'channel' }),
      log: () => {},
      now: clock
    });

  // --- (a) THE APPROVAL ARRIVES WHILE WE ARE WATCHING -> the age is measured.
  let world = [prRow({ statusCheckRollup: UNAPPROVED, mergeStateStatus: 'BLOCKED' })];
  const witnessed = mk(new PrWatchState(nextStateFile(), clock), () => world);
  await witnessed.watchOnce();                          // first sight, unapproved
  t += 60_000;
  world = [prRow()];                                    // the approver acts
  await witnessed.watchOnce();                          // WITNESSED: stamped here
  t += 600_000;
  const held = (await witnessed.watchOnce()).strandedMerges.pulls[0];
  row('(a) approval seen to ARRIVE, +600s — waitingMs', String(held?.waitingMs));
  row('(a) approvedAt', String(held?.approvedAt));

  // --- (b) THE HEAD MOVES -> a marker is pinned to a sha, so the clock restarts.
  t += 60_000;
  world = [prRow({ headRefOid: 'c'.repeat(40) })];
  const moved = (await witnessed.watchOnce()).strandedMerges.pulls[0];
  row('(b) after a HEAD CHANGE — waitingMs', String(moved?.waitingMs));

  // --- (c) FIRST SIGHT OF AN ALREADY-APPROVED PULL REQUEST. The daemon restarted
  // and met a verdict it did not see arrive. This is the row that read `0s` until
  // this section went red on the implementation, and 0 is the reassuring answer.
  t += 60_000;
  const restarted = mk(new PrWatchState(nextStateFile(), clock), () => [prRow()]);
  await restarted.watchOnce();                          // first sight, ALREADY approved
  t += 600_000;
  const met = (await restarted.watchOnce()).strandedMerges.pulls[0];
  row('(c) first sight already approved — waitingMs', String(met?.waitingMs));
  row('(c) approvedAt', String(met?.approvedAt));

  // --- (d) A STATE FILE FROM A BUILD THAT DID NOT RECORD IT. Same answer, and it
  // must survive a tick rather than being quietly re-stamped by the next one.
  const legacy = new PrWatchState(nextStateFile(), clock);
  legacy.load();
  legacy.set('wroosbit/butchr#115', {
    state: 'OPEN', reviewDecision: '', approval: 'recorded', checks: 'success',
    mergeStateStatus: 'CLEAN', headRefOid: 'b'.repeat(40), commentIds: [],
    greenIdleSha: '', seenAt: new Date(t).toISOString()
    // no approvedAt — a state file written before this shipped
  });
  const upgraded = mk(legacy, () => [prRow()]);
  t += 600_000;
  const old = (await upgraded.watchOnce()).strandedMerges.pulls[0];
  row('(d) upgraded daemon, no approvedAt — waitingMs', String(old?.waitingMs));
  if (old) console.log(`\n  detail: ${old.detail}`);

  verdict(
    held?.waitingMs === 600_000 &&
      moved?.waitingMs === 0 &&
      met?.waitingMs === null &&
      met?.approvedAt === null &&
      old?.waitingMs === null &&
      /genuinely unknown/.test(old?.detail ?? ''),
    'an age this watcher WITNESSED is measured; a head that moved restarts the clock, because ' +
      'an approval is pinned to a sha; and an approval it merely MET is null with a sentence ' +
      'saying so, never a zero that reads as "approved just now".',
    `(a)=${held?.waitingMs} (want 600000), (b)=${moved?.waitingMs} (want 0), ` +
      `(c)=${met?.waitingMs} (want null), (d)=${old?.waitingMs} (want null). A zero standing in ` +
      'for an unknown age tells a reader the approval has only just landed — the reassuring ' +
      'direction, and the one this report exists to refuse.'
  );
}

// ===========================================================================
// 8. THE CLASSIFIER IS THE ONE `green-idle` USES — NOT A SECOND OPINION
// ===========================================================================

rule('§8 — one classification per snapshot: the two sentences cannot come apart (KAN-339)');

{
  // Every blocker `readinessOf` can return, mapped. This is not a test of the
  // mapping's taste — it is the assertion that the mapping is TOTAL, so a
  // pull request cannot fall out of both populations and be reported by neither.
  const worlds = [
    ['approved + CLEAN', prRow(), 'nobody-has-pressed-it'],
    ['approved + BEHIND', prRow({ mergeStateStatus: 'BEHIND' }), 'the-head-does-not-merge'],
    ['approved + DIRTY', prRow({ mergeStateStatus: 'DIRTY' }), 'the-head-does-not-merge'],
    ['approved + UNKNOWN', prRow({ mergeStateStatus: 'UNKNOWN' }), 'the-head-does-not-merge'],
    ['approved + a check failing', prRow({ statusCheckRollup: [...APPROVED, { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }), 'a-check-is-not-green'],
    ['approved + checks pending', prRow({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'approval-recorded', state: 'SUCCESS' }, { __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS' }] }), 'a-check-is-not-green'],
    ['NOT approved + CLEAN', prRow({ statusCheckRollup: UNAPPROVED }), null],
    ['draft', prRow({ isDraft: true }), null],
    ['merged', prRow({ state: 'MERGED' }), null]
  ];

  let wrong = 0;
  for (const [what, r, want] of worlds) {
    const pr = snapshotFrom('wroosbit/butchr', r);
    const readiness = readinessOf(pr);
    const hold = approvalAtHead(pr) ? mergeHoldOf(readiness) : null;
    const ok = hold === want;
    if (!ok) wrong++;
    row(what, `blocker=${readiness.blocker ?? 'ready'} → hold=${hold ?? 'null'}${ok ? '' : `  ⚠ want ${want}`}`);
  }

  // ⚠ THE BEHIND ROW IS THE ONE THAT MATTERS AND IT IS NOT AN EDGE CASE. Each
  // of the KAN-260 four went BEHIND as `main` moved past it, which is a SECOND
  // reason it could not land. A report narrowed to `nobody-has-pressed-it`
  // would have gone quiet on all four exactly as their situation got worse.
  verdict(
    wrong === 0,
    'every blocker maps, including BEHIND — the state the KAN-260 four decayed into. A report ' +
      'that fell silent there would go quiet as the problem compounded.',
    `${wrong} world(s) classified wrongly. See the ⚠ rows above.`
  );
}

// ===========================================================================

rule(failures ? `FAILED — ${failures} section(s) red` : 'PASSED — all sections green');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failures ? 1 : 0);
