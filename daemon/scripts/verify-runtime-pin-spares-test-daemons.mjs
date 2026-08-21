// Live proof that KAN-550's runtime pin refuses the daemon that can displace
// the fleet and spares the daemon that cannot — the one a `verify-` script
// spawns into a throwaway $HOME.
//
// WHAT FAILURE THIS WOULD CATCH: the pin refusing every test-spawned daemon on
// any machine with `butchr-daemon.service` installed, which is what KAN-574 was
// filed for. Nine CI-runnable scripts went red on every developer machine and
// stayed green on every runner, because a runner has no unit for the guard to
// disagree with — so the whole suite's green was a statement about the runner's
// configuration rather than about the code. It would equally catch the fix
// overshooting: a `servesFleetSocket` that called the REAL home private would
// switch the pin off altogether and let the 2026-08-20 incident back in
// silently, and §2 and §4 are what stand in front of that.
//
// CI-RUNNABLE: yes — it brings its own `systemctl` on PATH, so the installed
// unit that this defect needs is simulated rather than required, and the
// sections run identically on a runner and on a developer machine. That is the
// point rather than a convenience: the defect was invisible to CI *by
// construction*, and a proof that needed the unit to be really installed would
// have inherited exactly that blindness.
//
// WHERE ITS INPUT COMES FROM, since a proof that supplies its own input has
// tested nothing about arrival (KAN-145). §1 constructs its `HomeIdentity`
// values by hand — it is testing the discrimination itself, and the fleet's
// real home is not a thing a test may move. §2 is what makes that honest: it
// takes NO constructed input, reads this process's own ambient environment, and
// asserts that an ordinary process on this machine lands in the `fleet-socket`
// branch — so §1's cases are the ones a real daemon actually reaches. §3 and §4
// supply no verdict at all: a real `dist/daemon.js` is spawned and asked to
// serve, and what is read is whether it claimed a socket.
//
// WHAT IT DOES NOT COVER, AND WHO COVERS IT. It never spawns a daemon onto the
// machine's REAL socket, deliberately and permanently: the arm that proves the
// refusal still fires (§4) reaches the same branch by telling a COPIED dist
// that the machine's home is the temp dir, so the daemon under test is the real
// build making the real decision while its socket stays in /tmp. An arm that
// used the real $HOME would, the day somebody broke the guard, spawn a second
// daemon at the live fleet's socket — a proof whose failure mode is an incident
// is not worth the fidelity it buys. What that leaves uncovered is the passwd
// lookup itself, `os.userInfo().homedir`; §2 is the observation that covers it,
// on the live machine, with nothing patched.
//
// Isolation is by $HOME: BUTCHR_DIR and the socket path both derive from
// os.homedir() (`ipc.ts`), so a temp HOME gives each daemon here its own socket
// and its own log, and the live daemon at ~/.local/share/butchr is untouched.
//
// Usage: node daemon/scripts/verify-runtime-pin-spares-test-daemons.mjs [--break-fix]
//
//   --break-fix   patch the copied build so `servesFleetSocket` always answers
//                 `fleet-socket` — which IS the code as it stood before
//                 KAN-574 — and watch §3 go red while §4 stays green. One
//                 mutation, two sections, opposite outcomes: that is what says
//                 §3 is measuring the fix and not the weather.
//
// Run it after `npm run build` in daemon/.

import { spawn } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  REFUSED_UNPINNED,
  homeIdentity,
  osHomeDir,
  runtimePinVerdict,
  servesFleetSocket
} from '../dist/daemon-provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(__dirname, '..');
const distDir = path.join(daemonDir, 'dist');

const BREAK_FIX = process.argv.includes('--break-fix');

if (!existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`no build at ${distDir} — run \`npm run build\` in daemon/ first`);
  process.exit(1);
}

/** A `node_modules` with a COMPILED node-pty — the daemon will not start without one. */
function resolveNodeModules() {
  const candidates = [
    path.join(daemonDir, 'node_modules'),
    path.join(process.env.HOME, 'code', 'wroosbit', 'butchr', 'daemon', 'node_modules')
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'node-pty', 'build', 'Release', 'pty.node'))) return dir;
  }
  console.error(
    'No daemon/node_modules with a compiled node-pty found. Run the workspace dep link ' +
      `or \`npm install\` in daemon/ (checked: ${candidates.join(', ')}).`
  );
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), 'kan574-pin-'));
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // Already gone. A cleanup that throws would replace the verdict below
      // with a stack trace, which is the one thing this must not do.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

let failures = 0;
let checks = 0;

function check(ok, what, detail) {
  checks++;
  if (ok) {
    console.log(`  PASS  ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
}

function rule(title) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The unit this machine is pretended to have. `crabcast` is what the real
// drop-in pins, so the simulation is the state KAN-574 was measured in.
const PINNED_RUNTIME = 'crabcast';
const LOADED_UNIT = {
  kind: 'loaded',
  environment: { BUTCHR_AGENT_RUNTIME: PINNED_RUNTIME, BUTCHR_MAX_AGENTS: '10' },
  execMainPid: 4242
};

// ─────────────────────────────────────────────────────────────────────────────
rule('1  servesFleetSocket: which daemon the pin is even about');
// ─────────────────────────────────────────────────────────────────────────────

const realHome = osHomeDir();
check(
  typeof realHome === 'string' && realHome.length > 0,
  'the OS names a home for this user',
  `os.userInfo().homedir gave ${JSON.stringify(realHome)}`
);

const privateHome = path.join(scratch, 'throwaway-home');
mkdirSync(privateHome, { recursive: true });

const asFleet = servesFleetSocket({ processHome: realHome, osHome: realHome });
check(
  asFleet.kind === 'fleet-socket',
  'HOME == the passwd home reads as the FLEET socket',
  `got ${asFleet.kind}`
);

const asPrivate = servesFleetSocket({ processHome: privateHome, osHome: realHome });
check(
  asPrivate.kind === 'private-socket',
  'a redirected HOME reads as a PRIVATE socket',
  `got ${asPrivate.kind}`
);

// A trailing slash is the same directory, and a string compare would miss it.
const asSlashed = servesFleetSocket({ processHome: `${realHome}/`, osHome: realHome });
check(
  asSlashed.kind === 'fleet-socket',
  'a trailing slash on HOME is still the fleet socket',
  `got ${asSlashed.kind}`
);

// ⚠ The branch that would hand an exemption to a daemon that CAN displace the
// fleet: two names for one directory are one socket.
const linkedHome = path.join(scratch, 'link-to-real-home');
symlinkSync(realHome, linkedHome);
const asLinked = servesFleetSocket({ processHome: linkedHome, osHome: realHome });
check(
  asLinked.kind === 'fleet-socket',
  'a HOME that is a SYMLINK to the real home is still the fleet socket',
  `got ${asLinked.kind} — a symlinked HOME claims the same socket file, so calling ` +
    `it private would exempt a daemon that really can displace the fleet`
);

// Undetermined must NOT read as private: that is the direction in which the
// pin switches itself off.
const noOsHome = servesFleetSocket({ processHome: privateHome, osHome: null });
check(
  noOsHome.kind === 'cannot-tell',
  'no passwd home reads as CANNOT-TELL, never as private',
  `got ${noOsHome.kind}`
);
const unresolvable = servesFleetSocket(
  { processHome: privateHome, osHome: realHome },
  () => {
    throw new Error('simulated realpath failure');
  }
);
check(
  unresolvable.kind === 'cannot-tell',
  'a realpath that cannot answer reads as CANNOT-TELL, never as private',
  `got ${unresolvable.kind}`
);

// ─────────────────────────────────────────────────────────────────────────────
rule('2  the same question asked of THIS machine, with nothing constructed');
// ─────────────────────────────────────────────────────────────────────────────

// §1's inputs are hand-built, so on their own they establish that the function
// discriminates and nothing about which branch a real daemon reaches. This is
// that missing half, and it is the KAN-145 check: no fixture, no patch, this
// process's own ambient environment.
const ambient = homeIdentity(process.env);
const ambientVerdict = servesFleetSocket(ambient);
console.log(`  ambient HOME       ${ambient.processHome}`);
console.log(`  passwd home        ${ambient.osHome}`);
console.log(`  verdict            ${ambientVerdict.kind}`);
check(
  ambientVerdict.kind === 'fleet-socket',
  'an ordinary process on this machine lands in the FLEET-SOCKET branch',
  `got ${ambientVerdict.kind} — if this is ever false, the runtime pin does not ` +
    `bind on this machine's own daemon, which is the KAN-550 incident with no guard`
);

// ─────────────────────────────────────────────────────────────────────────────
rule('3  runtimePinVerdict: the transition KAN-574 changes, and only it');
// ─────────────────────────────────────────────────────────────────────────────

const fleetHome = { processHome: realHome, osHome: realHome };
const testHome = { processHome: privateHome, osHome: realHome };

const stillRefuses = runtimePinVerdict(LOADED_UNIT, {}, fleetHome);
check(
  stillRefuses.kind === 'lost',
  'unpinned ON THE FLEET SOCKET still reads LOST — the 2026-08-20 incident',
  `got ${stillRefuses.kind}`
);

const spared = runtimePinVerdict(LOADED_UNIT, {}, testHome);
check(
  spared.kind === 'not-fleet-daemon',
  'unpinned on a PRIVATE socket reads NOT-FLEET-DAEMON',
  `got ${spared.kind}`
);

// Every other branch must be exactly as it was, private socket or not.
check(
  runtimePinVerdict(LOADED_UNIT, { BUTCHR_AGENT_RUNTIME: PINNED_RUNTIME }, testHome).kind ===
    'carried',
  'carrying the pin still reads CARRIED on a private socket',
  'the new branch must not shadow a daemon that agrees with the unit'
);
check(
  runtimePinVerdict({ kind: 'absent' }, {}, testHome).kind === 'nothing-pinned',
  'no unit still reads NOTHING-PINNED',
  'a machine with no unit was never the case this ticket is about'
);
check(
  runtimePinVerdict({ kind: 'unreachable', detail: 'no bus' }, {}, testHome).kind ===
    'cannot-tell',
  'an unreachable systemd still reads CANNOT-TELL',
  'a private socket must not turn "we could not ask" into "nothing to worry about"'
);
// A daemon carrying the WRONG runtime, not merely a missing one.
check(
  runtimePinVerdict(LOADED_UNIT, { BUTCHR_AGENT_RUNTIME: 'herdr' }, fleetHome).kind === 'lost',
  'the WRONG runtime on the fleet socket still reads LOST',
  'disagreement is what refuses, and that is unchanged'
);

// ─────────────────────────────────────────────────────────────────────────────
rule('4  END TO END: a real daemon, a simulated unit, and a throwaway HOME');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `systemctl` of our own, earlier on PATH than the real one.
 *
 * This is what makes the whole script CI-runnable. `queryDaemonUnit` runs
 * `systemctl --user show butchr-daemon.service …` through `spawnSync`, which
 * resolves the name against the child's PATH — so a runner with no systemd and
 * a developer machine with a real unit both get the same answer here, which is
 * the answer the defect needs. Anything that is not the `show` this daemon asks
 * for exits non-zero, which reads as "not a managed unit" and is the safe way
 * to be wrong.
 */
function makeStubSystemctl(dir, declaredEnvironment) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'systemctl');
  const envLine = Object.entries(declaredEnvironment)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const body = [
    '#!/bin/sh',
    '# KAN-574 test double. Answers the one query the pin asks and nothing else.',
    'for a in "$@"; do',
    '  if [ "$a" = "show" ]; then',
    '    echo "LoadState=loaded"',
    `    echo "Environment=${envLine}"`,
    '    echo "ExecMainPID=4242"',
    '    exit 0',
    '  fi',
    'done',
    'exit 1',
    ''
  ].join('\n');
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}

/**
 * A copy of `dist`, optionally mutated.
 *
 * `osHomeDir` is patched rather than `$HOME` because the two arms below need to
 * differ in what the daemon believes the MACHINE's home is, and that is the one
 * thing a test cannot set from outside. Patching it in a copy keeps the guard
 * under test the real one: the daemon still runs `servesFleetSocket` and still
 * decides for itself.
 */
function makeDist(name, { pretendMachineHome, breakFix }) {
  // The same layout `verify-agent-connection-identity.mjs` uses: a `dist` with
  // a `node_modules` beside it, because the daemon imports `node-pty` and a
  // copy in /tmp resolves from where it sits rather than from where it came.
  const installDir = path.join(scratch, name, 'daemon');
  const dir = path.join(installDir, 'dist');
  mkdirSync(installDir, { recursive: true });
  cpSync(distDir, dir, { recursive: true });
  symlinkSync(resolveNodeModules(), path.join(installDir, 'node_modules'));
  const file = path.join(dir, 'daemon-provenance.js');
  let src = readFileSync(file, 'utf8');

  if (pretendMachineHome !== undefined) {
    const anchor = 'export function osHomeDir() {';
    if (!src.includes(anchor)) throw new Error(`could not find ${anchor} to patch`);
    src = src.replace(anchor, `${anchor}\n    return ${JSON.stringify(pretendMachineHome)};`);
  }

  if (breakFix) {
    // Pre-KAN-574 behaviour, exactly: every daemon is treated as the fleet's.
    const anchor = 'export function servesFleetSocket(';
    const at = src.indexOf(anchor);
    if (at < 0) throw new Error(`could not find ${anchor} to patch`);
    const brace = src.indexOf('{', src.indexOf(')', at));
    src = `${src.slice(0, brace + 1)}\n    return { kind: 'fleet-socket' };${src.slice(brace + 1)}`;
  }

  writeFileSync(file, src);
  return dir;
}

/**
 * Start a real daemon and report whether it claimed a socket.
 *
 * The socket is the observable the whole ticket is about: the nine scripts fail
 * with "daemon never claimed its socket", so that is what is read here rather
 * than a log line, which could be produced by a daemon that then died.
 */
async function runDaemon(label, { dist, home, stubDir }) {
  mkdirSync(home, { recursive: true });
  const socketPath = path.join(home, '.local', 'share', 'butchr', 'butchr.sock');
  const stderr = [];

  console.log(`  starting ${label}`);
  console.log(`    dist=${dist}`);
  console.log(`    HOME=${home}`);
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js')], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      BUTCHR_BOARD_RECONCILE: 'off'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  children.push(child);
  child.stderr.on('data', (b) => stderr.push(String(b)));

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  for (let i = 0; i < 80 && !existsSync(socketPath) && exitCode === null; i++) await sleep(250);

  return {
    claimedSocket: existsSync(socketPath),
    exitCode,
    stderr: stderr.join(''),
    kill: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited, which is the outcome §4 is asserting anyway.
      }
    }
  };
}

const stubDir = path.join(scratch, 'stub-bin');
makeStubSystemctl(stubDir, { BUTCHR_AGENT_RUNTIME: PINNED_RUNTIME, BUTCHR_MAX_AGENTS: '10' });
console.log(`  stub systemctl declares ${PINNED_RUNTIME}; the spawned daemons carry no BUTCHR_*`);

// 4a — the regression itself. A test-spawned daemon on a machine whose unit
// pins a runtime must SERVE. This is the arm that is red on today's code.
const testDist = makeDist('dist-test-arm', { breakFix: BREAK_FIX });
const testDaemon = await runDaemon('4a  test-spawned daemon (private HOME)', {
  dist: testDist,
  home: path.join(scratch, 'home-4a'),
  stubDir
});
check(
  testDaemon.claimedSocket,
  'a daemon in a throwaway HOME CLAIMS ITS SOCKET though the unit pins a runtime',
  `exit=${testDaemon.exitCode} — ${
    testDaemon.exitCode === REFUSED_UNPINNED
      ? 'it refused to serve: this is KAN-574 exactly'
      : 'it never came up'
  }\n        ${testDaemon.stderr.split('\n').slice(0, 3).join('\n        ')}`
);
testDaemon.kill();

// 4b — the incident direction, reached without going anywhere near the live
// socket: this copy believes the machine's home IS its temp home, so the very
// same build takes the fleet-socket branch and must refuse.
const incidentHome = path.join(scratch, 'home-4b');
const incidentDist = makeDist('dist-incident-arm', {
  pretendMachineHome: incidentHome,
  breakFix: BREAK_FIX
});
const incidentDaemon = await runDaemon('4b  daemon that IS the machine’s (HOME == passwd home)', {
  dist: incidentDist,
  home: incidentHome,
  stubDir
});
check(
  !incidentDaemon.claimedSocket && incidentDaemon.exitCode === REFUSED_UNPINNED,
  `an unpinned daemon on the machine's OWN home still REFUSES (exit ${REFUSED_UNPINNED})`,
  `claimedSocket=${incidentDaemon.claimedSocket} exit=${incidentDaemon.exitCode} — if this ` +
    `passes a daemon through, KAN-550's guard is off and 2026-08-20 can happen again`
);
check(
  /REFUSING TO SERVE/.test(incidentDaemon.stderr),
  'and it says so where an operator will find it (fd 2 → the journal)',
  `stderr was: ${JSON.stringify(incidentDaemon.stderr.slice(0, 200))}`
);
incidentDaemon.kill();

// ─────────────────────────────────────────────────────────────────────────────
rule('verdict');
// ─────────────────────────────────────────────────────────────────────────────

if (BREAK_FIX) {
  console.log('--break-fix was set: `servesFleetSocket` was patched to the pre-KAN-574');
  console.log('answer, so §4a is EXPECTED to fail and §4b is EXPECTED to pass. A run in');
  console.log('which both stay green means this proof is not measuring the fix.\n');
  console.log('§1-§3 are EXPECTED to stay green, and that is not them failing to notice:');
  console.log('the patch is applied to the COPIES §4 spawns, while §1-§3 assert against');
  console.log('the installed ../dist. What turns those red is a regression in the build');
  console.log('itself, which is what they are there to catch.\n');
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
} else {
  console.log('\nALL PASS — the pin refuses the daemon that can displace the fleet,');
  console.log('and spares the daemon that cannot.');
}

process.exit(failures ? 1 : 0);
