#!/usr/bin/env node
// KAN-598: `StandardOutput=journal` must be true, not nominal.
//
// WHAT FAILURE THIS WOULD CATCH: the 2026-08-21 defect, in which
// `journalctl --user -u butchr-daemon.service` answered plausibly and carried
// ZERO of the daemon's decisions. `daemon.ts` assigns `console.log` and
// `console.error` to a file appender, so every decision the daemon made went to
// `~/.local/share/butchr/daemon.log` and fd 1 received nothing for the whole
// life of the service. Measured that day on the live machine: 72 journal lines
// in 24 hours, every one of them systemd's own lifecycle records, and `[board]`
// records in journald EVER: 0 — against 246 in `daemon.log` over 68 minutes.
//
// ⚠ THE SHAPE IS WHAT MATTERS AND IT IS WHY A WEAKER CHECK IS NO CHECK. The
// command did not error and did not come back empty. It returned real,
// well-formed, timestamped records, and the honest conclusion from them —
// "the daemon is running and quiet" — was wrong. An operator grepped that
// output for a stand-down, matched nothing, and was one sentence from
// publishing "no stand-down was attempted"; `daemon.log` held 65 of them, one
// per minute. So this script asserts on the presence of a REAL DECISION RECORD
// and never on the unit merely having journal output: §3 is the arm that fails
// a lifecycle-only journal, and without it every section here would have been
// green on the day the bug was filed.
//
// Concretely, this goes red if any of these regress:
//
//   * the daemon stops mirroring its log to fd 1, or mirrors it somewhere that
//     is not the journal (§2) — the defect itself;
//   * the mirror degrades to lifecycle-or-chatter only, so the journal carries
//     bytes but no record anybody would grep for (§2, §3);
//   * `readJournal` stops telling a decision-carrying journal from a
//     lifecycle-only one (§3) — the discriminator that did not exist, and
//     whose absence is why the defect survived;
//   * `journalStreamVerdict` regresses to reading `JOURNAL_STREAM`'s PRESENCE
//     (§1, §4). That variable is INHERITED by every descendant of the unit, so
//     presence reports "I am talking to the journal" for processes that are
//     talking to a pipe. It is exactly the `INVOCATION_ID` trap KAN-550 met at
//     the other unit predicate, and §4 measures the real values that make it
//     false;
//   * the gate opens when fd 1 is NOT the journal (§4) — which would stream the
//     daemon's whole log into whatever pipe a client spawned it on.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS WHAT THAT LEAVES ─────────────
//
// §1 and §3 hand the decision functions their inputs directly. They are proofs
// that supply their own input (KAN-145) and they say so: what they establish is
// that the DECISIONS are right across their input space, and nothing about
// whether a real daemon reaches them.
//
// §3 reads `lib/journal-reading.mjs` as source rather than importing a build,
// so its verdict is about what is written there whatever `dist` holds — the
// distinction KAN-527 draws between a proof that imports from `dist` and one
// that does not. §1, §2 and §4 DO import the built daemon, so a failed build
// makes their verdicts evidence about the previous `dist` and not about your
// mutation. Confirm the build exited 0 before reading them.
//
// §2 and §4 close that by running the REAL `daemon/dist/daemon.js` as a real
// process, with a real file descriptor on fd 1, and reading the bytes that
// actually landed there. Nothing is stubbed inside the daemon.
//
// ⚠ WHAT IS SUBSTITUTED IS THE JOURNAL ITSELF, and that is the coverage
// boundary of §2 and §4. fd 1 is a regular file in a temp directory and
// `JOURNAL_STREAM` is set to that file's own `dev:inode`, so the daemon's gate
// runs unmodified and answers `journal` — but journald is not in the loop, and
// these sections therefore prove nothing about journald's framing, its
// retention, or its per-service rate limiting. §5 is what covers the real
// thing, against the live `systemctl`/`journalctl` on a machine that has them,
// and it SKIPS in CI, which is why this script exits 2 there rather than 0.
//
// WHAT NOBODY COVERS, named rather than left to be inferred from a green run:
//
//   * journald's rate limiter. At the measured rate (~19 lines/minute) the
//     default 10000-per-30s burst is three orders of magnitude away, and a
//     journal that DID drop messages says so in itself ("Suppressed N
//     messages"), so this is a loud failure rather than a silent one. Nothing
//     here asserts it, and no unit setting here changes it.
//   * a daemon run by hand in a terminal. The mirror is gated on fd 1 being the
//     journal, so a foreground daemon prints nothing to its own tty — the same
//     as before this change, and deliberately not widened here.
//
// ⚠ NOTHING HERE STOPS, STARTS, OR WRITES TO THE LIVE `butchr-daemon.service`,
// and that is deliberate. Every daemon this script starts runs under a `HOME`
// of its own in a temp directory, so `BUTCHR_DIR` and `SOCKET_PATH` — both
// derived from `os.homedir()` — land there and nowhere near the running fleet.
// §5 only ever READS (`systemctl show`, `journalctl`).
//
// CI-RUNNABLE: partial — §3 is pure and needs nothing at all. §1 imports the
// built gate; §2 and §4 additionally spawn real node processes against a temp
// `HOME`; all three SKIP without a build. §5 needs a reachable
// `systemctl --user` and a `journalctl` and SKIPS on a runner, which makes this
// script exit 2 there rather than 0 (KAN-373's contract).
// `run-ci-verify-set.mjs` builds first, so §1, §2 and §4 execute there.
//
// ── DRIVING IT RED ────────────────────────────────────────────────────────
//
// Each of these was run and watched to fail before this script was committed;
// the output is pasted in the PR body.
//
//   1. In `daemon.ts`, drop `mirrorToJournal(entry)` from `log` — the
//      pre-KAN-598 daemon, exactly.                            -> §2 red
//   2. In `journal-stream.ts`, make `journalStreamVerdict` return `journal`
//      whenever `JOURNAL_STREAM` is set, without comparing it to the
//      descriptor — the inherited-variable trap.           -> §1, §4 red
//   3. In `lib/journal-reading.mjs`, make `readJournal` return
//      `carries-decisions` whenever the transcript is non-empty — "the unit
//      has journal output", which is the reading AC3 forbids.   -> §3 red
//   4. In `lib/journal-reading.mjs`, weaken `DECISION_MARK` to match any
//      daemon line, so untagged chatter counts as a decision.   -> §3 red

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';
// The operator-side discriminator. Read from source, not from `dist`: it is the
// same module `butchr-doctor.mjs` imports, and the doctor may not have a build.
// So §3's verdict is about what is written here, whatever the build did.
import { readJournal } from './lib/journal-reading.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(REPO, 'daemon', 'dist');

let failures = 0;
let skipped = 0;
const cleanups = [];

const say = (s = '') => process.stdout.write(`${s}\n`);
const ok = (what) => say(`  PASS  ${what}`);
const bad = (what, detail) => {
  failures += 1;
  say(`  FAIL  ${what}`);
  if (detail) say(`        ${detail}`);
};
const skip = (what, why) => {
  skipped += 1;
  say(`  SKIP  ${what}`);
  say(`        ${why}`);
};

process.on('exit', () => {
  for (const c of cleanups) {
    try {
      c();
    } catch {
      // best-effort teardown; a temp directory that outlives the run is not a
      // verdict about anything this script measured.
    }
  }
});

// ── the built gate, when there is a build ─────────────────────────────────
//
// A missing build SKIPS the sections that need it rather than exiting 1: §3
// needs no build and is the section that carries AC3, so refusing to run it
// because `dist` is absent would throw away the one verdict that is always
// available. KAN-373's exit 2 is what keeps the skip from reading as a pass.
const built = fs.existsSync(path.join(DIST, 'daemon.js')) &&
  fs.existsSync(path.join(DIST, 'journal-stream.js'));
const gate = built
  ? await import(path.join(DIST, 'journal-stream.js'))
  : { journalStreamVerdict: null, JOURNAL_STREAM_ENV: 'JOURNAL_STREAM' };
const { journalStreamVerdict, JOURNAL_STREAM_ENV } = gate;

// ── §1 — is fd 1 the journal? the decision, across its input space ─────────
//
// PROOF THAT SUPPLIES ITS OWN INPUT: these call the decision function with
// environments and fd identities this section makes up. What it establishes is
// that the decision is right, and nothing about a real daemon reaching it. §4
// is what covers that.
say('\n§1  journalStreamVerdict — the decision, on inputs this section supplies');
if (!built) {
  skip('journalStreamVerdict across its input space', 'daemon/dist is not built');
} else {
  const stat = (dev, ino) => () => ({ dev, ino });

  const unset = journalStreamVerdict({}, 1, stat(7, 42));
  if (unset.kind === 'not-journal') ok('JOURNAL_STREAM unset -> not-journal');
  else bad('JOURNAL_STREAM unset -> not-journal', `got ${unset.kind}`);

  const junk = journalStreamVerdict({ [JOURNAL_STREAM_ENV]: 'not-a-pair' }, 1, stat(7, 42));
  if (junk.kind === 'not-journal') ok('JOURNAL_STREAM malformed -> not-journal');
  else bad('JOURNAL_STREAM malformed -> not-journal', `got ${junk.kind}`);

  const match = journalStreamVerdict({ [JOURNAL_STREAM_ENV]: '7:42' }, 1, stat(7, 42));
  if (match.kind === 'journal' && match.dev === 7 && match.ino === 42) {
    ok('JOURNAL_STREAM matches fd 1 -> journal');
  } else {
    bad('JOURNAL_STREAM matches fd 1 -> journal', `got ${JSON.stringify(match)}`);
  }

  // ⚠ The arm that makes this a check rather than a restatement. A verdict
  // built on the variable's PRESENCE returns `journal` here, because the
  // variable IS present — inherited, from a unit this process is merely
  // descended from — while fd 1 is a pipe.
  const inherited = journalStreamVerdict({ [JOURNAL_STREAM_ENV]: '7:42' }, 1, stat(7, 43));
  if (inherited.kind === 'not-journal' && /inherited/.test(inherited.because)) {
    ok('JOURNAL_STREAM inherited, fd 1 is something else -> not-journal');
  } else {
    bad(
      'JOURNAL_STREAM inherited, fd 1 is something else -> not-journal',
      `got ${JSON.stringify(inherited)} — a presence check would pass this and be wrong`
    );
  }

  const unstattable = journalStreamVerdict(
    { [JOURNAL_STREAM_ENV]: '7:42' },
    1,
    () => {
      throw new Error('EBADF');
    }
  );
  if (unstattable.kind === 'not-journal') ok('fd 1 cannot be stat\'d -> not-journal');
  else bad('fd 1 cannot be stat\'d -> not-journal', `got ${unstattable.kind}`);
}

// ── the sandbox ───────────────────────────────────────────────────────────
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan598-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Run the real daemon with fd 1 on a real file, and return what landed there.
 *
 * `journalStream` is what to put in the environment. When it is the string
 * `'match'` the file's own `dev:inode` is used, which is what systemd does for
 * the journal socket and what makes the daemon's gate answer `journal`. Any
 * other value is passed through verbatim, which is how §4 stages the inherited
 * and absent cases.
 */
function runDaemonWithFd1(journalStream, ms = 4000) {
  const home = sandbox();
  const outFile = path.join(home, 'fd1.out');
  const fd = fs.openSync(outFile, 'a');
  const st = fs.fstatSync(fd);

  const env = { ...process.env, HOME: home };
  delete env.BUTCHR_AGENT_RUNTIME;
  delete env.BUTCHR_MAX_AGENTS;
  delete env[JOURNAL_STREAM_ENV];
  if (journalStream === 'match') env[JOURNAL_STREAM_ENV] = `${st.dev}:${st.ino}`;
  else if (journalStream !== null) env[JOURNAL_STREAM_ENV] = journalStream;

  const child = spawn(process.execPath, [path.join(DIST, 'daemon.js')], {
    env,
    stdio: ['ignore', fd, 'pipe']
  });
  fs.closeSync(fd);

  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });

  return new Promise((resolve) => {
    const done = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve({
        home,
        fd1: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
        stderr,
        // The daemon's own file log, for the comparison that makes an empty
        // fd 1 mean something: it separates "the mirror is off" from "the
        // daemon never got far enough to log anything".
        daemonLog: (() => {
          const f = path.join(home, '.local', 'share', 'butchr', 'daemon.log');
          return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        })()
      });
    };
    const timer = setTimeout(done, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      setTimeout(done, 150);
    });
  });
}

// ── §2 — a real daemon, and a real decision record on fd 1 ────────────────
say('\n§2  the real daemon puts real decision records on fd 1 when fd 1 is the journal');
let liveCapture = null;
if (!built) {
  skip('daemon reaches the journal', 'daemon/dist/daemon.js is not built');
} else {
  const r = await runDaemonWithFd1('match');

  // A positive control on the probe itself, before its result is read as a
  // fact about the world: if the daemon logged nothing anywhere, an empty fd 1
  // says nothing about the mirror. This is the line whose absence nearly let
  // the original false claim be published.
  const logReading = readJournal(r.daemonLog);
  if (logReading.kind !== 'carries-decisions') {
    bad(
      'positive control: the sandboxed daemon logged decisions at all',
      `daemon.log is ${logReading.kind} (${r.daemonLog.length} bytes) — this probe is blind, ` +
        `so its fd 1 result is not evidence. stderr: ${r.stderr.slice(0, 400)}`
    );
  } else {
    ok(`positive control: daemon.log carries ${logReading.decisions} decision record(s)`);

    liveCapture = r.fd1;
    const reading = readJournal(r.fd1);
    if (reading.kind === 'carries-decisions') {
      ok(`fd 1 carries ${reading.decisions} decision record(s) — e.g. ${reading.firstDecision.slice(0, 110)}`);
    } else {
      bad(
        'fd 1 carries a decision record',
        `readJournal says ${reading.kind} over ${r.fd1.length} bytes on fd 1, while daemon.log ` +
          `carried ${logReading.decisions}. This is the KAN-598 defect: the log exists and the ` +
          'journal does not have it.'
      );
    }
  }
}

// ── §3 — THE DISCRIMINATOR: a lifecycle-only journal must go red ──────────
//
// AC3. Everything above would be green on a journal that carried systemd's
// records and nothing else, if the predicate did not tell them apart. These are
// real lines, copied from the live machine's journal on 2026-08-21 — the exact
// output that read as a healthy quiet daemon.
say('\n§3  readJournal — a lifecycle-only journal is RED, not "has journal output"');
{
  const LIFECYCLE_ONLY = [
    'Aug 21 12:39:48 servyboi systemd[989]: Started butchr-daemon.service - Butchr local daemon (Chrome native-messaging bridge to herdr).',
    'Aug 21 12:40:26 servyboi systemd[989]: Stopping butchr-daemon.service - Butchr local daemon (Chrome native-messaging bridge to herdr)...',
    'Aug 21 12:40:26 servyboi systemd[989]: Stopped butchr-daemon.service - Butchr local daemon (Chrome native-messaging bridge to herdr).',
    'Aug 21 12:50:33 servyboi systemd[989]: butchr-daemon.service: Consumed 5.260s CPU time, 72.5M memory peak, 0B memory swap peak.',
    'Aug 21 12:50:33 servyboi systemd[989]: Started butchr-daemon.service - Butchr local daemon (Chrome native-messaging bridge to herdr).'
  ].join('\n');

  const lifecycle = readJournal(LIFECYCLE_ONLY);
  if (lifecycle.kind === 'lifecycle-only' && lifecycle.lines === 5) {
    ok('5 real systemd lifecycle records -> lifecycle-only (RED for any caller gating on this)');
  } else {
    bad(
      'a lifecycle-only journal is lifecycle-only',
      `got ${JSON.stringify(lifecycle)} — the day this ticket was filed, THIS was the whole journal`
    );
  }

  const empty = readJournal('');
  if (empty.kind === 'empty') ok('an empty journal -> empty (and is told apart from lifecycle-only)');
  else bad('an empty journal -> empty', `got ${empty.kind}`);

  // The middle state, refused explicitly: the daemon spoke, and said nothing
  // anybody greps for. Reporting that as healthy is this bug at a smaller
  // scale, so it gets a constructor of its own rather than falling either way.
  const chatter = readJournal(
    'Aug 21 12:39:48 servyboi butchr-daemon[258438]: [2026-08-21T19:25:18.521Z] PATH resolved to: /usr/bin'
  );
  if (chatter.kind === 'daemon-lines-without-decisions') {
    ok('daemon chatter with no decision record -> daemon-lines-without-decisions (also RED)');
  } else {
    bad('daemon chatter is not mistaken for a decision', `got ${chatter.kind}`);
  }

  const decision = readJournal(
    'Aug 21 12:39:48 servyboi butchr-daemon[258438]: [2026-08-21T19:25:19.102Z] [board] stood down task/KAN-577'
  );
  if (decision.kind === 'carries-decisions' && decision.decisions === 1) {
    ok('one [board] record -> carries-decisions (the AC3 record, recognised)');
  } else {
    bad('a [board] record is a decision', `got ${JSON.stringify(decision)}`);
  }

  // ⚠ The two verdicts come from ONE predicate. If §2's capture and the
  // lifecycle transcript were judged by different code, §3 would be asserting
  // about a function nothing ships.
  if (liveCapture !== null) {
    const live = readJournal(liveCapture);
    if (live.kind === 'carries-decisions' && lifecycle.kind === 'lifecycle-only') {
      ok('the same predicate says carries-decisions of §2\'s real capture and lifecycle-only of the transcript');
    } else {
      bad(
        'one predicate, opposite verdicts',
        `live=${live.kind} transcript=${lifecycle.kind}`
      );
    }
  } else if (built) {
    skip('one predicate, opposite verdicts', '§2 produced no capture to compare against');
  } else {
    skip('one predicate, opposite verdicts', 'daemon/dist/daemon.js is not built');
  }
}

// ── §4 — the gate is closed when fd 1 is NOT the journal ─────────────────
//
// Without this, §2 is satisfied by a daemon that writes its log to fd 1
// unconditionally — which would pour ~19 lines a minute into whatever pipe a
// client spawned it on, and into `daemon-spawn.err` if it went to fd 2.
say('\n§4  the real daemon writes NOTHING to fd 1 when fd 1 is not the journal');
if (!built) {
  skip('the gate is closed off-journal', 'daemon/dist/daemon.js is not built');
} else {
  for (const [what, stream] of [
    ['JOURNAL_STREAM unset (a raw client spawn)', null],
    ['JOURNAL_STREAM inherited from the unit, fd 1 a file of our own', '1:1']
  ]) {
    const r = await runDaemonWithFd1(stream);
    const control = readJournal(r.daemonLog);
    if (control.kind !== 'carries-decisions') {
      bad(
        `positive control for: ${what}`,
        `the daemon logged nothing to daemon.log either (${control.kind}), so an empty fd 1 ` +
          'measures the probe and not the gate'
      );
      continue;
    }
    if (r.fd1 === '') {
      ok(`${what} -> fd 1 empty, while daemon.log took ${control.decisions} decision record(s)`);
    } else {
      bad(
        `${what} -> fd 1 empty`,
        `${r.fd1.length} bytes reached fd 1: ${r.fd1.slice(0, 200)}`
      );
    }
  }
}

/**
 * Does the daemon currently serving this machine contain this change at all?
 *
 * Read off the running process rather than off the checkout: `/proc/<pid>/cmdline`
 * names the `daemon.js` it was started with, and the presence of
 * `journal-stream.js` beside it is what says whether that build can mirror.
 * A checkout can be many commits ahead of the process holding the socket.
 *
 * Returns `false` when it cannot be established — an unknown build is not a
 * build to accuse, and §5 only ever uses this to DOWNGRADE a failure to a skip.
 */
function liveDaemonCarriesThisFix(mainPid) {
  const pid = Number(mainPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false;
  }
  const arg = cmdline.split('\0').find((a) => a.endsWith('daemon.js'));
  if (arg === undefined) return false;
  return fs.existsSync(path.join(path.dirname(arg), 'journal-stream.js'));
}

// ── §5 — the live unit, on a machine that has systemd ────────────────────
//
// The one section that touches the real system, and it only reads. It is what
// covers journald itself, which §2 and §4 substitute a file for.
say('\n§5  the live butchr-daemon.service (read-only; SKIPS without systemd)');
{
  const show = spawnSync(
    'systemctl',
    [
      '--user',
      'show',
      'butchr-daemon.service',
      '-p',
      'LoadState',
      '-p',
      'StandardOutput',
      '-p',
      'MainPID'
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  const props = Object.fromEntries(
    (show.status === 0 ? show.stdout : '')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );

  if (show.status !== 0) {
    skip('the live unit carries decisions in its journal', 'no reachable `systemctl --user` here');
  } else if (props.LoadState !== 'loaded') {
    // ⚠ Read LoadState, never StandardOutput alone: `systemctl show` reports
    // systemd's DEFAULTS for a unit that does not exist, so `StandardOutput=journal`
    // comes back for a service this machine has never heard of.
    skip(
      'the live unit carries decisions in its journal',
      `butchr-daemon.service LoadState=${props.LoadState} — not installed on this machine`
    );
  } else if (props.StandardOutput !== 'journal') {
    bad(
      'the live unit sends stdout to the journal',
      `StandardOutput=${props.StandardOutput}. The daemon mirrors to fd 1; this unit does not carry it there.`
    );
  } else {
    const jr = spawnSync(
      'journalctl',
      ['--user', '-u', 'butchr-daemon.service', '--since', '-24h', '--no-pager'],
      { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }
    );
    if (jr.status !== 0) {
      skip('the live unit carries decisions in its journal', 'journalctl did not answer here');
    } else {
      const reading = readJournal(jr.stdout);
      if (reading.kind === 'carries-decisions') {
        ok(`live journal, last 24h: ${reading.decisions} decision record(s) in ${reading.lines} line(s)`);
      } else if (!liveDaemonCarriesThisFix(props.MainPID)) {
        // ⚠ NOT A FAILURE, AND THE DISTINCTION IS THE WHOLE VALUE OF THIS ARM.
        // The daemon serving this machine is whatever was last built and
        // restarted, which on a developer's box is a build that predates this
        // change — it CANNOT mirror, and a red here would be a verdict about
        // deployment wearing the clothes of a verdict about the code. That red
        // gets worked around, and the next real one with it.
        //
        // The discriminator is the running daemon's own `dist`: no
        // `journal-stream.js` in it means the process cannot contain this fix,
        // whatever the journal says.
        skip(
          'the live journal carries the daemon\'s decisions',
          `readJournal says ${reading.kind} over ${reading.lines ?? 0} line(s) — WHICH IS THE ` +
            'KAN-598 DEFECT, AND EXPECTED HERE: the daemon holding this machine predates this ' +
            'change (no journal-stream.js in the dist it is running), so it has no mirror to ' +
            'run. Deploy, then `systemctl --user restart butchr-daemon.service`, and this ' +
            'section asserts for real.'
        );
      } else {
        bad(
          'the live journal carries the daemon\'s decisions',
          `readJournal says ${reading.kind} over ${reading.lines ?? 0} line(s), and the running ` +
            'daemon DOES carry this change. The mirror is deployed and is not reaching journald.'
        );
      }
    }
  }
}

reportAndExit({ failures, skipped, argv: process.argv });
