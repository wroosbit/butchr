// Live proof that a failed agent spawn is reported rather than swallowed —
// the KAN-24 legibility fix, exercised against a real herdr.
//
// WHAT FAILURE THIS WOULD CATCH: a refused spawn that comes back looking like
// a success — a session left marked `active` with no `spawnError`, so
// `activate` answers `success: true` for an agent that does not exist. That is
// the KAN-24 outage exactly, and it stayed invisible for an afternoon. It also
// catches the softer regression the fix was really about: a `spawnError` that
// carries the raw operating-system error with none of the diagnosis that tells
// you which of the two failures you are looking at.
//
// CI-RUNNABLE: no — stands up a private herdr server and makes real spawns
// fail against it.
//
// Before the fix, `herdr agent start` was a bare spawnSync whose result was
// discarded. A refused spawn produced a session marked 'active' and an
// activate response of `success: true`, which is how an outage stayed
// invisible for an afternoon. This drives two real failure modes and prints
// what HerdrBridge now reports for each.
//
// Everything runs against a private herdr server on its own socket, so it
// cannot disturb a live session.
//
// Usage: node daemon/scripts/verify-spawn-failure-legibility.mjs [distDir]
//
// distDir defaults to ../dist. Point it at a build of an older revision to see
// the previous behaviour for comparison.

import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

// sockaddr_un.sun_path is ~108 bytes, so the socket cannot live under a long
// TMPDIR. /tmp directly is the only reliably short option.
const runDir = mkdtempSync('/tmp/herdr-k24-');
const stateDir = mkdtempSync(path.join(tmpdir(), 'k24-state-'));
const workspaceRoot = path.join(
  process.env.HOME, '.local', 'share', 'butchr', 'workspaces', 'k24proof'
);

process.env.HERDR_SOCKET_PATH = path.join(runDir, 'h.sock');
process.env.XDG_CONFIG_HOME = path.join(stateDir, 'config');
process.env.XDG_STATE_HOME = path.join(stateDir, 'state');
process.env.HERDR_LOG = 'herdr=info';
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const herdr = (...args) => {
  try {
    return execFileSync('herdr', args, { encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    return e.stdout ?? String(e);
  }
};

let server;
let tinyClient;
function cleanup() {
  tinyClient?.kill('SIGKILL');
  server?.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log('== starting a private herdr server ==');
server = spawn('herdr', ['server'], { detached: true, stdio: 'ignore', env: process.env });
for (let i = 0; i < 20; i++) {
  if (herdr('pane', 'list').includes('"panes"')) break;
  await sleep(500);
}
console.log(`   pid ${server.pid}, socket ${process.env.HERDR_SOCKET_PATH}`);

const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const bridge = new HerdrBridge();

const failures = [];
// `detail` explains the failure, so it is printed only when there is one —
// otherwise every PASS line carries the reason it would have had for failing.
const check = (name, ok, detail) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

/**
 * Print what the bridge reported for a refused spawn, and hold it to the three
 * things KAN-24 requires: the failure is recorded, the session is not passed off
 * as running, and the error says enough to act on.
 *
 * `diagnosis` is the phrase that distinguishes this failure mode from the other
 * one. Asserting it is the difference between "an error came back" and "the
 * error told you which outage you are in", which is the whole subject here.
 */
function report(label, session, diagnosis) {
  console.log(`   session.status ...... ${session.status}`);
  console.log(`   session.spawnError .. ${session.spawnError ?? '(none)'}`);
  // What handleActivateByKey would answer for this session.
  const activateSaid = session.spawnError
    ? { success: false, error: session.spawnError }
    : { success: true, sessionId: session.sessionId, status: session.status };
  console.log(`   activate would say .. ${JSON.stringify(activateSaid, null, 2).replace(/\n/g, '\n' + ' '.repeat(27))}`);
  console.log('');

  // If the spawn succeeded, the failure mode was never induced and this section
  // has proved nothing — which is a failure of the proof, not a pass.
  check(
    `${label}: the spawn actually failed (the mode was induced)`,
    session.status !== 'active' || Boolean(session.spawnError),
    `status ${session.status} with no spawnError — nothing was refused, so nothing was proved`
  );
  check(
    `${label}: the failure is recorded on the session`,
    typeof session.spawnError === 'string' && session.spawnError.length > 0,
    session.spawnError ? undefined : 'spawnError is empty — the refusal was swallowed'
  );
  check(
    `${label}: the session is not left marked active`,
    session.status !== 'active',
    `status: ${session.status}`
  );
  check(
    `${label}: activate would report the failure, not success`,
    activateSaid.success === false,
    `activate would have said success: ${activateSaid.success}`
  );
  check(
    `${label}: the error diagnoses the cause rather than only quoting the OS`,
    diagnosis.test(session.spawnError ?? ''),
    `expected ${diagnosis} in: ${session.spawnError ?? '(none)'}`
  );
}

// ---------------------------------------------------------------- geometry --
console.log('\n== failure mode 1: collapsed pane geometry (the real KAN-24 outage) ==');
herdr('agent', 'start', 'anchor', '--cwd', '/tmp', '--', 'bash', '-c', 'while true; do sleep 5; done');
await sleep(1000);
// A pty with no window size reports 1x1, which shrinks the workspace layout
// until a new pane's share rounds to zero. This is the exact mechanism.
tinyClient = spawn('script', ['-q', '-c', 'herdr agent attach anchor --takeover', '/dev/null'],
  { stdio: 'ignore', env: process.env });
await sleep(3000);

const geometrySession = bridge.spawnSession('k24proof', 'geometry', undefined, '', 1);
await sleep(500);
report('geometry', geometrySession, /pane-geometry failure, not a resource failure/);

tinyClient.kill('SIGKILL');
tinyClient = null;
await sleep(2000);

// ------------------------------------------------------------ fd exhaustion --
console.log('\n== failure mode 2: file-descriptor exhaustion (prlimit, as the ticket asks) ==');
const openNow = readdirSync(`/proc/${server.pid}/fd`).length;
console.log(`   server currently holds ${openNow} fds; dropping its soft limit to ${openNow + 1}`);
let fdLimitApplied = true;
try {
  execFileSync('prlimit', ['--pid', String(server.pid), `--nofile=${openNow + 1}:1048576`]);
} catch (e) {
  fdLimitApplied = false;
  console.log(`   prlimit failed (${e.message})`);
}
// A mode that could not be induced is a mode this script did not prove. Saying
// "skipping" and exiting 0 is precisely the shape KAN-119 exists to remove.
check(
  'fdlimit: the failure mode could be induced at all',
  fdLimitApplied,
  'prlimit could not drop the herdr server\'s fd limit, so nothing below exercises the fd path'
);
console.log(`   limit now: ${readFileSync(`/proc/${server.pid}/limits`, 'utf8')
  .split('\n').find(l => l.startsWith('Max open files')).trim()}`);

const fdSession = bridge.spawnSession('k24proof', 'fdlimit', undefined, '', 1);
await sleep(500);
report('fdlimit', fdSession, /Resource pressure at the time/);

console.log(
  failures.length
    ? `\n${failures.length} FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS — both refused spawns were reported, diagnosed, and never passed off as running.'
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
