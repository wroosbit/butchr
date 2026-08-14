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
//   - **`pressPaneKey`, `resetWorkspace`, `setAgentSpawnedListener`.** All three
//     are `absent` or `different-shaped` on purpose; the switch script asserts
//     they refuse honestly, and asserting them here would be asserting the same
//     thing twice. **`tailAgent` was the fourth entry on this list and is now
//     section 4c** — KAN-283 made the interface async and the method is served
//     over the wire, so it moved from "refuses honestly" to "must be shown
//     working against a real peer", which is this script's job rather than the
//     switch script's.
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

/**
 * Poll until `fn()` is truthy or the budget runs out. Returns what it saw.
 *
 * **`fn` MAY BE ASYNC, AND THE `await` IS WHY (KAN-283).** Section 4c polls a
 * tail, which is `Promise`-returning now. Without the `await` below, an async
 * predicate would return a *Promise* — truthy on the first evaluation whatever it
 * eventually resolves to — so this would exit immediately and hand back a
 * pending promise as if the condition had been met. That is the same defect
 * `verify-tail-async-awaited.mjs` exists for, in the helper rather than in the
 * daemon. Awaiting a non-promise is a no-op, so every synchronous caller here is
 * unaffected.
 */
async function until(fn, budgetMs, stepMs = 250) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
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
// KAN-381: the listener takes a PtyStreamEvent. This section is about the
// data arm — the snapshot/stream join — so it collects that arm and counts
// discontinuities separately, because one arriving mid-section would mean the
// link dropped under this proof and every chunk assertion below it would be
// measuring something else.
const gapsSeen = [];
const dispose = runtime.registerDataListener(session.sessionId, (event) => {
  if (event.kind === 'data') received.push(event.data);
  else gapsSeen.push(event.discontinuity);
});
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

// Asserted at the END of the section rather than the start, where it would
// have been trivially true: what has to hold is that the link stayed up for
// the whole of it. A gap here would mean every chunk count above was
// measuring a stream that had been severed and re-established (KAN-381).
check(
  'no discontinuity arrived during this section — the link held, so the chunk counts below mean what they say',
  gapsSeen.length === 0,
  JSON.stringify(gapsSeen)
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

// ── 4c. tailAgent, served over the socket for the first time ───────────────
rule('4c. tailAgent — a real tail, over the wire, through the async signature (KAN-283)');

// THIS SECTION IS WHY KAN-283 EXISTS, AND IT IS THE ONE THING NO FAKE CAN OWN.
// Under KAN-278 this method refused: `AgentRuntime.tailAgent` was synchronous and
// a socket cannot answer a synchronous call, while CrabCast's `tail_agent`
// answered `text`, `truncated`, `source` and `sourcesTried` all along. The data
// was there and our signature could not reach it. The interface is
// `Promise`-returning now, so this asks the real daemon and reads what comes
// back.
//
// `verify-tail-async-awaited.mjs` is the CI-runnable sibling and it proves a
// different thing: that every call site awaits, and what an un-awaited read
// degrades to. It has no peer and cannot establish that a tail crosses the wire.
// **That is this section's half, and neither script claims the other's.**
//
// The marker was echoed by section 4 through `sendToAgent`, so what is asserted
// here is a round trip through two different CrabCast verbs: we typed it with
// one and we are reading it back with the other.
const tailed = await until(
  async () => {
    const t = await runtime.tailAgent(KEY, TYPE, 60);
    return t.success === true && paneLetters(String(t.text ?? '')).includes('KANSENDOK')
      ? t
      : null;
  },
  20_000
);

check(
  'tailAgent SUCCEEDED — it no longer refuses, and this is the KAN-278 gap closing',
  tailed !== null && tailed.success === true,
  tailed === null
    ? 'no successful tail carrying the marker within 20s. If `success` is false, read the ' +
      'refusal: a `not found` means CrabCast has no agent at that path, which is the one ' +
      'limit this method has — they can only tail an agent they configured themselves.'
    : JSON.stringify({ ...tailed, text: `<${String(tailed.text).length} chars>` })
);

if (tailed) {
  check(
    'the text is a real pane read, not an empty string standing in for one',
    typeof tailed.text === 'string' && tailed.text.length > 0,
    `text length ${String(tailed.text ?? '').length}`
  );
  check(
    "it echoes the marker section 4 typed — one round trip, two of CrabCast's verbs",
    paneLetters(tailed.text).includes('KANSENDOK'),
    paneLetters(tailed.text).slice(-160)
  );
  // `source` IS THE FIELD WORTH CHECKING RATHER THAN THE TEXT, because it is the
  // one where their vocabulary and ours could have diverged silently. They
  // answer from the same `'recent-unwrapped' | 'visible'` pair `TAIL_SOURCES`
  // declares, and the adapter narrows anything else to `null` — so an
  // unrecognised value shows up here as a failure rather than being smuggled
  // through the type.
  check(
    'source names one of OUR two read sources — their vocabulary still matches ours',
    tailed.source === 'recent-unwrapped' || tailed.source === 'visible',
    `source=${JSON.stringify(tailed.source)}; a null here means CrabCast named a source this ` +
      'adapter does not recognise, which is a divergence to report to KAN-59 rather than to paper over'
  );
  check(
    'sourcesTried came back and is a subset of ours',
    Array.isArray(tailed.sourcesTried) &&
      tailed.sourcesTried.length > 0 &&
      tailed.sourcesTried.every((s) => s === 'recent-unwrapped' || s === 'visible'),
    JSON.stringify(tailed.sourcesTried)
  );
  console.log(
    `\n   source=${JSON.stringify(tailed.source)} ` +
      `truncated=${JSON.stringify(tailed.truncated)} ` +
      `sourcesTried=${JSON.stringify(tailed.sourcesTried)}\n`
  );
  console.log('   ── the real pane, as CrabCast read it ──');
  console.log(
    String(tailed.text)
      .split('\n')
      .filter((l) => l.trim().length)
      .slice(-8)
      .map((l) => `   | ${l}`)
      .join('\n')
  );
  console.log('   ───────────────────────────────────────\n');
}

// A READ THAT COULD NOT BE MADE IS STILL `success: false`, and it must not have
// acquired a `text` on the way. This is the half of the contract that going
// async could have quietly lost: an implementation with a wire to fail on is
// exactly the one tempted to answer `text: ''`.
const absent = await runtime.tailAgent('kan-283-no-such-agent-anywhere', TYPE, 20);
check(
  'an agent CrabCast does not know is a FAILED READ, never an empty pane',
  absent.success === false && absent.text === undefined,
  JSON.stringify(absent)
);
check(
  'and the refusal names the leg and offers the herdr runtime as the remedy',
  typeof absent.error === 'string' &&
    /refused by [a-z-]+:/.test(absent.error) &&
    /herdr runtime/.test(absent.error),
  absent.error
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
