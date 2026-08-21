#!/usr/bin/env node
// KAN-550: a daemon that is not the one you configured must not be able to
// serve the fleet quietly.
//
// WHAT FAILURE THIS WOULD CATCH: the 2026-08-20 incident, in each of the three
// ways it hid. `butchr-daemon.service` was stopped for two minutes; Chrome's
// native host auto-spawned a replacement within seconds; that replacement
// carried NO `BUTCHR_*` at all, so the runtime pin (`crabcast`) and the agent
// cap (6, on a machine the human had just asked to run at 6) were silently
// dropped, the Atlassian proxy went off and the board reconciler fell to report
// mode. Meanwhile `systemctl is-active` read `inactive` — correctly, since the
// process holding the socket was not systemd's — and `systemctl start` reported
// success while leaving nothing running, because the real unit lost the
// singleton race and exited *0*, which `Restart=on-failure` does not retry.
//
// Concretely, this goes red if any of these regress:
//
//   * a daemon whose unit pins a runtime it is not carrying comes up anyway
//     (§2, §6) — the silent flip;
//   * a daemon that loses the race to an unconfigured winner exits 0 (§3, §7)
//     — the exit status that left `Restart=` nothing to act on;
//   * the refusal or the loss goes to `daemon.log` only and not to fd 2 (§6,
//     §7) — "in the journal" is the criterion, and `console.error` inside this
//     daemon does NOT reach it, because `daemon.ts` redirects it to a file;
//   * `queryDaemonUnit` stops telling "there is no unit" from "I could not ask
//     systemd" (§1) — the collapse KAN-559 is filed for at the OTHER unit
//     predicate, refused here by construction;
//   * `isUnitMainProcess` regresses to reading `INVOCATION_ID`'s presence (§1,
//     §5). That variable is INHERITED by every descendant of a unit, so it
//     reports "systemd started me" for processes systemd never started. A first
//     draft of this fix did exactly that, and reported an unconfigured
//     hand-started daemon as healthy — the false green rebuilt inside its own
//     cure. §5 measures the real values that make it false.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS WHAT THAT LEAVES ─────────────
//
// §1-§4 hand the decision functions their inputs directly. They are proofs
// that supply their own input (KAN-145) and they say so: what they establish is
// that the DECISIONS are right across their input space, and nothing about
// whether a real daemon reaches them.
//
// §6 and §7 close that by running the REAL `daemon/dist/daemon.js` as real
// processes and reading the exit status the OS actually saw, plus the bytes
// that actually reached fd 2. Nothing is stubbed inside the daemon.
//
// ⚠ WHAT IS STUBBED IS `systemctl` ITSELF, and that is the coverage boundary of
// §6 and §7. A fake `systemctl` earlier on `PATH` impersonates the three states
// of the unit, which is what lets these sections run on a CI runner that has no
// user manager — and it means they prove nothing about systemd's real output
// format. §5 is what covers that, against the real `systemctl` on a machine
// that has one, and it SKIPS in CI, which is why this script exits 2 there
// rather than 0.
//
// WHAT NOBODY COVERS: that systemd, on seeing exit 3, actually restarts the
// unit and lands it in `failed` rather than `inactive`. That is `Restart=` and
// `StartLimitBurst=`'s behaviour, not this repository's, and asserting it would
// mean installing and cycling a real unit. It was demonstrated by hand on the
// PR instead, with the commands pasted, and it is named here rather than left
// to be inferred from a green run.
//
// ⚠ NOTHING HERE STOPS, STARTS, OR READS THE LIVE `butchr-daemon.service`, and
// that is deliberate rather than incidental. Every daemon this script starts
// runs under a `HOME` of its own in a temp directory, so `BUTCHR_DIR` and
// `SOCKET_PATH` — both derived from `os.homedir()` — land there and nowhere
// near the running fleet. The one section that touches the real system, §5,
// only ever READS (`systemctl show`), and the ticket that provoked this one
// records what the alternative costs: the proof on #250 stopped the live daemon
// twice and briefly put three supervisors in `blocked`.
//
// CI-RUNNABLE: partial — §1-§4 are pure and need nothing. §6 and §7 need
// `daemon/dist` and spawn real node processes with a stubbed `systemctl`; they
// SKIP without a build. §5 needs a reachable `systemctl --user` and SKIPS on a
// runner, which makes this script exit 2 there rather than 0 (KAN-373's
// contract). `run-ci-verify-set.mjs` builds first, so §6 and §7 execute there.
//
// ── DRIVING IT RED ────────────────────────────────────────────────────────
//
// Each of these was run and watched to fail before this script was committed;
// the output is pasted in the PR body.
//
//   1. In `daemon-provenance.ts`, make `incumbentIsConfigured` return `true`
//      for a `null` report.                                       -> §3 red
//      (§3 ONLY, and the narrowness is worth stating: §7's incumbent DOES
//      answer, so no live section exercises the no-answer branch. Nothing here
//      covers a real daemon that stays silent — an old build, or a wedged one —
//      and §3 asserting the decision is not the same claim.)
//   2. In `daemon-provenance.ts`, make `isUnitMainProcess` return
//      `unit.kind === 'loaded'` — presence of a unit rather than identity with
//      it, which is the shape the INVOCATION_ID draft had.    -> §1, §5 red
//   3. In `daemon.ts`, change the refusal's `process.exit(REFUSED_UNPINNED)`
//      back to falling through and serving.                   -> §6 red
//   4. In `daemon.ts`, swap `announceToJournal(...)` for `log(...)` on the
//      refusal path.                                          -> §6 red
//   5. In `daemon.ts`, restore the unconditional `process.exit(0)` on
//      EADDRINUSE.                                            -> §7 red
//   6. In `queryDaemonUnit`, drop the `LoadState` read and infer "absent"
//      from an empty `Environment`.                           -> §1 red
//   7. In `servesFleetSocket`, return `{ kind: 'fleet-socket' }` unconditionally
//      — the pre-KAN-574 answer, where the pin governed every daemon including
//      a test's.                                              -> §6 red
//      (And the mirror of it: return `private-socket` unconditionally, which is
//      the pin switching itself off.)                         -> §6 red

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DIST = path.join(REPO, 'daemon/dist');

let failures = 0;
let skipped = 0;
const cleanups = [];

const rule = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
function check(ok, what, detail) {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m ${what}`);
    return true;
  }
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${what}`);
  if (detail !== undefined) console.log(`       ${detail}`);
  return false;
}
function skip(what, why) {
  skipped += 1;
  console.log(`  \x1b[33mSKIP\x1b[0m ${what}`);
  console.log(`       ${why}`);
}

// ---------------------------------------------------------------------------

const provenance = await import(path.join(DIST, 'daemon-provenance.js')).catch((err) => {
  console.log(`\ndaemon/dist is not importable: ${err?.message ?? err}`);
  return null;
});

if (provenance === null) {
  skip('every section', 'daemon/dist is missing — build with `npm --prefix daemon run build`.');
  reportAndExit({ failures, skipped });
}

const {
  LOST_TO_CONFIGURED,
  LOST_TO_UNCONFIGURED,
  REFUSED_UNPINNED,
  RUNTIME_PIN_ACK_ENV,
  describeRefusal,
  describeThisProcess,
  incumbentIsConfigured,
  isUnitMainProcess,
  parseUnitEnvironment,
  pinDrift,
  queryDaemonUnit,
  runtimePinVerdict
} = provenance;

/** A `CommandRunner` that replays a canned `systemctl` answer. */
const canned = (stdout, status = 0, stderr = '') => () => ({ status, stdout, stderr });

// ── §1 the unit query tells three states apart ────────────────────────────
rule('§1  queryDaemonUnit: loaded / absent / unreachable are three answers');

{
  const loaded = queryDaemonUnit(
    canned(
      'Environment=PATH=/usr/bin BUTCHR_AGENT_RUNTIME=crabcast BUTCHR_MAX_AGENTS=6\n' +
        'LoadState=loaded\nExecMainPID=847\n'
    )
  );
  check(loaded.kind === 'loaded', 'a loaded unit reads as `loaded`', `got ${loaded.kind}`);
  check(
    loaded.kind === 'loaded' && loaded.environment.BUTCHR_AGENT_RUNTIME === 'crabcast',
    'its declared BUTCHR_AGENT_RUNTIME is read'
  );
  check(loaded.kind === 'loaded' && loaded.execMainPid === 847, 'its ExecMainPID is read');

  const absent = queryDaemonUnit(canned('Environment=\nLoadState=not-found\nExecMainPID=0\n'));
  check(absent.kind === 'absent', 'a not-found unit reads as `absent`', `got ${absent.kind}`);

  // THE TRAP THIS SECTION EXISTS FOR. `systemctl show -p Environment --value`
  // on a unit that does not exist prints an empty line and EXITS 0 — byte for
  // byte what a unit that exists and declares nothing prints. An implementation
  // that inferred absence from an empty environment would call the first case
  // "loaded with nothing pinned" and never refuse anything.
  const emptyButLoaded = queryDaemonUnit(canned('Environment=\nLoadState=loaded\nExecMainPID=0\n'));
  check(
    emptyButLoaded.kind === 'loaded',
    'a LOADED unit that declares nothing is still `loaded`, not `absent`',
    `got ${emptyButLoaded.kind} — absence was inferred from an empty Environment`
  );
  check(
    emptyButLoaded.kind === 'loaded' && emptyButLoaded.execMainPid === null,
    'ExecMainPID=0 reads as null (nobody), never as pid 0'
  );

  const unreachable = queryDaemonUnit(canned('', 1, 'Failed to connect to bus: No such file'));
  check(
    unreachable.kind === 'unreachable',
    'a systemctl that cannot reach the bus reads as `unreachable`, not `absent`',
    `got ${unreachable.kind}`
  );

  const nonsense = queryDaemonUnit(canned('Environment=\n'));
  check(
    nonsense.kind === 'unreachable',
    'a 0 exit with no LoadState reads as `unreachable`, not `absent`',
    `got ${nonsense.kind} — an unparsed answer was resolved toward the comfortable reading`
  );

  const thrower = () => {
    throw new Error('ENOENT: systemctl not installed');
  };
  check(
    queryDaemonUnit(thrower).kind === 'unreachable',
    'a systemctl that will not execute at all reads as `unreachable`'
  );
}

{
  const q = parseUnitEnvironment('A=1 B="two words" C=3');
  check(q.A === '1' && q.B === 'two words' && q.C === '3', 'quoted values with spaces parse');
}

{
  // The INVOCATION_ID trap, refused structurally: a process carrying an
  // inherited invocation id is NOT the unit's main process unless the pid says
  // so. §5 supplies the real numbers that make this a live hazard.
  const unit = { kind: 'loaded', environment: {}, execMainPid: 847 };
  check(isUnitMainProcess(unit, 847), 'the pid systemd names IS the unit main process');
  check(!isUnitMainProcess(unit, 848), 'any other pid is NOT, whatever it inherited');
  check(
    !isUnitMainProcess({ kind: 'absent' }, 847),
    'no unit means nobody is its main process'
  );
  check(
    !isUnitMainProcess({ kind: 'unreachable', detail: 'x' }, 847),
    'an unreachable systemd does not confer main-process status'
  );
}

// ── §2 the runtime pin verdict ────────────────────────────────────────────
rule('§2  runtimePinVerdict: only a DISAGREEMENT with the unit refuses');

{
  const pinned = { kind: 'loaded', environment: { BUTCHR_AGENT_RUNTIME: 'crabcast' }, execMainPid: 1 };

  const carried = runtimePinVerdict(pinned, { BUTCHR_AGENT_RUNTIME: 'crabcast' });
  check(carried.kind === 'carried', 'carrying the pinned runtime is `carried`', `got ${carried.kind}`);

  const lost = runtimePinVerdict(pinned, {});
  check(lost.kind === 'lost', 'the unit pins it and we do not carry it: `lost`', `got ${lost.kind}`);
  check(lost.kind === 'lost' && lost.running === null, 'and `running` is null, not an empty string');

  const wrong = runtimePinVerdict(pinned, { BUTCHR_AGENT_RUNTIME: 'herdr' });
  check(wrong.kind === 'lost', 'carrying a DIFFERENT runtime than the unit pins is also `lost`');

  const acked = runtimePinVerdict(pinned, { [RUNTIME_PIN_ACK_ENV]: '1' });
  check(
    acked.kind === 'lost-acknowledged',
    `${RUNTIME_PIN_ACK_ENV}=1 downgrades the refusal to an announcement`,
    `got ${acked.kind}`
  );
  const halfAcked = runtimePinVerdict(pinned, { [RUNTIME_PIN_ACK_ENV]: 'yes' });
  check(
    halfAcked.kind === 'lost',
    'only the exact string 1 acknowledges — a truthy value does not',
    `got ${halfAcked.kind}`
  );

  // The two cases that must NOT refuse. A machine with no unit is CORRECTLY
  // unpinned; refusing there would refuse on every container, runner and fresh
  // checkout, which is how a guard gets switched off wholesale.
  check(
    runtimePinVerdict({ kind: 'absent' }, {}).kind === 'nothing-pinned',
    'no unit at all: nothing is pinned, so nothing is wrong'
  );
  check(
    runtimePinVerdict({ kind: 'loaded', environment: {}, execMainPid: 1 }, {}).kind ===
      'nothing-pinned',
    'a unit that pins no runtime: nothing is wrong'
  );
  const cannot = runtimePinVerdict({ kind: 'unreachable', detail: 'no bus' }, {});
  check(
    cannot.kind === 'cannot-tell',
    'an unreachable systemd is `cannot-tell` — unknown, not fine',
    `got ${cannot.kind}`
  );
}

{
  const unit = {
    kind: 'loaded',
    environment: { BUTCHR_AGENT_RUNTIME: 'crabcast', BUTCHR_MAX_AGENTS: '6', PATH: '/usr/bin' },
    execMainPid: 1
  };
  const drift = pinDrift(unit, { BUTCHR_AGENT_RUNTIME: 'crabcast' });
  check(drift.length === 1 && drift[0].name === 'BUTCHR_MAX_AGENTS', 'drift names each lost pin');
  check(
    pinDrift(unit, { BUTCHR_AGENT_RUNTIME: 'crabcast', BUTCHR_MAX_AGENTS: '6' }).length === 0,
    'a fully-carried environment has no drift'
  );
  check(
    !pinDrift(unit, {}).some((d) => d.name === 'PATH'),
    'PATH is not a BUTCHR_ pin and is never reported as drift'
  );
  check(
    pinDrift({ kind: 'absent' }, { BUTCHR_MAX_AGENTS: '99' }).length === 0,
    'an extra BUTCHR_ var with no unit to contradict is not drift'
  );
}

// ── §3 the loser's reading of the winner fails toward LOUD ────────────────
rule('§3  incumbentIsConfigured: silence and nonsense are NOT a clean bill');

{
  const ok = {
    unit: { kind: 'loaded', declaresRuntime: 'crabcast' },
    isUnitMainProcess: true,
    pinDrift: []
  };
  check(incumbentIsConfigured(ok), 'the unit main process with no drift is configured');
  check(
    !incumbentIsConfigured(null),
    'NO ANSWER is not configured — an old or wedged daemon must go loud',
    'this is the exact reading that decides exit 3 vs exit 0'
  );
  check(
    !incumbentIsConfigured({ ...ok, isUnitMainProcess: false }),
    'a daemon that is not the unit main process is not configured'
  );
  check(
    !incumbentIsConfigured({ ...ok, pinDrift: [{ name: 'BUTCHR_AGENT_RUNTIME', declared: 'crabcast', running: null }] }),
    'a daemon missing a pinned variable is not configured'
  );
  check(
    incumbentIsConfigured({ unit: { kind: 'absent', declaresRuntime: null }, isUnitMainProcess: false, pinDrift: [] }),
    'on a machine with NO unit, a daemon is as configured as it can be'
  );
  check(
    !incumbentIsConfigured({ unit: { kind: 'unreachable', declaresRuntime: null }, isUnitMainProcess: false, pinDrift: [] }),
    'an unreachable systemd does not confer configured status'
  );
}

// ── §4 the refusal says what an operator needs ────────────────────────────
rule('§4  describeRefusal names both values and the way out');

{
  const pinned = { kind: 'loaded', environment: { BUTCHR_AGENT_RUNTIME: 'crabcast' }, execMainPid: 1 };
  const text = describeRefusal(runtimePinVerdict(pinned, {})).join('\n');
  check(text.includes('crabcast'), 'it names the runtime the unit declares');
  check(text.includes('(not set)'), 'it says the process has none, rather than printing nothing');
  check(text.includes(RUNTIME_PIN_ACK_ENV), 'it names the override');
  check(text.includes('systemctl --user start'), 'it names the command that fixes it');
  check(
    describeRefusal(runtimePinVerdict(pinned, { BUTCHR_AGENT_RUNTIME: 'crabcast' })).length === 0,
    'a carried pin produces no refusal text at all'
  );
}

// ── §5 the parser against a REAL systemctl ────────────────────────────────
rule('§5  the real `systemctl show` output is understood (needs a user manager)');

{
  const real = queryDaemonUnit();
  if (real.kind === 'unreachable') {
    skip(
      'real systemctl parse',
      `no reachable \`systemctl --user\` here (${real.detail}). §1 proves the parser against ` +
        `CANNED output only, so on this machine nothing has checked that systemd's ACTUAL ` +
        `format is the one the parser reads. That is what this section is for.`
    );
  } else {
    check(
      real.kind === 'loaded' || real.kind === 'absent',
      'a reachable systemd yields `loaded` or `absent`',
      `got ${real.kind}`
    );
    if (real.kind === 'loaded') {
      check(
        typeof real.environment === 'object' && real.environment !== null,
        'the real Environment line parsed into an object'
      );
      // The INVOCATION_ID hazard, measured rather than argued. This process is
      // not the daemon, and on a machine where any ancestor is a systemd unit it
      // nonetheless carries an INVOCATION_ID. If that presence were the test,
      // this assertion is what would go red.
      const self = describeThisProcess();
      if (self.invocationIdInherited === null) {
        skip(
          'the INVOCATION_ID inheritance hazard',
          'this process carries no INVOCATION_ID, so the inheritance trap cannot be ' +
            'demonstrated here. It needs a process descended from a systemd unit — which is ' +
            'every agent on the fleet machine, and no process on a bare runner.'
        );
      } else {
        check(
          !isUnitMainProcess(real, self.pid),
          'THIS process carries an inherited INVOCATION_ID and is still not the unit main process',
          `INVOCATION_ID=${self.invocationIdInherited} but ExecMainPID=${String(real.execMainPid)} ` +
            `and our pid is ${self.pid} — presence of the variable proves nothing`
        );
      }
    } else {
      skip(
        'the real unit',
        'systemd is reachable but butchr-daemon.service is not installed here, so the ' +
          'loaded-unit parse and the INVOCATION_ID hazard are unchecked on this machine.'
      );
    }
  }
}

// ── real-process harness ──────────────────────────────────────────────────

/**
 * A sandbox: its own HOME, and a `systemctl` on PATH that answers as told.
 *
 * The stub is what makes §6 and §7 runnable where there is no user manager. It
 * reads its answer out of files in the sandbox so a test can change what the
 * unit says WHILE a daemon is running — which is how §7 makes an already-live
 * incumbent become the unit's main process.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan550-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  const stub = path.join(dir, 'bin', 'systemctl');
  fs.writeFileSync(
    stub,
    [
      '#!/bin/sh',
      '# Stub systemctl for verify-daemon-provenance-is-loud.mjs (KAN-550).',
      'MODE=$(cat "$KAN550_SANDBOX/mode" 2>/dev/null)',
      'MAIN=$(cat "$KAN550_SANDBOX/mainpid" 2>/dev/null)',
      '[ -z "$MAIN" ] && MAIN=0',
      'case "$MODE" in',
      '  loaded)',
      '    printf "Environment=PATH=/usr/bin BUTCHR_AGENT_RUNTIME=crabcast\\n"',
      '    printf "LoadState=loaded\\nExecMainPID=%s\\n" "$MAIN"',
      '    exit 0 ;;',
      '  absent)',
      '    printf "Environment=\\nLoadState=not-found\\nExecMainPID=0\\n"',
      '    exit 0 ;;',
      '  *)',
      '    echo "Failed to connect to bus: No such file or directory" >&2',
      '    exit 1 ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o755 }
  );
  const box = {
    dir,
    socket: path.join(dir, '.local', 'share', 'butchr', 'butchr.sock'),
    setMode: (m) => fs.writeFileSync(path.join(dir, 'mode'), m),
    setMainPid: (p) => fs.writeFileSync(path.join(dir, 'mainpid'), String(p)),
    env: (extra) => ({
      ...process.env,
      HOME: dir,
      KAN550_SANDBOX: dir,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      // Never let a sandboxed daemon inherit the real fleet's pins.
      BUTCHR_AGENT_RUNTIME: undefined,
      BUTCHR_MAX_AGENTS: undefined,
      ...extra
    })
  };
  box.setMode('unreachable');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return box;
}

/**
 * A copy of `dist` that believes the MACHINE's home is this sandbox.
 *
 * ⚠ **KAN-574 made this necessary, and the reason is worth reading before you
 * decide it is a cheat.** The runtime pin now governs only a daemon that would
 * claim the socket the fleet talks to — `os.homedir()` (which `$HOME` moves)
 * against `os.userInfo().homedir` (which nothing moves). That is right, and it
 * is what stopped the pin from refusing every `verify-` script's daemon on
 * every developer machine. But it also means **a sandbox isolated by `$HOME`
 * alone is no longer a daemon the pin is about**, so §6's refusal arms would
 * assert nothing while staying green — the worst outcome available.
 *
 * So those arms move the OTHER reference instead: `osHomeDir` is patched, in a
 * COPY, to name the sandbox. The daemon is then the machine's own daemon as far
 * as it can tell, and it takes the fleet branch and decides for itself. **The
 * guard under test is untouched** — `servesFleetSocket`, `runtimePinVerdict`
 * and the refusal in `daemon.ts` are the shipped code, running.
 *
 * What that leaves uncovered is the passwd lookup itself, and nothing here
 * covers it: `verify-runtime-pin-spares-test-daemons.mjs` §2 does, by asking
 * the live machine with nothing patched.
 */
function machineHomeDist(box) {
  const root = path.join(box.dir, 'build', 'daemon');
  const dist = path.join(root, 'dist');
  if (fs.existsSync(dist)) return dist;
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(DIST, dist, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'daemon', 'node_modules'), path.join(root, 'node_modules'));
  const file = path.join(dist, 'daemon-provenance.js');
  const src = fs.readFileSync(file, 'utf8');
  const anchor = 'export function osHomeDir() {';
  // Asserted rather than assumed: a patch that silently missed would report a
  // daemon that served, and "the refusal did not fire" is exactly the finding
  // this arm exists to make. It must not be producible by a typo.
  if (!src.includes(anchor)) {
    throw new Error(`could not find ${anchor} in ${file} — the §6 patch would have missed`);
  }
  fs.writeFileSync(
    file,
    src.replace(anchor, `${anchor}\n    return ${JSON.stringify(box.dir)};`)
  );
  return dist;
}

/** Run a daemon to completion, or until it starts serving. Never the live one. */
function startDaemon(box, extraEnv, dist = DIST) {
  const env = box.env(extraEnv);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  cleanups.push(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  });
  return {
    child,
    exited,
    stderrSoFar: () => stderr,
    stdoutSoFar: () => stdout
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the sandbox socket to appear, or for the daemon to give up. */
async function waitForSocket(box, run, ms = 25_000) {
  const deadline = Date.now() + ms;
  let done = false;
  run.exited.then(() => {
    done = true;
  });
  while (Date.now() < deadline) {
    if (fs.existsSync(box.socket)) return true;
    if (done) return false;
    await sleep(100);
  }
  return false;
}

/** Wait for a daemon to exit and report its code, rather than hanging forever. */
async function exitCodeOf(run, ms = 25_000) {
  const raced = await Promise.race([run.exited, sleep(ms).then(() => 'timeout')]);
  if (raced === 'timeout') {
    try {
      run.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    return { code: 'timeout', signal: null };
  }
  return raced;
}

const distBuilt = fs.existsSync(path.join(DIST, 'daemon.js'));

// ── §6 a real daemon refuses to come up unpinned ──────────────────────────
rule('§6  a REAL daemon whose unit pins a runtime it lacks refuses to serve');

if (!distBuilt) {
  skip('the real refusal', 'daemon/dist/daemon.js is missing — build first.');
  skip('the acknowledged override', 'daemon/dist/daemon.js is missing — build first.');
  skip('the no-unit case', 'daemon/dist/daemon.js is missing — build first.');
} else {
  {
    const box = sandbox();
    box.setMode('loaded'); // the unit pins BUTCHR_AGENT_RUNTIME=crabcast
    // ... this daemon carries nothing, and (KAN-574) it is the machine's own
    // daemon rather than a test's, which is what makes the pin its business.
    const run = startDaemon(box, {}, machineHomeDist(box));
    const { code } = await exitCodeOf(run);
    check(
      code === REFUSED_UNPINNED,
      `it exits ${REFUSED_UNPINNED} rather than serving`,
      `got ${String(code)} — a daemon came up on a runtime nobody chose`
    );
    const err = run.stderrSoFar();
    check(
      err.includes('REFUSING TO SERVE'),
      'and says so on fd 2, where systemd puts the journal',
      `stderr was: ${JSON.stringify(err.slice(0, 200))}`
    );
    check(err.includes('crabcast'), 'naming the runtime the unit pins');
    check(!fs.existsSync(box.socket), 'and it never created a socket');
  }

  {
    const box = sandbox();
    box.setMode('loaded');
    // Same reason as the arm above: the override is only reachable on a daemon
    // the pin governs, so this one has to be the machine's own too (KAN-574).
    const run = startDaemon(box, { [RUNTIME_PIN_ACK_ENV]: '1' }, machineHomeDist(box));
    const served = await waitForSocket(box, run);
    check(served, `${RUNTIME_PIN_ACK_ENV}=1 lets it serve anyway`, 'it refused despite the override');
    // Serving is not the whole criterion: an override that leaves no line is
    // indistinguishable from the accident it permits.
    await sleep(200);
    check(
      run.stderrSoFar().includes('ON PURPOSE'),
      'and the override is still announced on fd 2, never silent'
    );
    run.child.kill('SIGTERM');
    await exitCodeOf(run, 10_000);
  }

  {
    const box = sandbox();
    box.setMode('absent'); // no unit on this machine at all
    const run = startDaemon(box, {});
    const served = await waitForSocket(box, run);
    check(served, 'with NO unit, an unpinned daemon serves normally');
    check(
      !run.stderrSoFar().includes('REFUSING TO SERVE'),
      'and nothing is refused — the guard is scoped to a real disagreement'
    );
    run.child.kill('SIGTERM');
    await exitCodeOf(run, 10_000);
  }

  {
    // KAN-574, and the complement of the first arm: SAME unit, SAME missing
    // BUTCHR_*, and the only difference is that this daemon is a test's rather
    // than the machine's — no `machineHomeDist`, so `$HOME` is a throwaway and
    // the socket it claims is its own. It must serve. Nine CI-runnable scripts
    // failed on every developer machine for as long as this arm was missing,
    // and CI could not see it: a runner has no unit to disagree with, so the
    // first arm above passed there for the wrong reason.
    const box = sandbox();
    box.setMode('loaded');
    const run = startDaemon(box, {});
    const served = await waitForSocket(box, run);
    check(
      served,
      'a TEST-spawned daemon serves though the unit pins a runtime it lacks',
      'it refused — the pin is governing daemons that cannot reach the fleet (KAN-574)'
    );
    check(
      !run.stderrSoFar().includes('REFUSING TO SERVE'),
      'and it is not told it is refusing, because it is not'
    );
    run.child.kill('SIGTERM');
    await exitCodeOf(run, 10_000);
  }
}

// ── §7 the singleton race, with real processes ────────────────────────────
rule('§7  losing the race: the exit code depends on WHO won');

if (!distBuilt) {
  skip('the race against an unconfigured winner', 'daemon/dist/daemon.js is missing — build first.');
  skip('the race against the configured winner', 'daemon/dist/daemon.js is missing — build first.');
} else {
  const box = sandbox();
  box.setMode('loaded');
  box.setMainPid(0); // systemd's unit has no main process: the incumbent is nobody's
  const incumbent = startDaemon(box, { BUTCHR_AGENT_RUNTIME: 'crabcast' });
  const up = await waitForSocket(box, incumbent);

  if (!up) {
    skip(
      'both race cases',
      `the incumbent daemon never opened ${box.socket}; without a winner there is no race ` +
        `to lose. Its stderr: ${JSON.stringify(incumbent.stderrSoFar().slice(0, 300))}`
    );
  } else {
    {
      // THE INCIDENT SHAPE. Something is serving, it is not the unit's main
      // process, and the unit is trying to start.
      const loser = startDaemon(box, { BUTCHR_AGENT_RUNTIME: 'crabcast' });
      const { code } = await exitCodeOf(loser);
      check(
        code === LOST_TO_UNCONFIGURED,
        `losing to a winner that is not the unit's own process exits ${LOST_TO_UNCONFIGURED}`,
        `got ${String(code)} — a clean exit here is what left Restart= nothing to act on`
      );
      const err = loser.stderrSoFar();
      check(
        err.includes('LOST THE SOCKET'),
        'and it says so on fd 2, so the journal carries it',
        `stderr was: ${JSON.stringify(err.slice(0, 200))}`
      );
      check(
        err.includes(String(incumbent.child.pid)),
        'naming the pid actually holding the socket',
        `expected pid ${incumbent.child.pid} in the message`
      );
    }

    {
      // Now the incumbent IS the unit's main process. Nothing about the
      // incumbent changed — only what systemd says — which is the point: the
      // answer is read live, per request, rather than cached at its boot.
      box.setMainPid(incumbent.child.pid);
      const loser = startDaemon(box, { BUTCHR_AGENT_RUNTIME: 'crabcast' });
      const { code } = await exitCodeOf(loser);
      check(
        code === LOST_TO_CONFIGURED,
        `losing to the unit's OWN daemon is still a no-op, still ${LOST_TO_CONFIGURED}`,
        `got ${String(code)} — this must not become a restart loop`
      );
      check(
        !loser.stderrSoFar().includes('LOST THE SOCKET'),
        'and it stays quiet on fd 2, because nothing is wrong'
      );
    }
  }

  incumbent.child.kill('SIGTERM');
  await exitCodeOf(incumbent, 10_000);
}

// ---------------------------------------------------------------------------

for (const fn of cleanups) {
  try {
    fn();
  } catch {
    // best effort; the sandboxes are under os.tmpdir()
  }
}

reportAndExit({ failures, skipped });
