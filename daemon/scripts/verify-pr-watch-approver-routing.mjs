// KAN-600: `pr-watch` routes `green-idle` to the approver the PULL REQUEST
// declares, rather than to the board relation it guesses the approver from.
//
// WHAT FAILURE THIS WOULD CATCH: a pull request going green with its declared
// approver live, idle at a bare prompt, and told nothing — which is what
// `wroosbit/CrabCast#132` did on 2026-08-21. It opened at 15:26:55Z, went green
// at 15:44Z, declared `story/KAN-117` in its `BUTCHR-APPROVER:` line, and the
// watcher logged, verbatim:
//
//     15:44:24  (green-idle): not telling story/KAN-117 (supervisor)
//                             — this relation does not hear this kind
//     15:44:24  (green-idle): telling epic/KAN-59 (parent)
//
// It sat mergeable for about forty minutes until a human-equivalent read found
// it. `green-idle` is the kind KAN-304 built for exactly this — its own words
// were "a green-with-nobody-merging is invisible until a human looks" — so the
// feature failed on its own stated case. §1 reproduces that against a build of
// `origin/main` and §2 shows the same three worlds answered correctly.
//
// It would equally catch the two failures this fix is most likely to commit
// instead: routing `green-idle` at an audience that cannot merge (§4 asserts
// the author is still not told), and turning "the approver is not running" into
// a silence indistinguishable from "the approver was muted" (§3).
//
// CI-RUNNABLE: partial — §2-§6 run anywhere: the GitHub reader is a stub, the
// fleet is invented, and there is no network, no `gh`, no credential and no
// terminal. §1, the red drive, needs a second `dist` built from `origin/main`
// and is SKIPPED — loudly, and saying that its absence makes the run no evidence
// that the defect existed. The recipe is below and its output is pasted in the
// pull request.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// "A proof that supplies its own input has not tested that the input arrives"
// (KAN-145). So, plainly:
//
//   THIS SCRIPT WRITES THE PULL REQUEST SNAPSHOTS IT THEN ASSERTS ON. The
//   `GitHubReader` is a stub and every `declaredApprover` below is a value this
//   file chose. So it establishes that ROUTING reads the declaration correctly
//   and NOT that the declaration arrives from GitHub.
//
//   WHO COVERS THAT INPUT LEG, in two halves and neither of them is this file:
//     - that `gh pr list` returns a body and that `snapshotFrom` parses the
//       declaration out of it: `verify-pr-watch.mjs` §1, which runs the shipped
//       parser over `fixtures/gh-pr-list.json`, plus the live `gh pr list`
//       output pasted in the pull request body with the four real declarations
//       and the measured rate-limit cost of asking for `body` at all;
//     - that this module's grammar agrees with the GATE's grammar about what
//       counts as a declaration: `verify-declared-approver-parity.mjs`, which
//       drives both implementations over one corpus.
//
//   WHAT NEITHER COVERS: that a routed frame reaches a MODEL. Unchanged from
//   KAN-304 — C3 is not observable on this carrier (`message-claims.ts`).
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-pr-watch-approver-routing.mjs
//
//   # with the red drive of §1, built where node_modules still resolves:
//   cp src/pr-watch.ts /tmp/kan600-pr-watch.ts
//   cp src/github.ts   /tmp/kan600-github.ts
//   git show origin/main:daemon/src/pr-watch.ts > src/pr-watch.ts
//   git show origin/main:daemon/src/github.ts   > src/github.ts
//   npx tsc --outDir dist-unfixed
//   cp /tmp/kan600-pr-watch.ts src/pr-watch.ts
//   cp /tmp/kan600-github.ts   src/github.ts
//   npm run build
//   node scripts/verify-pr-watch-approver-routing.mjs dist dist-unfixed

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', process.argv[2] ?? 'dist');
const unfixedDistDir = process.argv[3] ? path.resolve(scriptDir, '..', process.argv[3]) : null;

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const row = (label, value) => console.log(`  ${String(label).padEnd(52)} ${value}`);
const verdict = (ok, yes, no) => {
  if (!ok) failures++;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan600-'));
// `ipc.ts` computes BUTCHR_DIR from os.homedir() at module load, and both the
// channel kill switch and the watcher's state file live inside it. Set BEFORE
// the product is imported, or this proof writes the live fleet's state and
// flips every running agent off channels for as long as it takes to run.
process.env.HOME = TMP;

const loadFrom = (dir, mod) => import(path.join(dir, mod));
const { PrWatcher, PrWatchState } = await loadFrom(distDir, 'pr-watch.js');
const { snapshotFrom } = await loadFrom(distDir, 'github.js');
const { declaredApproverOf } = await loadFrom(distDir, 'declared-approver.js');
const { PendingNotifications, channelNotifier } = await loadFrom(distDir, 'notify.js');
const { routeChannelMessage, writeChannelSwitch, CHANNEL_SWITCH_PATH } =
  await loadFrom(distDir, 'channel.js');
const { AgentConnectionRegistry } = await loadFrom(distDir, 'agent-connections.js');

if (!CHANNEL_SWITCH_PATH.startsWith(TMP)) {
  console.error(
    `REFUSING TO RUN: the channel switch resolved to ${CHANNEL_SWITCH_PATH}, outside this ` +
    `proof's private HOME (${TMP}). Writing it would take the live fleet off channels.`
  );
  process.exit(1);
}
writeChannelSwitch(true);

/** A herdr that CANNOT be typed at: every method throws with a named stack. */
const tripWireHerdr = new Proxy(
  {},
  {
    get: (_t, prop) => () => {
      throw new Error(
        `TRIP-WIRE: the PR watcher reached herdr.${String(prop)}() — a notification tried to ` +
        'type at a terminal. KAN-301 removed that practice and KAN-600 must not restore it.'
      );
    }
  }
);

const openChannels = [];
async function realChannel(agents) {
  const sockDir = fs.mkdtempSync(path.join(TMP, 'chan-'));
  const sockPath = path.join(sockDir, 'test.sock');
  const registry = new AgentConnectionRegistry();
  const written = [];
  const serverSide = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    serverSide.push(socket);
  });
  await new Promise((res) => server.listen(sockPath, res));

  const clients = [];
  for (const address of agents) {
    const client = net.createConnection(sockPath);
    client.on('error', () => {});
    await new Promise((res) => client.once('connect', res));
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) written.push({ address: `${address.type}/${address.key}`, ...JSON.parse(line) });
      }
    });
    clients.push(client);
    await new Promise((res) => setTimeout(res, 20));
    registry.register(serverSide[serverSide.length - 1], address);
  }

  const channel = {
    written,
    close: () => {
      for (const c of clients) c.destroy();
      for (const s of serverSide) s.destroy();
      server.close();
    },
    route: (address, content) =>
      routeChannelMessage({
        registry,
        address,
        content,
        meta: { sender: '[butchr daemon]', workspaceType: address.type, workspaceKey: address.key },
        managed: () => true
      })
  };
  openChannels.push(channel);
  return channel;
}

const settle = () => new Promise((res) => setTimeout(res, 60));
let stateFiles = 0;
const nextStateFile = () => path.join(TMP, `pr-watch-${++stateFiles}.json`);

/** One pull request, with only the fields a case actually varies spelled out. */
const pr = (over = {}) => ({
  repo: 'wroosbit/CrabCast',
  number: 132,
  title: 'KAN-518: the thing',
  url: 'https://github.com/wroosbit/CrabCast/pull/132',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'butchr/KAN-518',
  headRefOid: 'a'.repeat(40),
  mergedAt: null,
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  checks: 'pending',
  failingChecks: [],
  approval: 'not-recorded',
  commentIds: [],
  declaredApprover: null,
  ...over
});

/**
 * A watcher wired to the real carrier, a stub GitHub and a herdr that bites.
 *
 * `WatcherCtor` is a parameter so §1 can drive `origin/main`'s watcher through
 * the identical harness — same worlds, same fleet, same carrier, one module
 * different. That is what makes §1 a measurement of the routing rule rather
 * than of two differently-written proofs.
 */
async function harness({ WatcherCtor, StateCtor, reads, agents, facts, supervisors = {} }) {
  const channel = await realChannel(agents.map(({ type, key }) => ({ type, key })));
  const pending = new PendingNotifications({ log: () => {} });
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));

  let tickIndex = 0;
  const watcher = new WatcherCtor({
    github: {
      listPullRequests: async () => {
        const read = reads[Math.min(tickIndex, reads.length - 1)];
        return { ok: true, prs: read };
      }
    },
    herdrBridge: tripWireHerdr,
    liveAgents: () => agents,
    issueFacts: (key) =>
      facts[key] ?? { status: { value: 'In Review', observedAt: new Date().toISOString() }, parentKey: null, linkedKeys: [] },
    supervisorFor: (agentName) => supervisors[agentName] ?? null,
    repos: () => ['wroosbit/CrabCast'],
    state: new StateCtor(nextStateFile(), () => Date.now()),
    deliver: channelNotifier({ route: channel.route, pending }),
    log
  });

  const ticks = [];
  for (let i = 0; i < reads.length; i++) {
    tickIndex = i;
    ticks.push(await watcher.watchOnce());
    await settle();
  }
  return { watcher, ticks, channel, logs };
}

/** Who a tick told, as `type/KEY(audience) ← kinds`. */
const notified = (tick) =>
  tick.notices.map((n) => `${n.type}/${n.key}(${n.relation}) ← ${n.events.map((e) => e.kind).join('+')}`);

/** Who was told about `green-idle`, as bare `type/KEY`. */
const toldGreenIdle = (tick) =>
  tick.notices
    .filter((n) => n.events.some((e) => e.kind === 'green-idle'))
    .map((n) => `${n.type}/${n.key}`);

// ===========================================================================
// The three declared-approver shapes, measured on 2026-08-21 and reproduced.
// ===========================================================================
//
// AC2: "a fix that only handles `parent` passes a one-case test and leaves
// c#132's shape broken." So all four worlds below run through every section,
// and PARENT is kept as the control — the shape that already worked and must go
// on working.
//
// SHAPE `own` IS GOVERNANCE-IRREGULAR AND IS EXERCISED ANYWAY, said out loud.
// `approval-marker.mjs` refuses a pull request that declares its own ticket's
// agent — an agent does not approve its own work — so no legitimate PR has this
// shape and none ever should. It is here because the ticket named it and
// because the property under test is that routing does not depend on WHICH
// board relation the declaration lands on. A rule that special-cases three
// relations and not the fourth is the rule this ticket is about, one relation
// over.
const AGENTS = {
  ownTask: { agentName: 'task-kan-518', type: 'task', key: 'KAN-518' },
  story: { agentName: 'story-kan-117', type: 'story', key: 'KAN-117' },
  parentEpic: { agentName: 'epic-kan-59', type: 'epic', key: 'KAN-59' },
  strangerEpic: { agentName: 'epic-kan-39', type: 'epic', key: 'KAN-39' }
};

const FLEET = Object.values(AGENTS);

const FACTS = {
  'KAN-518': {
    status: { value: 'In Review', observedAt: new Date().toISOString() },
    parentKey: 'KAN-59',
    linkedKeys: []
  }
};

// `story/KAN-117` activated the agent working KAN-518 — which is what puts it on
// the `supervisor` relation, and is exactly c#132's real topology.
const SUPERVISORS = { 'task-kan-518': { type: 'story', key: 'KAN-117' } };

const SHAPES = [
  {
    name: 'parent',
    declared: 'epic/KAN-59',
    expect: AGENTS.parentEpic,
    note: 'the ticket’s own parent epic — the shape that already worked (b#266, c#133)'
  },
  {
    name: 'supervisor',
    declared: 'story/KAN-117',
    expect: AGENTS.story,
    note: 'the supervisor of the agent that opened it — c#132, the measured stall'
  },
  {
    name: 'own',
    declared: 'task/KAN-518',
    expect: AGENTS.ownTask,
    note: 'the branch’s own agent — irregular, refused by the gate, exercised anyway'
  },
  {
    name: 'no board relation',
    declared: 'epic/KAN-39',
    expect: AGENTS.strangerEpic,
    note: 'an epic in a different project from the repository — c#127’s shape'
  }
];

/** Two ticks: pending, then green. The second is where `green-idle` is born. */
const pendingThenGreen = (declared) => [
  [pr({ checks: 'pending', declaredApprover: declared })],
  [pr({ checks: 'success', declaredApprover: declared })]
];

async function routeShape(dir, declared) {
  const { PrWatcher: W, PrWatchState: S } = await loadFrom(dir, 'pr-watch.js');
  return harness({
    WatcherCtor: W,
    StateCtor: S,
    reads: pendingThenGreen(declared),
    agents: FLEET,
    facts: FACTS,
    supervisors: SUPERVISORS
  });
}

// ===========================================================================
// 1. RED — the same four worlds against origin/main's routing
// ===========================================================================

rule('1. UNFIXED — origin/main routes `green-idle` by board relation');

if (!unfixedDistDir) {
  console.log(
    '\n  SKIPPED: no baseline dist supplied. This section is the red drive — without it the\n' +
    '  rest of this file only proves that the new rule does what it says, never that the old\n' +
    '  one did not. The recipe is in the header and its output is pasted in the pull request.\n' +
    '  A run without it is NOT evidence that the defect existed.'
  );
} else {
  const results = [];
  for (const shape of SHAPES) {
    const { ticks, logs } = await routeShape(unfixedDistDir, shape.declared);
    const told = toldGreenIdle(ticks[1]);
    results.push({ shape, told, logs: logs.filter((l) => l.includes('green-idle')) });
  }
  console.log('');
  for (const { shape, told } of results) {
    row(
      `declares ${shape.declared.padEnd(14)} (${shape.name})`,
      told.length ? `green-idle → ${told.join(', ')}` : 'green-idle → NOBODY'
    );
  }
  console.log('\n  and what origin/main logged about the approver it did not tell:\n');
  for (const { shape, logs } of results) {
    for (const line of logs) {
      if (line.includes('not telling')) console.log(`    [${shape.name}] ${line.trim()}`);
    }
  }

  // The measurement: on origin/main every shape is routed to the board parent,
  // so three of the four reach an agent that the pull request did not name.
  const wrongOnes = results.filter(
    ({ shape, told }) => !told.includes(`${shape.expect.type}/${shape.expect.key}`)
  );
  const parentAlwaysTold = results.every(({ told }) => told.includes('epic/KAN-59'));
  console.log('');
  row('shapes whose declared approver was NOT told', `${wrongOnes.length} of ${SHAPES.length}`);
  row('every shape was routed to the board parent instead', parentAlwaysTold ? 'yes' : 'no');
  verdict(
    wrongOnes.length === 3 && parentAlwaysTold,
    'origin/main routes every shape to the board parent, so three of the four declared ' +
      'approvers — including c#132’s live, idle `story/KAN-117` — are told nothing. This is ' +
      'the red the fix has to turn.',
    `expected exactly 3 unrouted shapes all falling through to the board parent; got ` +
      `${wrongOnes.length} unrouted, parentAlwaysTold=${parentAlwaysTold}`
  );
}

// ===========================================================================
// 2. GREEN — the declared approver is told, in all four shapes (AC1, AC2)
// ===========================================================================

rule('2. FIXED — `green-idle` goes to the approver the pull request declares');

{
  const results = [];
  for (const shape of SHAPES) {
    const { ticks, channel } = await routeShape(distDir, shape.declared);
    results.push({ shape, told: toldGreenIdle(ticks[1]), notices: notified(ticks[1]), channel });
  }
  console.log('');
  for (const { shape, told, notices } of results) {
    row(`declares ${shape.declared.padEnd(14)} (${shape.name})`, `green-idle → ${told.join(', ') || 'NOBODY'}`);
    row('', `all notices: ${notices.join('  |  ') || '(none)'}`);
  }

  const eachToldItsOwn = results.every(({ shape, told }) =>
    told.length === 1 && told[0] === `${shape.expect.type}/${shape.expect.key}`
  );
  const alwaysLabelledApprover = results.every(({ ticks, notices }) =>
    notices.filter((n) => n.includes('green-idle')).every((n) => n.includes('(approver)'))
  );

  // The frame that actually came off the far end of a socket, for the shape the
  // ticket was filed about. `transport` here is the product's verdict, not a
  // literal written in this file.
  const c132 = results.find((r) => r.shape.name === 'supervisor');
  const frame = c132.channel.written.find((w) => w.address === 'story/KAN-117');
  console.log('');
  row('c#132’s shape — frame delivered to story/KAN-117', frame ? 'yes' : 'NO FRAME');
  if (frame) {
    const text = JSON.stringify(frame).replace(/\\n/g, ' ');
    row('  it names the declaration rather than a relation', /BUTCHR-APPROVER/.test(text) ? 'yes' : 'no');
    console.log(`\n    ${text.slice(0, 700)}${text.length > 700 ? '…' : ''}`);
  }

  console.log('');
  verdict(
    eachToldItsOwn && alwaysLabelledApprover && !!frame && /BUTCHR-APPROVER/.test(JSON.stringify(frame)),
    'all four declared-approver shapes route `green-idle` to exactly the declared agent, ' +
      'addressed as `approver`, and the frame says which line made it the audience',
    `eachToldItsOwn=${eachToldItsOwn} labelledApprover=${alwaysLabelledApprover} frame=${!!frame}`
  );
}

// ===========================================================================
// 3. Muted by rule versus undeliverable (AC3)
// ===========================================================================

rule('3. The log says WHICH rule applied — muted by rule is not undeliverable');

{
  // (a) A live declared approver: everybody else is MUTED, and the line says so.
  const live = await routeShape(distDir, 'story/KAN-117');
  const mutedLines = live.logs.filter((l) => l.includes('MUTED BY RULE'));
  const toldLine = live.logs.find((l) => l.includes('telling story/KAN-117'));

  // (b) The declared approver is NOT in the census. Nothing routes to it, and
  //     that is a different fact from a mute — this is the state `#271` was in
  //     on this machine at 20:32:26Z on 2026-08-21.
  const absent = await harness({
    WatcherCtor: PrWatcher,
    StateCtor: PrWatchState,
    reads: pendingThenGreen('epic/KAN-999'),
    agents: FLEET,
    facts: FACTS,
    supervisors: SUPERVISORS
  });
  const undeliverableLine = absent.logs.find((l) => l.includes('UNDELIVERABLE'));
  const fellBack = toldGreenIdle(absent.ticks[1]);

  console.log('');
  row('live approver — lines saying MUTED BY RULE', mutedLines.length);
  if (mutedLines[0]) console.log(`\n    ${mutedLines[0].trim()}`);
  if (toldLine) console.log(`    ${toldLine.trim()}`);
  console.log('');
  row('absent approver — an UNDELIVERABLE line', undeliverableLine ? 'yes' : 'NO');
  if (undeliverableLine) console.log(`\n    ${undeliverableLine.trim()}`);
  row('and it falls back to the board relation', fellBack.join(', ') || 'NOBODY');

  const skips = absent.ticks[1].skipped;
  const dispositions = [...new Set(skips.map((s) => s.disposition))].sort();
  const rules = [...new Set(absent.ticks[1].skipped.map((s) => s.rule))];
  row('skipped[].disposition values on the absent tick', dispositions.join(', ') || '(none)');
  row('skipped[].rule values on the absent tick', rules.join(', ') || '(none)');

  const mutedNamesTheRule = mutedLines.every((l) => /under `declared-approver`/.test(l));
  const toldNamesTheRule = !!toldLine && /routed by declared-approver/.test(toldLine);
  const undeliverableNamesTheAgent =
    !!undeliverableLine && undeliverableLine.includes('epic/KAN-999');
  const wordsAreDistinct =
    mutedLines.every((l) => !l.includes('UNDELIVERABLE')) &&
    !!undeliverableLine &&
    !undeliverableLine.includes('MUTED BY RULE');

  console.log('');
  verdict(
    mutedLines.length > 0 &&
      mutedNamesTheRule &&
      toldNamesTheRule &&
      undeliverableNamesTheAgent &&
      wordsAreDistinct &&
      fellBack.includes('epic/KAN-59') &&
      rules.includes('declared-approver-not-live'),
    'a mute names the rule that muted it, an unreachable approver is reported as ' +
      'UNDELIVERABLE and by name, the two never share a sentence, and an unreachable ' +
      'declaration falls back to the board relation rather than to silence',
    `muted=${mutedLines.length} mutedNamesRule=${mutedNamesTheRule} told=${toldNamesTheRule} ` +
      `undeliverable=${undeliverableNamesTheAgent} distinct=${wordsAreDistinct} ` +
      `fellBackTo=${fellBack.join(',')}`
  );
}

// ===========================================================================
// 4. What did NOT widen — the author is still not told, and `approved` moved
// ===========================================================================

rule('4. The author is still not told green-idle; `approved` mutes the declared approver');

{
  // The ticket's task 2 — "route green-idle to own and supervisor as well" — is
  // REFUSED, and this is the assertion that keeps the refusal true. The one
  // thing a PR author can do with "green and nobody has looked" is press merge
  // without an approval, which is what `task/KAN-226` did on #92 five minutes
  // after CI went green.
  const { ticks } = await routeShape(distDir, 'story/KAN-117');
  const green = ticks[1];
  const toldNames = toldGreenIdle(green);

  // And the other half of the same correction: `approved` used to be muted for
  // the board `parent` on the assumption that the parent is the approver. It is
  // now muted for the agent that actually is one — so the parent, who is NOT the
  // approver here, now hears about the approval it did not give.
  const approvedReads = [
    [pr({ checks: 'success', approval: 'not-recorded', declaredApprover: 'story/KAN-117' })],
    [pr({ checks: 'success', approval: 'recorded', declaredApprover: 'story/KAN-117' })]
  ];
  const app = await harness({
    WatcherCtor: PrWatcher,
    StateCtor: PrWatchState,
    reads: approvedReads,
    agents: FLEET,
    facts: FACTS,
    supervisors: SUPERVISORS
  });
  const approvedTold = app.ticks[1].notices
    .filter((n) => n.events.some((e) => e.kind === 'approved'))
    .map((n) => `${n.type}/${n.key}`);

  console.log('');
  row('green-idle recipients (declared: story/KAN-117)', toldNames.join(', '));
  row('the pull request’s own agent among them', toldNames.includes('task/KAN-518') ? 'YES' : 'no');
  console.log('');
  row('approved recipients (declared: story/KAN-117)', approvedTold.join(', ') || '(none)');
  row('the declared approver among them', approvedTold.includes('story/KAN-117') ? 'YES' : 'no');
  row('the board parent among them', approvedTold.includes('epic/KAN-59') ? 'yes' : 'no');

  console.log('');
  verdict(
    toldNames.length === 1 &&
      toldNames[0] === 'story/KAN-117' &&
      !approvedTold.includes('story/KAN-117') &&
      approvedTold.includes('epic/KAN-59') &&
      approvedTold.includes('task/KAN-518'),
    'green-idle stays a one-agent event and that agent is the declared approver; an approval ' +
      'is muted for the agent that gave it and reaches the board parent it used to be ' +
      'withheld from',
    `greenIdle=${toldNames.join(',')} approved=${approvedTold.join(',')}`
  );
}

// ===========================================================================
// 5. First sight — a new REPOSITORY is backlog, a new PULL REQUEST is news
// ===========================================================================

rule('5. First sight: the backlog rule is about the repository, not the pull request');

{
  // (a) A repository this watcher has never read. Its forty rows are history and
  //     an already-green one must NOT announce — KAN-367's defect.
  const cold = await harness({
    WatcherCtor: PrWatcher,
    StateCtor: PrWatchState,
    reads: [
      [pr({ checks: 'success', declaredApprover: 'story/KAN-117' })],
      [pr({ checks: 'success', declaredApprover: 'story/KAN-117' })]
    ],
    agents: FLEET,
    facts: FACTS,
    supervisors: SUPERVISORS
  });

  // (b) The same watcher, same repository, already holding a pull request — and
  //     a SECOND one opens, already green. That is not backlog; it is the case
  //     that produced c#132.
  const warm = await harness({
    WatcherCtor: PrWatcher,
    StateCtor: PrWatchState,
    reads: [
      [pr({ number: 100, headRefName: 'butchr/KAN-518', checks: 'success', declaredApprover: 'story/KAN-117' })],
      [
        pr({ number: 100, headRefName: 'butchr/KAN-518', checks: 'success', declaredApprover: 'story/KAN-117' }),
        pr({ number: 132, checks: 'success', declaredApprover: 'story/KAN-117' })
      ],
      [
        pr({ number: 100, headRefName: 'butchr/KAN-518', checks: 'success', declaredApprover: 'story/KAN-117' }),
        pr({ number: 132, checks: 'success', declaredApprover: 'story/KAN-117' })
      ]
    ],
    agents: FLEET,
    facts: FACTS,
    supervisors: SUPERVISORS
  });

  const coldEverAnnounced = cold.ticks.some((t) => toldGreenIdle(t).length > 0);
  const warmTick2 = toldGreenIdle(warm.ticks[2]);
  const warmNewPrOnly = warm.ticks[2].notices
    .filter((n) => n.events.some((e) => e.kind === 'green-idle'))
    .every((n) => n.events.every((e) => e.number === 132));

  console.log('');
  row('cold repository — green-idle ever announced', coldEverAnnounced ? 'YES' : 'no');
  row('warm repository — #132 opens green, then', warmTick2.join(', ') || 'NOBODY');
  row('and only for the pull request that just opened', warmNewPrOnly ? 'yes' : 'no');
  for (const line of warm.logs.filter((l) => l.includes('first sight'))) {
    console.log(`\n    ${line.trim()}`);
  }

  console.log('');
  verdict(
    !coldEverAnnounced && warmTick2.includes('story/KAN-117') && warmNewPrOnly,
    'a repository joining the watch set announces none of its history, and a pull request ' +
      'opened under a watcher that was already reading that repository is announced — the ' +
      'no-replay guarantee kept, and the case it was never about handed back',
    `coldAnnounced=${coldEverAnnounced} warm=${warmTick2.join(',')} onlyNew=${warmNewPrOnly}`
  );
}

// ===========================================================================
// 6. The grammar — a body that SHOWS the line has not said it
// ===========================================================================

rule('6. A demonstration of the convention is not a declaration of an approver');

{
  const cases = [
    ['a plain line', 'BUTCHR-APPROVER: epic/KAN-39', 'epic/KAN-39'],
    ['a line among prose', 'Fixes KAN-1.\n\nBUTCHR-APPROVER: story/KAN-117\n\ncheers', 'story/KAN-117'],
    ['inside a fenced block', '```\nBUTCHR-APPROVER: epic/KAN-39\n```', null],
    ['inside a ~~~ fence', '~~~text\nBUTCHR-APPROVER: epic/KAN-39\n~~~', null],
    ['quoted with >', '> BUTCHR-APPROVER: epic/KAN-39', null],
    ['indented four spaces', '    BUTCHR-APPROVER: epic/KAN-39', null],
    ['hidden in an HTML comment', '<!--\nBUTCHR-APPROVER: epic/KAN-39\n-->', null],
    [
      'an EXAMPLE above the real one',
      'Write it like this:\n\n```\nBUTCHR-APPROVER: epic/KAN-39\n```\n\nBUTCHR-APPROVER: story/KAN-117',
      'story/KAN-117'
    ],
    ['no declaration at all', 'Fixes KAN-1. Nothing to see.', null]
  ];

  console.log('');
  let wrong = 0;
  for (const [name, body, want] of cases) {
    const got = declaredApproverOf(body);
    const ok = got === want;
    if (!ok) wrong++;
    row(`${ok ? ' ' : '✗'} ${name}`, `${JSON.stringify(got)}  (want ${JSON.stringify(want)})`);
  }

  // And through the shipped snapshot parser, which is the path a real read takes.
  const throughSnapshot = snapshotFrom('wroosbit/CrabCast', {
    number: 132,
    headRefName: 'butchr/KAN-518',
    state: 'OPEN',
    body: 'Fixes KAN-518.\n\nBUTCHR-APPROVER: story/KAN-117\n'
  });
  const noBody = snapshotFrom('wroosbit/CrabCast', { number: 133, headRefName: 'butchr/KAN-519', state: 'OPEN' });
  console.log('');
  row('snapshotFrom carries the declaration through', JSON.stringify(throughSnapshot.declaredApprover));
  row('a row with no `body` at all', JSON.stringify(noBody.declaredApprover));

  console.log('');
  verdict(
    wrong === 0 &&
      throughSnapshot.declaredApprover === 'story/KAN-117' &&
      noBody.declaredApprover === null,
    'only an asserted line declares an approver, an example above a real declaration does ' +
      'not win, and a row GitHub returned without a body declares nobody rather than throwing',
    `${wrong} grammar case(s) wrong; snapshot=${throughSnapshot.declaredApprover}, ` +
      `noBody=${noBody.declaredApprover}`
  );
}

for (const c of openChannels) c.close();
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

rule(failures === 0 ? 'ALL SECTIONS PASSED' : `${failures} SECTION(S) FAILED`);
if (!unfixedDistDir) {
  console.log(
    '  NOTE: §1, the red drive, was SKIPPED. Everything above establishes that the new rule\n' +
    '  behaves as described and NOTHING about whether the old one misbehaved. The pull\n' +
    '  request carries a run with the baseline dist supplied.'
  );
}
console.log(
  '  `green-idle` is routed to the approver the pull request declares, whatever board relation\n' +
  '  that agent holds and whether or not it holds one. Nothing here typed at a terminal: the\n' +
  '  herdr handed to the watcher throws on every method, so a composer reach would have ended\n' +
  '  this run rather than passed it.'
);

process.exit(failures ? 1 : 0);
