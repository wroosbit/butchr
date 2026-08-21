#!/usr/bin/env node
// KAN-647: a change to what the running fleet executes must leave a record
// naming somebody, and it must do so on the path where nobody ran the gate.
//
// WHAT FAILURE THIS WOULD CATCH: the two ungated deploys of 2026-08-21. At
// 16:23Z the daemon was restarted and `dist` rebuilt; at 22:03Z the checkout
// moved to `67f4adc` and the daemon restarted. Neither left an entry anywhere,
// so "was this gated?" was answerable only by asking the actor — and the actor
// in the second case was `epic/KAN-39`, which was not hiding anything and
// described the act as *"I deployed 67f4adc and ran the proof"*, a sentence
// about proving a ticket in which the bypass is invisible. KAN-646 reports a
// fleet-visible behaviour change correlating with that restart, which nobody
// was looking for because nothing said a restart had happened.
//
// Concretely, this goes red if any of these regress:
//
//   * a daemon that comes up on different code than the last recorded start,
//     with nothing announcing it, fails to say so on fd 2 (§4b) — the whole
//     defect, on the exact path a bypass takes;
//   * an intent file gates a start it does not describe (§2, §4d) — "the gate
//     ran" quietly substituted for "the gate landed what it promised";
//   * an intent that pins neither a head nor a digest is believed (§2) — a
//     check with no failing branch the world can reach;
//   * an intent survives the start it gated and gates the next one too (§4e)
//     — the same substitution arriving through time instead of through content;
//   * a rebuild that emits identical bytes is reported as a deploy (§1, §3) —
//     an alarm that fires on a non-event is an alarm nobody reads;
//   * a plain restart raises the ungated alarm (§4f) — same.
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS WHAT THAT LEAVES ─────────────
//
// §2 and §3 hand the decision functions their inputs directly. They are proofs
// that supply their own input (KAN-145) and they say so: what they establish is
// that the DECISIONS are right across their input space, and nothing about
// whether a real daemon reaches them.
//
// §4 closes that by running the REAL `daemon/dist/daemon.js` as real processes
// and reading the ledger those processes actually wrote, plus the bytes that
// actually reached fd 2. Nothing inside the daemon is stubbed. The deploys are
// real: a copy of `dist` is mutated between starts, so the daemon genuinely
// comes up on different code each time.
//
// ⚠ WHAT IS NOT COVERED, stated rather than left to be inferred from a green:
//
//   * The LIVE fleet. Every daemon here runs under a `HOME` of its own in a
//     temp directory, so `BUTCHR_DIR` — and therefore the ledger, the intent
//     and the socket — land there and nowhere near `butchr-daemon.service`.
//     Nothing here stops, starts or reads the live daemon. That the instrument
//     fires on the REAL fleet is demonstrated by hand, once, at the deploy of
//     the PR that lands this, and the output is pasted on KAN-647.
//   * `systemctl` is stubbed to answer "no unit", which is what makes §4
//     runnable on a machine with no user manager. Nothing here proves anything
//     about systemd's real output; `verify-daemon-provenance-is-loud.mjs` §5
//     is what asks the real one.
//   * FORGERY. An intent names whoever wrote it and nothing authenticates
//     that. Under one shared identity nothing can, which is the same limit
//     `BUTCHR-APPROVAL` markers carry and is stated in
//     `announce-deploy-intent.mjs`. What this closes is the SILENT case.
//   * The `checkout-moved` classification is asserted in §3 against
//     constructed identities only. No live section moves a real checkout,
//     because doing so in the shared clone would move it for every agent on
//     the machine.
//
// CI-RUNNABLE: partial — §1-§3 are pure and need nothing but `dist` to import
// from. §4 spawns real node daemons and SKIPS without a build, which makes this
// script exit 2 there rather than 0 (KAN-373's contract).
// `run-ci-verify-set.mjs` builds first, so §4 executes there.
//
// ── DRIVING IT RED ────────────────────────────────────────────────────────
//
// Each of these was run and watched to fail before this script was committed;
// the output is pasted in the PR body.
//
//   1. In `deploy-ledger.ts`, make `judgeGate` return `gated` when the intent
//      pins nothing (drop the `pinned.length === 0` branch).      -> §2 red
//   2. In `deploy-ledger.ts`, make `judgeGate` ignore `mismatched` and gate on
//      a fresh intent regardless of what came up.            -> §2, §4d red
//   3. In `deploy-ledger.ts`, make `consumeIntent` a no-op.             -> §4e red
//   4. In `daemon.ts`, swap `announceToJournal(describeUngatedStart(...))` for
//      `log(...)` — daemon.log only, which is the file nobody opens.  -> §4b red
//   5. In `deploy-ledger.ts`, make `fingerprintDist` hash mtimes instead of
//      bytes.                                                   -> §1, §3 red
//   6. In `deploy-ledger.ts`, make `changesTheRunningFleet` return false for
//      `deploy`.                                                     -> §4b red

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

const ledger = await import(path.join(DIST, 'deploy-ledger.js')).catch((err) => {
  console.log(`\ndaemon/dist is not importable: ${err?.message ?? err}`);
  return null;
});

if (ledger === null) {
  skip('every section', 'daemon/dist is missing — build with `npm --prefix daemon run build`.');
  reportAndExit({ failures, skipped });
}

const {
  INTENT_MAX_AGE_MS,
  changesTheRunningFleet,
  classifyStart,
  fingerprintDist,
  judgeGate,
  parseIntent,
  readBuildIdentity,
  readLedger
} = ledger;

/** A BuildIdentity with the fields these sections care about, and no I/O. */
const identity = (digest, head, { newestMs = 1000, originMain = null, behind = null } = {}) => ({
  distDir: '/fixture/dist',
  repoRoot: '/fixture',
  head,
  originMain,
  behindOriginMain: behind,
  dist: { digest, fileCount: 3, newestMs, error: null }
});

// ── §1 the fingerprint is about bytes, not timestamps ─────────────────────
rule('§1  fingerprintDist: content decides, and an unreadable tree has no digest');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan647-fp-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'console.log(2);\n');

  const first = fingerprintDist(dir);
  check(typeof first.digest === 'string' && first.digest.length === 64, 'a readable tree hashes');
  check(first.fileCount === 2, 'every file is counted, including nested ones', `got ${first.fileCount}`);

  // THE DISCRIMINATION THIS SECTION EXISTS FOR. A rebuild moves every mtime and
  // emits the same bytes; an mtime-based fingerprint would call that a deploy
  // and raise an alarm on a non-event, which is how an alarm stops being read.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, 'a.js'), later, later);
  const touched = fingerprintDist(dir);
  check(touched.digest === first.digest, 'touching a file does NOT change the digest');
  check(touched.newestMs > first.newestMs, 'the newest mtime is still reported beside it');

  fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(3);\n');
  check(fingerprintDist(dir).digest !== first.digest, 'changing a byte DOES change the digest');

  // A rename is a real code change with an unchanged byte multiset. A digest
  // over contents alone would be blind to it.
  fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1);\n');
  fs.renameSync(path.join(dir, 'sub', 'b.js'), path.join(dir, 'sub', 'c.js'));
  check(fingerprintDist(dir).digest !== first.digest, 'renaming a file DOES change the digest');

  const gone = fingerprintDist(path.join(dir, 'no-such-tree'));
  check(gone.digest === null, 'an unreadable tree has NO digest');
  check(
    typeof gone.error === 'string' && gone.error.includes('no-such-tree'),
    'and says which tree it could not read',
    JSON.stringify(gone.error)
  );
}

// ── §2 every way an intent fails to gate ──────────────────────────────────
rule('§2  judgeGate: five refusals and one acceptance, over the whole space');

{
  const build = identity('dddd', 'hhhh');
  const now = Date.UTC(2026, 7, 21, 23, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const at = iso(now - 5_000);

  const good = judgeGate(
    { by: 'epic/KAN-203', at, intendedHead: 'hhhh', intendedDist: 'dddd', note: null },
    build,
    now
  );
  check(good.kind === 'gated' && good.by === 'epic/KAN-203', 'a matching, fresh intent GATES');
  check(
    good.kind === 'gated' && good.pinned.join('+') === 'head+dist',
    'and records which pins it checked',
    JSON.stringify(good)
  );

  const absent = judgeGate(null, build, now);
  check(absent.kind === 'ungated' && absent.because === 'no-intent', 'no intent -> no-intent');

  const stale = judgeGate(
    { by: 'x', at: iso(now - INTENT_MAX_AGE_MS - 1000), intendedHead: 'hhhh', intendedDist: 'dddd', note: null },
    build,
    now
  );
  check(stale.kind === 'ungated' && stale.because === 'stale-intent', 'an intent past the bound -> stale-intent');

  const future = judgeGate(
    { by: 'x', at: iso(now + 10 * 60_000), intendedHead: 'hhhh', intendedDist: 'dddd', note: null },
    build,
    now
  );
  check(future.kind === 'ungated' && future.because === 'stale-intent', 'an intent from the future -> stale-intent');

  const unparseable = judgeGate(
    { by: 'x', at: 'not a date', intendedHead: 'hhhh', intendedDist: null, note: null },
    build,
    now
  );
  check(
    unparseable.kind === 'ungated' && unparseable.because === 'unreadable-intent',
    'an unparseable timestamp -> unreadable-intent'
  );

  // ⚠ THE ONE THAT MATTERS MOST. An intent pinning nothing cannot fail to
  // match, so it would gate every start it was left beside — a check that has
  // no failing branch the world can reach is not a weak check, it is a check
  // that does not exist while appearing to.
  const unpinned = judgeGate({ by: 'x', at, intendedHead: null, intendedDist: null, note: null }, build, now);
  check(
    unpinned.kind === 'ungated' && unpinned.because === 'unpinned-intent',
    'an intent pinning NEITHER head nor dist -> unpinned-intent, never gated'
  );

  const wrongDist = judgeGate(
    { by: 'x', at, intendedHead: 'hhhh', intendedDist: 'OTHER', note: null },
    build,
    now
  );
  check(
    wrongDist.kind === 'ungated' && wrongDist.because === 'mismatched-intent',
    'the gate named a build that did not come up -> mismatched-intent'
  );
  const wrongHead = judgeGate(
    { by: 'x', at, intendedHead: 'OTHER', intendedDist: 'dddd', note: null },
    build,
    now
  );
  check(
    wrongHead.kind === 'ungated' && wrongHead.because === 'mismatched-intent',
    'the gate named a commit that did not come up -> mismatched-intent'
  );

  // One pin is enough — a daemon outside a git checkout has no head to pin.
  const distOnly = judgeGate(
    { by: 'x', at, intendedHead: null, intendedDist: 'dddd', note: null },
    identity('dddd', null),
    now
  );
  check(distOnly.kind === 'gated', 'a dist-only pin gates a daemon with no checkout');

  // And a pin that cannot be evaluated is a mismatch, not a pass.
  const headPinNoHead = judgeGate(
    { by: 'x', at, intendedHead: 'hhhh', intendedDist: null, note: null },
    identity('dddd', null),
    now
  );
  check(
    headPinNoHead.kind === 'ungated' && headPinNoHead.because === 'mismatched-intent',
    'a head pin against a daemon with no head is a MISMATCH, not a pass'
  );

  check(parseIntent({ at: '2026-01-01T00:00:00Z' }) === null, 'an intent with no `by` does not parse');
  check(parseIntent({ by: 'x' }) === null, 'an intent with no `at` does not parse');
  check(parseIntent('a string') === null, 'a non-object does not parse');
}

// ── §3 what changed since the last start ──────────────────────────────────
rule('§3  classifyStart: deploy, checkout-moved, rebuild, restart, unknown');

{
  const a = identity('AAA', 'h1');
  check(classifyStart(null, a).kind === 'first-record', 'no predecessor -> first-record');
  check(
    !changesTheRunningFleet(classifyStart(null, a)),
    'and first-record does NOT raise the alarm — installing the alarm is not a deploy'
  );

  check(classifyStart(a, identity('BBB', 'h1')).kind === 'deploy', 'different bytes -> deploy');
  check(changesTheRunningFleet({ kind: 'deploy' }), 'and a deploy DOES raise the alarm');

  const moved = classifyStart(a, identity('AAA', 'h2', { behind: 4 }));
  check(moved.kind === 'checkout-moved', 'same bytes, moved HEAD -> checkout-moved');
  check(moved.behind === 4, 'and carries how far behind origin/main the running build is');
  check(changesTheRunningFleet(moved), 'and it raises the alarm too — merged and inert, at once');

  check(
    classifyStart(a, identity('AAA', 'h1', { newestMs: 9999 })).kind === 'rebuild-no-change',
    'same bytes, newer mtimes, same head -> rebuild-no-change'
  );
  check(
    !changesTheRunningFleet({ kind: 'rebuild-no-change' }),
    'and a byte-identical rebuild does NOT raise the alarm'
  );

  check(classifyStart(a, identity('AAA', 'h1')).kind === 'restart', 'nothing changed -> restart');
  check(!changesTheRunningFleet({ kind: 'restart' }), 'and a plain restart does NOT raise the alarm');

  const unreadable = { ...identity(null, 'h1'), dist: { digest: null, fileCount: 0, newestMs: null, error: 'boom' } };
  const indet = classifyStart(a, unreadable);
  check(indet.kind === 'indeterminate', 'an unreadable build -> indeterminate, never "restart"');
  check(
    changesTheRunningFleet(indet),
    'and indeterminate RAISES the alarm — "we do not know" must not read as "nothing changed"'
  );
}

// ── real-process harness ──────────────────────────────────────────────────

/**
 * A sandbox: its own HOME, so `BUTCHR_DIR` — ledger, intent and socket alike —
 * lands here and nowhere near the live fleet, plus a `systemctl` on PATH that
 * answers "no unit" so this runs on a machine with no user manager.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan647-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(
    path.join(dir, 'bin', 'systemctl'),
    [
      '#!/bin/sh',
      '# Stub systemctl for verify-deploy-ledger-is-unbypassable.mjs (KAN-647).',
      'printf "Environment=\\nLoadState=not-found\\nExecMainPID=0\\n"',
      'exit 0',
      ''
    ].join('\n'),
    { mode: 0o755 }
  );
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    socket: path.join(dir, '.local', 'share', 'butchr', 'butchr.sock'),
    ledgerFile: path.join(dir, '.local', 'share', 'butchr', 'deploys.jsonl'),
    intentFile: path.join(dir, '.local', 'share', 'butchr', 'deploy-intent.json'),
    consumedFile: path.join(dir, '.local', 'share', 'butchr', 'deploy-intent.consumed.json'),
    env: (extra) => {
      const env = {
        ...process.env,
        HOME: dir,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        BUTCHR_AGENT_RUNTIME: undefined,
        BUTCHR_MAX_AGENTS: undefined,
        ...extra
      };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      return env;
    }
  };
}

/**
 * A copy of `dist` this section is free to mutate.
 *
 * ⚠ The mutation is what makes these deploys REAL rather than described. The
 * daemon is not told it is being deployed and nothing inside it is patched: it
 * hashes the tree it is executing, and that tree genuinely differs from the one
 * the previous start hashed.
 */
function deployTree(box) {
  const root = path.join(box.dir, 'build', 'daemon');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(DIST, dist, { recursive: true });
  fs.symlinkSync(path.join(REPO, 'daemon', 'node_modules'), path.join(root, 'node_modules'));
  return dist;
}

/**
 * Change the code in that tree, the way a merge would.
 *
 * A trailing comment on an already-loaded module: it moves the bytes, changes
 * no behaviour, and cannot make the daemon fail to start — which keeps the
 * section measuring the ledger rather than measuring node.
 */
let mutations = 0;
function mutate(dist) {
  mutations += 1;
  const file = path.join(dist, 'adf.js');
  fs.appendFileSync(file, `\n// kan647 deploy fixture, mutation ${mutations}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function linesIn(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Start a real daemon, wait until it has written its ledger line, kill it.
 *
 * Waiting on the LEDGER rather than on the socket is deliberate and is the
 * boundary of what this measures: the record is written before the socket, so
 * this establishes that a daemon writes one — and NOT that a daemon that goes
 * on to serve writes one. Nothing observed here depends on the difference, and
 * saying so is cheaper than a section that waits 25s five times over.
 */
async function runDaemon(box, dist, deadlineMs = 30_000) {
  const before = linesIn(box.ledgerFile);
  const child = spawn(process.execPath, [path.join(dist, 'daemon.js')], {
    env: box.env(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  child.stdout.on('data', () => {});
  cleanups.push(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  });

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const end = Date.now() + deadlineMs;
  let grew = false;
  while (Date.now() < end) {
    if (linesIn(box.ledgerFile) > before) {
      grew = true;
      break;
    }
    if (exited) break;
    await sleep(50);
  }
  // The announcement goes to fd 2 in the same tick as the record is written,
  // but the pipe read is asynchronous — give it a moment before reading it.
  await sleep(300);
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  await sleep(200);
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  const records = readLedger(box.ledgerFile).records;
  return { grew, stderr, last: records[records.length - 1] ?? null, count: records.length };
}

function writeIntent(box, intent) {
  fs.mkdirSync(path.dirname(box.intentFile), { recursive: true });
  fs.writeFileSync(box.intentFile, JSON.stringify(intent));
}

// ── §4 real daemons, real deploys, real ledger ────────────────────────────
rule('§4  a REAL daemon records what it came up on, and shouts when nobody owns it');

if (!fs.existsSync(path.join(DIST, 'daemon.js'))) {
  for (const s of ['§4a baseline', '§4b the ungated deploy', '§4c the gated deploy', '§4d the mismatched gate', '§4e the consumed intent', '§4f the plain restart']) {
    skip(s, 'daemon/dist/daemon.js is missing — build first.');
  }
} else {
  const box = sandbox();
  const dist = deployTree(box);

  // §4a — the ledger's first line. Judged against nothing, and says so.
  const a = await runDaemon(box, dist);
  if (!check(a.grew, '§4a a real daemon start writes a ledger line', a.stderr.slice(-500))) {
    skip('§4b-§4f', 'no baseline record — the later sections would be measuring nothing.');
  } else {
    check(a.last.start.kind === 'first-record', '§4a and classifies it first-record', JSON.stringify(a.last.start));
    check(
      !a.stderr.includes('UNGATED DEPLOY'),
      '§4a and does NOT shout — the ledger has no predecessor to judge against'
    );

    // §4b — THE DEFECT. New code, nobody announced it.
    mutate(dist);
    const b = await runDaemon(box, dist);
    check(b.last?.start?.kind === 'deploy', '§4b different code -> the record says `deploy`', JSON.stringify(b.last?.start));
    check(
      b.last?.gate?.kind === 'ungated' && b.last.gate.because === 'no-intent',
      '§4b with nothing announcing it -> `ungated: no-intent`',
      JSON.stringify(b.last?.gate)
    );
    check(b.last?.by === null, '§4b and it is attributable to NOBODY, said as null');
    check(
      b.stderr.includes('UNGATED DEPLOY'),
      '§4b and the daemon says so on fd 2, where the journal is',
      `stderr had ${b.stderr.length} bytes: ${JSON.stringify(b.stderr.slice(-400))}`
    );

    // §4c — the gate, done properly. The positive control: without this the
    // section above could be a check that reports everything as ungated.
    mutate(dist);
    const built = readBuildIdentity(dist);
    writeIntent(box, {
      by: 'epic/KAN-203',
      at: new Date().toISOString(),
      intendedHead: built.head,
      intendedDist: built.dist.digest,
      note: 'kan647 fixture'
    });
    const c = await runDaemon(box, dist);
    check(c.last?.start?.kind === 'deploy', '§4c an announced deploy is still a `deploy`');
    check(
      c.last?.gate?.kind === 'gated' && c.last.gate.by === 'epic/KAN-203',
      '§4c and the record names who did it',
      JSON.stringify(c.last?.gate)
    );
    check(!c.stderr.includes('UNGATED DEPLOY'), '§4c and nothing is shouted about');

    // §4e — the intent must not survive the start it gated.
    check(
      !fs.existsSync(box.intentFile),
      '§4e the intent is consumed, so it cannot gate the NEXT start too'
    );
    check(
      fs.existsSync(box.consumedFile),
      '§4e and it is moved aside rather than deleted — "wrong gate" stays distinguishable from "no gate"'
    );

    // §4d — the gate ran and did not land what it promised.
    mutate(dist);
    writeIntent(box, {
      by: 'epic/KAN-203',
      at: new Date().toISOString(),
      intendedHead: built.head,
      intendedDist: built.dist.digest, // the PREVIOUS build's digest
      note: 'kan647 fixture: promises a build that is not the one coming up'
    });
    const d = await runDaemon(box, dist);
    check(
      d.last?.gate?.kind === 'ungated' && d.last.gate.because === 'mismatched-intent',
      '§4d an intent naming a different build does NOT gate',
      JSON.stringify(d.last?.gate)
    );
    check(d.stderr.includes('UNGATED DEPLOY'), '§4d and it is shouted about like any other bypass');

    // §4f — and the alarm does not fire on a non-event.
    const f = await runDaemon(box, dist);
    check(f.last?.start?.kind === 'restart', '§4f restarting on the same code -> `restart`', JSON.stringify(f.last?.start));
    check(
      f.last?.gate?.kind === 'ungated',
      '§4f which is still unattributed — the record never pretends otherwise'
    );
    check(
      !f.stderr.includes('UNGATED DEPLOY'),
      '§4f but nothing is shouted about, because nothing about the fleet changed'
    );
  }
}

for (const c of cleanups) {
  try {
    c();
  } catch {
    // best effort
  }
}

reportAndExit({ failures, skipped });
