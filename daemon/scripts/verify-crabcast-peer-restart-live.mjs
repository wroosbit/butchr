// Live proof for KAN-403, against a REAL CrabCast daemon that is REALLY
// RESTARTED underneath a live mirror: the peer process is stopped, a new one is
// started on the same data dir, and what comes back is measured rather than
// assumed.
//
// WHAT FAILURE THIS WOULD CATCH: a mirror that is permanently dead after a
// deploy. A restarted CrabCast re-adopts the agents in its durable registry at
// boot and issues each a NEW `sessionId`; the id Butchr holds was issued by the
// process that just exited, so `pty_init` is refused `unknown_session` with the
// link healthy — which settles the mirror `ended`, and `ended` is terminal, so
// the reconnect sweep skips it forever. `adoptFromCensus` cannot rescue it
// either: the address is still held by a session whose `status` is `active`. The
// pane is alive, its scrollback is intact, and Butchr renders nothing at it until
// the daemon is restarted. Every deploy does this, to every mirror.
//
// It would also catch the narrower thing that makes the above invisible: a
// reconnect that CANNOT TELL a peer restart from a socket blip. `build.commit`
// does not move across a restart of the same binary — measured, §3 — so the one
// identifier the handshake read before this ticket is exactly the one that says
// nothing about the event this script produces.
//
// CI-RUNNABLE: no — needs the `crabcast` binary, a real herdr and a real pty. It
// asserts nothing without them.
//
// ── HOW THE RESTART IS PRODUCED, AND WHY IT IS SAFE ───────────────────────
//
// KAN-381 produced its drop by cutting a RELAY while CrabCast stayed up, and its
// header names this gap in as many words: *"A peer that RESTARTS. CrabCast stays
// up throughout."* The alternative it declined — restarting the daemon this
// machine's whole fleet runs on — is still declined here, and it is not what this
// script does.
//
// Instead this script starts a CrabCast of its OWN: `crabcast daemon --config
// <scratch>`, whose config is the single key `dataDir` pointing inside a
// `mkdtemp` scratch. Socket, log, durable registry and agent sidecars all live
// under it (their README §config). So:
//
//   - **The fleet's daemon is never signalled.** The only pid this script ever
//     sends a signal to is one it spawned itself and recorded — asserted, not
//     merely intended, in `stopDaemon()`.
//   - **The restart is real on both sides.** SIGTERM to the daemon process, wait
//     for the socket to actually disappear, then a fresh `crabcast daemon` on the
//     same data dir. A new process, a new `bootId`, a boot reconcile.
//   - **Cleanup is `rm -rf`, not `crabcast forget`.** The record this run creates
//     lands in the scratch `dataDir`, never in
//     `~/.local/share/crabcast/agents.jsonl` — which is on the standing
//     never-touch list for every Butchr agent, and which KAN-381 had to reach for
//     `crabcast forget` to sweep. An isolated data dir removes that problem
//     rather than handling it.
//
// WHAT THIS LEAVES UNCOVERED, named rather than implied:
//
//   - **A restart that moves `build.commit`.** Both daemons here are the same
//     installed binary, so the commit is IDENTICAL across the restart. That is
//     the ordinary deploy shape for a redeploy of the same build and it is the
//     harder case (nothing in the build identity changed), but a deploy that
//     actually ships new code would also move the commit, and no run here has
//     produced that. §3 asserts the commit did NOT move, which is the honest
//     claim about what was observed.
//   - **`contractVersion` moving across the restart.** Same reason. Unobserved.
//   - **The `claude` launcher.** This uses `shell`, for the reason
//     `verify-crabcast-runtime-live.mjs` gives: it depends on nothing but herdr.
//   - **`spawnSession`.** The probe is ADOPTED off the census, as in KAN-381.
//   - **A restart while a session was SPAWNED by this daemon rather than
//     adopted.** `remoteIds` is populated the same way for both and the repair
//     under test reads that map, so the mechanism is shared — but only the
//     adopted arm has been driven, and that distinction is left standing rather
//     than argued away.
//
// ── WHAT THIS SCRIPT SUPPLIES AND WHAT IT DOES NOT ────────────────────────
//
// **This script writes the record it then asserts on** — it configures and
// activates the probe agent, so the census row it later reads is one this run
// created. What that leaves uncovered is a peer restart under a mirror somebody
// ELSE established, and nothing covers that: it needs a real deploy under a real
// fleet, which is the human's call and not a proof's. What it does NOT supply is
// the thing that matters most here: the NEW session id after the restart is
// minted by CrabCast's own boot reconcile, unprompted, and the pane's scrollback
// across the restart is the real pane's. Neither is staged.
//
// ── RUNNING IT ─────────────────────────────────────────────────────────────
//
//   node daemon/scripts/verify-crabcast-peer-restart-live.mjs [--verbose]
//
// It needs room for one more `shell` pane on the machine's capacity gate, which
// is machine-wide and therefore shared with the fleet even though the daemon is
// not. If CrabCast refuses for capacity the run says so and asserts nothing;
// `override: true` is used ONLY if the plain activation is refused, and every use
// is printed with the figures it bypassed. `preempt` is never used.
//
// Every setup failure prints "setup:" and asserts nothing. None may be read as a
// red against this ticket.

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

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
 * Terminal output is not text — `verify-crabcast-runtime-live.mjs` established
 * this. herdr emits a cursor-position escape before nearly every character, so a
 * plain `includes` finds nothing while every byte is present and in order.
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

// ── setup: an isolated CrabCast, on a scratch data dir ─────────────────────
//
// `os.tmpdir()` rather than the workspace, and the reason is mechanical: a unix
// socket address is a fixed 104-byte buffer, an over-long path is silently
// TRUNCATED, and CrabCast refuses a `dataDir` whose socket path would exceed it
// (their README §config). A Butchr workspace path is already most of that budget
// before the data dir is appended.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan403-'));
const dataDir = path.join(scratch, 'cc');
const configPath = path.join(scratch, 'crabcast.config.json');
const socketPath = path.join(dataDir, 'crabcast.sock');
fs.writeFileSync(configPath, JSON.stringify({ dataDir }) + '\n');

if (socketPath.length > 104) {
  console.error(`setup: socket path is ${socketPath.length} chars, over the 104-byte limit.`);
  process.exit(1);
}

const TYPE = 'task';
const KEY = process.env.KAN403_PROBE_KEY ?? 'kan-403-restart-probe';
const workDir = workspaceDirFor(TYPE, KEY);

console.log(`isolated dataDir : ${dataDir}`);
console.log(`isolated socket  : ${socketPath} (${socketPath.length} chars)`);
console.log(`probe agent      : ${TYPE}/${KEY}`);
console.log(`workspace        : ${workDir}`);
console.log(
  `\nThe fleet's own CrabCast at ~/.local/share/crabcast is NOT touched: this run signals\n` +
    `only pids it spawned itself, and its registry lives in the scratch dir above.\n`
);

/** Every daemon pid this script has spawned. Nothing else may ever be signalled. */
const spawnedPids = new Set();
let daemonProc = null;

/** One request on a direct connection to the isolated socket. */
function askPeer(body, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    const id = `kan403-${process.pid}-${Math.round(Math.random() * 1e9)}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer to ${body.action} in ${timeoutMs}ms`));
    }, timeoutMs);
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

async function startDaemon(label) {
  const logPath = path.join(scratch, `daemon-${label}.log`);
  const out = fs.openSync(logPath, 'a');
  const proc = spawn('crabcast', ['daemon', '--config', configPath], {
    stdio: ['ignore', out, out],
    detached: false
  });
  spawnedPids.add(proc.pid);
  daemonProc = proc;
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
    `   daemon ${label}: pid ${up.pid}, bootId ${up.bootId}, build ${String(up.build?.commit).slice(0, 12)}, contract v${up.contractVersion}`
  );
  return up;
}

/**
 * Stop a daemon this script started, and wait for the socket to actually go.
 *
 * **The pid is checked against the set of pids this script spawned before any
 * signal is sent**, and that is a guard rather than a comment: the one way this
 * script could harm the fleet is by signalling a daemon it does not own, and
 * "we only ever pass our own pid" is exactly the kind of claim that survives a
 * refactor while stopping being true.
 */
async function stopDaemon(pid) {
  if (!spawnedPids.has(pid)) {
    throw new Error(
      `refusing to signal pid ${pid}: this script did not spawn it. Spawned: ${[...spawnedPids].join(', ')}`
    );
  }
  process.kill(pid, 'SIGTERM');
  const gone = await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 20_000);
  await until(() => !fs.existsSync(socketPath), 10_000);
  return { exited: gone === true, socketGone: !fs.existsSync(socketPath) };
}

/** Remove everything this run created. Called on every exit path. */
async function cleanup() {
  try {
    if (daemonProc?.pid && spawnedPids.has(daemonProc.pid)) {
      try {
        process.kill(daemonProc.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await until(() => {
        try {
          process.kill(daemonProc.pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 15_000);
    }
  } catch {
    /* nothing to stop */
  }
  // The registry, the sidecars and the socket all live under `scratch`, so this
  // one removal is the whole sweep. Nothing here reaches
  // ~/.local/share/crabcast, and no `crabcast forget` is needed or issued.
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch (err) {
    console.log(`   could NOT remove ${scratch}: ${err?.message ?? err}`);
  }
  // Same guard KAN-381 uses: only a path inside butchr/workspaces is removed, so
  // a KAN403_PROBE_KEY pointing somewhere unexpected deletes nothing.
  const inWorkspaces = workDir.includes(`${path.sep}butchr${path.sep}workspaces${path.sep}`);
  try {
    if (inWorkspaces && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    console.log(`   could NOT remove ${workDir}: ${err?.message ?? err}`);
  }
  return { scratchGone: !fs.existsSync(scratch), workDirGone: !fs.existsSync(workDir) };
}

async function bail(message) {
  console.error(`\nsetup: ${message}\nNothing was asserted.\n`);
  try {
    runtime?.dispose();
  } catch {
    /* may not exist yet */
  }
  await cleanup();
  process.exit(1);
}

try {
  execFileSync('crabcast', ['--help'], { stdio: 'ignore', timeout: 20_000 });
} catch {
  await bail('no usable `crabcast` on PATH. This proof needs the real binary.');
}

// ── 1. an isolated peer, and a real mirror over it ─────────────────────────
rule('1. an isolated CrabCast, a real pane, a live mirror');

let daemonA;
try {
  daemonA = await startDaemon('A');
} catch (err) {
  await bail(`could not start the isolated daemon: ${err?.message ?? err}`);
}

process.env.BUTCHR_AGENT_RUNTIME = 'crabcast';
process.env.BUTCHR_CRABCAST_SOCKET = socketPath;

const { runtime, report } = createAgentRuntime({ log: (m) => verbose && console.log(`      ${m}`) });
check('the CrabCast runtime is serving', report.mode === 'crabcast', JSON.stringify(report));

const connected = await until(() => runtime.describe().link.connected, 10_000);
check('the link connected to the isolated peer', connected === true, JSON.stringify(runtime.describe().link));

const peerA = runtime.describe().link;
check(
  'and it handshook — a 40-char build commit came back',
  typeof peerA.peerCommit === 'string' && peerA.peerCommit.length === 40,
  JSON.stringify(peerA)
);

// The probe pane, configured and activated over a DIRECT connection, adopted by
// the runtime off the census. Same shape as KAN-381 §setup and for the same two
// reasons: the capacity escape stays out of `CrabCastRuntime`, and the session
// under test is adopted rather than spawned.
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

const configured = await askPeer({
  action: 'configure_agent',
  path: workDir,
  priority: 1,
  launcher: 'shell',
  prompt: 'KAN-403 peer-restart probe.'
});
if (configured.success !== true) await bail(`configure_agent refused: ${configured.error}`);

let activated = await askPeer({ action: 'activate_agent', path: workDir });
if (activated.success !== true) {
  console.log(
    `   setup: plain activate_agent was refused — CrabCast's own figures:\n` +
      `          ${String(activated.error).split('\n')[0]}\n` +
      `          Retrying with \`override: true\`, the escape that refusal names. It is recorded\n` +
      `          on CrabCast's side with the figures it bypassed. \`preempt\` is NOT used:\n` +
      `          nothing is stood down.`
  );
  activated = await askPeer({ action: 'activate_agent', path: workDir, override: true });
}
if (activated.success !== true) await bail(`activate_agent refused even with override: ${activated.error}`);

const remoteSessionIdBefore = activated.sessionId;
console.log(`   CrabCast started it as session ${remoteSessionIdBefore}`);

const session = await until(() => runtime.listActiveSessions().find((s) => s.key === KEY), 30_000);
if (!session) await bail('the runtime never adopted the pane from the census, so there is no mirror to test.');
check("the runtime adopted the running pane from CrabCast's own census", !!session);
check('and it is marked adopted rather than spawned', session.adopted === true, JSON.stringify({ adopted: session.adopted }));
console.log(`   butchr session  : ${session.sessionId}`);

const events = [];
const dispose = runtime.registerDataListener(session.sessionId, (event) => events.push(event));

const mirrored = await until(
  () => (runtime.getSession(session.sessionId)?.ptyBuffer ?? '').length > 0,
  25_000
);
check('the mirror filled from the pty_init snapshot', mirrored === true);
check(
  'the session starts with no discontinuities recorded',
  runtime.getSession(session.sessionId).ptyDiscontinuities.length === 0,
  JSON.stringify(runtime.getSession(session.sessionId).ptyDiscontinuities)
);

const cr = String.fromCharCode(13);
const before = 'KANBEFORERESTART';
runtime.writePty(session.sessionId, `echo ${before}${cr}`);
const sawBefore = await until(
  () => events.some((e) => e.kind === 'data' && paneLetters(e.data).includes(before)),
  30_000
);
check(
  'output before the restart reached the listener on the data arm',
  sawBefore === true,
  `${events.length} event(s), ${events.filter((e) => e.kind === 'data').length} of them data`
);

// ── 2. output timed to happen while the peer is DOWN ───────────────────────
rule('2. a background job in the real pane, timed to fire while the peer is gone');

// Assembled by the shell, never typed — `paneLetters` strips punctuation, so a
// literal marker would appear the moment the command line is echoed and "the
// listener saw it" would be true before the job ever ran. KAN-381 §2.
const GAP_MARKER = 'KANRESTARTMARK';
runtime.writePty(session.sessionId, `SUF=MARK${cr}`);
await sleep(600);
runtime.writePty(session.sessionId, `(sleep 6; echo KANRESTART$SUF; echo KANRESTART$SUF) &${cr}`);
await sleep(600);

check(
  'the marker is NOT already in the mirror — the job has not run yet',
  !paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(GAP_MARKER),
  'the marker leaked from the typed command line; the assembly above did not work'
);

// ── 3. the restart ─────────────────────────────────────────────────────────
rule('3. the restart — the peer process is stopped and a new one takes its place');

const bootIdA = daemonA.bootId;
const commitA = daemonA.build?.commit;
const contractA = daemonA.contractVersion;

const droppedAt = Date.now();
const stopped = await stopDaemon(daemonA.pid);
check('the peer process exited', stopped.exited === true);
check('and it removed its socket on the way out', stopped.socketGone === true);

const disclosed = await until(() => events.some((e) => e.kind === 'discontinuity'), 15_000);
check(
  'a discontinuity reached the listener while the peer was down',
  disclosed === true,
  `${events.length} event(s), none a discontinuity`
);

const openEvent = events.find((e) => e.kind === 'discontinuity');
if (openEvent) {
  const d = openEvent.discontinuity;
  check("it is sequence 1, cause 'link-dropped'", d.sequence === 1 && d.cause === 'link-dropped', JSON.stringify(d));
  check("resync is 'pending' — nothing has been repaired yet", d.resync === 'pending', JSON.stringify(d));
  check(
    'lostAt is within a second of the moment this script stopped the peer',
    Math.abs(Date.parse(d.lostAt) - droppedAt) < 2_000,
    `lostAt=${d.lostAt} stopped=${new Date(droppedAt).toISOString()}`
  );
}
check(
  'the mirror is reported STALE rather than live',
  runtime.describe().ptyMirrorStates.stale === 1,
  JSON.stringify(runtime.describe().ptyMirrorStates)
);

console.log('   waiting while the pane keeps working with nobody subscribed…');
await sleep(7_000);

check(
  'THE EVENTS WERE GENUINELY MISSED: the marker never arrived on the data arm',
  events.filter((e) => e.kind === 'data' && paneLetters(e.data).includes(GAP_MARKER)).length === 0
);

const daemonB = await startDaemon('B');

// THE FACT THIS WHOLE TICKET TURNS ON.
check(
  'the peer has a DIFFERENT bootId — this was a restart, not a socket blip',
  typeof daemonB.bootId === 'string' && daemonB.bootId !== bootIdA,
  `A=${bootIdA} B=${daemonB.bootId}`
);
check(
  'and the SAME build.commit — so the commit says nothing about a restart',
  daemonB.build?.commit === commitA,
  `A=${commitA} B=${daemonB.build?.commit}`
);
check(
  'and the same contractVersion, for the same reason',
  daemonB.contractVersion === contractA,
  `A=${contractA} B=${daemonB.contractVersion}`
);
console.log(
  `\n   THE RESTART: bootId ${String(bootIdA).slice(0, 8)} → ${String(daemonB.bootId).slice(0, 8)}, ` +
    `commit ${String(commitA).slice(0, 12)} → ${String(daemonB.build?.commit).slice(0, 12)} (unchanged)\n`
);

// ── 4. what the restarted peer holds ───────────────────────────────────────
rule('4. what a restarted CrabCast holds about a session it did not start');

const censusAfter = await askPeer({ action: 'list_agents' });
const rowAfter = (censusAfter.agents ?? []).find((r) => r.path === workDir || r.workDir === workDir);
check('the restarted peer still has the agent, running', rowAfter?.state === 'running', JSON.stringify(rowAfter ?? null));
const remoteSessionIdAfter = rowAfter?.sessionId;
check(
  'BUT ITS sessionId MOVED — the boot reconcile re-adopted the pane and minted a new one',
  typeof remoteSessionIdAfter === 'string' && remoteSessionIdAfter !== remoteSessionIdBefore,
  `before=${remoteSessionIdBefore} after=${remoteSessionIdAfter}`
);
console.log(`   remote session  : ${remoteSessionIdBefore}\n                  → ${remoteSessionIdAfter}`);

// The old id is not merely different — the peer says, in its own refusal, that
// retrying it cannot work and that the client must re-resolve. That sentence is
// what makes the repair a RE-RESOLUTION rather than a retry, and it is read off
// the wire here rather than quoted from a document.
const staleInit = await askPeer({ action: 'pty_init', sessionId: remoteSessionIdBefore });
check(
  'and the OLD id is refused `unknown_session` — a retry of it cannot ever succeed',
  staleInit.success === false && staleInit.refusal === 'unknown_session',
  JSON.stringify({ success: staleInit.success, refusal: staleInit.refusal })
);
if (verbose && staleInit.error) console.log(`         CrabCast's own words: ${staleInit.error}`);

// ── 5. the repair ──────────────────────────────────────────────────────────
rule('5. the repair — the mirror re-resolves its remote id and comes back');

const backUp = await until(() => runtime.describe().link.connected, 20_000);
check('the link reconnected to the new peer', backUp === true, JSON.stringify(runtime.describe().link));

check(
  'the handshake READ THE NEW bootId — the link can now say the peer restarted',
  runtime.describe().link.peerBootId === daemonB.bootId,
  `link reports ${JSON.stringify(runtime.describe().link.peerBootId)}, peer is ${daemonB.bootId}`
);
check(
  'and it names the transition rather than leaving it to be inferred',
  runtime.describe().link.peerIdentity === 'restarted',
  `peerIdentity=${JSON.stringify(runtime.describe().link.peerIdentity)}`
);

const settled = await until(
  () => runtime.getSession(session.sessionId)?.ptyDiscontinuities[0]?.resync === 'succeeded',
  40_000
);
check(
  'THE RESYNC SUCCEEDED ACROSS A RESTART — the mirror is not permanently dead',
  settled === true,
  JSON.stringify(runtime.getSession(session.sessionId)?.ptyDiscontinuities)
);

const gap = runtime.getSession(session.sessionId)?.ptyDiscontinuities[0];
if (gap) {
  check(
    'and it states the window: lostAt → restoredAt, in milliseconds',
    gap.restoredAt !== null && typeof gap.windowMs === 'number' && gap.windowMs > 0,
    JSON.stringify(gap)
  );
  check(
    'which is arithmetic on its own endpoints rather than an independent guess',
    gap.windowMs === Date.parse(gap.restoredAt) - Date.parse(gap.lostAt),
    JSON.stringify(gap)
  );
  check(
    "and it discloses the CAUSE as a peer restart, not a bare link drop",
    gap.peerRestarted === true,
    JSON.stringify(gap)
  );
  console.log(`\n   THE GAP: ${gap.lostAt} → ${gap.restoredAt} = ${gap.windowMs}ms, ${gap.resync}, peerRestarted=${gap.peerRestarted}\n`);
}

check(
  'the mirror is back to live and nothing is left open',
  runtime.describe().ptyMirrorStates.stale === 0 &&
    runtime.describe().ptyMirrorStates.ended === 0 &&
    runtime.describe().ptyDiscontinuities.open === 0,
  JSON.stringify(runtime.describe().ptyMirrorStates) + ' ' + JSON.stringify(runtime.describe().ptyDiscontinuities)
);

// AC1's substantive half: the mirror holds what the pane printed while the peer
// did not exist. Only a real peer, holding a real pane's scrollback across a
// real restart, can produce this.
const caughtUp = await until(
  () => paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(GAP_MARKER),
  30_000
);
check(
  'MIRRORED STATE IS CORRECT: the re-subscription carried what the pane printed while the peer was gone',
  caughtUp === true,
  `buffer tail: ${paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').slice(-120)}`
);

const after = 'KANAFTERRESTART';
runtime.writePty(session.sessionId, `echo ${after}${cr}`);
const streamingAgain = await until(
  () => events.some((e) => e.kind === 'data' && paneLetters(e.data).includes(after)),
  30_000
);
check(
  'the stream is live again — new output reaches the listener, so the re-subscription is real',
  streamingAgain === true,
  `${events.filter((e) => e.kind === 'data').length} data event(s) total`
);

// And the write path, which is the half a reader would assume follows from the
// read path and does not: `writePty` addresses the remote id too, so a mirror
// that re-resolved only its subscription would render fine and swallow input.
check(
  'and INPUT lands too — the re-resolved id is used for writes as well as reads',
  paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').includes(after),
  `buffer tail: ${paneLetters(runtime.getSession(session.sessionId)?.ptyBuffer ?? '').slice(-120)}`
);

// ── 6. the durable half ────────────────────────────────────────────────────
rule('6. a consumer that was not here still learns of the gap and its cause');

const late = [];
const disposeLate = runtime.registerDataListener(session.sessionId, (e) => late.push(e));
await sleep(600);
check(
  'a listener registering after the fact receives no replayed live event — correctly',
  late.every((e) => e.kind === 'data'),
  JSON.stringify(late.filter((e) => e.kind !== 'data'))
);
const durable = runtime.getSession(session.sessionId)?.ptyDiscontinuities ?? [];
check(
  'but the session still holds the gap, settled and attributed, which is what pty_init hands them',
  durable.length === 1 && durable[0].resync === 'succeeded' && durable[0].peerRestarted === true,
  JSON.stringify(durable)
);
disposeLate?.();

// ── cleanup ────────────────────────────────────────────────────────────────
rule('cleanup');
dispose?.();
const terminated = runtime.terminateSession(session.sessionId);
check('the probe pane was terminated', terminated.success === true, JSON.stringify(terminated));
await sleep(1_500);
runtime.dispose();

const swept = await cleanup();
check(
  'the isolated data dir is gone — registry, sidecars, socket and all',
  swept.scratchGone === true,
  `${scratch} still exists`
);
check('and the probe workspace directory is gone too', swept.workDirGone === true, `${workDir} still exists`);
console.log(
  `   nothing was written to ~/.local/share/crabcast, and no \`crabcast forget\` was issued:\n` +
    `   an isolated dataDir puts the whole record inside the scratch this run removes.`
);

console.log(
  `\n${
    failures
      ? `FAILED — ${failures} check(s)`
      : 'OK — a REAL CrabCast restart under a live mirror: bootId moved while build.commit did ' +
        'not, the peer minted a new session id for the same pane, the mirror re-resolved it ' +
        'rather than retrying a dead one, the pane output produced while the peer did not exist ' +
        'was recovered, and the gap is disclosed as a peer restart'
  }\n`
);
process.exit(failures ? 1 : 0);
