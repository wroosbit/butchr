// The rollback's reap: stand down what the flip started, then PROVE it stopped
// (KAN-483).
//
// WHY THIS IS IN THE REPOSITORY AND NOT IN THE CUTOVER KIT. Same reason
// `cutover-health.mjs` is, and the same incident one turn of the screw further
// on. `~/butchr-cutover/rollback.sh` reverted the config and re-filed the
// transcripts and never once asked whether the agents it was rolling back were
// still running. They were: three of them, for at least 31 minutes after the
// log said `ROLLBACK COMPLETE`, one of which committed, pushed and opened a
// pull request nobody asked for. A check that only exists inside a rollback
// script can only be evaluated by rolling back, which is why the last one was
// wrong for five attempts and this one has
// `verify-cutover-reap-verdict.mjs` beside it instead.
//
// ⚠ IT REAPS BY ASKING, NEVER BY KILLING. The agents are CrabCast's; it was
// asked to start them and it did. So the reap is one `deactivate_by_key` per
// agent — the daemon's own drain verb, the same one `cutover.sh` step 5 uses —
// and CrabCast stops its own processes. Nothing here signals a process.
// `/proc` is read to COUNT, which is how we find out whether the asking
// worked, and counting is the thing KAN-483 asks for by name.
//
// ⚠ IT MUST RUN BEFORE THE CONFIG REVERT, and that ordering is the whole
// design rather than a preference. `docs/crabcast-cutover-sequence.md` states
// it at step R3: *a herdr daemon cannot see CrabCast's panes*. Revert first and
// the daemon comes back with no CrabCast runtime to ask, so every agent still
// running is unreachable by construction and can never be stood down — the
// orphans become permanent at the moment the revert lands. R2 before R3, in
// the script exactly as in the document.
//
// NODE BUILTINS ONLY, NO `dist`, NO `node_modules` — the promise
// `probe-cutover-readiness.mjs` and `cutover-health.mjs` both make, for the
// same reason. This runs on the worst day, and the worst day is the one where
// the build is broken.
//
// Usage:
//   node daemon/scripts/cutover-reap.mjs             # drain, then render a verdict
//   node daemon/scripts/cutover-reap.mjs --census    # render a verdict, drain NOTHING
//   node daemon/scripts/cutover-reap.mjs --explain   # and why, in prose
//   node daemon/scripts/cutover-reap.mjs --timeout 90
//
// `--census` is what `rollback.sh` runs at the END, after the config revert and
// the transcript half, to decide whether it may print COMPLETE. It is a pure
// read and carries no drain verb, so the last word on a rollback is a
// measurement rather than the memory of an earlier one.
//
// Exit codes — a VERDICT, in the same three values `cutover-health.mjs` uses:
//   0  the fleet is DOWN: no agents, none missing, no CrabCast agent processes
//   1  NOT DOWN: at least one of those three is non-zero. The reasons say which.
//   2  the read did not happen — socket silent, /proc unreadable. NOT A VERDICT
//      ABOUT THE FLEET. A rollback that reports INCOMPLETE off a 2 is reporting
//      about its instrument and must say so in those words.

import net from 'net';
import os from 'os';
import path from 'path';
import { reapVerdict, countAgentProcesses, defaultAgentsDir } from './lib/cutover-reap-verdict.mjs';

const SOCKET_PATH =
  process.env.BUTCHR_SOCK || path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');

const argv = process.argv.slice(2);
const censusOnly = argv.includes('--census');
const explain = argv.includes('--explain');
// How long to wait for the machine to catch up with the asking. The env var
// exists so the kit can be driven in a sandbox without a two-minute wait per
// scenario — being testable is a safety property here rather than a
// convenience, which is the argument lib.sh already makes for every other
// override in this kit. `--timeout` wins over it, and the default is the one
// that runs in production.
const timeoutArg = argv.indexOf('--timeout');
const DRAIN_TIMEOUT_S =
  timeoutArg !== -1
    ? Number(argv[timeoutArg + 1]) || 120
    : Number(process.env.CUTOVER_REAP_TIMEOUT_S) || 120;
const AGENTS_DIR = defaultAgentsDir();

/** One request/response over the daemon's unix socket. */
function ask(payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET_PATH);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no complete frame within ${timeoutMs}ms from ${SOCKET_PATH}`));
    }, timeoutMs);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Parse-on-every-chunk rather than waiting for a newline: the census is
      // large enough to arrive in several and a partial parse simply throws.
      try {
        const frame = JSON.parse(buf);
        clearTimeout(timer);
        sock.end();
        resolve(frame);
      } catch {
        /* keep reading */
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `{agents, missing, names}` off one `list_agents` frame. */
async function census() {
  const frame = await ask({ action: 'list_agents' });
  const rows = Array.isArray(frame?.agents) ? frame.agents : [];
  return {
    agents: rows.length,
    missing: (frame?.missingAgents || []).length,
    names: rows.map((r) => `${r?.type ?? '?'}/${r?.key ?? '?'}`)
  };
}

/**
 * Read all three terms at once. Kept together deliberately: a report that
 * carries a fresh registry count beside a stale process count is the shape of
 * sentence this whole ticket is about.
 */
async function readAll() {
  const c = await census();
  const p = countAgentProcesses({ agentsDir: AGENTS_DIR });
  return { census: c, procs: p };
}

const report = {
  at: new Date().toISOString(),
  mode: censusOnly ? 'census' : 'reap',
  socket: SOCKET_PATH,
  agentsDir: AGENTS_DIR,
  before: null,
  deactivated: [],
  failedToDeactivate: [],
  after: null
};

let verdict;

try {
  const before = await readAll();
  report.before = {
    agents: before.census.agents,
    missing: before.census.missing,
    processes: before.procs.count,
    names: before.census.names,
    pids: before.procs.pids,
    procScanned: before.procs.scanned,
    marker: before.procs.marker
  };

  if (!censusOnly && before.census.agents > 0) {
    // Tasks first, supervisors last — the order `cutover.sh` step 5 drains in,
    // for its reason: supervisors are the ones who would notice and report
    // something wrong, so they are the last to lose the ability to.
    const byPass = (pass) => before.census.names.filter((n) => n.split('/')[0] === pass);
    for (const pass of ['task', 'story', 'epic']) {
      for (const name of byPass(pass)) {
        const [type, key] = name.split('/');
        try {
          await ask({ action: 'deactivate_by_key', type, key }, 30000);
          report.deactivated.push(name);
        } catch (err) {
          // Recorded and NOT fatal here. One agent refusing to stand down must
          // not stop the other nine being asked, and the verdict below is read
          // off the census rather than off this list — which is the point:
          // a `deactivate` that returned cheerfully proves nothing either.
          report.failedToDeactivate.push({ name, error: String(err?.message ?? err) });
        }
        await sleep(500);
      }
    }

    // Wait for the machine to catch up with the asking. CrabCast stops its own
    // processes and that is not instantaneous; polling all three terms means
    // the loop exits on the world being right rather than on a fixed sleep.
    const deadline = Date.now() + DRAIN_TIMEOUT_S * 1000;
    for (;;) {
      const now = await readAll();
      if (now.census.agents === 0 && now.census.missing === 0 && now.procs.count === 0) break;
      if (Date.now() >= deadline) break;
      await sleep(3000);
    }
  }

  const after = await readAll();
  report.after = {
    agents: after.census.agents,
    missing: after.census.missing,
    processes: after.procs.count,
    names: after.census.names,
    pids: after.procs.pids,
    procScanned: after.procs.scanned,
    marker: after.procs.marker
  };

  verdict = reapVerdict({
    census: { agents: after.census.agents, missing: after.census.missing },
    processes: after.procs.count
  });
} catch (err) {
  verdict = reapVerdict({ census: null, processes: null, readError: err });
}

Object.assign(report, {
  read: verdict.read,
  down: verdict.down,
  reasons: verdict.reasons
});

console.log(JSON.stringify(report));

if (explain) {
  const lines = [
    '',
    `  mode          ${report.mode}`,
    `  marker        ${report.before?.marker ?? report.agentsDir + '/'}`,
    ''
  ];
  if (report.before) {
    lines.push(
      `  BEFORE        agents ${report.before.agents}, missing ${report.before.missing}, ` +
        `processes ${report.before.processes}` +
        (report.before.pids.length ? `  (pids ${report.before.pids.join(', ')})` : ''),
      `                ${report.before.procScanned} process(es) scanned`
    );
  }
  if (report.deactivated.length) lines.push(`  DEACTIVATED   ${report.deactivated.join(', ')}`);
  if (report.failedToDeactivate.length) {
    lines.push(`  REFUSED       ${report.failedToDeactivate.map((f) => f.name).join(', ')}`);
  }
  if (report.after) {
    lines.push(
      `  AFTER         agents ${report.after.agents}, missing ${report.after.missing}, ` +
        `processes ${report.after.processes}` +
        (report.after.pids.length ? `  (pids ${report.after.pids.join(', ')})` : '')
    );
  }
  lines.push(
    '',
    `  VERDICT       ${
      !verdict.read
        ? 'NO READ — this says nothing about the fleet, only about the instrument'
        : verdict.down
          ? 'DOWN — nothing the flip started is still running'
          : 'NOT DOWN — ' + verdict.reasons.join('; ')
    }`,
    ''
  );
  console.error(lines.join('\n'));
}

// Verdict-derived, per KAN-119: computed from `reapVerdict` above, not a setup
// guard.
//
// `process.exitCode` RATHER THAN `process.exit()`, for the reason
// `cutover-health.mjs` spells out: node's stdout is asynchronous when it is a
// pipe, and `process.exit()` tears the process down without draining it — so
// the JSON line would be truncated exactly when this is called the way
// `rollback.sh` calls it, `out="$(cutover_reap)"`. The verdict is identical;
// what changes is whether the caller receives the line that explains it.
process.exitCode = verdict.code;
