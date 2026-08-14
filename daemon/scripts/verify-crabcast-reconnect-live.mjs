// Live proof for KAN-381, against a REAL CrabCast daemon, a REAL herdr pane and
// a REAL pty: the link is dropped while the pane keeps working, and what comes
// back is a re-subscribed mirror AND a disclosed gap.
//
// WHAT FAILURE THIS WOULD CATCH: a reconnect that restores the link and not the
// subscription — the terminal answering every question promptly, with pre-drop
// bytes, while CrabCast streams to a socket that no longer exists and nothing
// says a gap occurred. It would also catch the narrower thing no fake can see:
// a real `pty_init` after a real reconnect NOT carrying what the pane produced
// while we were away, which would make the resync a re-subscription without a
// catch-up and leave the mirror permanently short of a window nobody can
// recover.
//
// CI-RUNNABLE: no — needs a real CrabCast daemon at `BUTCHR_CRABCAST_SOCKET`,
// a real herdr and a real pty; it attempts nothing without one.
//
// ── HOW THE DROP IS PRODUCED, AND WHAT THAT COSTS ─────────────────────────
//
// The runtime is pointed at a **relay** — a Unix socket this script listens on
// and pipes byte-for-byte to the real `crabcast.sock`. Cutting the relay closes
// the runtime's socket for real, through the kernel, and CrabCast sees a client
// disconnect and later a fresh client connect: a real reconnect on both sides.
//
// The relay exists because the alternative is restarting the CrabCast daemon
// this machine's whole fleet is running on. It also means **no test hook exists
// in production code** — nothing in `CrabCastLink` can be asked to drop itself,
// which is the right shape for a thing that must only ever happen to us.
//
// WHAT THE RELAY LEAVES UNCOVERED, and nobody else covers it either:
//
//   - **A peer that RESTARTS.** CrabCast stays up throughout. A restart moves
//     `bootId` and `build.commit`, and the handshake re-reads both on the new
//     connection — that path is exercised by nothing here. It is the ordinary
//     deploy case, so this is the honest gap and it is named rather than
//     implied.
//   - **The errno path.** The relay closes politely. AF_UNIX has no RST, so a
//     peer dying rudely is delivered as EOF exactly like a polite close and no
//     socket in either proof produces ECONNRESET. `verify-crabcast-reconnect-
//     resync.mjs` §4b asserts the SHAPE of that fix statically and says so.
//   - **The `claude` launcher.** This uses `shell`, for the reason
//     `verify-crabcast-runtime-live.mjs` gives: it depends on nothing but herdr.
//   - **`spawnSession`.** The session here is ADOPTED, not spawned — see the
//     setup block. `verify-crabcast-runtime-live.mjs` owns the spawn path.
//
// The relay runs in this process. So the FIN is not initiated by calling
// anything on the link — it arrives over a socket, on the real event path — but
// it is not a peer of ours dying either. Stated because the two are different
// claims and only the first is made.
//
// ── WHAT IT SUPPLIES AND WHAT IT DOES NOT ─────────────────────────────────
//
// The gap's contents are NOT staged: a background job started in the real pane
// before the drop prints its marker while the link is down, so the bytes are
// produced by a real shell into a real pty with nobody subscribed. That is the
// one thing a constructed fixture cannot do, and it is why this ticket asks for
// a live reconnect rather than a fixture.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   BUTCHR_CRABCAST_SOCKET=~/.local/share/crabcast/crabcast.sock \
//     node daemon/scripts/verify-crabcast-reconnect-live.mjs [--verbose]
//
// It needs room for one more `shell` pane. CrabCast refuses at capacity, with
// its own figures, and on a busy fleet that is the ordinary answer rather than
// a fault. **The probe is therefore started by this script with `override:
// true`** — the escape CrabCast's own refusal names, recorded on their side
// with the figures it bypassed — and the runtime adopts it off the census. See
// the block above the setup for why the override lives here rather than in
// `CrabCastRuntime`, and note that `preempt` is deliberately never used.
//
// Every setup failure prints "setup:" and asserts nothing. None of them may be
// read as a red against this ticket.

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

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
 * Terminal output is not text — see `verify-crabcast-runtime-live.mjs` for the
 * run that established this. herdr emits a cursor-position escape before nearly
 * every character, so a plain `includes` finds nothing while every byte is
 * present and in order.
 */
function paneLetters(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
}

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
const realSocket = process.env.BUTCHR_CRABCAST_SOCKET;
if (!realSocket) {
  console.error(
    'setup: BUTCHR_CRABCAST_SOCKET is not set. This proof needs a real CrabCast daemon;\n' +
      'see the header. Nothing was attempted.'
  );
  process.exit(1);
}
if (!fs.existsSync(realSocket)) {
  console.error(`setup: no socket at ${realSocket}. Nothing was attempted.`);
  process.exit(1);
}

const TYPE = 'task';
const KEY = process.env.KAN381_PROBE_KEY ?? 'kan-381-reconnect-probe';
const workDir = workspaceDirFor(TYPE, KEY);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kan381-live-'));
const relayPath = path.join(work, 'relay.sock');

console.log(`real CrabCast   : ${realSocket}`);
console.log(`relay           : ${relayPath}`);
console.log(`probe agent     : ${TYPE}/${KEY}`);
console.log(`workspace       : ${workDir}`);

// ── the relay ──────────────────────────────────────────────────────────────
let relayServer = null;
const pairs = new Set();
/** Client connections the relay has accepted since it started. */
let relayAccepts = 0;

function startRelay() {
  return new Promise((resolve, reject) => {
    relayServer = net.createServer((client) => {
      relayAccepts++;
      const upstream = net.createConnection(realSocket);
      const pair = { client, upstream };
      pairs.add(pair);
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = () => {
        pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', drop);
      upstream.on('error', drop);
      client.on('close', drop);
      upstream.on('close', drop);
    });
    relayServer.on('error', reject);
    relayServer.listen(relayPath, resolve);
  });
}

/** Cut every live pair AND stop accepting, so the outage has a real duration. */
async function cutRelay() {
  for (const pair of [...pairs]) {
    pair.client.end();
    pair.upstream.destroy();
  }
  pairs.clear();
  await new Promise((resolve) => relayServer.close(resolve));
  if (fs.existsSync(relayPath)) fs.rmSync(relayPath, { force: true });
}

await startRelay();

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
process.env.BUTCHR_CRABCAST_SOCKET = relayPath;

const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });
check('the CrabCast runtime is serving', report.mode === 'crabcast', JSON.stringify(report));

// ── 1. a real agent, through the relay, on the real peer ───────────────────
rule('1. a real pane, mirrored through the relay');

const connected = await until(() => runtime.describe().link.connected, 8_000);
check('the link connected through the relay', connected === true, JSON.stringify(runtime.describe().link));

const peer = runtime.describe().link;
check(
  'and it handshook with the REAL CrabCast — a 40-char build commit came back',
  typeof peer.peerCommit === 'string' && peer.peerCommit.length === 40,
  JSON.stringify(peer)
);
console.log(`   peer build ${String(peer.peerCommit).slice(0, 12)}, contract v${peer.peerContractVersion}`);

// ── the probe pane: started BY THIS SCRIPT, adopted by the runtime ────────
//
// SETUP, NOT A VERDICT. The pane is configured and activated over a DIRECT
// connection to the real CrabCast — not through the runtime — and the runtime
// then picks it up from the census through `adoptFromCensus`. Two reasons, and
// the second is the one that matters:
//
//  1. **Capacity.** CrabCast refuses `activate_agent` when the machine is short
//     of CPU, with its own figures. On this fleet that refusal did not clear in
//     15 minutes of retrying — *"4.00 cores are in use, against the 3.0 cores
//     this machine leaves to agents"*, six Claude agents on four cores. The
//     refusal names its own escape: `override: true`, *"start it even at
//     capacity — recorded with the figures it bypassed"*. That is CrabCast's
//     documented interface rather than a way round it, and using it is
//     disclosed in this script's output every run. **`preempt` is NOT used** —
//     it stands another agent down, and no proof is worth that.
//  2. **It keeps the override out of production code.** Nothing in
//     `CrabCastRuntime` learns to bypass a capacity gate for a test's
//     convenience. `spawnSession` is untouched and still cannot send
//     `override`.
//
// WHAT THAT CHANGES ABOUT WHAT IS PROVED, stated because it is a real
// difference: the session under test is **adopted**, not spawned. So this does
// not exercise `spawnSession` — `verify-crabcast-runtime-live.mjs` owns that —
// and it does exercise adoption against a real peer, which is a bonus rather
// than the point. Everything this ticket is about happens after the mirror
// exists, and a mirror over an adopted session is the same mirror.
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

/** One request on a direct connection to the REAL socket, bypassing the relay. */
function askRealPeer(body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(realSocket);
    let buf = '';
    const id = `kan381-setup-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer to ${body.action} in 20s`));
    }, 20_000);
    socket.on('connect', () => socket.write(JSON.stringify({ ...body, id }) + '\n'));
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.id === id) {
          clearTimeout(timer);
          socket.destroy();
          resolve(frame);
          return;
        }
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const configured = await askRealPeer({
  action: 'configure_agent',
  path: workDir,
  priority: 1,
  launcher: 'shell',
  prompt: 'KAN-381 reconnect probe.'
});
if (configured.success !== true) {
  console.error(`\nsetup: configure_agent refused. Nothing was asserted.\n${configured.error}\n`);
  runtime.dispose();
  await cutRelay();
  process.exit(1);
}

console.log(
  '   setup: activating the probe with `override: true` — CrabCast is at capacity and says so;\n' +
    '          this is the escape its own refusal names, and it is recorded on their side with\n' +
    '          the figures it bypassed. `preempt` is NOT used: nothing is stood down.'
);
const activated = await askRealPeer({ action: 'activate_agent', path: workDir, override: true });
if (activated.success !== true) {
  console.error(`\nsetup: activate_agent refused even with override. Nothing was asserted.\n${activated.error}\n`);
  runtime.dispose();
  await cutRelay();
  process.exit(1);
}
console.log(`   setup: CrabCast started it as session ${activated.sessionId}`);

// The runtime learns about it the way it would learn about any agent a CrabCast
// daemon started that this daemon process did not: off the census.
const session = await until(() => runtime.listActiveSessions().find((s) => s.key === KEY), 30_000);
if (!session) {
  console.error(
    '\nsetup: the runtime never adopted the pane from the census, so there is no mirror to\n' +
      'test. Nothing was asserted.\n'
  );
  runtime.dispose();
  await cutRelay();
  process.exit(1);
}
check("the runtime adopted the running pane from CrabCast's own census", !!session);
check('and it is marked adopted rather than spawned', session.adopted === true, JSON.stringify({ adopted: session.adopted }));
console.log(`   butchr session  : ${session.sessionId}`);

/** Every event the listener saw, both arms, in order. */
const events = [];
const dispose = runtime.registerDataListener(session.sessionId, (event) => events.push(event));
check('registerDataListener returned a disposer', typeof dispose === 'function');

const mirrored = await until(
  () => (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length > 0,
  20_000
);
check('the mirror filled from the pty_init snapshot', mirrored === true);
check(
  'the session starts with no discontinuities recorded',
  runtime.getSession(session.sessionId).ptyDiscontinuities.length === 0,
  JSON.stringify(runtime.getSession(session.sessionId).ptyDiscontinuities)
);

const before = 'KANBEFOREDROP';
runtime.writePty(session.sessionId, `echo ${before}${String.fromCharCode(13)}`);
const sawBefore = await until(
  () => events.some((e) => e.kind === 'data' && paneLetters(e.data).includes(before)),
  25_000
);
check(
  'output before the drop reached the listener on the data arm',
  sawBefore === true,
  `${events.length} event(s), ${events.filter((e) => e.kind === 'data').length} of them data`
);

// ── 2. arrange output that will happen while we are NOT listening ──────────
rule('2. a background job in the real pane, timed to fire during the outage');

// THE MARKER IS ASSEMBLED BY THE SHELL, NOT TYPED. `paneLetters` strips
// punctuation, so a marker typed literally would appear in the pane the moment
// the command line is echoed — and "the listener saw it" would be true before
// the job ever ran. Splitting it across a variable means the literal string
// exists only in the job's OUTPUT.
const GAP_MARKER = 'KANGAPMARKER';
const cr = String.fromCharCode(13);
runtime.writePty(session.sessionId, `SUF=MARKER${cr}`);
await sleep(500);
runtime.writePty(session.sessionId, `(sleep 5; echo KANGAP$SUF; echo KANGAP$SUF) &${cr}`);
await sleep(500);

check(
  'the marker is NOT already in the mirror — the job has not run yet',
  !paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(GAP_MARKER),
  'the marker leaked from the typed command line; the assembly above did not work'
);

// ── 3. the drop ────────────────────────────────────────────────────────────
rule('3. the drop — a real socket close, with the pane still working');

const acceptsBeforeDrop = relayAccepts;
const dataEventsBeforeDrop = events.filter((e) => e.kind === 'data').length;
const droppedAt = Date.now();
await cutRelay();

const disclosed = await until(() => events.some((e) => e.kind === 'discontinuity'), 10_000);
check(
  'a discontinuity reached the listener while the link was still down',
  disclosed === true,
  `${events.length} event(s), none a discontinuity`
);

const openEvent = events.find((e) => e.kind === 'discontinuity');
if (openEvent) {
  const d = openEvent.discontinuity;
  check("it is sequence 1, cause 'link-dropped'", d.sequence === 1 && d.cause === 'link-dropped', JSON.stringify(d));
  check("resync is 'pending' — nothing has been repaired yet", d.resync === 'pending', JSON.stringify(d));
  check(
    'restoredAt and windowMs are null, not 0 — the gap is still growing',
    d.restoredAt === null && d.windowMs === null,
    JSON.stringify(d)
  );
  check(
    'lostAt is within a second of the moment this script cut the relay',
    Math.abs(Date.parse(d.lostAt) - droppedAt) < 1_000,
    `lostAt=${d.lostAt} cut=${new Date(droppedAt).toISOString()}`
  );
}
check(
  'the mirror is reported STALE rather than live',
  runtime.describe().ptyMirrorStates.stale === 1,
  JSON.stringify(runtime.describe().ptyMirrorStates)
);
check(
  'and the link agrees it is down',
  runtime.describe().link.connected === false,
  JSON.stringify(runtime.describe().link)
);

// The pane is still working through all of this — it belongs to herdr and
// CrabCast, and neither noticed us leave. The background job fires in here.
console.log('   waiting out the outage while the real pane keeps producing output…');
await sleep(8_000);

const missedAtListener = events.filter(
  (e) => e.kind === 'data' && paneLetters(e.data).includes(GAP_MARKER)
);
check(
  'THE EVENTS WERE GENUINELY MISSED: the marker never arrived on the data arm',
  missedAtListener.length === 0,
  JSON.stringify(missedAtListener.map((e) => e.data.slice(0, 60)))
);
check(
  'and no data at all arrived during the outage — the stream really was severed',
  events.filter((e) => e.kind === 'data').length === dataEventsBeforeDrop,
  `${events.filter((e) => e.kind === 'data').length - dataEventsBeforeDrop} chunk(s) arrived while down`
);

// ── 4. the reconnect ───────────────────────────────────────────────────────
rule('4. the reconnect — re-subscribed, caught up, and the window stated');

await startRelay();

const backUp = await until(() => runtime.describe().link.connected, 15_000);
check('the link reconnected', backUp === true, JSON.stringify(runtime.describe().link));
check(
  'CrabCast accepted a NEW client connection — a real reconnect on their side too',
  relayAccepts > acceptsBeforeDrop,
  `relay accepts ${relayAccepts}, was ${acceptsBeforeDrop}`
);

const settled = await until(
  () => runtime.getSession(session.sessionId).ptyDiscontinuities[0]?.resync === 'succeeded',
  20_000
);
check(
  'the discontinuity settled as succeeded',
  settled === true,
  JSON.stringify(runtime.getSession(session.sessionId).ptyDiscontinuities)
);

const gap = runtime.getSession(session.sessionId).ptyDiscontinuities[0];
if (gap) {
  check(
    'AND IT STATES THE WINDOW: lostAt → restoredAt, in milliseconds',
    gap.restoredAt !== null && typeof gap.windowMs === 'number' && gap.windowMs > 0,
    JSON.stringify(gap)
  );
  check(
    'the window covers the real outage — at least the 8s this script waited',
    gap.windowMs >= 8_000,
    `windowMs=${gap.windowMs}`
  );
  check(
    'and it is arithmetic on its own endpoints rather than an independent guess',
    gap.windowMs === Date.parse(gap.restoredAt) - Date.parse(gap.lostAt),
    JSON.stringify(gap)
  );
  console.log(`\n   THE GAP: ${gap.lostAt} → ${gap.restoredAt} = ${gap.windowMs}ms, ${gap.resync}\n`);
}

check(
  'the listener was told a second time, under the same sequence',
  events.filter((e) => e.kind === 'discontinuity').length >= 2 &&
    events.filter((e) => e.kind === 'discontinuity').every((e) => e.discontinuity.sequence === 1),
  JSON.stringify(events.filter((e) => e.kind === 'discontinuity').map((e) => e.discontinuity))
);

// AC1: mirrored state correct afterwards. This is the half a fake cannot prove,
// because it needs a REAL peer to have kept the bytes we were not there for.
const caughtUp = await until(
  () => paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(GAP_MARKER),
  20_000
);
check(
  'MIRRORED STATE IS CORRECT: the re-subscription snapshot carried what the pane printed while we were away',
  caughtUp === true,
  `buffer tail: ${paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').slice(-120)}`
);

// THE ASSERTION THAT WAS HERE WAS NON-DETERMINISTIC AND THE RED DRIVE IS WHAT
// CAUGHT IT — recorded rather than quietly deleted, because it is the kind of
// check that would have flaked in front of somebody else.
//
// It re-checked, at this point, that no data event had ever carried the marker
// — meaning "the snapshot did not leak into the stream path". It passed on the
// green run and FAILED on the mutated one, and **the mutation cannot affect
// which bytes CrabCast streams**: it only removed two calls that open and close
// a record. So the difference was timing, not behaviour. A live pane is redrawn
// by herdr, and a redraw legitimately re-streams text that is still on screen —
// including the marker printed during the outage. That is not a leak, and an
// assertion that cannot tell the two apart is one that reports the wrong thing
// on a schedule nobody controls.
//
// What is actually claimable is scoped to the outage window, and it is already
// asserted above, twice: the marker did not arrive on the data arm while the
// mirror was stale, and NO data at all did. That is the property — a consumer
// appending deltas has a hole its own copy cannot close, which is why the gap
// has to be announced rather than inferred from the buffer.
//
// The snapshot-does-not-fan-out invariant itself is owned at subscribe time by
// `verify-crabcast-runtime-live.mjs` §3, where there is no redraw to confuse it.

const after = 'KANAFTERRESYNC';
runtime.writePty(session.sessionId, `echo ${after}${cr}`);
const streamingAgain = await until(
  () => events.some((e) => e.kind === 'data' && paneLetters(e.data).includes(after)),
  25_000
);
check(
  'the stream is live again — new output reaches the listener, so the re-subscription is real',
  streamingAgain === true,
  `${events.filter((e) => e.kind === 'data').length} data event(s) total`
);
check(
  'the mirror is back to live and nothing is left open',
  runtime.describe().ptyMirrorStates.stale === 0 &&
    runtime.describe().ptyDiscontinuities.open === 0 &&
    runtime.describe().ptyDiscontinuities.total === 1,
  JSON.stringify(runtime.describe().ptyMirrorStates) + ' ' + JSON.stringify(runtime.describe().ptyDiscontinuities)
);

// ── 5. what a consumer attaching NOW is told ───────────────────────────────
rule('5. the durable half — a consumer that was not here still learns of the gap');

// The live event only reaches whoever was listening at the time. The extension
// re-issues pty_init on every reconnect of ITS OWN link to the daemon, so the
// consumer that most needs this is routinely one that was not present. It reads
// the record off the session, which is what router.ts sends with the buffer.
const late = [];
const disposeLate = runtime.registerDataListener(session.sessionId, (e) => late.push(e));
await sleep(500);
check(
  'a listener registering after the fact receives no replayed live event — correctly',
  late.every((e) => e.kind === 'data'),
  JSON.stringify(late.filter((e) => e.kind !== 'data'))
);
check(
  'but the session still holds the gap, which is what pty_init hands them',
  runtime.getSession(session.sessionId).ptyDiscontinuities.length === 1 &&
    runtime.getSession(session.sessionId).ptyDiscontinuities[0].resync === 'succeeded',
  JSON.stringify(runtime.getSession(session.sessionId).ptyDiscontinuities)
);
disposeLate?.();

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
dispose?.();
const terminated = runtime.terminateSession(session.sessionId);
check('the probe pane was terminated', terminated.success === true, JSON.stringify(terminated));
await sleep(1_500);
runtime.dispose();
await cutRelay();
fs.rmSync(work, { recursive: true, force: true });

const inWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
if (inWorkspaces && fs.existsSync(workDir)) {
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`   removed probe workspace ${workDir}`);
}
console.log(
  `   NOTE: CrabCast still holds a configured record for that path. Remove it with:\n` +
    `         crabcast forget ${workDir}`
);

console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — a real link drop against a real peer: the mirror was re-subscribed, the pane ' +
        'output produced during the outage was recovered into the mirror, and the window in ' +
        'which it was missed is stated on the wire rather than inferred'
  }\n`
);
process.exit(failures ? 1 : 0);
