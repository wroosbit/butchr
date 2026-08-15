// KAN-416 PROBE — not a verify script, and deliberately not named like one.
//
// It asserts nothing and gates nothing. It measures, per drop/reconnect cycle,
// where the marker that was printed during the outage actually is:
//
//   - `direct`   — a snapshot read from the REAL peer on a SEPARATE connection
//                  while our own link is still down. This is the pane's own
//                  answer to "did the job print, and do you still hold it?",
//                  taken independently of anything the runtime does.
//   - `resync`   — the mirror's buffer the moment the discontinuity settles
//                  `succeeded`, i.e. the re-subscription snapshot itself.
//   - `polled`   — the 20s `until` the live proof actually runs.
//
// Those three separate the two opposite findings KAN-416 names:
//   direct MISSING              -> the pane never had it; the ASSERTION is wrong
//                                  about what a correct snapshot contains.
//   direct HAS, resync MISSING  -> the re-subscription lost it; the RESYNC is
//                                  short, which is a gate-5 finding.
//
// Setup is copied from verify-crabcast-reconnect-live.mjs (relay, override
// activation, adoption off the census) because the point is to measure the same
// path that script measures. It uses its OWN probe key so it cannot collide
// with a concurrent run of that script, and it sweeps its own record.

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { createAgentRuntime } from '../dist/runtime-switch.js';
import { workspaceDirFor } from '../dist/herdr.js';

const CYCLES = Number(process.env.KAN416_CYCLES ?? 12);
const OUTAGE_MS = Number(process.env.KAN416_OUTAGE_MS ?? 8_000);
const verbose = process.argv.includes('--verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paneLetters(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .replace(/[^A-Za-z]/g, '');
}

/**
 * Replay a pane byte stream onto a screen and return what is VISIBLE.
 *
 * ⚠ THIS IS THE INSTRUMENT `paneLetters(...).includes(...)` ONLY LOOKS LIKE.
 * herdr repaints cell by cell and **emits only the cells that changed**, so a
 * string can be plainly on the screen while never appearing contiguously in the
 * byte stream — the search then answers "not there" about a mirror that is
 * perfectly correct. Replaying is stateful, so a cell that was not repainted
 * keeps the character it already had, which is what the pane itself does.
 */
function renderScreen(raw, rows = 24, cols = 200) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 0;
  let c = 0;
  const CSI = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/y;
  const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (ch === '\x1b') {
      OSC.lastIndex = i;
      if (OSC.exec(raw)) {
        i = OSC.lastIndex;
        continue;
      }
      CSI.lastIndex = i;
      const m = CSI.exec(raw);
      if (m) {
        const p = m[1].split(';');
        if (m[3] === 'H' || m[3] === 'f') {
          r = Math.max(0, (parseInt(p[0] || '1', 10) || 1) - 1);
          c = Math.max(0, (parseInt(p[1] || '1', 10) || 1) - 1);
        } else if (m[3] === 'J' && (p[0] === '2' || p[0] === '')) {
          for (const row of grid) row.fill(' ');
        } else if (m[3] === 'K') {
          if (r < rows) for (let x = c; x < cols; x++) grid[r][x] = ' ';
        }
        i = CSI.lastIndex;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '\n') {
      r = Math.min(rows - 1, r + 1);
      i++;
      continue;
    }
    if (ch === '\r') {
      c = 0;
      i++;
      continue;
    }
    if (ch === '\x07' || ch === '\b') {
      i++;
      continue;
    }
    if (r < rows && c < cols) grid[r][c] = ch;
    c++;
    i++;
  }
  return grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n');
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

const realSocket = process.env.BUTCHR_CRABCAST_SOCKET;
if (!realSocket || !fs.existsSync(realSocket)) {
  console.error('setup: BUTCHR_CRABCAST_SOCKET missing or not a socket. Nothing attempted.');
  process.exit(1);
}

const TYPE = 'task';
const KEY = process.env.KAN416_PROBE_KEY ?? 'kan-416-snapshot-probe';
const workDir = workspaceDirFor(TYPE, KEY);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kan416-probe-'));
const relayPath = path.join(work, 'relay.sock');

console.log(`real CrabCast : ${realSocket}`);
console.log(`relay         : ${relayPath}`);
console.log(`probe agent   : ${TYPE}/${KEY}`);
console.log(`cycles        : ${CYCLES}, outage ${OUTAGE_MS}ms`);

async function cleanup() {
  const { execFileSync } = await import('child_process');
  const run = (args) =>
    execFileSync('crabcast', args, { stdio: 'pipe', timeout: 20_000, encoding: 'utf8' });
  try {
    run(['deactivate', workDir]);
    console.log(`   crabcast deactivate: stood the probe down at ${workDir}`);
  } catch (err) {
    if (verbose) console.log(`   deactivate declined: ${String(err).split('\n')[0]}`);
  }
  try {
    run(['forget', workDir]);
    console.log(`   crabcast forget returned OK — no record remains for ${workDir}`);
  } catch (err) {
    console.log(`   COULD NOT forget ${workDir} — remove by hand (two commands, not chained).`);
  }
  try {
    if (workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`) && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`   removed probe workspace ${workDir}`);
    }
  } catch {
    console.log(`   could not remove ${workDir}`);
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

// A SIGTERM must still sweep the record. Measured the hard way on 2026-08-15:
// the first long run of this probe was killed by a harness timeout and left a
// configured record and a running pane behind, which had to be swept by hand.
let sweeping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (sweeping) return;
    sweeping = true;
    console.log(`\n${sig} — sweeping before exit.`);
    try {
      await cleanup();
    } finally {
      process.exit(130);
    }
  });
}

// ── the relay ──────────────────────────────────────────────────────────────
let relayServer = null;
const pairs = new Set();
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

async function cutRelay() {
  for (const pair of [...pairs]) {
    pair.client.end();
    pair.upstream.destroy();
  }
  pairs.clear();
  await new Promise((resolve) => relayServer.close(resolve));
  if (fs.existsSync(relayPath)) fs.rmSync(relayPath, { force: true });
}

/** One request on a direct connection to the REAL socket, bypassing the relay. */
function askRealPeer(body, { holdMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(realSocket);
    let buf = '';
    const id = `kan416-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
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
          // Hold the socket open briefly only if asked; a pty_init subscription
          // ends when the connection closes, and we do not want to keep one.
          setTimeout(() => socket.destroy(), holdMs);
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

await startRelay();

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
process.env.BUTCHR_CRABCAST_SOCKET = relayPath;

const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });
if (report.mode !== 'crabcast') {
  console.error(`setup: runtime is ${report.mode}, not crabcast.`);
  process.exit(1);
}

const connected = await until(() => runtime.describe().link.connected, 8_000);
if (!connected) {
  console.error('setup: link never connected through the relay.');
  runtime.dispose();
  await cutRelay();
  process.exit(1);
}

if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

const configured = await askRealPeer({
  action: 'configure_agent',
  path: workDir,
  priority: 1,
  launcher: 'shell',
  prompt: 'KAN-416 snapshot probe.'
});
if (configured.success !== true) {
  console.error(`setup: configure_agent refused: ${configured.error}`);
  runtime.dispose();
  await cutRelay();
  process.exit(1);
}

const activated = await askRealPeer({ action: 'activate_agent', path: workDir, override: true });
if (activated.success !== true) {
  console.error(`setup: activate_agent refused even with override: ${activated.error}`);
  runtime.dispose();
  await cutRelay();
  await cleanup();
  process.exit(1);
}
console.log(`   setup: CrabCast started it as session ${activated.sessionId}`);
let remoteId = activated.sessionId;

const session = await until(() => runtime.listActiveSessions().find((s) => s.key === KEY), 30_000);
if (!session) {
  console.error('setup: the runtime never adopted the pane from the census.');
  runtime.dispose();
  await cutRelay();
  await cleanup();
  process.exit(1);
}
console.log(`   butchr session: ${session.sessionId}`);

const events = [];
runtime.registerDataListener(session.sessionId, (e) => events.push(e));

const mirrored = await until(
  () => (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length > 0,
  20_000
);
if (!mirrored) {
  console.error('setup: the mirror never filled.');
  runtime.dispose();
  await cutRelay();
  await cleanup();
  process.exit(1);
}

const cr = String.fromCharCode(13);
const buf = () => runtime.getSession(session.sessionId)?.ptyBuffer ?? '';

// Warm-up: make sure the shell is actually executing what we type before any
// cycle is counted. A cycle whose marker never printed is not a measurement of
// the resync, and this is what tells the two apart.
runtime.writePty(session.sessionId, `echo KANPROBEREADY${cr}`);
const ready = await until(
  () => events.some((e) => e.kind === 'data' && paneLetters(e.data).includes('KANPROBEREADY')),
  25_000
);
console.log(`   shell responsive: ${ready === true}`);
if (!ready) {
  console.error('setup: the shell never echoed the warm-up marker.');
  runtime.dispose();
  await cutRelay();
  await cleanup();
  process.exit(1);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const rows = [];
const ROWS_OUT = process.env.KAN416_ROWS_OUT ?? path.join(os.tmpdir(), `kan416-probe-${process.pid}.json`);
console.log(`rows file     : ${ROWS_OUT}`);

for (let i = 0; i < CYCLES; i++) {
  const L = LETTERS[i % LETTERS.length] + LETTERS[Math.floor(i / LETTERS.length) % LETTERS.length];
  const MARKER = `KANGAPMARKER${L}`;
  const row = { cycle: i + 1, marker: MARKER };

  runtime.writePty(session.sessionId, `SUF=MARKER${L}${cr}`);
  await sleep(500);
  runtime.writePty(session.sessionId, `(sleep 5; echo KANGAP$SUF; echo KANGAP$SUF) &${cr}`);
  await sleep(500);

  row.preDropLen = buf().length;
  row.markerLeakedIntoCommandLine = paneLetters(buf()).includes(MARKER);
  // Did the WHOLE typed line reach bash? Read off the rendered screen, not the
  // stream: the tail `) &` is the half that goes missing when a write is cut
  // short, and a bash left holding an unbalanced `(` runs nothing ever again.
  const preScreen = renderScreen(buf());
  row.commandLineIntact = preScreen.includes('echo KANGAP$SUF) &');
  row.atContinuationPrompt = /\n> /.test(preScreen) || preScreen.endsWith('\n>');

  const dataBefore = events.filter((e) => e.kind === 'data').length;
  const acceptsBefore = relayAccepts;
  const droppedAt = Date.now();
  await cutRelay();

  const disclosed = await until(() => events.some((e) => e.kind === 'discontinuity'), 10_000);
  row.disclosed = disclosed === true;

  // Wait out the outage. The background job fires ~5s after it was typed, so
  // ~4s into this window.
  await sleep(OUTAGE_MS);

  // ── THE INDEPENDENT READ ────────────────────────────────────────────────
  // Our own link is still down. Ask the REAL peer, on a connection of our own,
  // what the pane holds right now. This is the pane's answer, not the mirror's.
  let direct = null;
  try {
    const res = await askRealPeer({ action: 'pty_init', sessionId: remoteId });
    direct = typeof res.buffer === 'string' ? res.buffer : null;
    row.directRefused = res.success === true ? null : String(res.error ?? 'no reason');
  } catch (err) {
    row.directError = String(err).split('\n')[0];
  }
  row.directLen = direct === null ? null : direct.length;
  row.directHasMarker = direct === null ? null : paneLetters(direct).includes(MARKER);
  // The same question asked of the SCREEN rather than of the stream.
  row.directScreenHasMarker = direct === null ? null : renderScreen(direct).includes(MARKER);
  if (direct !== null) {
    const letters = paneLetters(direct);
    const at = letters.indexOf(MARKER);
    row.directBytesAfterMarker = at < 0 ? null : letters.length - at - MARKER.length;
    row.directTail = letters.slice(-90);
  }

  row.missedAtListener =
    events.filter((e) => e.kind === 'data' && paneLetters(e.data).includes(MARKER)).length === 0;
  row.silentDuringOutage = events.filter((e) => e.kind === 'data').length === dataBefore;

  // ── the reconnect ───────────────────────────────────────────────────────
  await startRelay();
  const backUp = await until(() => runtime.describe().link.connected, 15_000);
  row.linkBack = backUp === true;
  row.newAccept = relayAccepts > acceptsBefore;

  const settledAt = { t: null };
  const settled = await until(() => {
    const d = runtime.getSession(session.sessionId).ptyDiscontinuities.slice(-1)[0];
    if (d?.resync === 'succeeded') {
      settledAt.t = Date.now();
      return true;
    }
    return false;
  }, 20_000);
  row.settled = settled === true;
  row.settleMs = settledAt.t ? settledAt.t - droppedAt : null;

  // The mirror buffer AS SOON AS the resync settled: `closeGap` runs after the
  // snapshot has replaced the buffer, so this is the snapshot (plus at most the
  // few frames that arrived between the replace and this read).
  const atResync = buf();
  row.resyncLen = atResync.length;
  row.resyncHasMarker = paneLetters(atResync).includes(MARKER);
  row.resyncScreenHasMarker = renderScreen(atResync).includes(MARKER);
  {
    const letters = paneLetters(atResync);
    const at = letters.indexOf(MARKER);
    row.resyncBytesAfterMarker = at < 0 ? null : letters.length - at - MARKER.length;
    row.resyncTail = letters.slice(-90);
  }

  // ── what the live proof's assertion actually does ───────────────────────
  const pollStart = Date.now();
  const caughtUp = await until(() => paneLetters(buf()).includes(MARKER), 20_000);
  row.polledCaughtUp = caughtUp === true;
  row.polledMs = caughtUp ? Date.now() - pollStart : null;
  row.afterPollLen = buf().length;
  row.afterPollTail = paneLetters(buf()).slice(-90);

  // Bytes the pane streamed to us in the polling window — the redraw rate.
  row.dataEventsThisCycle = events.filter((e) => e.kind === 'data').length - dataBefore;

  // ── THE DISCRIMINATOR ───────────────────────────────────────────────────
  // A tty echoes keystrokes in the line discipline, with no help from the
  // shell, so "the command line was echoed" says nothing about whether
  // anything RAN it. This types one more command and waits for its OUTPUT: if
  // that comes back, the shell is executing and a missing marker is a missing
  // marker; if it does not, the pane stopped running things and the marker
  // never printed at all. Those are opposite findings and nothing above tells
  // them apart.
  runtime.writePty(session.sessionId, `W=IVE${L}${cr}`);
  await sleep(400);
  runtime.writePty(session.sessionId, `echo KANAL$W${cr}`);
  const alive = await until(() => paneLetters(buf()).includes(`KANALIVE${L}`), 10_000);
  row.shellAlive = alive === true;

  if (process.env.KAN416_DUMP_DIR) {
    const d = process.env.KAN416_DUMP_DIR;
    fs.mkdirSync(d, { recursive: true });
    if (direct !== null) fs.writeFileSync(path.join(d, `cycle${row.cycle}-direct.raw`), direct);
    fs.writeFileSync(path.join(d, `cycle${row.cycle}-resync.raw`), atResync);
    fs.writeFileSync(path.join(d, `cycle${row.cycle}-afterpoll.raw`), buf());
  }

  rows.push(row);
  // Written every cycle, not at the end: a run that is killed still leaves its
  // measurements behind.
  fs.writeFileSync(ROWS_OUT, JSON.stringify(rows, null, 2));
  console.log(
    `cycle ${String(row.cycle).padStart(2)} ${MARKER}: direct=${row.directHasMarker} ` +
      `resync=${row.resyncHasMarker} polled=${row.polledCaughtUp} ` +
      `screen[d=${row.directScreenHasMarker} r=${row.resyncScreenHasMarker}] ` +
      `cmdIntact=${row.commandLineIntact} shellAlive=${row.shellAlive} ` +
      `| directLen=${row.directLen} resyncLen=${row.resyncLen} settleMs=${row.settleMs} ` +
      `polledMs=${row.polledMs}`
  );
  if (verbose || row.polledCaughtUp !== true) {
    console.log(`      direct tail : ${row.directTail}`);
    console.log(`      resync tail : ${row.resyncTail}`);
    console.log(`      afterPoll   : ${row.afterPollTail}`);
  }

  await sleep(1_000);
}

// ── verdict-free summary ───────────────────────────────────────────────────
const n = rows.length;
const green = rows.filter((r) => r.polledCaughtUp === true).length;
console.log(`\n${'═'.repeat(72)}`);
console.log(`RATE: the live proof's assertion would have passed ${green}/${n} cycles.`);
console.log(`  direct had the marker  : ${rows.filter((r) => r.directHasMarker === true).length}/${n}`);
console.log(`  resync snapshot had it : ${rows.filter((r) => r.resyncHasMarker === true).length}/${n}`);
console.log(`  polled found it        : ${green}/${n}`);
console.log(
  `  snapshot lengths       : direct ${Math.min(...rows.map((r) => r.directLen ?? Infinity))}–${Math.max(
    ...rows.map((r) => r.directLen ?? 0)
  )}, resync ${Math.min(...rows.map((r) => r.resyncLen))}–${Math.max(...rows.map((r) => r.resyncLen))}`
);
console.log(`${'═'.repeat(72)}\n`);

fs.writeFileSync(ROWS_OUT, JSON.stringify(rows, null, 2));
console.log(`rows written to ${ROWS_OUT}`);

runtime.dispose();
await cutRelay();
await cleanup();
process.exit(0);
