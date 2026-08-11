// Proof for KAN-204, acceptance criterion 1: a real daemon process, restarted
// for real, and the cap on the other side of the restart.
//
// WHAT FAILURE THIS WOULD CATCH: the cost estimate not actually being carried
// across a daemon restart in the running daemon — the wiring, as opposed to the
// mechanism. verify-cost-estimate-plausibility.mjs proves that the store, the
// damping and the plausibility bound compose correctly at the boundary
// daemon.ts uses them across; it writes the record it then reads, so it cannot
// show that anything writes that record in production. This script would catch
// `saveCostEstimate` never being called on publish, `restoreCostEstimate` never
// being called before the first window, either of them being called in the
// wrong order, and the whole estimate being silently discarded on startup —
// every one of which leaves the other script perfectly green while the cap
// collapses on every deploy, which is exactly the KAN-145 shape this epic keeps
// re-finding.
//
// CI-RUNNABLE: no — starts a real daemon and then warms up for 780 s across 13
// cost windows so the estimate can walk down off its seed. Both the daemon and
// the wall clock put it out of reach of a per-PR check.
//
// WHY THIS DOES NOT TOUCH THE RUNNING DAEMON
//
// BUTCHR_DIR is derived from os.homedir(), so a daemon started with HOME
// pointing at a scratch directory gets its own socket, its own registry and its
// own agent-cost.json, and cannot see or disturb the one supervising this
// machine's fleet. Nothing here connects to the real socket, and this script
// must never be changed to. What it does NOT isolate — deliberately — is
// /proc: the cost sampler measures this machine's real agent trees over real
// 60-second windows, and the CPU term reads this machine's real /proc/stat. So
// the numbers below are live readings of the actual fleet, taken by the actual
// daemon code, through the actual socket API.
//
// The empty scratch registry means the daemon restores no agents and `running`
// reads 0. That is fine and is not what is under test: `cap`, `capByCpu`,
// `agentCores` and `agentCoresSource` are what acceptance criterion 1 is about,
// and none of them depends on `running`.
//
// WHAT IS STILL NOT COVERED: this starts `dist/daemon.js` directly rather than
// through the installed service unit, so an install that ships a stale build,
// or a service unit pointing somewhere else, would not be caught here —
// butchr_staleness_check is the instrument for that, and the PR quotes it.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # sever the wiring without touching the store's own logic:
//   #   in src/daemon.ts, delete the restoreCostEstimate() call in onListen()
//   npm run build && node scripts/verify-capacity-survives-daemon-restart.mjs
//   # the AFTER reading comes back on the seed and the cap collapses; exits 1.
//   # Then `git checkout src/daemon.ts && npm run build` and watch it recover.
//
// WHY IT WAITS SO LONG BEFORE RESTARTING ANYTHING
//
// The first version of this script warmed the daemon for 75 seconds — one cost
// window — and then restarted it. It passed, and it proved nothing: 75 seconds
// in, the estimate is still 0.684, one damping step from the 0.75 seed, so the
// cap was 3 before the restart and 3 after it. "The cap did not collapse" is
// trivially true of a cap that had already collapsed. A restart is only a test
// of anything if the daemon had something worth carrying across.
//
// So it warms up for `--warmup` seconds (default 13 minutes) to walk the
// estimate well clear of the seed, and section 1 FAILS if it did not get clear
// — a vacuous pass is worse than a red, because someone will cite it.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-capacity-survives-daemon-restart.mjs [--warmup=780]
//
// It takes as long as the warm-up plus a few seconds. There is no way to make
// it fast that does not involve supplying the estimate this script exists to
// observe being produced.

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonJs = path.resolve(scriptDir, '..', 'dist', 'daemon.js');

const warmupArg = process.argv.find((a) => a.startsWith('--warmup='));
/** Seconds to let the first daemon run before restarting it. See the header. */
const WARMUP_SECONDS = warmupArg ? Number(warmupArg.split('=')[1]) : 780;

if (!fs.existsSync(daemonJs)) {
  console.error(`No build at ${daemonJs}. Run \`npm run build\` in daemon/ first.`);
  process.exit(1); // setup guard, not a verdict
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// A scratch HOME, so BUTCHR_DIR lands somewhere that is not the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kan204-home-'));
const butchrDir = path.join(home, '.local', 'share', 'butchr');
const socketPath = path.join(butchrDir, 'butchr.sock');
const costPath = path.join(butchrDir, 'agent-cost.json');

console.log(
  `scratch HOME:      ${home}\n` +
  `its BUTCHR_DIR:    ${butchrDir}\n` +
  `the real one:      ${path.join(os.homedir(), '.local', 'share', 'butchr')}  (untouched)\n`
);

let child = null;

function startDaemon(label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [daemonJs], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = proc;
    const lines = [];
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) lines.push(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    // Wait for the socket to appear rather than for a log line, so this does
    // not depend on the daemon's logging staying the shape it is today.
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      if (fs.existsSync(socketPath)) {
        await sleep(250);
        console.log(`  ${label}: pid ${proc.pid}, listening`);
        resolve({ proc, lines });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`daemon did not open ${socketPath} within 30s:\n${lines.join('\n')}`));
        return;
      }
      setTimeout(poll, 200);
    };
    void poll();
  });
}

function stopDaemon(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 5000);
  });
}

/** One request over the scratch socket, the same JSON-lines API the MCP uses. */
function ask(action, data = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out asking the daemon for ${action}`));
    }, 20_000);
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== 'kan204') continue;
        clearTimeout(timer);
        socket.end();
        resolve(msg);
      }
    });
    socket.on('connect', () => {
      socket.write(
        JSON.stringify({ action, ...data, id: 'kan204', workspaceType: 'task', workspaceKey: 'KAN-204' }) + '\n'
      );
    });
  });
}

const show = (label, c) =>
  console.log(
    `  ${label.padEnd(34)} cap ${String(c.cap).padStart(3)} (bound by ${c.capBoundBy.padEnd(8)})  ` +
    `agentCores ${String(c.agentCores).padStart(6)} (${c.agentCoresSource})  ` +
    `capByCpu ${String(c.capByCpu).padStart(3)}  capByMemory ${c.capByMemory}`
  );

try {
  // ------------------------------------------------------------- before ----
  rule('1. A REAL DAEMON, WARMED UP — one full cost window on this machine');

  await startDaemon('first daemon');

  // The first window opens at startup and closes 60s later. One window is not
  // enough — see the header: the estimate has to walk clear of the seed before
  // a restart is a test of anything.
  console.log(
    `  warming up for ${WARMUP_SECONDS}s (${Math.round(WARMUP_SECONDS / 60)} cost windows), so the estimate\n` +
    '  walks down off the 0.75 seed and the cap has somewhere to fall from...'
  );
  await sleep(WARMUP_SECONDS * 1000);

  const before = (await ask('capacity')).capacity ?? (await ask('capacity'));
  show('BEFORE the restart', before);
  console.log(`\n${before.derivation}\n`);

  const persisted = fs.existsSync(costPath) ? JSON.parse(fs.readFileSync(costPath, 'utf8')) : null;
  console.log(`  ${costPath}:\n    ${persisted ? JSON.stringify(persisted) : '(absent)'}`);

  verdict(
    before.agentCoresSource === 'measured' && persisted !== null && persisted.cores > 0,
    `the daemon measured this machine's fleet (${before.agentCores} core/tree over ` +
      `${before.measuredAgentTrees} tree(s)) and wrote it\n    down at ${costPath} — ` +
      'the publish path calls the store, which is half of the wiring under test.',
    before.agentCoresSource !== 'measured'
      ? `after ${WARMUP_SECONDS}s the daemon still had no measurement (agentCoresSource=${before.agentCoresSource}). ` +
        'Nothing below can test what a restart does with an estimate that was never taken; ' +
        'check whether this machine has any agent trees on it.'
      : `the daemon published a measurement but wrote nothing to ${costPath}. saveCostEstimate is ` +
        'not being called on publish, so there is nothing for a restart to pick up.'
  );

  // The premise check. A restart is only a test of anything if the daemon had
  // walked clear of the seed first; without this the whole script can pass on
  // "cap 3 before, cap 3 after", which is the regression, not its absence.
  const SEED_CORES = 0.75;
  const seedCap = Math.floor((before.cores - 1 - 0.5) / SEED_CORES);
  verdict(
    before.cap > seedCap && before.agentCores < SEED_CORES,
    `and it walked clear of the seed first: ${before.agentCores} core/tree against the 0.75 constant, so the cap\n` +
      `    is ${before.cap} where a cold daemon would say ${seedCap}. There is now ${before.cap - seedCap} of cap for the restart to lose,\n` +
      '    which is what makes section 2 a test rather than a tautology.',
    `this run is VACUOUS, not passing: after ${WARMUP_SECONDS}s the estimate is still ${before.agentCores} ` +
      `(seed ${SEED_CORES}) and the cap is ${before.cap} against a cold-daemon ${seedCap}. A restart cannot be shown ` +
      'to preserve a cap that had already collapsed. Re-run with a longer --warmup, and do not cite ' +
      'this run for acceptance criterion 1.'
  );

  // -------------------------------------------------------------- after ----
  rule('2. THE RESTART — SIGTERM, start again, ask immediately');

  await stopDaemon(child);
  console.log('  first daemon stopped');
  const restartedAt = Date.now();
  await startDaemon('second daemon');

  // Deliberately *not* waiting for a window. This is the exact state the KAN-201
  // PR could not reach and the deployment landed in: a daemon seconds old, whose
  // own sampler has measured nothing yet.
  const after = (await ask('capacity')).capacity ?? (await ask('capacity'));
  const secondsIn = ((Date.now() - restartedAt) / 1000).toFixed(1);
  console.log(`  asked ${secondsIn}s after the restart — well inside the first window\n`);
  show('AFTER the restart', after);
  console.log(`\n${after.derivation}\n`);

  verdict(
    after.agentCoresSource === 'restored' && after.agentCores === before.agentCores,
    `${secondsIn} seconds after a real restart the daemon is dividing by ${after.agentCores}, the figure the\n` +
      "    previous daemon measured, and reporting it as 'restored' rather than as its own measurement.\n" +
      '    This is the case the unit battery cannot reach: it exists only in a live process.',
    after.agentCoresSource === 'seed'
      ? `the restarted daemon fell back to the seed (agentCores ${after.agentCores}). ` +
        'restoreCostEstimate is not running, or is running after the first sample rather than before it — ' +
        'the estimate is on disk and nothing reads it.'
      : `the restarted daemon reported agentCores ${after.agentCores} from ` +
        `'${after.agentCoresSource}', where the previous daemon measured ${before.agentCores}.`
  );

  const seedCapAfter = Math.floor((after.cores - 1 - 0.5) / 0.75);
  verdict(
    after.cap >= before.cap,
    `and the cap does not collapse across the restart: ${before.cap} before, ${after.cap} after (bound by ` +
      `${before.capBoundBy} → ${after.capBoundBy}).\n    Without the estimate being carried across it would have been ` +
      `${seedCapAfter}, off the seed. That is acceptance criterion 1,\n    on a real restart of a real daemon.`,
    `the cap collapsed across the restart: ${before.cap} (bound by ${before.capBoundBy}) → ` +
      `${after.cap} (bound by ${after.capBoundBy}). This is the KAN-201 regression, still present.`
  );

  // ------------------------------------------------------- the invariant ---
  rule('3. AND THE INVARIANT HELD THROUGHOUT');

  for (const [label, c] of [['before', before], ['after', after]]) {
    const trees = c.measuredAgentTrees ?? 0;
    const implied = c.agentCores * trees;
    console.log(
      `  ${label.padEnd(8)} ${c.agentCores} core × ${trees} tree(s) = ${implied.toFixed(2)} cores implied, ` +
      `against ${c.cpuBusyCores} busy (${c.cpuBusySource})` +
      (c.liveCoresBound ? `  — bounded to ${c.liveCoresBound.used}` : '')
    );
  }
  const violated = [before, after].filter((c) => {
    const trees = c.measuredAgentTrees ?? 0;
    return (
      c.cpuBusySource === 'measured' &&
      trees > 0 &&
      c.agentCores * trees > c.cpuBusyCores &&
      !c.liveCoresBound
    );
  });
  verdict(
    violated.length === 0,
    'neither reading published an estimate implying more CPU than this machine reported in use without\n' +
      '    the live term declining to divide by it. The figures above are from the running daemon, not\n' +
      '    from a model this script drove.',
    `${violated.length} live reading(s) asserted more agent CPU than the machine reported busy, with no ` +
      'bound recorded. That is the state the ticket was filed from, reproduced on a running daemon.'
  );
} catch (e) {
  failures.push(`the harness itself failed: ${e?.stack ?? e?.message ?? String(e)}`);
} finally {
  if (child) await stopDaemon(child);
  fs.rmSync(home, { recursive: true, force: true });
}

rule('VERDICT');
if (failures.length === 0) {
  console.log(
    'PASS — the estimate is carried across a real daemon restart by the running daemon, and the cap\n' +
    'does not collapse in the window where the KAN-201 regression lived.'
  );
} else {
  console.log(`FAIL — ${failures.length} problem(s):\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
}
process.exit(failures.length ? 1 : 0);
