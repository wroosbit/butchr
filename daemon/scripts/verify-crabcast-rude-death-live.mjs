// Live proof for KAN-456 (gate 5, leg 2), against a REAL CrabCast daemon that is
// REALLY killed — rudely on one arm, politely on the other, in ONE run, with the
// same harness and the same assertions on both.
//
// WHAT FAILURE THIS WOULD CATCH: code that comes to depend on telling a rude
// CrabCast death from a polite one. Measured here, that distinction does not
// exist on the socket: an AF_UNIX peer that is SIGKILLed and one that shuts down
// cleanly deliver byte-identical events to the reading end, and the
// `LinkStateEvent` Butchr publishes to every owner of connection-borne state
// carries `errno: null` on both. So a branch on `event.errno` — or any handling
// keyed to "the peer died badly" — is a branch on a value that cannot carry the
// fact it is being asked for, and it would be wrong in the direction that looks
// like it works: the reassuring arm is the one that always fires. §4 is the gate
// that goes red when such a branch appears.
//
// It would also catch the narrower thing that makes the above easy to get wrong.
// ECONNRESET *is* reachable on an established AF_UNIX connection — §3 produces it
// — but it is an artifact of WRITING into the teardown window, and it arrives on
// BOTH arms. Reading it as "the peer died rudely" is the specific mistake this
// script exists to make impossible to hold.
//
// CI-RUNNABLE: no — needs the `crabcast` binary on PATH. Every setup failure
// prints "setup:" and asserts nothing; none may be read as a red against KAN-456.
//
// ── WHICH SECTIONS SURVIVE A FAILED BUILD, STATED BECAUSE THE EXIT CODE BLENDS ──
//
// This script is one of the mixed kind. §4 reads `daemon/src/*.ts` AS TEXT, so it
// tests what you wrote and its verdict stands after a failed build. §1, §2, §3
// and §5 import `CrabCastLink` from `../dist/`, so after a failed build they test
// the PREVIOUS build and their verdicts are about code you did not write. Read
// the section, never the exit code. Run with `--static-only` to get §4 alone,
// which needs neither a build nor a peer.
//
// ── HOW THE DEATHS ARE PRODUCED, AND WHY IT IS SAFE ─────────────────────────
//
// This script starts a CrabCast of its OWN — `crabcast daemon --config <scratch>`
// over a `mkdtemp` dataDir — and signals only pids it spawned itself, asserted in
// `signalOwn()` rather than merely intended (the guard is `task/KAN-403`'s
// `if (!spawnedPids.has(pid)) throw`, copied deliberately). The fleet's daemon at
// ~/.local/share/crabcast is never signalled, never read and never written.
//
// ⚠ `~/code/wroosbit/crabcast` IS THE LIVE DEPLOY CHECKOUT and this script does
// not build in it, install into it, or move it. It does EXECUTE the installed
// `crabcast` binary, which is a symlink into that tree's `dist/` — that is
// unavoidable for any live proof against a real peer, it is what
// `verify-crabcast-peer-restart-live.mjs` already does on `main`, and running a
// binary is not what the hazard notice on KAN-456 forbids.
//
// No CrabCast source was read. Everything asserted about their behaviour here is
// an observation of the wire and of the filesystem, reproducible by re-running.
//
// ── WHAT THIS SCRIPT SUPPLIES AND WHAT IT DOES NOT ──────────────────────────
//
// **This script spawns the peer it then kills**, so the death is one this run
// produced rather than one it found. What that leaves uncovered is a peer death
// under a mirror somebody else established, and a death by any route other than a
// signal — an OOM kill, a machine losing power, a container stop. Nothing covers
// those, and no run here should be read as though it did.
//
// It also does NOT establish a pty mirror. §1 asserts on the `LinkStateEvent`
// itself, which is the ENTIRE interface between the socket layer and every owner
// of connection-borne state — `CrabCastRuntime.onLinkState` is its only consumer
// — so identical events across the arms is a claim about what the layer above
// CAN see, not a claim that mirrors were watched dying. A proof that watched
// mirrors across a rude death would be a stronger claim than this one makes, and
// it is `verify-crabcast-peer-restart-live.mjs` that drives the mirror path.
//
// ── RUNNING IT ──────────────────────────────────────────────────────────────
//
//   node daemon/scripts/verify-crabcast-rude-death-live.mjs [--verbose] [--static-only]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const verbose = process.argv.includes('--verbose');
const staticOnly = process.argv.includes('--static-only');

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
}

function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`         ${String(detail).split('\n').slice(0, 8).join('\n         ')}`);
  } else if (verbose && detail) {
    console.log(`         ${String(detail).split('\n')[0]}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, budgetMs, stepMs = 120) {
  const deadline = Date.now() + budgetMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

// ══════════════════════════════════════════════════════════════════════════
// §4 first, because it needs neither a build nor a peer.
// ══════════════════════════════════════════════════════════════════════════

function sectionFourStaticErrnoGate() {
  rule('§4  STATIC: nothing branches on `event.errno` — the "no difference is needed" gate');

  console.log(
    `   This section reads daemon/src as TEXT. Its verdict is about what you wrote\n` +
      `   and survives a failed build.\n`
  );

  let sources;
  try {
    sources = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ file: f, text: fs.readFileSync(path.join(srcDir, f), 'utf8') }));
  } catch (err) {
    console.error(`setup: could not read ${srcDir}: ${err?.message ?? err}`);
    process.exit(1);
  }

  // Every read of the drop event's errno, anywhere in the daemon.
  const reads = [];
  for (const { file, text } of sources) {
    text.split('\n').forEach((line, i) => {
      if (/event\.errno/.test(line)) reads.push({ file, line: i + 1, text: line.trim() });
    });
  }

  console.log(`   ${reads.length} read(s) of \`event.errno\` across ${sources.length} source file(s):`);
  for (const r of reads) console.log(`      ${r.file}:${r.line}  ${r.text.slice(0, 96)}`);
  console.log('');

  check(
    '`event.errno` is read at all (if this is 0 the gate has nothing to guard and the ' +
      'grep has probably drifted off the field name)',
    reads.length > 0,
    `found ${reads.length} reads. If the field was renamed, rename it here too — a gate ` +
      `that matches nothing passes forever.`
  );

  // A read is presentational when it is inside a template literal — that is how
  // the one legitimate consumer uses it, as a clause in a log line. A read in a
  // control position (`if`, `switch`, a standalone ternary, a comparison against
  // a literal errno) is a branch on a value this ticket measured to be `null` on
  // both arms, which is the defect.
  const branchy = reads.filter((r) => {
    const t = r.text;
    if (/^\s*\*/.test(t) || /^\s*\/\//.test(t)) return false; // a comment is not a branch
    const insideTemplate = /\$\{[^}]*event\.errno/.test(t);
    if (insideTemplate) return false;
    return /\b(if|switch|while)\s*\(|===|!==|==|case\s|\?\s*[^:]*:/.test(t);
  });

  for (const b of branchy) console.log(`      ⚠ control-position read: ${b.file}:${b.line}  ${b.text.slice(0, 96)}`);

  check(
    'no control flow branches on `event.errno` — every read is presentational',
    branchy.length === 0,
    branchy.length === 0
      ? 'the only reads are inside template literals (log lines)'
      : `${branchy.length} read(s) sit in a control position. A rude death and a polite close ` +
        `both deliver errno=null (§1), so such a branch takes the same arm for BOTH and is ` +
        `wrong in the direction that looks like it works. If you meant to branch on a ` +
        `CONNECT-time errno (ECONNREFUSED/ENOENT, §5) that is a different value read off ` +
        `describe().lastErrno, not off the drop event.`
  );
}

sectionFourStaticErrnoGate();

if (staticOnly) {
  rule(`--static-only: §1, §2, §3 and §5 not run. ${failures} failure(s) in §4.`);
  process.exit(failures ? 1 : 0);
}

// ══════════════════════════════════════════════════════════════════════════
// Live setup
// ══════════════════════════════════════════════════════════════════════════

let CrabCastLink;
try {
  ({ CrabCastLink } = await import('../dist/crabcast-link.js'));
} catch (err) {
  console.error(`setup: daemon/dist is missing or stale — run \`npm run build\` first (${err?.message ?? err})`);
  process.exit(1);
}

// `os.tmpdir()` rather than the workspace: a unix socket address is a fixed
// 104-byte buffer and an over-long path is silently TRUNCATED. A Butchr
// workspace path is already most of that budget.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan456-'));
const dataDir = path.join(scratch, 'cc');
const configPath = path.join(scratch, 'crabcast.config.json');
const socketPath = path.join(dataDir, 'crabcast.sock');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }) + '\n');

if (socketPath.length > 104) {
  console.error(`setup: socket path is ${socketPath.length} chars, over the 104-byte limit.`);
  process.exit(1);
}

console.log(`\nisolated dataDir : ${dataDir}`);
console.log(`isolated socket  : ${socketPath} (${socketPath.length} chars)`);
console.log(
  `\nThe fleet's own CrabCast at ~/.local/share/crabcast is NOT touched: this run signals\n` +
    `only pids it spawned itself, and its registry lives in the scratch dir above.\n`
);

/** Every daemon pid this script has spawned. Nothing else may ever be signalled. */
const spawnedPids = new Set();
let currentProc = null;

/**
 * Send a signal to a daemon this script started.
 *
 * The pid is checked against the spawned set BEFORE any signal is sent, and that
 * is a guard rather than a comment: the one way this script could harm the fleet
 * is by signalling a daemon it does not own, and "we only ever pass our own pid"
 * is exactly the kind of claim that survives a refactor while stopping being true.
 */
function signalOwn(pid, sig) {
  if (!spawnedPids.has(pid)) {
    throw new Error(
      `refusing to signal pid ${pid}: this script did not spawn it. Spawned: ${[...spawnedPids].join(', ')}`
    );
  }
  process.kill(pid, sig);
}

/** One request on a throwaway direct connection to the isolated socket. */
function askPeer(body, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    let buf = '';
    const id = `kan456-${process.pid}-${Math.round(Math.random() * 1e9)}`;
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`no answer to ${body.action} in ${timeoutMs}ms`));
    }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify({ ...body, id }) + '\n'));
    s.on('data', (chunk) => {
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
          s.destroy();
          resolve(frame);
          return;
        }
      }
    });
    s.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function startDaemon(label) {
  const logPath = path.join(scratch, `daemon-${label}.log`);
  const out = fs.openSync(logPath, 'a');
  const proc = spawn('crabcast', ['daemon', '--config', configPath], {
    stdio: ['ignore', out, out],
    detached: false
  });
  spawnedPids.add(proc.pid);
  currentProc = proc;
  const up = await until(async () => {
    if (!fs.existsSync(socketPath)) return false;
    try {
      const s = await askPeer({ action: 'daemon_status' }, 5_000);
      return s.success === true ? s : false;
    } catch {
      return false;
    }
  }, 30_000);
  if (!up) throw new Error(`daemon ${label} never answered; see ${logPath}`);
  console.log(
    `   daemon ${label}: pid ${proc.pid}, bootId ${String(up.bootId).slice(0, 8)}, ` +
      `build ${String(up.build?.commit).slice(0, 12)}, contract v${up.contractVersion}`
  );
  return proc;
}

/**
 * A raw observer connection, recording the socket's own event sequence.
 *
 * `mode: 'passive'` never writes after the death. `mode: 'writing'` hammers
 * writes across the teardown window, which is where ECONNRESET lives if it lives
 * anywhere on this transport.
 */
function observer(mode) {
  const events = [];
  let t0 = 0;
  const at = () => (t0 ? Date.now() - t0 : null);
  const socket = net.createConnection(socketPath);
  const rec = (name, extra) => events.push({ name, atMs: at(), ...extra });
  socket.on('end', () => rec('end'));
  socket.on('error', (e) => rec('error', { code: e.code ?? null }));
  socket.on('close', (hadError) => rec('close', { hadError }));
  return {
    mode,
    socket,
    events,
    ready: new Promise((res, rej) => {
      socket.once('connect', res);
      socket.once('error', rej);
    }),
    startClock() {
      t0 = Date.now();
    },
    /** The event NAMES in order — the timing-free shape this script asserts on. */
    shape() {
      return events.map((e) => (e.name === 'close' ? `close(hadError=${e.hadError})` : e.name === 'error' ? `error(${e.code})` : e.name));
    }
  };
}

/** A CrabCastLink, connected and handshaken, recording its own LinkStateEvents. */
async function makeLink(label) {
  const events = [];
  const link = new CrabCastLink({ socketPath, reconnectDelayMs: 400, log: () => {} });
  link.onLinkState((e) => events.push({ ...e }));
  link.connect();
  const up = await until(() => link.connected, 10_000);
  if (!up) throw new Error(`link «${label}» never connected`);
  await link.peerIdentified();
  return { link, events, drops: () => events.filter((e) => e.state === 'disconnected') };
}

/** One arm: a peer started, observed four ways, and killed with `signal`. */
async function runArm(label, signal) {
  rule(`ARM «${label}» — peer killed with ${signal}`);
  const proc = await startDaemon(label);

  // Two real links. The difference between them is the whole of §3: `idle` has
  // nothing in flight when the peer dies, `busy` is mid-request. Both see the
  // SAME death.
  const idle = await makeLink('idle');
  const busy = await makeLink('busy');

  const passive = observer('passive');
  const writing = observer('writing');
  await Promise.all([passive.ready, writing.ready]);

  passive.startClock();
  writing.startClock();

  signalOwn(proc.pid, signal);

  // The writing observer and the `busy` link both write across the teardown
  // window; `idle` and `passive` never do. 40 × 5ms straddles it generously
  // without asserting on any timing.
  for (let i = 0; i < 40; i++) {
    try {
      writing.socket.write(JSON.stringify({ action: 'daemon_status', id: `pm-${i}` }) + '\n', () => {});
    } catch {
      /* the stream is already destroyed; recorded via its events, not here */
    }
    // A rejection here is the expected outcome once the link notices; it is the
    // link's DROP EVENT we are measuring, never this promise.
    busy.link.request({ action: 'daemon_status' }).catch(() => {});
    await sleep(5);
  }

  const peerExited = await until(() => {
    try {
      process.kill(proc.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 15_000);

  // Let both links notice, and let them make at least one reconnect attempt so
  // that §5's post-mortem errno is populated.
  await until(() => idle.drops().length > 0 && busy.drops().length > 0, 10_000);
  await sleep(1_500);

  const socketFileLeft = fs.existsSync(socketPath);

  // What a FRESH connect attempt sees now that the peer is gone.
  let postMortemErrno;
  try {
    await new Promise((res, rej) => {
      const s = net.createConnection(socketPath);
      s.once('connect', () => {
        s.destroy();
        res();
      });
      s.once('error', rej);
    });
    postMortemErrno = '(connected — a peer is still answering!)';
  } catch (err) {
    postMortemErrno = err.code ?? err.message;
  }

  const described = idle.link.describe();
  idle.link.close();
  busy.link.close();
  passive.socket.destroy();
  writing.socket.destroy();

  // A rude death leaves the socket file behind; remove it so the next arm binds
  // cleanly. This is inside our own scratch dir and reaches nothing else.
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* the next bind will report it */
    }
  }

  const idleDrops = idle.drops();
  const busyDrops = busy.drops();

  return {
    label,
    signal,
    peerExited: peerExited === true,
    idleDropCount: idleDrops.length,
    idleDropErrno: idleDrops.length ? idleDrops[0].errno : '(no drop event)',
    busyDropCount: busyDrops.length,
    busyDropErrno: busyDrops.length ? busyDrops[0].errno : '(no drop event)',
    passiveShape: passive.shape(),
    writingShape: writing.shape(),
    writingErrno: (writing.events.find((e) => e.name === 'error') ?? {}).code ?? null,
    passiveEvents: passive.events,
    writingEvents: writing.events,
    socketFileLeft,
    postMortemErrno,
    describedLastErrno: described.lastErrno,
    connections: described.connections,
    attempts: described.attempts
  };
}

/**
 * The errnos a write meeting a socket mid-teardown can produce.
 *
 * **A set rather than a value, and that is the KAN-416 lesson applied rather
 * than quoted.** Which one you get depends on whether the write lands before or
 * after the kernel finished tearing the peer end down — measured varying
 * BETWEEN RUNS on the same arm, so an assertion pinning the exact value is a
 * flake with a ticket number waiting for it. `ECONNRESET` dominates
 * (12/12 in a dedicated 6×2 repeat); `EPIPE` has been seen once.
 */
const WRITE_RACE_ERRNOS = ['ECONNRESET', 'EPIPE'];

async function cleanup() {
  try {
    if (currentProc?.pid && spawnedPids.has(currentProc.pid)) {
      try {
        signalOwn(currentProc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await until(() => {
        try {
          process.kill(currentProc.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000);
    }
  } catch {
    /* nothing to stop */
  }
  // Registry, sidecars and socket all live under `scratch`, so this one removal
  // is the whole sweep. Nothing here reaches ~/.local/share/crabcast.
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch (err) {
    console.log(`   could NOT remove ${scratch}: ${err?.message ?? err}`);
  }
}

let rude;
let polite;
try {
  rude = await runArm('rude', 'SIGKILL');
  polite = await runArm('polite', 'SIGTERM');
} catch (err) {
  console.error(`\nsetup: the live arms could not be driven — ${err?.message ?? err}`);
  console.error('setup: nothing above §4 was asserted. This is not a red against KAN-456.');
  await cleanup();
  process.exit(1);
}
await cleanup();

// ══════════════════════════════════════════════════════════════════════════
// The measurement, side by side, BEFORE any assertion reads it.
// ══════════════════════════════════════════════════════════════════════════

rule('MEASURED — rude (SIGKILL) beside polite (SIGTERM), one run, same harness');

const rows = [
  ['peer really exited', String(rude.peerExited), String(polite.peerExited)],
  ['IDLE link drop errno', String(rude.idleDropErrno), String(polite.idleDropErrno)],
  ['BUSY link drop errno', String(rude.busyDropErrno), String(polite.busyDropErrno)],
  ['passive socket shape', rude.passiveShape.join(' → '), polite.passiveShape.join(' → ')],
  ['writing socket shape', rude.writingShape.join(' → '), polite.writingShape.join(' → ')],
  ['socket file left behind', String(rude.socketFileLeft), String(polite.socketFileLeft)],
  ['post-mortem connect errno', String(rude.postMortemErrno), String(polite.postMortemErrno)],
  ['describe().lastErrno after', String(rude.describedLastErrno), String(polite.describedLastErrno)]
];
const w0 = Math.max(...rows.map((r) => r[0].length));
const w1 = Math.max(...rows.map((r) => r[1].length), 'RUDE (SIGKILL)'.length);
console.log(`   ${'observation'.padEnd(w0)}  ${'RUDE (SIGKILL)'.padEnd(w1)}  POLITE (SIGTERM)`);
console.log(`   ${'─'.repeat(w0)}  ${'─'.repeat(w1)}  ${'─'.repeat(18)}`);
for (const [k, a, b] of rows) {
  const same = a === b ? ' ' : '≠';
  console.log(`   ${k.padEnd(w0)}  ${a.padEnd(w1)}  ${b}  ${same}`);
}

if (verbose) {
  for (const arm of [rude, polite]) {
    console.log(`\n   ${arm.label} passive timings: ${arm.passiveEvents.map((e) => `${e.name}@+${e.atMs}ms`).join(', ')}`);
    console.log(`   ${arm.label} writing timings: ${arm.writingEvents.map((e) => `${e.name}@+${e.atMs}ms`).join(', ')}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// §1 — the claim gate 5 actually rests on
// ══════════════════════════════════════════════════════════════════════════

rule('§1  The drop Butchr publishes is IDENTICAL across the two deaths');

check(
  'both peers really exited',
  rude.peerExited && polite.peerExited,
  `rude=${rude.peerExited} polite=${polite.peerExited}. A peer that did not exit measures nothing.`
);

check(
  'each arm produced exactly one `disconnected` LinkStateEvent per link',
  rude.idleDropCount === 1 && polite.idleDropCount === 1 &&
    rude.busyDropCount === 1 && polite.busyDropCount === 1,
  `idle: rude=${rude.idleDropCount} polite=${polite.idleDropCount}; ` +
    `busy: rude=${rude.busyDropCount} polite=${polite.busyDropCount}`
);

check(
  'an IDLE link\'s drop errno is null on BOTH arms — the drop carries no trace of how the peer died',
  rude.idleDropErrno === null && polite.idleDropErrno === null,
  `rude=${String(rude.idleDropErrno)} polite=${String(polite.idleDropErrno)}. If one of these ` +
    `is non-null the distinction has become visible to every owner of connection-borne state, ` +
    `and §4's gate should be reconsidered rather than kept.`
);

check(
  'the two idle drop events are indistinguishable from each other',
  rude.idleDropErrno === polite.idleDropErrno,
  `rude errno=${String(rude.idleDropErrno)} vs polite errno=${String(polite.idleDropErrno)}`
);

// ══════════════════════════════════════════════════════════════════════════
// §2 — the passive reader: what a peer death looks like with nothing in flight
// ══════════════════════════════════════════════════════════════════════════

rule('§2  A PASSIVE reader cannot tell them apart — EOF is EOF');

check(
  'the passive event SHAPE is identical across arms',
  rude.passiveShape.join(' → ') === polite.passiveShape.join(' → '),
  `rude: ${rude.passiveShape.join(' → ')}\npolite: ${polite.passiveShape.join(' → ')}`
);

check(
  'no `error` event reaches a passive reader on either arm',
  !rude.passiveShape.some((s) => s.startsWith('error')) &&
    !polite.passiveShape.some((s) => s.startsWith('error')),
  `rude: ${rude.passiveShape.join(' → ')}\npolite: ${polite.passiveShape.join(' → ')}. ` +
    `AF_UNIX has no RST: a SIGKILLed peer's fds are closed by the kernel, which is EOF.`
);

check(
  'both arms close with hadError=false',
  rude.passiveShape.includes('close(hadError=false)') &&
    polite.passiveShape.includes('close(hadError=false)'),
  `rude: ${rude.passiveShape.join(' → ')}\npolite: ${polite.passiveShape.join(' → ')}`
);

// ══════════════════════════════════════════════════════════════════════════
// §3 — the writer: ECONNRESET is real, and it is NOT a rude-death signal
// ══════════════════════════════════════════════════════════════════════════

rule('§3  What sets the drop\'s errno is OUR write, not the death — busy beside idle');

console.log(
  `   ⚠ This section deliberately does NOT assert the exact errno. Which of\n` +
    `   ${WRITE_RACE_ERRNOS.join('/')} you get depends on whether the write landed before or after\n` +
    `   the kernel finished the teardown, and it was measured varying BETWEEN RUNS on\n` +
    `   the same arm. Pinning it is how this becomes the next KAN-416.\n` +
    `   Observed this run — rude: ${String(rude.writingErrno)}, polite: ${String(polite.writingErrno)}\n`
);

check(
  'an `error` event DOES reach a writer, on both arms',
  rude.writingShape.some((s) => s.startsWith('error')) &&
    polite.writingShape.some((s) => s.startsWith('error')),
  `rude: ${rude.writingShape.join(' → ')}\npolite: ${polite.writingShape.join(' → ')}. ` +
    `If this stops being true the \`error\` handler in crabcast-link.ts has become ` +
    `unreachable on an established connection, and KAN-381's reason for not clearing ` +
    `\`this.socket\` there needs restating.`
);

check(
  `the writer's errno is a write-race errno (${WRITE_RACE_ERRNOS.join(' or ')}) on both arms`,
  WRITE_RACE_ERRNOS.includes(rude.writingErrno) && WRITE_RACE_ERRNOS.includes(polite.writingErrno),
  `rude=${String(rude.writingErrno)} polite=${String(polite.writingErrno)}. A value outside ` +
    `that set is a new observation worth a ticket, not a flake to widen the set for.`
);

check(
  'both arms close the writing socket with hadError=true',
  rude.writingShape.includes('close(hadError=true)') &&
    polite.writingShape.includes('close(hadError=true)'),
  `rude: ${rude.writingShape.join(' → ')}\npolite: ${polite.writingShape.join(' → ')}`
);

// The comparison that carries the finding: for a FIXED manner of death, being
// mid-write changes the drop's errno from null to an errno; for a FIXED
// observation mode, the manner of death changes nothing.
check(
  'a BUSY link\'s drop errno is non-null on BOTH arms — so `event.errno` tracks whether WE ' +
    'were mid-write, not how the peer died',
  rude.busyDropErrno !== null && polite.busyDropErrno !== null,
  `busy: rude=${String(rude.busyDropErrno)} polite=${String(polite.busyDropErrno)}; ` +
    `idle: rude=${String(rude.idleDropErrno)} polite=${String(polite.idleDropErrno)}. ` +
    `If a busy link now reports null the write no longer reaches the socket before ` +
    `teardown and §3 is measuring nothing — check the write loop, not the daemon.`
);

check(
  'busy and idle differ on the SAME death, on both arms — the axis that moves the errno ' +
    'is ours, and it is the one nothing may branch on',
  rude.busyDropErrno !== rude.idleDropErrno && polite.busyDropErrno !== polite.idleDropErrno,
  `rude: busy=${String(rude.busyDropErrno)} idle=${String(rude.idleDropErrno)}; ` +
    `polite: busy=${String(polite.busyDropErrno)} idle=${String(polite.idleDropErrno)}`
);

// ══════════════════════════════════════════════════════════════════════════
// §5 — the one place they DO differ, and it is outside the socket
// ══════════════════════════════════════════════════════════════════════════

rule('§5  The only visible difference is the peer\'s own cleanup, one connect later');

console.log(
  `   ⚠ A red in this section is a claim about CRABCAST'S cleanup behaviour, which is\n` +
    `   uncontracted and may change without notice. It is NOT a claim that Butchr broke.\n` +
    `   Read it as "the one signal that distinguished the two deaths has moved".\n`
);

check(
  'a polite shutdown unlinks the socket file; a rude kill leaves it behind',
  rude.socketFileLeft === true && polite.socketFileLeft === false,
  `rude left it: ${rude.socketFileLeft}, polite left it: ${polite.socketFileLeft}`
);

check(
  'so a FRESH connect distinguishes them: ECONNREFUSED after a rude death, ENOENT after a polite one',
  rude.postMortemErrno === 'ECONNREFUSED' && polite.postMortemErrno === 'ENOENT',
  `rude=${rude.postMortemErrno} polite=${polite.postMortemErrno}`
);

check(
  'and that difference reaches describe().lastErrno — the distinction exists, one reconnect cycle out',
  rude.describedLastErrno !== polite.describedLastErrno,
  `rude=${String(rude.describedLastErrno)} polite=${String(polite.describedLastErrno)}. ` +
    `Note this is a CONNECT-time errno on a NEW socket, not the drop's errno, which §1 ` +
    `shows is null on both.`
);

// ══════════════════════════════════════════════════════════════════════════

rule('VERDICT');
console.log(
  `   On the socket: INDISTINGUISHABLE. A passive reader gets end → close(hadError=false)\n` +
    `   with errno null on both arms; a writer gets error → close(hadError=true) on both.\n` +
    `   AF_UNIX carries no signal of the peer's manner of death — there is no RST, and a\n` +
    `   SIGKILLed peer's fds are closed by the kernel, which is EOF.\n\n` +
    `   What DOES move the drop's errno is whether WE were mid-write (§3, busy vs idle on\n` +
    `   the same death). So a branch on \`event.errno\` would key on Butchr's own request\n` +
    `   timing while reading as though it discriminated the peer. §4 is that gate.\n\n` +
    `   Outside the socket: DISTINGUISHABLE, contingently. CrabCast's SIGTERM handler\n` +
    `   unlinks its socket file and SIGKILL cannot, so the NEXT connect attempt answers\n` +
    `   ENOENT after a polite death and ECONNREFUSED after a rude one. That is the peer's\n` +
    `   own cleanup, not a property of the transport, and it is uncontracted.\n\n` +
    `   Needed? NO. §4 shows the drop's errno has exactly one consumer in the daemon and\n` +
    `   it is a log line. Both deaths converge on the same reconnect-and-resync path.\n`
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
