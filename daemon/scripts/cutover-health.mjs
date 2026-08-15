// The cutover watchdog's health poll (KAN-481).
//
// WHY THIS IS IN THE REPOSITORY AND NOT IN THE CUTOVER KIT. The predicate it
// evaluates used to live inside a `grep -o` pipeline in
// `~/butchr-cutover/watchdog.sh`, where the only way to run it was to be
// mid-cutover. So it was never run against a control, and when it started
// firing on healthy fleets there was nothing to notice with: attempt #5 was
// rolled back at 162 seconds by a red that carried no information. A predicate
// that can be run against yesterday's recorded frames, and against the fleet
// running right now, is the whole fix — `verify-cutover-health-predicate.mjs`
// is what runs it.
//
// IT READS AND NEVER WRITES. One socket action, `list_agents`, which is a read.
// There is no flip verb here and no rollback verb, deliberately: the watchdog
// decides to roll back and this decides nothing but healthy-or-not.
//
// NODE BUILTINS ONLY, NO `dist`, NO `node_modules` — the same promise
// `probe-cutover-readiness.mjs` makes, for the same reason. This runs on the
// worst day, and the worst day is the one where the build is broken.
//
// Usage:
//   node daemon/scripts/cutover-health.mjs            # JSON + verdict exit
//   node daemon/scripts/cutover-health.mjs --explain  # and why, in prose
//   node daemon/scripts/cutover-health.mjs --frame F  # evaluate a saved frame
//
// Exit codes:
//   0  the fleet is reachable (or is empty — see `unhealthy` in the predicate)
//   1  UNHEALTHY: agents exist and not one of them can be reached
//   2  the read did not happen — socket silent, frame unparseable. THIS IS NOT
//      A VERDICT ABOUT THE FLEET, and the watchdog must count it separately
//      from a 1. A rollback triggered by an unreadable socket is a rollback
//      triggered by the instrument.

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fleetHealth, retiredCounts } from './lib/cutover-health-predicate.mjs';

const SOCKET_PATH =
  process.env.BUTCHR_SOCK || path.join(os.homedir(), '.local', 'share', 'butchr', 'butchr.sock');

const argv = process.argv.slice(2);
const explain = argv.includes('--explain');
const frameArg = argv.indexOf('--frame');

/** Read one `list_agents` frame off the daemon socket. */
function readFleet(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no complete frame within 15s from ${socketPath}`));
    }, 15000);

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('connect', () => sock.write(JSON.stringify({ action: 'list_agents' }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // The daemon answers this action with one JSON document. Parse-on-every-
      // chunk rather than waiting for a newline, because the response is large
      // enough to arrive in several and a partial parse simply throws.
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

let frame;
try {
  if (frameArg !== -1) {
    const file = argv[frameArg + 1];
    if (!file) throw new Error('--frame needs a path');
    frame = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    frame = await readFleet(SOCKET_PATH);
  }
} catch (err) {
  // Exit 2, never 1. "I could not look" and "I looked and it is broken" are
  // different claims, and the watchdog rolls back on only one of them.
  console.error(
    JSON.stringify({ error: String(err?.message ?? err), read: false, socket: SOCKET_PATH })
  );
  process.exit(2);
}

const health = fleetHealth(frame?.agents);
const retired = retiredCounts(frame?.agents);

const report = {
  ...health,
  // Carried alongside so a reader comparing this against an old `cutover.log`
  // line is comparing like with like, and so the day the two verdicts disagree
  // is visible in the log rather than needing this script re-run.
  retiredCounts: retired,
  missing: (frame?.missingAgents || []).length,
  mode: (frame?.runtimeSwitch && frame.runtimeSwitch.mode) || null,
  at: new Date().toISOString()
};

console.log(JSON.stringify(report));

if (explain) {
  const lines = [
    '',
    `  agents        ${report.agents}`,
    `  reachable     ${report.reachable}   (${report.bySession} by session, ${report.byChannel} by channel; an agent may be both)`,
    `  unreachable   ${report.unreachable}${report.unreachable ? `   ${report.unreachableAgents.join(', ')}` : ''}`,
    '',
    `  MARGIN        ${report.marginAgents} reachable agent(s) stand between this fleet and a trip.`,
    '                The trip needs that number to reach ZERO, and to stay there for',
    '                the watchdog\'s FAIL_LIMIT consecutive polls.',
    '',
    `  VERDICT       ${report.unhealthy ? 'UNHEALTHY — agents exist and not one can be reached' : 'healthy'}`,
    ''
  ];
  console.error(lines.join('\n'));
}

// Verdict-derived, per KAN-119: this value is computed from the predicate above
// and is not a setup guard.
process.exit(report.unhealthy ? 1 : 0);
