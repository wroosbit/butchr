// A startup self-check verdict is about ONE CONNECTION, and must stop being
// consulted the moment that connection is not the one the agent is holding.
//
// WHAT FAILURE THIS WOULD CATCH: a healthy agent pinned to the composer forever
// by a verdict about a socket that closed while the check was still running — so
// every `steer` to it takes a Ctrl+C and destroys the tool call in flight, over a
// channel that has been working the whole time.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them in
// process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ---------------------------------------------------------------------------
// THE DEFECT, AND WHY THE EXISTING RELEASE PATH CANNOT REACH IT (KAN-435)
// ---------------------------------------------------------------------------
//
// `ChannelSelfCheckStore.releaseConnection` is the only thing that drops a
// verdict, and it fires from the socket's `close` handler in daemon.ts. That
// covers the ordinary order — verdict recorded, connection closes later, verdict
// dropped. It cannot cover the reverse, and the reverse is what the bring-up
// sequence produces:
//
//   `claude --continue || claude` spawns an MCP server per invocation, so an
//   agent registers more than one connection while it starts, and the last one
//   wins. `superviseChannelStartup` declares ready on whichever is current; the
//   self-check writes its probe there and waits up to 20 SECONDS for an answer.
//   A connection that closes inside that window is released BEFORE there is any
//   verdict to release — so the release does nothing — and the verdict lands
//   afterwards naming a socket that is already gone. Nothing looks at it again.
//
// MEASURED ON THE LIVE FLEET, from ~/.local/share/butchr/daemon.log. Two agents,
// same mechanism, ~8 hours apart, neither involving a daemon restart:
//
//   04:01:07.360Z  [ChannelStartup] task/KAN-441: ready (connection conn-176)
//   04:01:07.412Z  Client disconnected — task/KAN-441 unregistered (conn-176)
//   04:01:07.792Z  Connection conn-178 is task/KAN-441          <- the real one
//   04:01:27.360Z  [ChannelSelfCheck] task/KAN-441: no-answer -> composer,
//                  "the probe frame was written to conn-176"
//
//   20:12:03.455Z  Connection conn-129 is story/KAN-117
//   20:12:04.066Z  [ChannelStartup] story/KAN-117: ready (conn-129)
//   20:12:04.541Z  Client disconnected — story/KAN-117 unregistered (conn-129)
//   20:12:06.534Z  Connection conn-130 is story/KAN-117         <- the real one
//   20:12:24.068Z  [ChannelSelfCheck] story/KAN-117: no-answer -> composer
//
// At 04:04:29Z, `story/KAN-117` had been on the composer for 7h52m while holding
// conn-130, and `task/KAN-441` since 04:01 while holding conn-178. Two of the
// eight agents on the board.
//
// THE SAME LOG CARRIES THE CONTROL FOR THE RELEASE PATH ITSELF: at 20:11:01 an
// earlier `story/KAN-117` connection closed while a verdict DID exist, and the
// line reads `unregistered (conn-8), ...; its channel self-check verdict is
// dropped with it`. The conn-129 close has no such clause. The release works;
// the ordering is the entire defect, which is why the fix is at the point of
// CONSULTATION rather than another attempt to drop the record at the right time.
//
// ---------------------------------------------------------------------------
// NO TIMING DEPENDENCE, DELIBERATELY — AND THAT IS WHY THERE IS NO BUDGET HERE
// ---------------------------------------------------------------------------
// The defect is a race, so the temptation is to reproduce it by racing, and that
// is how a proof becomes an intermittent (KAN-416). Nothing here waits, sleeps,
// or measures elapsed real time: `runChannelSelfCheck` takes its whole world as
// injected functions, so the swap is expressed as "`resolveConnection` answers
// conn-A, then conn-B" — an ORDERING, which is what the defect actually is. The
// clock is a counter. Every section is deterministic and the script has no
// timeout of its own to blow.
//
// ---------------------------------------------------------------------------
// WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST
// ---------------------------------------------------------------------------
// A proof that supplies its own input has not tested that the input arrives
// (KAN-145), and this one supplies the outside world entirely: the connections,
// the acks, the clock. **It does not prove that a real bring-up swaps
// connections** — that is a fact about `claude --continue || claude` and no
// harness can hold it.
//
// WHO COVERS THAT: the two daemon-log timelines above, read off the running
// fleet and pasted into the KAN-435 pull request, and `probe-channel-selfcheck.mjs`
// for the live activation path. Sections 2, 3 and 4 are built the other way
// round — real `ChannelSelfCheckStore`, real `AgentConnectionRegistry`, real
// `routeChannelMessage`, real `MessageRouter` — so the decisions they assert are
// made by the code that makes them in production.
//
// ---------------------------------------------------------------------------
// THE FLEET'S CHANNEL SWITCH IS NEVER READ AND NEVER WRITTEN
// ---------------------------------------------------------------------------
// Section 3 needs channel emission ON, and the switch is a file under
// `os.homedir()`. `HOME` is relocated to a scratch directory BEFORE the build is
// imported, and the guard below aborts if `CHANNEL_SWITCH_PATH` does not then
// land inside it. Turning the fleet's real switch on would put a blocking dialog
// in front of every activation on this machine.
//
// Usage: node daemon/scripts/verify-selfcheck-verdict-outlives-connection.mjs [--stale-degrades] [--blind-swap]
//
//   --stale-degrades  patch a COPY of the build so `degraded` asks about an
//                     address again — the pre-KAN-435 question. Sections 2, 3
//                     and 4 are expected to FAIL.
//   --blind-swap      patch a COPY so the check no longer notices that its
//                     connection was replaced. Section 1 is expected to FAIL.
//
// Run it after `npm run build` in daemon/.

import path from 'path';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const staleDegrades = process.argv.includes('--stale-degrades');
const blindSwap = process.argv.includes('--blind-swap');

const dist = path.join(daemonDir, 'dist');
// A SETUP GUARD, NOT A VERDICT: exit 2 so it can never be mistaken for a check
// that ran and found something.
if (!existsSync(path.join(dist, 'channel-selfcheck.js'))) {
  console.error('daemon/dist/channel-selfcheck.js is missing — run `npm run build` in daemon/ first.');
  process.exit(2);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'butchr-swap-'));

// BEFORE ANY IMPORT. `ipc.ts` computes BUTCHR_DIR from `os.homedir()` at module
// load, so this has to happen while the build is still unloaded.
const fakeHome = path.join(scratch, 'home');
mkdirSync(path.join(fakeHome, '.local', 'share', 'butchr'), { recursive: true });
process.env.HOME = fakeHome;

// Only the module under test is swapped; the rest of the build is the real one,
// so the gate and the listing stay real under both red modes.
let selfCheckModule = path.join(dist, 'channel-selfcheck.js');

if (staleDegrades || blindSwap) {
  const patchedDir = path.join(scratch, 'dist');
  cpSync(dist, patchedDir, { recursive: true });
  const target = path.join(patchedDir, 'channel-selfcheck.js');
  selfCheckModule = target;
  let source = readFileSync(target, 'utf8');

  if (staleDegrades) {
    // THE DEFECT, INTRODUCED DELIBERATELY: `degraded` back to the address-only
    // question. The verdict store still holds exactly what it held; what changes
    // is that a verdict about a dead connection is allowed to answer for a live
    // one — which is the state two agents were measured in.
    const before = source;
    source = source.replace(
      /degraded\(address, liveConnectionId\) \{[\s\S]*?\n {4}\}/,
      "degraded(address, liveConnectionId) {\n        return this.get(address)?.transport === 'composer'; // --stale-degrades\n    }"
    );
    if (source === before) {
      console.error(
        '--stale-degrades could not find `degraded(address, liveConnectionId) { ... }` in the ' +
        'copied channel-selfcheck.js. The patch did not apply, so this run would report an ' +
        'honest store for the wrong reason. Refusing to continue.'
      );
      process.exit(2);
    }
    console.log('--stale-degrades: patched the copied store back to the address-only question.');
    console.log('                  Sections 2, 3 and 4 are expected to FAIL.');
  }

  if (blindSwap) {
    // The check stops noticing that its subject was replaced, so a swap comes
    // back as `no-answer` — a verdict blaming the recipient's build for a
    // connection change on our own side.
    const before = source;
    source = source.replace(
      /const live = world\.resolveConnection\(\);\n {4}if \(live && live\.id !== connection\.id\) \{[\s\S]*?\n {4}\}/,
      'const live = null; // --blind-swap: the check no longer notices the replacement'
    );
    if (source === before) {
      console.error(
        '--blind-swap could not find the connection-replacement branch in the copied ' +
        'channel-selfcheck.js. The patch did not apply. Refusing to continue.'
      );
      process.exit(2);
    }
    console.log('--blind-swap: patched the copied check so it no longer notices a replacement.');
    console.log('              Section 1 is expected to FAIL.');
  }

  writeFileSync(target, source);
}

const { ChannelSelfCheckStore, runChannelSelfCheck, transportFor } = await import(selfCheckModule);
const { AgentConnectionRegistry } = await import(path.join(dist, 'agent-connections.js'));
const { routeChannelMessage, writeChannelSwitch, CHANNEL_SWITCH_PATH, carrierFor } =
  await import(path.join(dist, 'channel.js'));
const { MessageRouter } = await import(path.join(dist, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(dist, 'registry.js'));
const { PromptLoader } = await import(path.join(dist, 'prompt.js'));

// THE GUARD THAT MAKES THE $HOME RELOCATION A FACT RATHER THAN AN INTENTION.
if (!CHANNEL_SWITCH_PATH.startsWith(fakeHome)) {
  console.error(
    `REFUSING TO RUN: CHANNEL_SWITCH_PATH is ${CHANNEL_SWITCH_PATH}, which is outside the ` +
    `scratch home ${fakeHome}. This script would have written the real fleet's channel switch.`
  );
  process.exit(2);
}

const failures = [];
// ARGUMENT ORDER IS `(ok, name, detail)`, AND IT IS WORTH A COMMENT BECAUSE THE
// FIRST DRAFT OF THIS FILE HAD IT THE OTHER WAY ROUND. Two scripts in this
// directory declare `check` with the condition second; this one takes it first,
// matching the call sites below. With the arguments swapped, `ok` was the name
// string — always truthy — so every assertion printed PASS whatever it found,
// including a line reading `PASS false`. A harness that cannot go red is not a
// weak proof, it is the absence of one wearing a green tick, so both red modes
// below are run before this script is believed.
const check = (ok, name, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const rule = (t) => {
  console.log('\n' + '='.repeat(78));
  console.log(t);
  console.log('='.repeat(78));
};

const ADDRESS = { type: 'task', key: 'KAN-435' };

// ---------------------------------------------------------------- section 1 --

rule('1. The check notices that its subject was replaced, and does not blame the agent');

/**
 * Drive the SHIPPED check against a world whose connection changes underneath
 * it. `resolveConnection` answers the current generation up to and including the
 * write, and the next one afterwards — which is the ordering the daemon log
 * shows, expressed as an ordering rather than as a race.
 *
 * THE GENERATION ADVANCES ON EVERY ATTEMPT, AND SINCE KAN-450 IT HAS TO. Until
 * then this check was single-shot, so one swap was enough to reach
 * `connection-replaced` and the world could settle on conn-B afterwards. A swap
 * is now re-run once against its replacement, so a world that swaps and then
 * settles resolves to a verdict about conn-B — correctly, and it is what
 * `verify-selfcheck-rechecks-replaced-connection.mjs` §1 asserts. Reaching this
 * outcome at all therefore needs the ceiling case: a connection replaced under
 * BOTH attempts, which is the state this outcome now names.
 */
async function runWithSwap({ swap, ack = null }) {
  const logLines = [];
  // THE SWAP IS EXPRESSED AS A PHASE, NOT AS A CALL COUNT. "The connection
  // changed while the check was waiting for its answer" is the actual condition;
  // counting calls encodes today's call sequence instead, and would go quietly
  // green — or quietly red — the next time a line is added ahead of the await.
  // The first draft counted, put the swap one call too late, and reported no
  // swap at all. `armed` counts attempts-that-have-started-waiting, which is the
  // same phase one level up now that there can be two attempts.
  let armed = 0;
  const resolve = () => ({ id: `conn-${String.fromCharCode(65 + (swap ? armed : 0))}` });
  const report = await runChannelSelfCheck({
    address: ADDRESS,
    ackTimeoutMs: 1,
    world: {
      emissionEnabled: () => true,
      resolveConnection: resolve,
      expectAck: async () => {
        // Everything from here on is after the probe went out, which is exactly
        // the window daemon.log shows the real connection closing in.
        armed += 1;
        return ack;
      },
      // Re-resolves, as the production `writeProbe` does.
      writeProbe: () => resolve() !== null,
      now: () => 0,
      log: (m) => logLines.push(m)
    }
  });
  return { report, logLines };
}

const swapped = await runWithSwap({ swap: true });
check(
  swapped.report.outcome === 'connection-replaced',
  'a connection replaced under the check is reported as such, not as a failure of the agent',
  `outcome=${swapped.report.outcome}`
);
check(
  swapped.report.transport === 'channel',
  '  …and it does NOT take the agent off the channel',
  `transport=${swapped.report.transport}`
);
check(
  swapped.report.proved === false,
  '  …while still not claiming anything was proved',
  `proved=${swapped.report.proved}`
);
check(
  swapped.report.connectionId === 'conn-B' &&
    swapped.report.detail.includes('conn-B') &&
    swapped.report.detail.includes('conn-C'),
  '  …and it names BOTH connections, so a reader can see the swap',
  swapped.report.detail.slice(0, 90) + '…'
);

// THE CONTROL, and it is the half that stops this being satisfied by a check
// that never fails: with NO swap, the same timeout is still `no-answer` and the
// agent is still degraded. A patch that simply stopped degrading would pass
// every assertion above and fail this one.
const notSwapped = await runWithSwap({ swap: false });
check(
  notSwapped.report.outcome === 'no-answer' && notSwapped.report.transport === 'composer',
  'CONTROL: with no swap, the same silence is still `no-answer` and still degrades',
  `outcome=${notSwapped.report.outcome} transport=${notSwapped.report.transport}`
);

// And a genuine pass is unaffected by the new branch.
const answered = await runWithSwap({
  swap: false,
  ack: { nonce: 'n', emitted: true, pingAnswered: true, clientName: 'claude-code', clientVersion: '2.1.224' }
});
check(
  answered.report.outcome === 'passed' && answered.report.transport === 'channel',
  'CONTROL: a loop that crosses on a measured client still passes',
  `outcome=${answered.report.outcome}`
);
check(
  transportFor('connection-replaced') === 'channel',
  'transportFor puts `connection-replaced` on the passing side, beside `unverified-client`'
);

// ---------------------------------------------------------------- section 2 --

rule('2. The store: a verdict cannot answer for a connection it never measured');

const staleVerdict = {
  outcome: 'no-answer',
  transport: 'composer',
  proved: false,
  clientName: null,
  clientVersion: null,
  clientVersionVerified: null,
  connectionId: 'conn-176',
  elapsedMs: 20_000,
  checkedAt: new Date(0).toISOString(),
  detail: 'the probe frame was written to conn-176 and this agent did not answer'
};

const store = new ChannelSelfCheckStore();
store.record(ADDRESS, staleVerdict);

check(
  store.degraded(ADDRESS, 'conn-176') === true,
  'CONTROL: while the agent still holds the connection it was measured on, it IS degraded',
  'a fix that merely stopped degrading would fail here'
);
check(
  store.degraded(ADDRESS, 'conn-178') === false,
  'a verdict about conn-176 does NOT degrade an agent that is holding conn-178',
  'this is task/KAN-441 exactly'
);
check(
  store.degraded(ADDRESS, null) === true,
  'an agent holding NO connection keeps the pre-KAN-435 answer',
  'carrierFor puts degraded ahead of registered on purpose; that ordering is untouched'
);
// THE FAIL-OPEN THAT `typeof` CLOSES. Every TypeScript caller is forced to pass
// the argument; the proofs under this directory are JavaScript and can omit it,
// and an omission that read as "some other connection is live" would put a
// genuinely unproven agent back on the channel in silence.
check(
  store.degraded(ADDRESS) === true,
  'a caller that omits the argument gets the CONSERVATIVE answer, not the comfortable one',
  'undefined is not a connection id'
);

const unchecked = new ChannelSelfCheckStore();
check(
  unchecked.degraded(ADDRESS, 'conn-1') === false,
  'unchecked is still not failed'
);

// The mechanism that creates the stale verdict, asserted rather than described:
// a close that arrives BEFORE the verdict exists releases nothing.
const ordering = new ChannelSelfCheckStore();
check(
  ordering.releaseConnection(ADDRESS, 'conn-176') === false,
  'a close arriving BEFORE the verdict exists drops nothing — there is nothing to drop',
  'which is why the fix is at the point of consultation, not another attempt to drop it'
);
ordering.record(ADDRESS, staleVerdict);
check(
  ordering.releaseConnection(ADDRESS, 'conn-176') === true &&
    ordering.get(ADDRESS) === undefined,
  '  …and the ordinary order still works exactly as it did',
  'the release path is not the defect and is not changed'
);

// ---------------------------------------------------------------- section 3 --

rule('3. The gate: the frame is actually written, which is the behaviour rather than the label');

writeChannelSwitch(true);

const connections = new AgentConnectionRegistry();
const writes = [];
const socketA = { destroyed: false, write: (b) => (writes.push(['A', b]), true) };
const socketB = { destroyed: false, write: (b) => (writes.push(['B', b]), true) };

// conn-1 registers, then is replaced by conn-2 — the bring-up sequence.
connections.register(socketA, ADDRESS);
const idA = connections.resolve(ADDRESS).id;
connections.register(socketB, ADDRESS);
const idB = connections.resolve(ADDRESS).id;
check(idA !== idB, 'the identity map has moved to a new connection', `${idA} -> ${idB}`);

const gateStore = new ChannelSelfCheckStore();
gateStore.record(ADDRESS, { ...staleVerdict, connectionId: idA });

const routed = routeChannelMessage({
  registry: connections,
  address: ADDRESS,
  content: 'a steer',
  selfCheck: gateStore,
  managed: () => true
});
check(
  routed.routed === true && routed.connectionId === idB,
  'a steer rides the CHANNEL, on the new connection, despite the old verdict',
  `routed=${routed.routed} reason=${routed.reason ?? '-'} connection=${routed.connectionId ?? '-'}`
);
check(
  writes.some(([which]) => which === 'B'),
  '  …and the frame really was written to the new socket',
  `writes=${writes.map(([w]) => w).join(',') || '(none)'}`
);

// CONTROL: a verdict about the connection that IS live still refuses, and still
// names the self-check as the reason. Without this, "the gate never refuses"
// would pass section 3.
const currentStore = new ChannelSelfCheckStore();
currentStore.record(ADDRESS, { ...staleVerdict, connectionId: idB });
const refused = routeChannelMessage({
  registry: connections,
  address: ADDRESS,
  content: 'a steer',
  selfCheck: currentStore,
  managed: () => true
});
check(
  refused.routed === false && refused.reason === 'selfcheck-failed',
  'CONTROL: a verdict about the LIVE connection still refuses the channel',
  `reason=${refused.reason ?? '-'}`
);

// And the carrier the row reports is the same decision, from the same function.
check(
  carrierFor({
    emissionEnabled: true,
    degraded: gateStore.degraded(ADDRESS, idB),
    registered: true,
    managed: true
  }).transport === 'channel',
  'carrierFor, asked with the live connection, answers `channel` for the stale verdict'
);

// ---------------------------------------------------------------- section 4 --

rule('4. Both surfaces answer, and they answer the same thing');

const session = {
  sessionId: 'task-kan-435-1',
  type: ADDRESS.type,
  key: ADDRESS.key,
  url: 'https://example.invalid/browse/KAN-435',
  createdAt: new Date(0),
  status: 'active',
  workDir: '/tmp/kan-435'
};
// A STUB BRIDGE RATHER THAN A REAL ONE, and only here: `HerdrBridge` shells out
// to `herdr agent list`, which is a machine this script must not need. The
// ROUTER is the real one — it is the thing under test — and everything it asks
// this object for is a fact about panes, which is not what section 4 is about.
const bridge = {
  getSessionByAddress: () => session,
  listHerdrStatuses: () => new Map([['butchr-task-kan-435', 'working']]),
  listActiveSessions: () => [session],
  listHerdrAgentsChecked: () => ({
    reachable: true,
    agents: [{ name: 'butchr-task-kan-435', status: 'working', agentRuntime: 'claude', workDir: session.workDir }],
    unreadableRecordsTotal: 0,
    unreadableRecords: []
  }),
  describeAgent: () => ({ agentName: 'butchr-task-kan-435', type: ADDRESS.type, workDir: null, herdrStatus: 'unknown' })
};

function ask(action) {
  let response;
  const router = new MessageRouter(
    new WorkspaceRegistry(),
    new PromptLoader(path.resolve(daemonDir, '..')),
    bridge,
    (msg) => { response = msg; },
    () => {},
    {
      channelSelfCheck: (addr) => gateStore.get(addr) ?? null,
      // The same closure daemon.ts wires: one resolve, feeding both fields, so
      // the row cannot hold a degradation opinion of its own.
      channelCarrier: (addr) => {
        const conn = connections.resolve(addr);
        return carrierFor({
          emissionEnabled: true,
          degraded: gateStore.degraded(addr, conn?.id ?? null),
          registered: conn !== undefined,
          managed: true
        });
      }
    }
  );
  router.handle({ action, key: ADDRESS.key, type: ADDRESS.type });
  return response;
}

const status = ask('agent_status');
check(
  status?.channel !== undefined,
  'butchr_agent_status carries a `channel` block at all',
  'its absence for EVERY agent in EVERY state is what KAN-435 was filed on'
);
check(
  status?.channel?.transport === 'channel',
  '  …and it reports the carrier the next steer will actually take',
  `transport=${status?.channel?.transport ?? '(absent)'}`
);
check(
  status?.channel?.outcome === 'no-answer',
  '  …without hiding what the check found',
  `outcome=${status?.channel?.outcome ?? '(absent)'}`
);

const listed = ask('list_agents');
const row = (listed?.agents ?? []).find((a) => a.key === ADDRESS.key);
check(
  row?.channel?.transport === status?.channel?.transport &&
    row?.channel?.outcome === status?.channel?.outcome,
  'the two surfaces cannot disagree — same reader, same fragment',
  `list=${row?.channel?.transport ?? '(absent)'} status=${status?.channel?.transport ?? '(absent)'}`
);

// ------------------------------------------------------------------ verdict --

rule('VERDICT');
if (failures.length) {
  console.log(`${failures.length} CHECK(S) FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
} else {
  console.log('ALL CHECKS PASSED — a verdict is consulted only about the connection it');
  console.log('measured, a replaced connection is named rather than blamed, the gate writes');
  console.log('the frame, and both surfaces report the same carrier.');
}
process.exit(failures.length ? 1 : 0);
