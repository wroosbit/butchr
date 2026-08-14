// Proof for KAN-381: when the CrabCast link drops and comes back, every pty
// mirror is re-subscribed AND the gap is disclosed — whether or not the
// re-subscription worked.
//
// WHAT FAILURE THIS WOULD CATCH: a mirror that survives a reconnect looking
// live while nothing is streaming to it. Before this ticket the link
// reconnected, `CrabCastLink.subscribedSessions()` was called from nowhere, and
// `PtyMirror.state` stayed `'live'` on a mirror CrabCast had stopped serving —
// so the terminal answered every question promptly with pre-drop bytes and no
// field anywhere said a gap had happened. It would also catch the narrower
// regressions this script's sections are shaped around: a resync that fires on
// a polite FIN and not on an abrupt reset; a discontinuity emitted only when
// the resync SUCCEEDS, which is the one case where nobody needs telling; and a
// gap that reaches live listeners but is not recorded for a consumer that
// attaches afterwards.
//
// CI-RUNNABLE: yes — stands up its own Unix socket and answers its own frames
// in process; no live daemon, no herdr, no PTY, no credential, no peer, no
// network. It writes nothing to disk outside os.tmpdir().
//
// ── THIS SCRIPT SUPPLIES ITS OWN PEER, AND HERE IS WHAT THAT COSTS ─────────
//
// The CrabCast at the other end of the socket below is fifty lines of this
// file. So every claim here is of the form "given a peer that behaves like
// THIS, the adapter does that" — and it is structurally incapable of noticing
// that a real CrabCast behaves differently. In particular it cannot tell you:
//
//   - that a real `pty_init` after a reconnect returns a buffer containing what
//     was produced during the outage (this fake returns one because it was
//     written to);
//   - that a real peer keeps the pane alive across our disconnection at all;
//   - that a real drop produces the socket events this fake produces.
//
// **`daemon/scripts/verify-crabcast-reconnect-live.mjs` owns exactly those**,
// against the machine's real CrabCast daemon and a real herdr pane, with the
// FIN arriving from outside this process. It is CI-RUNNABLE: no. Neither script
// claims the other's half, and the boundary is here rather than left to be
// inferred (KAN-145).
//
// What this script owns that the live one cannot: a peer you are willing to
// take away for a second (section 4), and the negative control in section 5,
// which needs two mirrors whose histories differ by exactly one outage.
//
// ── IT READS BOTH `dist` AND `src`, SO READ THE SECTION NOT THE EXIT CODE ──
//
// Sections 1-4 import from `../dist/` and are therefore assertions about the
// LAST SUCCESSFUL BUILD: run them after a failed `tsc` and they are testing
// yesterday's code while looking exactly as they would otherwise. Section 4b
// reads `../src/crabcast-link.ts` as text and is unaffected by the build. So a
// verdict from this script is a blend, and the rule is the repository's own:
// confirm `npm run build` exited 0 — by a route that reports it, not through a
// pipe — before reading anything above 4b.
//
// Usage: node daemon/scripts/verify-crabcast-reconnect-resync.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { CrabCastLink, CRABCAST_PIN, CRABCAST_CONTRACT_VERSION } from '../dist/crabcast-link.js';
import { CrabCastRuntime } from '../dist/crabcast-runtime.js';
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

async function until(fn, budgetMs, stepMs = 25) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

// ── the instrument ─────────────────────────────────────────────────────────
//
// A Unix socket answering the four verbs this path uses, holding one pane
// buffer per remote session so that "output produced while we were not
// listening" is a thing that can actually be arranged. `pty_init` returns the
// buffer as it stands, which is the shape CrabCast's own does.

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kan381-resync-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

const socketPath = path.join(work, 'crabcast.sock');

const PANE_A = 'remote-session-alpha';
const PANE_B = 'remote-session-beta';
const KEY_A = 'kan-381-probe-a';
const KEY_B = 'kan-381-probe-b';
const DIR_A = workspaceDirFor('task', KEY_A);
const DIR_B = workspaceDirFor('task', KEY_B);

/** Each pane's accumulated output, as the peer holds it. */
const paneBuffers = new Map([
  [PANE_A, ''],
  [PANE_B, '']
]);
/** How many `pty_init` requests each pane has received, across all connections. */
const ptyInitCounts = new Map();
/** Sockets currently attached, and which panes each has subscribed. */
const liveSockets = new Set();
const subscriptions = new Map(); // socket -> Set<paneId>

/** Announce a row only once the test wants it adopted. */
let censusRows = [];

function censusRow(paneId, dir) {
  return {
    path: dir,
    paneName: `crabcast-${path.basename(dir)}-abc123`,
    sessionId: paneId,
    status: 'running',
    herdrStatus: 'working',
    agentRuntime: 'claude',
    state: 'running',
    workDir: dir,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    launcher: 'shell'
  };
}

/**
 * Produce output on a pane.
 *
 * It always lands in the peer's own buffer. It is streamed only to sockets that
 * have an live `pty_init` for it — which is the whole mechanism under test:
 * with nobody subscribed, the bytes exist and reach nobody, and that is what a
 * missed event IS.
 */
function emitOnPane(paneId, data) {
  paneBuffers.set(paneId, (paneBuffers.get(paneId) ?? '') + data);
  for (const socket of liveSockets) {
    if (!subscriptions.get(socket)?.has(paneId)) continue;
    socket.write(JSON.stringify({ action: 'pty_output', sessionId: paneId, data }) + '\n');
  }
}

const server = net.createServer((socket) => {
  liveSockets.add(socket);
  subscriptions.set(socket, new Set());
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = (body) =>
        socket.write(JSON.stringify({ id: req.id, success: true, ...body }) + '\n');

      if (req.action === 'daemon_status') {
        reply({
          action: 'daemon_status_response',
          build: { commit: CRABCAST_PIN },
          contractVersion: CRABCAST_CONTRACT_VERSION
        });
      } else if (req.action === 'list_agents') {
        reply({
          action: 'list_agents_response',
          agents: censusRows,
          foreignPanes: [],
          unreadableRecordsTotal: 0,
          unreadableRecords: []
        });
      } else if (req.action === 'pty_init') {
        const paneId = req.sessionId;
        ptyInitCounts.set(paneId, (ptyInitCounts.get(paneId) ?? 0) + 1);
        subscriptions.get(socket)?.add(paneId);
        reply({ action: 'pty_init_response', buffer: paneBuffers.get(paneId) ?? '' });
      } else if (req.action === 'pty_input' || req.action === 'pty_resize') {
        if (req.id) reply({ action: `${req.action}_response` });
      }
    }
  });
  socket.on('close', () => {
    liveSockets.delete(socket);
    subscriptions.delete(socket);
  });
  socket.on('error', () => {});
});

await new Promise((resolve) => server.listen(socketPath, resolve));

/** Drop every attached connection the way a peer closing politely would. */
function dropAllPolitely() {
  for (const socket of [...liveSockets]) socket.end();
}

/** Take the listener away entirely, so reconnect attempts fail rather than land. */
async function takePeerAway() {
  dropAllPolitely();
  await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
}

/** Put it back, on the same path, holding the same pane buffers. */
async function bringPeerBack() {
  await new Promise((resolve) => server.listen(socketPath, resolve));
}

const link = new CrabCastLink({
  socketPath,
  requestTimeoutMs: 3_000,
  reconnectDelayMs: 150,
  log: (m) => verbose && console.log(`      [link] ${m}`)
});
const runtime = new CrabCastRuntime({
  link,
  censusIntervalMs: 100,
  log: (m) => verbose && console.log(`      [runtime] ${m}`)
});

// ── 1. a mirror, subscribed and streaming ──────────────────────────────────
rule('1. baseline — a mirror is subscribed and the data arm carries output');

censusRows = [censusRow(PANE_A, DIR_A)];

const connected = await until(() => runtime.describe().link.connected, 3_000);
check('the link connected', connected === true, JSON.stringify(runtime.describe().link));

const sessionA = await until(
  () => runtime.listActiveSessions().find((s) => s.key === KEY_A),
  3_000
);
check('the runtime adopted the census row', !!sessionA, JSON.stringify(runtime.listActiveSessions()));
if (!sessionA) {
  console.log('\nFAILED early — nothing below would mean anything without a session.\n');
  runtime.dispose();
  server.close();
  process.exit(1);
}

/** Every event the listener saw, in order, both arms. */
const eventsA = [];
const disposeA = runtime.registerDataListener(sessionA.sessionId, (event) => eventsA.push(event));
check('registerDataListener returned a disposer', typeof disposeA === 'function');

const subscribed = await until(() => (ptyInitCounts.get(PANE_A) ?? 0) >= 1, 3_000);
check('the mirror issued its first pty_init', subscribed === true, `count=${ptyInitCounts.get(PANE_A)}`);

emitOnPane(PANE_A, 'BEFORE-THE-DROP\n');
const sawBefore = await until(
  () => eventsA.some((e) => e.kind === 'data' && e.data.includes('BEFORE-THE-DROP')),
  3_000
);
check('output before the drop reached the listener on the data arm', sawBefore === true,
  JSON.stringify(eventsA));
check(
  'and no discontinuity has been reported, because none has happened',
  eventsA.every((e) => e.kind === 'data'),
  JSON.stringify(eventsA.filter((e) => e.kind !== 'data'))
);
check(
  'the session records no gaps yet',
  runtime.getSession(sessionA.sessionId).ptyDiscontinuities.length === 0,
  JSON.stringify(runtime.getSession(sessionA.sessionId).ptyDiscontinuities)
);
check(
  'and describe() reports the mirror live',
  runtime.describe().ptyMirrorStates.live === 1,
  JSON.stringify(runtime.describe().ptyMirrorStates)
);

// ── 2. the drop — disclosed IMMEDIATELY, before any repair is attempted ────
rule('2. the drop — the gap opens and is announced while it is still open');

const initsBeforeDrop = ptyInitCounts.get(PANE_A);
dropAllPolitely();

const opened = await until(() => eventsA.some((e) => e.kind === 'discontinuity'), 3_000);
check(
  'a discontinuity reached the listener',
  opened === true,
  `${eventsA.length} event(s), none of them a discontinuity`
);

const openEvent = eventsA.find((e) => e.kind === 'discontinuity');
if (openEvent) {
  const d = openEvent.discontinuity;
  check("it is sequence 1 — this session's first gap", d.sequence === 1, JSON.stringify(d));
  check("it is 'pending', because nothing has been repaired yet", d.resync === 'pending', JSON.stringify(d));
  check(
    'restoredAt and windowMs are null rather than 0 — the gap is still growing',
    d.restoredAt === null && d.windowMs === null,
    JSON.stringify(d)
  );
  check("cause names the drop", d.cause === 'link-dropped', JSON.stringify(d));
  check('lostAt is a parseable instant', Number.isFinite(Date.parse(d.lostAt)), d.lostAt);
}

// THE ASSERTION THE WHOLE TICKET TURNS ON: the mirror must stop claiming to be
// live the moment its subscription dies, rather than at the moment somebody
// notices. `stale` had no name before this ticket, which is why the claim went
// on being made.
const wentStale = await until(() => runtime.describe().ptyMirrorStates.stale === 1, 2_000);
check(
  'the mirror is reported STALE, not live — a subscription CrabCast no longer holds',
  wentStale === true,
  JSON.stringify(runtime.describe().ptyMirrorStates)
);

// ── 3. events genuinely missed, then the resync ────────────────────────────
rule('3. the outage — output produced with nobody subscribed, then re-subscription');

// Nobody is subscribed to PANE_A right now. This lands in the peer's buffer and
// reaches no socket: it is a missed event in the only sense that matters.
emitOnPane(PANE_A, 'DURING-THE-OUTAGE\n');
const missedAtListener = eventsA.filter((e) => e.kind === 'data' && e.data.includes('DURING-THE-OUTAGE'));
check(
  'the missed bytes did NOT arrive on the data arm — this is a real gap, not a staged one',
  missedAtListener.length === 0,
  JSON.stringify(missedAtListener)
);

const resubscribed = await until(() => (ptyInitCounts.get(PANE_A) ?? 0) > initsBeforeDrop, 5_000);
check(
  'the reconnect issued a FRESH pty_init for the mirror — the resync half',
  resubscribed === true,
  `pty_init count is still ${ptyInitCounts.get(PANE_A)}, was ${initsBeforeDrop} before the drop`
);

const closed = await until(
  () => eventsA.filter((e) => e.kind === 'discontinuity').length >= 2,
  5_000
);
check(
  'the discontinuity was re-emitted once it settled',
  closed === true,
  `${eventsA.filter((e) => e.kind === 'discontinuity').length} discontinuity event(s)`
);

const settled = eventsA.filter((e) => e.kind === 'discontinuity').pop();
if (settled) {
  const d = settled.discontinuity;
  check('it settled as succeeded', d.resync === 'succeeded', JSON.stringify(d));
  check(
    'under the SAME sequence — one drop reported twice, not two drops',
    d.sequence === 1,
    JSON.stringify(d)
  );
  check(
    'and it now states the window: restoredAt set, windowMs a real duration',
    d.restoredAt !== null && typeof d.windowMs === 'number' && d.windowMs >= 0,
    JSON.stringify(d)
  );
  check(
    'the window is arithmetic on its own endpoints, not an independent guess',
    d.windowMs === Date.parse(d.restoredAt) - Date.parse(d.lostAt),
    JSON.stringify(d)
  );
  console.log(`   window: ${d.lostAt} → ${d.restoredAt} = ${d.windowMs}ms`);
}

// The resync is only half the answer, and this is the other half doing its job:
// the mirror's CONTENT caught up.
const caughtUp = await until(
  () => (runtime.getSession(sessionA.sessionId)?.ptyBuffer ?? '').includes('DURING-THE-OUTAGE'),
  3_000
);
check(
  'the re-subscription snapshot carried what was produced during the outage',
  caughtUp === true,
  `buffer: ${JSON.stringify((runtime.getSession(sessionA.sessionId)?.ptyBuffer ?? '').slice(-80))}`
);

emitOnPane(PANE_A, 'AFTER-THE-RESYNC\n');
const streamingAgain = await until(
  () => eventsA.some((e) => e.kind === 'data' && e.data.includes('AFTER-THE-RESYNC')),
  3_000
);
check(
  'and the stream is live again — new output reaches the listener',
  streamingAgain === true,
  JSON.stringify(eventsA.slice(-3))
);

check(
  'the mirror is back to live',
  runtime.describe().ptyMirrorStates.live === 1 && runtime.describe().ptyMirrorStates.stale === 0,
  JSON.stringify(runtime.describe().ptyMirrorStates)
);

// The DURABLE record, which is what a consumer attaching after the fact reads.
const recorded = runtime.getSession(sessionA.sessionId).ptyDiscontinuities;
check(
  'the session holds exactly one gap — the record is per drop, not per emission',
  recorded.length === 1,
  JSON.stringify(recorded)
);
check(
  'and the stored copy is the settled one, not a stale duplicate of the open event',
  recorded[0]?.resync === 'succeeded' && recorded[0]?.restoredAt !== null,
  JSON.stringify(recorded)
);

// ── 4. a long outage — one drop is one gap, however many retries fail ──────
rule('4. a peer that stays away — failed reconnect attempts must not multiply the gap');

// A drop is followed by a retry every `reconnectDelayMs`, and each failure is an
// `error` on a socket that never connected. Those must announce nothing: a gap
// per failed attempt would turn a thirty-second outage into two hundred
// discontinuities and bury the one that matters. The gap already open is the
// answer for the whole outage, and it stays `pending` for the length of it —
// which is also what makes `pending` a state worth having rather than a
// placeholder.
const initsBeforeOutage = ptyInitCounts.get(PANE_A);
await takePeerAway();

const wentStaleAgain = await until(
  () => runtime.getSession(sessionA.sessionId).ptyDiscontinuities.length === 2,
  5_000
);
check(
  'the second drop opened a second gap',
  wentStaleAgain === true,
  JSON.stringify(runtime.getSession(sessionA.sessionId).ptyDiscontinuities)
);
check(
  'numbered 2 — sequences do not restart or skip',
  runtime.getSession(sessionA.sessionId).ptyDiscontinuities[1]?.sequence === 2,
  JSON.stringify(runtime.getSession(sessionA.sessionId).ptyDiscontinuities)
);

// Several reconnect attempts land in here and every one of them fails.
await sleep(900);
const duringOutage = runtime.getSession(sessionA.sessionId).ptyDiscontinuities;
check(
  'after ~6 failed reconnect attempts there is still exactly ONE open gap, not one per attempt',
  duringOutage.length === 2 && duringOutage[1].resync === 'pending',
  JSON.stringify(duringOutage)
);
check(
  'and the operator report agrees: one gap open, link down',
  runtime.describe().ptyDiscontinuities.open === 1 && runtime.describe().link.connected === false,
  JSON.stringify(runtime.describe().ptyDiscontinuities)
);
check(
  'the attempt counter moved, so the retries really were happening',
  runtime.describe().link.attempts > 2,
  JSON.stringify({ attempts: runtime.describe().link.attempts })
);

emitOnPane(PANE_A, 'DURING-THE-LONG-OUTAGE\n');
await bringPeerBack();

const outageClosed = await until(
  () => runtime.getSession(sessionA.sessionId).ptyDiscontinuities[1]?.resync === 'succeeded',
  8_000
);
check(
  'when the peer came back the gap settled, stating the whole outage as its window',
  outageClosed === true,
  JSON.stringify(runtime.getSession(sessionA.sessionId).ptyDiscontinuities[1])
);
check(
  'and the mirror was re-subscribed against the NEW connection',
  (ptyInitCounts.get(PANE_A) ?? 0) > initsBeforeOutage,
  `pty_init count ${ptyInitCounts.get(PANE_A)}, was ${initsBeforeOutage}`
);
check(
  'the link reports more than one connection — which is what tells a reconnected link from a fresh one',
  runtime.describe().link.connections >= 3,
  JSON.stringify({ connections: runtime.describe().link.connections })
);
if (verbose) {
  console.log(`   gaps: ${JSON.stringify(runtime.getSession(sessionA.sessionId).ptyDiscontinuities)}`);
}

// ── 4b. the errno path, which THIS SCRIPT CANNOT REACH ────────────────────
rule('4b. the errno path — asserted statically, because AF_UNIX cannot produce it');

// WHAT THIS COVERS AND WHAT IT DOES NOT, because the difference matters.
//
// The first implementation of this ticket had a hole: `close` decided whether
// to announce a disconnect by asking "was this the current socket?", and the
// `error` handler had already answered no by clearing the reference. So a
// connection that ERRORED — an ECONNRESET from a peer that died rather than
// closing politely — announced nothing, and every mirror it dropped stayed
// `live` forever. That is the ticket's own defect surviving in the path most
// likely to produce it.
//
// **No socket in this file can reproduce it.** RST is a TCP mechanism and
// CrabCast's transport is a Unix domain socket, where a peer's death is
// delivered as EOF exactly like a polite close — `resetAndDestroy` on an AF_UNIX
// socket throws `ERR_INVALID_HANDLE_TYPE`, which is how this was found. Writing
// to a closed peer would raise EPIPE, but only if the write wins a race against
// the EOF, and a check that flakes is worse than one that is honest about its
// reach.
//
// So this asserts the SHAPE of the fix rather than its effect, and says so.
// **Nothing exercises the real errno path** — not this script, not the live one,
// which drops a link the same polite way. That is the honest edge of both.
//
// **DRIVEN RED, and this is the input that does it** (H-28: a green is a claim
// about your check, so name what turns it red and confirm the world can supply
// one). Reinstating the single line this fix removed —
// `if (this.socket === socket) this.socket = null;` in `crabcast-link.ts`'s
// `error` handler — and rebuilding gives, measured 2026-08-14:
//
//     BUILD_EXIT=0        <- compiles, so the proof saw the mutation
//     PROOF_EXIT=1        FAILED — 1 check(s)
//     4b  FAIL  the 'error' handler does not clear this.socket
//
// **Exactly one check fails, and it is this one.** Every behavioural section
// above stays green, because AF_UNIX cannot produce the errno path they would
// need to notice — which is the whole reason this section is static, and is why
// a defect that reached production here would be invisible to all of them. A
// check with no reachable failing branch is not a weak check, it is one that
// does not exist while appearing to; this one has a branch and it has been
// walked.
const linkSource = fs.readFileSync(
  new URL('../src/crabcast-link.ts', import.meta.url),
  'utf8'
);
const errorHandler = linkSource.slice(
  linkSource.indexOf("socket.on('error'"),
  linkSource.indexOf("socket.on('close'")
);
check(
  "the 'error' handler does not clear this.socket — that is what would steal the notice from 'close'",
  errorHandler.length > 0 && !/this\.socket\s*=\s*null/.test(errorHandler),
  errorHandler.slice(0, 400)
);
check(
  "and 'close' is what emits the disconnect, so one teardown path serves both events",
  /socket\.on\('close'[\s\S]*?emitLinkState\(\{\s*state: 'disconnected'/.test(linkSource),
  'no disconnected emission found inside the close handler'
);

// ── 5. the negative control: a stale mirror and a fresh one differ ─────────
rule('5. control — a mirror that lived through an outage is NOT reported like one that did not');

// THIS IS THE ASSERTION THAT CARRIES THE PROPERTY. Everything above would still
// pass if the discontinuity were emitted for every mirror unconditionally, or
// for none — section 3 would just be measuring the resync. What must be true is
// that the two are TOLD APART, and that needs a mirror whose history differs by
// exactly one outage and nothing else.
censusRows = [censusRow(PANE_A, DIR_A), censusRow(PANE_B, DIR_B)];

const sessionB = await until(() => runtime.listActiveSessions().find((s) => s.key === KEY_B), 3_000);
check('a second session was adopted, after every drop this test makes', !!sessionB);

if (sessionB) {
  const eventsB = [];
  runtime.registerDataListener(sessionB.sessionId, (event) => eventsB.push(event));
  const subscribedB = await until(() => (ptyInitCounts.get(PANE_B) ?? 0) >= 1, 3_000);
  check('it subscribed', subscribedB === true);

  emitOnPane(PANE_B, 'FRESH-MIRROR\n');
  await until(() => eventsB.some((e) => e.kind === 'data'), 3_000);

  const gapsA = runtime.getSession(sessionA.sessionId).ptyDiscontinuities;
  const gapsB = runtime.getSession(sessionB.sessionId).ptyDiscontinuities;

  check(
    'the mirror that lived through the outages reports them',
    gapsA.length === 2,
    JSON.stringify(gapsA)
  );
  check(
    'the mirror that did not reports none',
    gapsB.length === 0,
    JSON.stringify(gapsB)
  );
  check(
    'SO THE TWO ARE DISTINGUISHABLE — which is the property, and what removing the signal destroys',
    gapsA.length !== gapsB.length,
    `stale=${gapsA.length} fresh=${gapsB.length}`
  );
  check(
    'both are streaming and both answer promptly — the reason the gap has to be SAID',
    eventsB.some((e) => e.kind === 'data') &&
      (runtime.getSession(sessionA.sessionId)?.ptyBuffer ?? '').length > 0,
    'a stale mirror that answers slowly would need no marker; this one does not'
  );
}

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
disposeA?.();
runtime.dispose();
await new Promise((resolve) => server.close(resolve));
console.log('   socket closed, runtime disposed');

console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — mirrors are re-subscribed across a reconnect, and the window in which events ' +
        'could have been missed is disclosed on the drop and settled on the repair'
  }\n`
);
process.exit(failures ? 1 : 0);
