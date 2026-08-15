// The startup channel self-check: every outcome it can reach, the fallback it
// actually enforces, and the row a supervisor reads it off — driven against the
// SHIPPED decision procedure on a scripted world.
//
// WHAT FAILURE THIS WOULD CATCH: an agent whose channel loop is broken being
// used as though it were not — messages routed over a channel that proved
// nothing, with `butchr_list_agents` reporting a fleet that is fine. That is the
// silent state KAN-248 exists to prevent, and it has three separate ways to
// arrive, each of which looks like success from outside:
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
//   1. **A verdict that is reported and not enforced.** The row says
//      `transport: composer` and `routeChannelMessage` keeps writing frames to
//      the agent anyway, because the gate was never asked. The listing would be
//      honest and the fleet would still be broken — this epic's recurring defect
//      exactly, an artifact whose sentence claims more than its mechanism covers.
//      Section 4 asks the real `routeChannelMessage`, with a real
//      `AgentConnectionRegistry` and a real `ChannelSelfCheckStore`.
//   2. **Unchecked collapsed into failed, or failed into unchecked.** The first
//      takes the whole fleet off channels on every daemon restart; the second
//      leaves a degraded agent routing. Sections 1, 4 and 5 hold the two apart
//      at the store, at the gate and on the wire.
//   3. **A failure that loses the client version.** A `no-answer` on a client
//      nobody has measured is a different investigation from the same failure on
//      one that has been, and the field that tells them apart is the one most
//      likely to be dropped on the failure path. Section 1 asserts the version
//      survives every outcome that learned it.
//
// It also covers the two orderings the whole thing rests on: the answer is armed
// BEFORE the probe frame is written (section 2 — a sub-millisecond loopback round
// trip makes the other order a real race, not a theoretical one), and a verdict
// is dropped by CONNECTION ID rather than by address (section 3 — releasing by
// address would delete the verdict of an agent that reconnected before its old
// socket's close fired, which is agent-connections.ts decision 3's bug
// reintroduced one map over).
//
// ---------------------------------------------------------------------------
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), and this one supplies the whole outside world: the acks, the
// connections, the clock. **Nothing here proves that a real Claude Code answers
// a real ping behind a real notification, or that a real `mcp.js` reports a real
// `clientInfo.version`** — those are facts about a client, and no deterministic
// harness can hold one.
//
// WHO COVERS THAT: `probe-channel-selfcheck.mjs`, which activates a real agent
// through the shipped launcher and reads the verdict out of `list_agents`, and
// whose output is pasted in the KAN-248 pull request. Sections 3, 4 and 5 here
// are deliberately built the other way — real `ChannelSelfCheckStore`, real
// `routeChannelMessage`, real `AgentConnectionRegistry`, real `MessageRouter` —
// so the decisions they assert are made by the code that makes them in
// production rather than by a harness that agrees with it.
//
// AND WHAT NEITHER COVERS, SAID HERE BECAUSE IT IS THE HONEST EDGE OF THE WHOLE
// TICKET: no script and no probe can detect a client that READ the frame and
// silently declined the channel. That decision is never told to the server —
// measured, not assumed: the client's `initialize` is byte-identical with and
// without `--dangerously-load-development-channels`. The version pin is what
// stands in for it. See the header of `daemon/src/channel-selfcheck.ts`.
//
// ---------------------------------------------------------------------------
// THE FLEET'S CHANNEL SWITCH IS NEVER READ AND NEVER WRITTEN
// ---------------------------------------------------------------------------
// Section 4 needs channel emission ON, and the switch is a file under
// `os.homedir()`. So `HOME` is relocated to a scratch directory BEFORE the build
// is imported, and the guard below aborts if `CHANNEL_SWITCH_PATH` does not then
// land inside it. Turning the fleet's switch on would put a blocking dialog in
// front of every activation on this machine; a guard that asserts where the file
// is beats a comment promising it.
//
// Usage: node daemon/scripts/verify-channel-selfcheck.mjs [--blind]
//
//   --blind   patch a COPY of the build so a failed check no longer degrades the
//             transport, and watch this proof go red. A gate nobody has seen
//             fail has not been shown to be a gate.
//
// Run it after `npm run build` in daemon/.

import path from 'path';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(daemonDir, '..');
const blind = process.argv.includes('--blind');

const dist = path.join(daemonDir, 'dist');
if (!existsSync(path.join(dist, 'channel-selfcheck.js'))) {
  console.error('daemon/dist/channel-selfcheck.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-selfcheck-'));

// BEFORE ANY IMPORT. `ipc.ts` computes BUTCHR_DIR from `os.homedir()` at module
// load, and `os.homedir()` reads $HOME, so this has to happen while the build is
// still unloaded. Everything the switch, the log and the registry touch now
// lives under `scratch`.
const fakeHome = path.join(scratch, 'home');
mkdirSync(path.join(fakeHome, '.local', 'share', 'butchr'), { recursive: true });
process.env.HOME = fakeHome;

// ONLY THE MODULE UNDER TEST IS SWAPPED, and the rest of the build is the real
// one. A wholesale copy of `dist` into /tmp cannot resolve `node_modules` —
// `router.js` and `herdr.js` reach for real packages — and symlinking them in
// would put a second, subtly different tree in front of every import. It is also
// unnecessary: `routeChannelMessage` and the router take the verdicts as
// PARAMETERS, so a patched `channel-selfcheck.js` reaches them through the store
// and the reports this script hands over. The gate and the listing being real is
// the whole point of sections 4 and 5, and this keeps them real under `--blind`.
let selfCheckModule = path.join(dist, 'channel-selfcheck.js');

if (blind) {
  const patchedDir = path.join(scratch, 'dist');
  cpSync(dist, patchedDir, { recursive: true });
  const target = path.join(patchedDir, 'channel-selfcheck.js');
  selfCheckModule = target;
  const source = readFileSync(target, 'utf8');
  // THE DEFECT, INTRODUCED DELIBERATELY: a failed self-check that still leaves
  // the agent on the channel. Every outcome maps to `channel`, so the check
  // still runs, still logs, still fills in a row — and changes nothing. That is
  // precisely "reported but not enforced", and it is the failure mode that would
  // survive a proof which only inspected the report.
  const patched = source.replace(
    /export function transportFor\(outcome\) \{[\s\S]*?\n\}/,
    'export function transportFor(outcome) {\n    return \'channel\';\n}'
  );
  if (patched === source) {
    console.error('--blind could not find transportFor to patch; the build has moved.');
    process.exit(2);
  }
  writeFileSync(target, patched);
  console.log('--blind: patched a copy of the build so a failed self-check no longer degrades.\n');
}

const u = (f) => `file://${path.join(dist, f)}`;

const {
  ChannelSelfCheckAckRegistry,
  ChannelSelfCheckStore,
  VERIFIED_CLIENT_VERSIONS,
  runChannelSelfCheck,
  transportFor
} = await import(`file://${selfCheckModule}`);
const { AgentConnectionRegistry } = await import(u('agent-connections.js'));
const { CHANNEL_SWITCH_PATH, routeChannelMessage, writeChannelSwitch } = await import(u('channel.js'));
const { MessageRouter } = await import(u('router.js'));
const { WorkspaceRegistry } = await import(u('registry.js'));
const { PromptLoader } = await import(u('prompt.js'));
const { HerdrBridge } = await import(u('herdr.js'));

// THE GUARD THE HEADER PROMISES. If a future change to how BUTCHR_DIR is
// resolved stopped honouring $HOME, this script would silently start writing the
// real fleet's kill switch — turning channels on for every agent on the machine.
// Asserted rather than trusted.
if (!CHANNEL_SWITCH_PATH.startsWith(scratch)) {
  console.error(
    `ABORTING: the channel switch resolved to ${CHANNEL_SWITCH_PATH}, which is OUTSIDE this\n` +
    `script's scratch directory (${scratch}). Writing it would change the REAL fleet's\n` +
    `channel state. Relocating $HOME no longer isolates BUTCHR_DIR; fix that before this runs.`
  );
  process.exit(2);
}

let failures = 0;
const say = (s = '') => process.stdout.write(`${s}\n`);
const rule = (title) => say(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) say(`        ${detail}`);
  return ok;
};

const ADDRESS = { type: 'task', key: 'KAN-248' };
const VERIFIED_VERSION = VERIFIED_CLIENT_VERSIONS[VERIFIED_CLIENT_VERSIONS.length - 1];
const UNMEASURED_VERSION = '9.9.999';

/**
 * A world for one run of the check, plus a record of what it was asked.
 *
 * `ack` is what the agent answers, or `null` for "never answered". Everything
 * else defaults to the working case, so each scenario below states only its own
 * deviation and a reader can see what is being varied.
 */
function world({
  emission = true,
  connection = { id: 'conn-1' },
  writeOk = true,
  ack = {
    emitted: true,
    pingAnswered: true,
    clientName: 'claude-code',
    clientVersion: VERIFIED_VERSION,
    clientCapabilities: ['elicitation', 'roots'],
    agentElapsedMs: 4
  }
} = {}) {
  const calls = [];
  let clock = 1_770_000_000_000;
  return {
    calls,
    logs: [],
    nonces: { armed: [], written: [] },
    get world() {
      const self = this;
      return {
        emissionEnabled: () => {
          calls.push('emissionEnabled');
          return emission;
        },
        resolveConnection: () => {
          calls.push('resolveConnection');
          return connection;
        },
        expectAck: (nonce) => {
          calls.push('expectAck');
          self.nonces.armed.push(nonce);
          return Promise.resolve(ack === null ? null : { nonce, ...ack });
        },
        writeProbe: (nonce) => {
          calls.push('writeProbe');
          self.nonces.written.push(nonce);
          return writeOk;
        },
        now: () => (clock += 3),
        log: (m) => self.logs.push(m)
      };
    }
  };
}

const run = (opts = {}, extra = {}) => {
  const w = world(opts);
  return runChannelSelfCheck({ address: ADDRESS, world: w.world, ...extra }).then((report) => ({
    report,
    w
  }));
};

// ------------------------------------- 1. every outcome the check can reach --

rule('1. Every outcome, and the transport each one implies');

const scenarios = [
  {
    label: 'the loop crosses on a measured client version',
    opts: {},
    outcome: 'passed',
    transport: 'channel',
    version: VERIFIED_VERSION
  },
  {
    label: 'the loop crosses on a version nobody has measured',
    opts: { ack: { emitted: true, pingAnswered: true, clientName: 'claude-code', clientVersion: UNMEASURED_VERSION } },
    outcome: 'unverified-client',
    transport: 'channel',
    version: UNMEASURED_VERSION
  },
  {
    label: 'the client answers a ping but reports no version at all',
    opts: { ack: { emitted: true, pingAnswered: true, clientName: null, clientVersion: null } },
    outcome: 'unverified-client',
    transport: 'channel',
    version: null
  },
  {
    label: "the agent's MCP server never answers",
    opts: { ack: null },
    outcome: 'no-answer',
    transport: 'composer',
    version: null
  },
  {
    label: 'the notification could not be emitted to the client',
    opts: { ack: { emitted: false, emitError: 'transport closed', pingAnswered: false, clientVersion: VERIFIED_VERSION } },
    outcome: 'emit-failed',
    transport: 'composer',
    version: VERIFIED_VERSION
  },
  {
    label: 'the frame was emitted and the client never answered the ping',
    opts: { ack: { emitted: true, pingAnswered: false, pingError: 'timed out', clientVersion: VERIFIED_VERSION } },
    outcome: 'client-unresponsive',
    transport: 'composer',
    version: VERIFIED_VERSION
  },
  {
    label: 'emission was switched off before the check ran',
    opts: { emission: false },
    outcome: 'channel-disabled',
    transport: 'composer',
    version: null
  },
  {
    label: 'no live connection to write the probe frame to',
    opts: { connection: null },
    outcome: 'no-connection',
    transport: 'composer',
    version: null
  },
  {
    label: 'the connection died between resolving it and writing to it',
    opts: { writeOk: false },
    outcome: 'no-connection',
    transport: 'composer',
    version: null
  },
  {
    label: "T3's watcher never reached ready, so there was no loop to test",
    opts: {},
    extra: { startupOutcome: 'dialog-unanswered' },
    outcome: 'not-ready',
    transport: 'composer',
    version: null
  }
];

for (const s of scenarios) {
  const { report, w } = await run(s.opts, s.extra ?? {});
  check(
    report.outcome === s.outcome,
    `${s.label} → ${s.outcome}`,
    report.outcome === s.outcome ? '' : `got '${report.outcome}'`
  );
  check(
    report.transport === s.transport,
    `  …and that outcome means the ${s.transport}`,
    report.transport === s.transport ? '' : `got '${report.transport}'`
  );
  // THE VERSION SURVIVES THE FAILURE PATH. `emit-failed` and
  // `client-unresponsive` learned a version before they failed, and dropping it
  // there would be dropping it in exactly the case somebody needs it.
  check(
    report.clientVersion === s.version,
    `  …carrying clientVersion ${s.version === null ? 'null' : s.version}`,
    report.clientVersion === s.version ? '' : `got ${JSON.stringify(report.clientVersion)}`
  );
  check(
    typeof report.detail === 'string' && report.detail.length > 20,
    '  …with a sentence a supervisor can act on',
    report.detail
  );
  if (s.outcome === 'not-ready') {
    check(
      !w.calls.includes('writeProbe'),
      '  …and no probe frame was written at an agent that never came up',
      w.calls.join(' → ')
    );
  }
}

const { report: passedReport } = await run();
check(passedReport.proved === true, "`proved` is true for 'passed' and for nothing else");
const { report: driftReport } = await run({
  ack: { emitted: true, pingAnswered: true, clientVersion: UNMEASURED_VERSION }
});
check(driftReport.proved === false, '  …including the version-drift case, which routes but is unproved');
check(
  driftReport.clientVersionVerified === false && passedReport.clientVersionVerified === true,
  '  …and `clientVersionVerified` separates measured from merely working'
);
check(
  driftReport.detail.includes(UNMEASURED_VERSION) && driftReport.detail.includes(VERIFIED_VERSION),
  '  …naming both the version it saw and the versions somebody measured',
  driftReport.detail
);

// ------------------------------------------ 2. the answer is armed first --

rule('2. The answer is armed BEFORE the probe frame goes out');

const { w: ordered } = await run();
const armedAt = ordered.calls.indexOf('expectAck');
const wroteAt = ordered.calls.indexOf('writeProbe');
check(
  armedAt !== -1 && wroteAt !== -1 && armedAt < wroteAt,
  'expectAck is called before writeProbe',
  ordered.calls.join(' → ')
);
check(
  ordered.nonces.armed.length === 1 &&
    ordered.nonces.armed[0] === ordered.nonces.written[0],
  'the nonce armed for is the nonce written'
);

const { w: first } = await run();
const { w: second } = await run();
check(
  first.nonces.written[0] !== second.nonces.written[0],
  'two runs mint different nonces, so a re-activation cannot resolve its predecessor',
  `${first.nonces.written[0]} vs ${second.nonces.written[0]}`
);

// The registry half of the same rule, against the real class.
const acks = new ChannelSelfCheckAckRegistry();
const armed = acks.expect('nonce-A', 5_000);
check(acks.pending === 1, 'an armed answer is pending until it arrives');
check(
  acks.deliver({ nonce: 'nonce-B', emitted: true }) === false,
  "an answer for a nonce nobody armed is dropped, not resolved onto somebody else's check"
);
check(acks.pending === 1, '  …and leaves the real one still waiting');
check(acks.deliver({ nonce: 'nonce-A', emitted: true, pingAnswered: true }) === true, 'the right nonce resolves');
check((await armed).emitted === true, "  …with the agent's own report");
check(acks.pending === 0, '  …and nothing is left pending');

const timedOut = acks.expect('nonce-C', 20);
check((await timedOut) === null, 'an answer that never comes resolves null rather than hanging');
check(
  acks.deliver({ nonce: 'nonce-C', emitted: true }) === false,
  '  …and an answer arriving after that timeout is dropped rather than reviving a reported check'
);

// -------------------------------------------------- 3. the verdict store --

rule('3. The store: a verdict belongs to a connection, not to an address');

const store = new ChannelSelfCheckStore();
check(store.get(ADDRESS) === undefined, 'an agent nobody checked has no verdict');
check(
  store.degraded(ADDRESS, null) === false,
  '  …and UNCHECKED IS NOT FAILED — it does not degrade'
);

const failed = (await run({ ack: null })).report;
store.record(ADDRESS, { ...failed, connectionId: 'conn-OLD' });
// THE LIVE CONNECTION IS NAMED ON EVERY CALL SINCE KAN-435. `degraded` is a
// question about the connection an agent is holding, so these read
// "degraded WHILE HOLDING conn-OLD" — which is the case a verdict about
// conn-OLD is entitled to answer.
check(store.degraded(ADDRESS, 'conn-OLD') === true, 'a failed verdict degrades the agent');
check(
  store.degraded(ADDRESS, 'conn-NEW') === false,
  '  …and it does NOT degrade an agent that is now holding a DIFFERENT connection',
  'KAN-435: story/KAN-117 sat on the composer for 7h52m on a verdict about a socket that had closed'
);

check(
  store.releaseConnection(ADDRESS, 'conn-SOMEONE-ELSE') === false,
  "releasing a DIFFERENT connection leaves the verdict alone",
  'the reconnect case: a close for the old socket must not delete the new verdict'
);
check(store.degraded(ADDRESS, 'conn-OLD') === true, '  …the verdict is still there');
check(
  store.releaseConnection(ADDRESS, 'conn-OLD') === true,
  'releasing the connection it was measured on drops it'
);
check(
  store.get(ADDRESS) === undefined,
  '  …back to unchecked, which is what "nobody has proved this connection" means'
);

// A VERDICT THAT NEVER HELD A CONNECTION IS RELEASED BY NOTHING, which is why
// `forget` exists and why a re-spawn calls it. Found by the live probe: a
// re-activated agent carried its previous run's `not-ready` — with the previous
// run's timestamp — on its row until the new check finished.
const orphan = new ChannelSelfCheckStore();
const neverConnected = (await run({ connection: null })).report;
orphan.record(ADDRESS, neverConnected);
check(
  neverConnected.connectionId === null && orphan.degraded(ADDRESS, null) === true,
  'a verdict with NO connection degrades the agent and no release can drop it'
);
check(
  orphan.releaseConnection(ADDRESS, 'anything') === false,
  '  …releaseConnection cannot reach it — there is no connection id to match'
);
check(
  (orphan.forget(ADDRESS), orphan.get(ADDRESS) === undefined),
  '  …so a re-spawn calls forget(), and the stale verdict is gone before the new check runs'
);

const spellings = new ChannelSelfCheckStore();
spellings.record({ type: 'Task', key: 'kan-248' }, { ...failed, connectionId: 'c1' });
check(
  spellings.degraded({ type: 'task', key: 'KAN-248' }, 'c1') === true,
  'two spellings of one agent are one agent, as everywhere else in the daemon'
);

// -------------------------------------------------------- 4. the real gate --

rule('4. The gate: a failed check is ENFORCED, not merely reported');

writeChannelSwitch(true);
say(`  (channel emission switched on at ${CHANNEL_SWITCH_PATH} — inside this run's scratch $HOME)`);

const connections = new AgentConnectionRegistry();
const fakeSocket = { destroyed: false, write: () => true };
const registered = connections.register(fakeSocket, ADDRESS);
const connectionId = registered.connection.id;

const route = (selfCheck) =>
  routeChannelMessage({
    registry: connections,
    address: ADDRESS,
    content: 'hello',
    selfCheck
  });

const unchecked = new ChannelSelfCheckStore();
const uncheckedOutcome = route(unchecked);
check(
  uncheckedOutcome.routed === true,
  'an UNCHECKED agent still routes over the channel',
  'conflating unchecked with failed would take the fleet off channels on every daemon restart'
);

const degradedStore = new ChannelSelfCheckStore();
degradedStore.record(ADDRESS, { ...failed, connectionId });
const degradedOutcome = route(degradedStore);
check(
  degradedOutcome.routed === false && degradedOutcome.reason === 'selfcheck-failed',
  'a DEGRADED agent is refused by the gate, so its messages land on the composer',
  degradedOutcome.routed ? 'IT WAS ROUTED — the verdict is reported and not enforced' : degradedOutcome.reason
);
check(
  typeof degradedOutcome.detail === 'string' && degradedOutcome.detail.includes('self-check'),
  '  …and the refusal says why, in words the sender can act on',
  degradedOutcome.detail
);

const passedStore = new ChannelSelfCheckStore();
passedStore.record(ADDRESS, { ...passedReport, connectionId });
check(route(passedStore).routed === true, 'an agent whose check PASSED routes');

const driftStore = new ChannelSelfCheckStore();
driftStore.record(ADDRESS, { ...driftReport, connectionId });
check(
  route(driftStore).routed === true,
  'an agent on an unmeasured client version routes — a version bump is not a fault',
  'it is flagged on its row instead; degrading the fleet on a patch release is a policy nobody asked for'
);

writeChannelSwitch(false);
const offOutcome = route(degradedStore);
check(
  offOutcome.routed === false && offOutcome.reason === 'channel-disabled',
  'the kill switch still answers first, ahead of the self-check',
  'a shut gate must not leak which agents are degraded any more than which are connected'
);
writeChannelSwitch(true);

// ------------------------------------------- 5. what a supervisor can see --

rule('5. The row: visible in list_agents, which is where a supervisor looks');

const bin = path.join(scratch, 'bin');
mkdirSync(bin, { recursive: true });
const census = JSON.stringify({
  id: 'cli:agent:list',
  result: {
    type: 'agent_list',
    agents: [
      { name: 'butchr-task-kan-248', agent: 'claude', agent_status: 'working', cwd: scratch },
      { name: 'butchr-task-kan-999', agent: 'claude', agent_status: 'working', cwd: scratch }
    ]
  }
});
writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\ncat <<'EOF'\n${census}\nEOF\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const listWith = (opts) => {
  let response;
  const router = new MessageRouter(
    new WorkspaceRegistry(),
    new PromptLoader(repoRoot),
    new HerdrBridge(),
    (msg) => {
      response = msg;
    },
    () => {},
    opts
  );
  router.handle({ action: 'list_agents' });
  return response;
};

const rowsWith = (store) => {
  const res = listWith({ channelSelfCheck: (address) => store.get(address) ?? null });
  const byKey = new Map(res.agents.map((a) => [a.key.toLowerCase(), a]));
  return byKey;
};

const listStore = new ChannelSelfCheckStore();
listStore.record(ADDRESS, { ...failed, connectionId });
const rows = rowsWith(listStore);
const degradedRow = rows.get('kan-248');
const uncheckedRow = rows.get('kan-999');

check(
  degradedRow?.channel?.transport === 'composer',
  'the degraded agent shows `transport: composer` on its own row',
  JSON.stringify(degradedRow?.channel)
);
check(
  degradedRow?.channel?.outcome === 'no-answer',
  '  …and the outcome that put it there, rather than a bare boolean'
);
check(
  uncheckedRow?.channel?.outcome === 'unchecked' &&
    uncheckedRow?.channel?.transport === 'channel',
  'an unchecked agent says so, and says it still routes',
  JSON.stringify(uncheckedRow?.channel)
);
check(
  uncheckedRow?.channel?.clientVersion === null &&
    'clientVersion' in (uncheckedRow?.channel ?? {}),
  '  …with the version answered as null rather than omitted'
);

const pinned = new ChannelSelfCheckStore();
pinned.record(ADDRESS, { ...passedReport, connectionId });
const pinnedRow = rowsWith(pinned).get('kan-248');
check(
  pinnedRow?.channel?.clientVersion === VERIFIED_VERSION,
  `the passing row carries the client version (${VERIFIED_VERSION})`,
  'a pass on one client version is not a pass on the next one — §6.1'
);
check(pinnedRow?.channel?.proved === true, '  …and is the only shape that claims `proved`');

// THE THIRD SHAPE, AND THE ONE MOST EASILY LOST. A daemon with no reader cannot
// answer, and must not be mistaken for one answering "nothing is wrong".
const noReader = listWith({});
const noReaderRow = noReader.agents.find((a) => a.key.toLowerCase() === 'kan-248');
check(
  noReaderRow !== undefined && !('channel' in noReaderRow),
  'a daemon with no self-check reader OMITS the field rather than nulling it',
  'absent means "cannot answer"; present means "checked, and here is what I found"'
);

// ----------------------------------------------------------------- verdict --

rule('VERDICT');
say(`  outcomes exercised     ${scenarios.length}`);
say(`  verified client versions ${VERIFIED_CLIENT_VERSIONS.join(', ')}`);
say(`  transportFor('passed') = ${transportFor('passed')}, ('no-answer') = ${transportFor('no-answer')}`);
say('');
if (failures === 0) {
  say('ALL CHECKS PASSED — every outcome is reached and named, a failed check is');
  say('enforced at the gate rather than only reported, and the row a supervisor');
  say('reads carries the outcome and the client version.');
  if (blind) {
    say('');
    say('BUT --blind WAS PASSED AND NOTHING WENT RED. The patch did not take, or the');
    say('proof is not testing what it claims to. Treat this as a failure.');
    failures += 1;
  }
} else {
  say(`${failures} CHECK(S) FAILED.`);
  if (blind) {
    say('');
    say('--blind was passed, so this is the expected result: with `transportFor`');
    say('patched to answer `channel` for every outcome, a failed self-check stops');
    say('degrading anything. The listing still reports it and the gate stops acting');
    say('on it — reported but not enforced, which is the defect this file exists to');
    say('catch.');
  }
}

process.exit(failures ? 1 : 0);
