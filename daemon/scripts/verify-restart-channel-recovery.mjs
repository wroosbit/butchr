#!/usr/bin/env node
/**
 * WHAT FAILURE THIS WOULD CATCH: KAN-274's eager reconnect regressing, so that
 * an agent surviving a daemon restart is left unaddressable over the channel for
 * minutes — or forever — instead of the sub-second it costs now. That is the
 * exact defect KAN-274 fixed and nothing has watched since: measured on the
 * 2026-08-11T17:22:28Z restart, one agent took 2301962 ms (38 minutes) to come
 * back and four others never did. If `scheduleReconnect` is deleted, if its
 * `close` handler stops firing, or if the reconnect timer is left `ref`ed into a
 * dead process, this goes red the next time a restart lands in the log.
 *
 * HOW IT KNOWS. It reads nothing it wrote. Its input is `daemon.log`, produced
 * by the running daemon in the ordinary course of restarting, and it joins two
 * lines the daemon emits for its own reasons:
 *
 *   `[reconcile] N of M surviving agent(s) hold no channel registration: ...`
 *       who survived holding nothing — the daemon's own count (daemon.ts).
 *   `Connection conn-K is <type>/<KEY>`
 *       that agent's registration arriving back.
 *
 * That is the strength worth naming, because the failure mode this repo keeps
 * re-finding is a proof that supplies its own input (KAN-145): this one cannot
 * pass by constructing a record that already has the answer in it, because it
 * does not construct records at all.
 *
 * THE BOUND IS READ FROM THE CODE, NOT HARDCODED. `RECONNECT_MAX_MS` in
 * daemon/src/mcp.ts is the ceiling on the reconnect backoff, so it is the
 * longest an agent should ever wait. Reading it here means raising the ceiling
 * moves the assertion with it rather than silently invalidating it — and means
 * this script cannot pass because someone tuned a constant it was ignoring.
 *
 * ⚠ WHAT THIS DOES NOT COVER, so nobody reads a green as more than it is:
 *
 *   - It is retrospective. It asserts about restarts ALREADY IN THE LOG, so a
 *     regression is invisible to it until a restart happens. A green on a log
 *     with no recent restart means "nothing has gone wrong yet that I can see",
 *     not "reconnect works". It reports how old its newest sample is for exactly
 *     this reason; do not skip that line.
 *   - It measures the DAEMON's view: a registration arrived. It does NOT
 *     establish that a message sent to that agent would reach a model. Channel
 *     delivery to a model is `channel-liveness`'s job, and the gap between
 *     "registered" and "delivered" is owned by no script — see KAN-454.
 *   - It says nothing about what an agent LOST while the link was down. That is
 *     the mid-turn question; it needs a staged restart and cannot be read out of
 *     a log at all. KAN-454 answers it by observation, not here.
 *
 * ⚠ IT READS SOURCE AND LOG AS TEXT AND IMPORTS NOTHING FROM `dist`. So its
 * verdict is unaffected by a failed build and is about the code you actually
 * wrote. Do not discard a red from this script because the build broke.
 *
 * Usage:
 *   node daemon/scripts/verify-restart-channel-recovery.mjs [--log PATH] [--since ISO]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DEFAULT_LOG = join(homedir(), '.local/share/butchr/daemon.log');

/**
 * Restarts older than this predate the fleet turning over onto KAN-274's
 * agent-side reconnect loop, and are expected to be slow. Established in
 * KAN-454: the fix merged 2026-08-11T16:11:43Z, but it lives in each agent's own
 * MCP server process, so it only reached an agent when that agent was next
 * spawned. Every restart from here on shows the post-fix behaviour; the eight
 * before it are the mixed population and are reported, never asserted on.
 */
const DEFAULT_SINCE = '2026-08-11T23:00:00Z';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const logPath = arg('--log', DEFAULT_LOG);
const since = Date.parse(arg('--since', DEFAULT_SINCE));

if (Number.isNaN(since)) {
  console.error('--since must be an ISO timestamp');
  process.exit(2);
}

// ---- setup guards. These are NOT verdicts: exit 2, never 1. ----

let mcpSource;
try {
  mcpSource = readFileSync(join(REPO, 'daemon', 'src', 'mcp.ts'), 'utf8');
} catch (err) {
  console.error(`setup: cannot read daemon/src/mcp.ts: ${err.message}`);
  process.exit(2);
}

const ceilingMatch = /RECONNECT_MAX_MS\s*=\s*([\d_]+)/.exec(mcpSource);
if (!ceilingMatch) {
  console.error(
    'setup: RECONNECT_MAX_MS not found in daemon/src/mcp.ts. The bound this ' +
    'script asserts is read from that constant, so its absence means the ' +
    'reconnect backoff has been restructured and this script needs rewriting ' +
    'rather than passing.'
  );
  process.exit(2);
}
const ceilingMs = Number(ceilingMatch[1].replace(/_/g, ''));

// The ceiling is the longest backoff, not the longest legitimate recovery: the
// agent still has to connect and identify after its timer fires, and the daemon
// is doing its own boot work meanwhile. This allowance is deliberately generous
// — the defect class is minutes-or-never, and a gate tuned so fine that ordinary
// scheduling noise reds it is a gate somebody will switch off.
const ALLOWANCE_MS = 5_000;
const boundMs = ceilingMs + ALLOWANCE_MS;

let raw;
try {
  // latin1, not utf8: the log carries PTY bytes and a strict decoder can drop a
  // whole line. A missing line here reads as an agent that never came back, so
  // the decoder choice is load-bearing — and it is why nothing below matches on
  // a non-ASCII character (KAN-454: an em-dash-anchored regex reported every
  // agent as lost).
  raw = readFileSync(logPath, 'latin1');
} catch (err) {
  console.error(`setup: cannot read ${logPath}: ${err.message}`);
  process.exit(2);
}

// ---- the measurement ----

const lines = raw.split('\n');
const TS = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;
const START = /Butchr daemon listening on \S+ \(pid (\d+)\)/;
const SURVIVORS = /\[reconcile\] \d+ of \d+ surviving agent\(s\) hold no channel registration: ([^.]+)\./;
const IDENTIFY = /Connection (conn-\d+) is (\S+\/\S+)/;

const tsOf = (line) => {
  const m = TS.exec(line);
  return m ? Date.parse(m[1]) : null;
};

const boundaries = [];
for (let i = 0; i < lines.length; i++) {
  const m = START.exec(lines[i]);
  if (!m) continue;
  const at = tsOf(lines[i]);
  if (at !== null) boundaries.push({ index: i, at, pid: m[1] });
}

const failures = [];
const observations = [];

for (let b = 0; b < boundaries.length; b++) {
  const { index, at, pid } = boundaries[b];
  const end = b + 1 < boundaries.length ? boundaries[b + 1].index : lines.length;
  if (at < since) continue;

  let survivors = null;
  for (let i = index; i < end; i++) {
    const m = SURVIVORS.exec(lines[i]);
    if (m) {
      survivors = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      break;
    }
  }
  // No survivors line means a cold boot with nothing to reconnect. There is no
  // claim to check, so this is skipped rather than passed.
  if (!survivors || survivors.length === 0) continue;

  const firstSeen = new Map();
  for (let i = index; i < end; i++) {
    const m = IDENTIFY.exec(lines[i]);
    if (!m) continue;
    const t = tsOf(lines[i]);
    if (t !== null && !firstSeen.has(m[2])) firstSeen.set(m[2], t);
  }

  // How long this restart's window actually is. An agent cannot be judged to
  // have "never come back" inside a window shorter than the bound — the daemon
  // may simply have been restarted again first — so those are reported as
  // inconclusive rather than counted as failures.
  const windowMs = (b + 1 < boundaries.length ? boundaries[b + 1].at : tsOf(lines[lines.length - 2] ?? '') ?? at) - at;

  for (const agent of survivors) {
    const seen = firstSeen.get(agent);
    if (seen === undefined) {
      if (windowMs < boundMs) {
        observations.push(
          `inconclusive: ${agent} had not re-registered when the daemon restarted again ` +
          `${windowMs}ms later (shorter than the ${boundMs}ms bound) — ${new Date(at).toISOString()}`
        );
      } else {
        failures.push(
          `${agent} NEVER re-registered after the restart at ${new Date(at).toISOString()} ` +
          `(pid ${pid}), watched for ${windowMs}ms`
        );
      }
      continue;
    }
    const recoveredMs = seen - at;
    if (recoveredMs > boundMs) {
      failures.push(
        `${agent} took ${recoveredMs}ms to re-register after the restart at ` +
        `${new Date(at).toISOString()} (pid ${pid}), over the ${boundMs}ms bound ` +
        `(RECONNECT_MAX_MS ${ceilingMs} + ${ALLOWANCE_MS} allowance)`
      );
    } else {
      observations.push(`ok: ${agent} back in ${recoveredMs}ms — ${new Date(at).toISOString()}`);
    }
  }
}

const checked = failures.length + observations.filter((o) => o.startsWith('ok:')).length;

console.log(`log:            ${logPath}`);
console.log(`asserting on:   restarts at or after ${new Date(since).toISOString()}`);
console.log(`bound:          ${boundMs}ms (RECONNECT_MAX_MS ${ceilingMs} read from daemon/src/mcp.ts + ${ALLOWANCE_MS} allowance)`);
console.log(`agent-restarts: ${checked} checked`);

const newest = observations.length || failures.length
  ? [...boundaries].filter((x) => x.at >= since).pop()
  : null;
if (newest) {
  const ageHours = ((Date.now() - newest.at) / 3_600_000).toFixed(1);
  console.log(`newest sample:  ${new Date(newest.at).toISOString()} (${ageHours}h old)`);
}

const inconclusive = observations.filter((o) => o.startsWith('inconclusive:'));
for (const o of inconclusive) console.log(`  ${o}`);

if (checked === 0) {
  // ⚠ Nothing to assert on is NOT a pass. A green here would mean "no restart
  // has been recorded since the cutoff", which is indistinguishable from a
  // working reconnect and must not be reported as one.
  console.log('\nNO RESTART WITH SURVIVORS IN RANGE — nothing was checked.');
  console.log('This is not a pass. It is the absence of evidence, and it is reported');
  console.log('as such so nobody reads it as a working reconnect loop.');
  process.exit(2);
}

if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  ${f}`);
  console.log(
    '\nThis is the KAN-274 defect class: an agent that survived a restart and was ' +
    'left unaddressable. A steer to it is refused, and until it re-registers the ' +
    'fleet cannot reach it at all.'
  );
} else {
  console.log(`\nAll ${checked} agent-restarts re-registered inside the bound.`);
}

process.exit(failures.length ? 1 : 0);
