// Live proof for KAN-278, against a REAL CrabCast daemon, a REAL herdr and a
// REAL pty: an agent spawned through the CrabCast-backed runtime, with the
// switch on.
//
// WHAT FAILURE THIS WOULD CATCH: a CrabCast-backed runtime that typechecks,
// reports itself healthy and cannot actually run an agent — the failure mode
// where every unit-shaped check is green because every one of them was answered
// by our own fake. Concretely it would catch: `spawnSession` never reaching
// `configure_agent`/`activate_agent`; the address translation putting the agent
// at a path CrabCast rejects; the pty mirror subscribing to a session id that
// does not exist on their side, so a terminal renders nothing; and
// `agent.detached` not reaching `setSessionEndedListener`, which is what leaves
// a dead agent rendering as live.
//
// CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`;
// it attempts nothing without one.
//
// ── WHY THIS SCRIPT EXISTS BESIDE THE OTHER ONE ────────────────────────────
//
// `verify-crabcast-runtime-switch.mjs` stands up its own socket and answers its
// own frames. That makes it CI-safe and it makes it structurally incapable of
// noticing that CrabCast does something different from what we assumed — it is
// a proof that SUPPLIES ITS OWN INPUT, and it says so in its own header.
//
// **This script is the one that owns the join.** Nothing here is faked: the
// daemon is a real CrabCast, the pane is a real herdr pane, the pty is a real
// pty, and every assertion below is about what that stack actually did. It is
// deliberately NOT in CI, for the same reason CrabCast keeps its own
// herdr-dependent proofs out of theirs: it needs a real herdr and real panes.
// Its output goes on the pull request.
//
// ── WHAT IT STILL DOES NOT COVER, NAMED RATHER THAN LEFT TO INFERENCE ──────
//
//   - **The `claude` launcher.** This spawns with `shell`, which is a real
//     pane with a real process and a real pty but not a Claude agent. What
//     that leaves untested is the launcher path only — prompt delivery, MCP
//     wiring, and `expectsRuntime`. It is the same choice CrabCast makes in its
//     own walkthrough and for the same reason: `shell` depends on nothing but
//     herdr. **Nobody covers the `claude` path yet.** It is not covered by the
//     other script either, and it should be exercised before any cutover.
//   - **Butchr's own daemon end to end.** This constructs the runtime through
//     `createAgentRuntime` — the real switch, the real selection — but it does
//     not boot `daemon.ts`. So it proves the switch produces a working runtime;
//     it does not prove the daemon's own routers behave once one is installed.
//     Nothing covers that, because nothing is migrated onto this runtime by
//     KAN-278 and there is nothing yet to observe.
//   - **`tailAgent`, `pressPaneKey`, `resetWorkspace`, `setAgentSpawnedListener`.**
//     All four are `absent` or `different-shaped` on purpose; the switch script
//     asserts they refuse honestly, and asserting them here would be asserting
//     the same thing twice.
//   - **A `channelEnabled: true` spawn, and the `null` state.** Section 4b
//     asserts the field arrives and that it is `false`, which is what a spawn
//     this adapter makes is entitled to be — nothing here asks CrabCast for its
//     own builtin channel server, because that is a cutover decision (KAN-294
//     item 5). So the `true` and `null` states are exercised only against the
//     staged wire in `verify-channel-spawn-verdict.mjs` §3, and against a real
//     peer by hand: the three states were driven on a live daemon at the pin and
//     the transcript is on the KAN-294 pull request. **No script owns the live
//     `true` case**, and that is the honest edge of this one.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   BUTCHR_CRABCAST_SOCKET=<path to a live crabcast.sock> \
//     node daemon/scripts/verify-crabcast-runtime-live.mjs [--verbose]
//
// A CrabCast daemon must already be listening there. Any of `crabcast
// configure|activate|deactivate|forget|send` spawns one; `list` deliberately
// does not.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { createAgentRuntime } from '../dist/runtime-switch.js';
import { workspaceDirFor } from '../dist/herdr.js';

const verbose = process.argv.includes('--verbose');
let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 6).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Terminal output is not text, and assuming it was cost this proof its first
 * run.
 *
 * herdr renders a pane by emitting a cursor-position escape before nearly every
 * character, so `echo KANMARKERONE` reaches the stream as
 * `…[1;1H…mK…[1;2H…mA…[1;3H…mN…` and a plain `includes('KANMARKERONE')` finds
 * nothing while the bytes are all present and in order. The first live run
 * reported three failures for exactly that reason — the adapter was correct and
 * the assertion was wrong.
 *
 * So: strip CSI and OSC sequences, then keep only the characters a marker is
 * made of. Markers below are letters-only and short, so neither a wrap nor a
 * digit inside an escape can break the match.
 */
function paneLetters(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
}

/** Poll until `fn()` is truthy or the budget runs out. Returns what it saw. */
async function until(fn, budgetMs, stepMs = 250) {
  const deadline = Date.now() + budgetMs;
  let last = fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = fn();
  }
  return last;
}

// ── setup guard (NOT a verdict) ────────────────────────────────────────────
const socketPath = process.env.BUTCHR_CRABCAST_SOCKET;
if (!socketPath) {
  console.error(
    'setup: BUTCHR_CRABCAST_SOCKET is not set. This proof needs a real CrabCast daemon;\n' +
      'see the header for how to start one. Nothing was attempted.'
  );
  process.exit(1);
}
if (!fs.existsSync(socketPath)) {
  console.error(
    `setup: no socket at ${socketPath}. A CrabCast daemon must be listening there before\n` +
      'this proof can mean anything. Nothing was attempted.'
  );
  process.exit(1);
}

const TYPE = 'task';
const KEY = process.env.KAN278_PROBE_KEY ?? 'kan-278-live-probe';
const workDir = workspaceDirFor(TYPE, KEY);

console.log(`CrabCast socket : ${socketPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}`);
console.log(`workspace       : ${workDir}`);

// ── 1. the switch selects CrabCast ─────────────────────────────────────────
rule('1. the switch — BUTCHR_AGENT_RUNTIME=crabcast selects the CrabCast runtime');

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
const { runtime, report } = createAgentRuntime({
  log: (m) => verbose && console.log(`      ${m}`)
});

check('the runtime is CrabCastRuntime', runtime.constructor.name === 'CrabCastRuntime');
check('the report says so', report.mode === 'crabcast', JSON.stringify(report));
console.log(`\n   report summary: ${report.summary}\n`);

const connected = await until(() => runtime.describe().link.connected, 5_000);
check('the link connected to the real daemon', connected === true, JSON.stringify(runtime.describe().link));

const link = runtime.describe().link;
check(
  'the peer identified its build over the wire',
  typeof link.peerCommit === 'string' && link.peerCommit.length === 40,
  JSON.stringify(link)
);
console.log(
  `   peer build ${String(link.peerCommit).slice(0, 12)}; adapter pinned to ` +
    `${link.pinnedCommit.slice(0, 12)}; match=${link.peerMatchesPin}`
);

const censusUp = await until(() => runtime.herdrReachable(), 6_000);
check('the census is reachable through CrabCast', censusUp === true, JSON.stringify(runtime.describe()));

// ── 2. spawn a real agent ──────────────────────────────────────────────────
rule('2. spawnSession — a real pane, through CrabCast, through herdr');

const ended = [];
runtime.setSessionEndedListener((event) => ended.push(event));

const session = runtime.spawnSession(TYPE, KEY, undefined, 'KAN-278 live probe agent.', 'shell');
check('spawnSession returned a session synchronously', !!session?.sessionId, JSON.stringify(session));
check(
  "it starts in 'initializing' — the honest state while two async calls run",
  session.status === 'initializing',
  session.status
);
check('the workspace directory was created by Butchr, not CrabCast', fs.existsSync(workDir));

const became = await until(() => session.status === 'active' || !!session.spawnError, 60_000);
check(
  'the session went active',
  session.status === 'active',
  session.spawnError ?? `still ${session.status} after 60s`
);

if (session.status !== 'active') {
  console.log(
    `\nFAILED early — the agent never started, so nothing below would mean anything.\n` +
      `${session.spawnError ?? ''}\n`
  );
  runtime.dispose();
  process.exit(1);
}

console.log(`   butchr session  : ${session.sessionId}`);
console.log(`   workdir         : ${session.workDir}`);

// The census is CrabCast's own answer, not ours — this is the assertion that
// the agent exists on their side rather than only in our session map.
const inCensus = await until(
  () => runtime.listHerdrAgents().find((a) => a.workDir === workDir),
  10_000
);
check(
  "the agent appears in CrabCast's own census at our path",
  !!inCensus,
  JSON.stringify(runtime.listHerdrAgents().slice(0, 4))
);
if (inCensus) console.log(`   census row      : ${inCensus.name}  herdrStatus=${inCensus.herdrStatus}`);

const presence = await runtime.confirmAgentPresent(inCensus?.name ?? 'unknown', false, 15_000);
check('confirmAgentPresent finds it', presence.present === true, JSON.stringify(presence));

// ── 3. the pty mirror — KAN-224's design, against a real stream ────────────
rule('3. pty — the mirror joins the snapshot to the stream, over a real socket');

const received = [];
const dispose = runtime.registerDataListener(session.sessionId, (data) => received.push(data));
check('registerDataListener returned a disposer', typeof dispose === 'function');

// The snapshot lands first and is NEVER fanned out to listeners. So at this
// point the mirror may hold text while the listener has seen nothing — that
// asymmetry is the design, not a bug, and asserting it is how we know the
// snapshot did not leak into the stream path.
const mirrored = await until(() => (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length > 0, 20_000);
check('the mirror filled from the pty_init snapshot', mirrored === true);
const afterSnapshot = received.length;
check(
  'the snapshot was NOT delivered through the listener path (no duplication by construction)',
  afterSnapshot === 0,
  `${afterSnapshot} chunk(s) arrived before any input was written`
);

// Letters only, and short: see `paneLetters` for why a timestamped marker is
// the wrong shape for an assertion against a rendered pane.
const marker = 'KANMARKERALPHA';
const wrote = runtime.writePty(session.sessionId, `echo ${marker}${String.fromCharCode(13)}`);
check('writePty accepted the keystrokes', wrote === true);

const sawMarker = await until(() => paneLetters(received.join('')).includes(marker), 25_000);
check(
  'the echoed marker arrived through the listener — a real cross-process stream',
  sawMarker === true,
  `listener saw ${received.length} chunk(s), ${received.join('').length} chars, no marker`
);
check(
  'and the same bytes are in the mirrored ptyBuffer',
  paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(marker)
);

// The disposer is a local array filter (KAN-224 §3.4) — CrabCast has no detach
// verb, and under this design it does not need one. After disposing, the
// listener must stop receiving while the mirror keeps filling.
dispose();
const atDispose = received.length;
const mirrorAtDispose = (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length;
const marker2 = 'KANMARKERBETA';
runtime.writePty(session.sessionId, `echo ${marker2}${String.fromCharCode(13)}`);
const mirrorGrew = await until(
  () => paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(marker2),
  25_000
);
check('after disposing, the mirror still tracks the session', mirrorGrew === true);
check(
  'but the disposed listener received nothing further',
  received.length === atDispose,
  `${received.length - atDispose} chunk(s) arrived after the disposer ran`
);
if (verbose) console.log(`         mirror grew from ${mirrorAtDispose} chars`);

check(
  'resizePty is accepted for a live session',
  runtime.resizePty(session.sessionId, 100, 30) === true
);
check(
  'and refused for one that does not exist',
  runtime.resizePty('no-such-session', 100, 30) === false
);

// ── 4. sendToAgent ─────────────────────────────────────────────────────────
rule('4. sendToAgent — typed into the real pane');

const sent = await runtime.sendToAgent(KEY, `echo KAN278-SEND-OK`, TYPE);
check(
  'CrabCast reports the keystrokes delivered',
  sent.success === true,
  JSON.stringify(sent)
);

// ── 4b. the spawn's channel verdict ARRIVED, from a spawn nobody staged ────
rule("4b. channelEnabled — CrabCast's own answer about the spawn we just made");

// THIS IS THE SECTION THAT COVERS THE GAP KAN-145 LEFT BETWEEN TWO HONEST
// SCRIPTS. `verify-channel-spawn-verdict.mjs` §3 proves the adapter keeps the
// three states without flattening them — by answering `activate_response` with
// a value IT CHOSE. It is therefore structurally incapable of noticing that
// CrabCast stopped sending the field, renamed it, or moved it to another frame.
// Nothing but a real peer can notice that, so this is where it is asserted.
//
// The field is read off the adapter's own record rather than off a raw frame,
// deliberately: what has to be true is that the value survived the wire AND the
// adapter's read into the place a caller would look.
const verdict = runtime.channelEnabledFor(session.sessionId);
check(
  'the field ARRIVED: a real activate_response carried a real boolean',
  verdict === true || verdict === false,
  `channelEnabledFor returned ${JSON.stringify(verdict)} — \`null\` here means CrabCast sent ` +
    `no recognisable channelEnabled on activate_response, which is the change this section ` +
    `exists to catch. That surface is OUTSIDE their read-path contract (their KAN-287 is the ` +
    `ticket to bring it in), so it can move without their CI going red.`
);
check(
  'and it is `false` — this spawn asked for no CrabCast builtin, so no channel',
  verdict === false,
  `got ${JSON.stringify(verdict)}. A \`true\` here would mean an agent Butchr spawned was ` +
    `given CrabCast's own channel server, which nothing in KAN-294 does and which would be a ` +
    `cutover decision rather than an adapter one.`
);
console.log(
  `   channelEnabled  : ${JSON.stringify(verdict)}  (tally across this runtime's sessions: ` +
    `${JSON.stringify(runtime.describe().channelEnabled)})`
);

// The contract version, read once per connection at the handshake rather than
// polled — which is what CrabCast's own document asks for.
const contract = runtime.describe().link;
check(
  `the peer publishes read-path contract v${contract.pinnedContractVersion}, as pinned`,
  contract.peerContractVersion === contract.pinnedContractVersion,
  JSON.stringify({
    peer: contract.peerContractVersion,
    pinned: contract.pinnedContractVersion
  })
);

// ── 5. teardown reaches the session-ended listener ─────────────────────────
rule('5. agent.detached — a dead agent stops rendering as a live one');

const terminated = runtime.terminateSession(session.sessionId);
check('terminateSession was accepted', terminated.success === true, JSON.stringify(terminated));

const sawEnd = await until(() => ended.length > 0, 15_000);
check(
  'setSessionEndedListener fired',
  sawEnd === true,
  `no SessionEndedEvent after 15s; a UI would still be rendering this agent as live`
);
if (ended.length) {
  const e = ended[0];
  check(
    'the event carries this session, addressed in Butchr terms',
    e.sessionId === session.sessionId && e.type === TYPE && e.key === KEY,
    JSON.stringify(e)
  );
  check(
    "reason is 'exited' — CrabCast cannot distinguish a takeover, and this does not guess",
    e.reason === 'exited',
    JSON.stringify(e)
  );
}

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
runtime.dispose();

// Butchr owns this directory at both ends — CrabCast never made it and will
// never delete it. Removing it here is the same asymmetry `resetWorkspace`
// refuses to hide.
const inWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
if (inWorkspaces && fs.existsSync(workDir)) {
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`   removed probe workspace ${workDir}`);
} else {
  console.log(`   left ${workDir} alone — it is not inside the workspaces tree`);
}
console.log(
  `   NOTE: CrabCast still holds a configured record for that path. Remove it with:\n` +
    `         crabcast forget ${workDir}`
);

// ── verdict ────────────────────────────────────────────────────────────────
console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — a real agent ran through the CrabCast-backed runtime: spawned, mirrored its ' +
        'pty across the socket, took input, and announced its own death'
  }\n`
);
process.exit(failures ? 1 : 0);
