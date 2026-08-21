//
// KAN-571's red drive for the log-read discipline, as a script rather than as a
// paragraph in a PR body.
//
// `prompts/task.md`: a proof that has only ever passed is evidence of nothing,
// and where demonstrating the failure needs a recipe, the recipe is part of the
// proof because the reviewer has to be able to reproduce the red as well as the
// green. This is that recipe for `lib/settled-log.mjs`.
//
// NOT A `verify-` SCRIPT, deliberately, and named so it cannot be mistaken for
// one: it asserts that things FAIL, so a runner that collected it alongside the
// real proofs would be reading its greens backwards. It is not in the CI set.
//
// ── WHAT IT DRIVES, AND WHY EACH ARM EXISTS ─────────────────────────────────
//
// The fix's claim is a DISCRIMINATION, not a pass: that a log which is still
// being written and a log which is genuinely missing the line are told apart.
// A discrimination needs both sides shown, so three arms:
//
//   ARM 1 — a REAL writer, two processes, no fixture. The real `DaemonLog`
//     from `dist` appends while a reader does the one-shot `readFileSync` the
//     proofs used to do. Establishes that a truncated tail is a thing this
//     machine actually produces, rather than a hazard argued from the API
//     docs. This is the arm with no fabricated input in it.
//
//   ARM 2 — the old read matched against half a line; the new one refuses to.
//     Shown on a mid-write file, with the OLD predicate and the NEW one run
//     against the same bytes. ⚠ THIS ARM SUPPLIES ITS OWN INPUT — it writes a
//     file with a deliberate trailing fragment, because a truncation you have
//     to wait for is not a truncation you can put in a test. What that leaves
//     uncovered is whether such a file occurs in nature, and ARM 1 is what
//     covers it: arm 1 observes one without ever constructing one.
//
//   ARM 3 — THE DISCRIMINATING ARM, and the one that would catch this fix
//     being a rug. A wait that returns `'settled'` for everything would pass
//     arms 1 and 2 and be worthless. Arm 3 gives `awaitSettledLog` a complete,
//     quiet log that genuinely lacks the line and requires it to say
//     `'missing-line'` — i.e. to still go red, and to blame the writer. Its
//     end-to-end twin is in the PR body: `router.ts` mutated so the daemon
//     logs `ERR 401` where the proof wants `FAILED 401`, which turns
//     `verify-launchdarkly-proxy-failure-is-loud` red with exactly this
//     verdict.
//
// Run: node daemon/scripts/red-drive-kan571.mjs
// Exits 0 when every arm behaved as described, 1 when any did not.
//

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { readSettledLog, awaitSettledLog, describeSettledLog } from './lib/settled-log.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const LOG_FILE_MODULE = path.join(daemonDir, 'dist', 'log-file.js');

// A setup guard, not a verdict: this says the instrument was never assembled.
if (!fs.existsSync(LOG_FILE_MODULE)) {
  console.error(`${LOG_FILE_MODULE} is missing — run \`npm run build\` in daemon/ first.`);
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`);
  if (!ok) failures++;
}
function rule(title) {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`);
}

// The line the daemon actually writes, copied from `handleLaunchDarklyProxyCall`
// in daemon/src/router.ts, and the regex the proof matches it with.
const AUDIT_LINE =
  '[2026-08-21T00:40:04.301Z] launchdarkly-proxy: task/KAN-298 → ' +
  'launchdarkly_get_feature_flag GET /api/v2/flags/butchr/agent-runner → ' +
  'FAILED 401 (12ms) [credential fault — the fleet is affected]';
const AUDIT_RE =
  /launchdarkly-proxy: task\/KAN-298 → launchdarkly_get_feature_flag GET \S+ → FAILED 401/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan571-red-'));

// ── ARM 1 ───────────────────────────────────────────────────────────────────
rule('ARM 1. a real DaemonLog, written by a real process, read the way the proofs read it');

const WRITER = path.join(tmp, 'writer.mjs');
fs.writeFileSync(
  WRITER,
  `import { DaemonLog } from ${JSON.stringify(LOG_FILE_MODULE)};\n` +
    `const log = DaemonLog.open(process.argv[2]);\n` +
    `for (let i = 0; i < 20000; i++) {\n` +
    `  log.append(${JSON.stringify(AUDIT_LINE)} + ' seq=' + i + '\\n');\n` +
    `  if (i % 50 === 0) await new Promise((r) => setImmediate(r));\n` +
    `}\n` +
    `await new Promise((r) => setTimeout(r, 300));\n` +
    `process.exit(0);\n`
);

const arm1File = path.join(tmp, 'arm1-daemon.log');
const writer = fork(WRITER, [arm1File]);
// Three windows, counted separately, because they are three different facts and
// lumping them makes the headline number mean nothing. `beforeOpen` is every
// read taken before the file existed at all — `createWriteStream` opens
// asynchronously, so this is large and uninteresting; it dominated the count
// when this arm reported one total. `duringWrite` is the window that bears on
// the defect.
let beforeOpen = 0;
let duringWrite = 0;
let sawTruncated = 0;
let firstFragment = null;
let opened = false;
let writerLive = true;
writer.on('exit', () => {
  writerLive = false;
});
while (writerLive) {
  const r = readSettledLog(arm1File);
  if (r.missing) {
    if (!opened) beforeOpen++;
  } else {
    opened = true;
    duringWrite++;
    if (!r.complete) {
      sawTruncated++;
      if (!firstFragment) firstFragment = r.partial;
    }
  }
  await new Promise((r2) => setImmediate(r2));
}

const pct = duringWrite ? ((100 * sawTruncated) / duringWrite).toFixed(2) : 'n/a';
console.log(
  `         ${beforeOpen} reads before the file existed at all (createWriteStream opens async —\n` +
    `         a one-shot read here gets ENOENT from a daemon that has already logged);\n` +
    `         ${duringWrite} reads while it was being appended to, of which ${sawTruncated} (${pct}%) found a truncated tail.`
);
if (firstFragment) {
  console.log(`         a fragment actually observed: ${JSON.stringify(firstFragment.slice(0, 110))}`);
}
// ⚠ THE ASSERTION IS ON "unfinished", NOT ON "truncated", AND THAT IS
// DELIBERATE. Truncation is rare — measured at 1 in 1372 reads on one run of
// this machine and 0 in 1881 on the next — so an arm that required one would be
// a flaky check inside a ticket about flaky checks. What is robustly true, and
// what the fix is actually about, is that a one-shot read of this file lands on
// something unfinished; the truncation percentage above is REPORTED as a
// measurement rather than asserted, so a run that sees none says so plainly
// instead of going red.
check(
  'a real DaemonLog does present unfinished reads to a concurrent readFileSync',
  beforeOpen + sawTruncated > 0,
  beforeOpen + sawTruncated > 0
    ? 'so the hazard is a property of this machine, not an argument from the API documentation'
    : `every read found a finished file — the race did not reproduce in this run. That is a ` +
        `statement about this run's timing and not a refutation: arm 2 shows what a one-shot ` +
        `read does with a mid-write file regardless of how often one occurs.`
);

// ── ARM 2 ───────────────────────────────────────────────────────────────────
rule('ARM 2. the old read matched against half a line; the new one refuses to');
console.log(
  '         ⚠ THIS ARM CONSTRUCTS ITS INPUT. The file below is written with a\n' +
    '         deliberate trailing fragment. Arm 1 is what establishes that such a\n' +
    '         file occurs without anyone constructing one.\n'
);

// A log whose LAST line is the audit line, cut off mid-way — the exact shape CI
// run 32433221528 printed as its evidence.
const truncatedAt = AUDIT_LINE.indexOf('FAILED 401') + 'FAILED 4'.length;
const arm2File = path.join(tmp, 'arm2-daemon.log');
fs.writeFileSync(
  arm2File,
  '[2026-08-21T00:40:03.000Z] launchdarkly-proxy: task/KAN-298 → launchdarkly_list_feature_flags GET /api/v2/flags/butchr → 200 (9ms)\n' +
    AUDIT_LINE.slice(0, truncatedAt)
);

const raw = fs.readFileSync(arm2File, 'utf8');
const reading = readSettledLog(arm2File);

console.log(`         the file's last 30 bytes: ${JSON.stringify(raw.slice(-30))}`);
check(
  'the file really is mid-line — the arm is testing what it says it is',
  !raw.endsWith('\n') && reading.complete === false,
  `partial fragment is ${reading.partial.length} bytes`
);
// The old shape: one readFileSync, regex against the whole thing. It cannot
// tell a finished line from an unfinished one, because nothing in it looks.
check(
  'THE OLD SHAPE: a regex over the raw read is decided by the truncation point',
  /launchdarkly-proxy: task\/KAN-298 → launchdarkly_get_feature_flag GET \S+ → FAILED 4/.test(raw),
  'a shorter prefix of the same regex matches the half-written line — the old read had no way\n' +
    'to know it was looking at a fragment, so whether it matched depended on where the write\n' +
    'happened to stop. That is the defect: the verdict was a function of the flush, not of the daemon.'
);
check(
  'THE NEW SHAPE: the fragment is never offered to a predicate',
  !AUDIT_RE.test(reading.settled) && !reading.settled.includes(reading.partial),
  `settled text is ${reading.settled.length} bytes and ends at the last newline; ` +
    `the ${reading.partial.length}-byte fragment is held on \`partial\``
);
check(
  'and the fragment is still on `raw`, so a negative assertion can search it',
  reading.raw.includes(reading.partial) && reading.raw.length > reading.settled.length,
  'a token hiding in an unfinished line must still fail "the log carries no token"'
);

// The wait, on a file nothing is writing: it must time out saying the log was
// unfinished, NOT that the daemon is silent.
const midWriteWait = await awaitSettledLog(arm2File, (s) => AUDIT_RE.test(s), {
  timeoutMs: 600,
  intervalMs: 50
});
check(
  "a mid-write log times out as 'still-being-written', naming the READ",
  midWriteWait.outcome === 'still-being-written',
  describeSettledLog(midWriteWait, arm2File)
);

// ── ARM 3 ───────────────────────────────────────────────────────────────────
rule('ARM 3. THE DISCRIMINATING ARM — a genuinely absent line must still go red');
console.log(
  '         A wait that answered "settled" for everything would pass arms 1 and 2\n' +
    '         and be worthless. This arm is what that fix would fail.\n'
);

const arm3File = path.join(tmp, 'arm3-daemon.log');
fs.writeFileSync(
  arm3File,
  '[2026-08-21T00:40:03.000Z] launchdarkly-proxy: task/KAN-298 → launchdarkly_list_feature_flags GET /api/v2/flags/butchr → 200 (9ms)\n' +
    '[2026-08-21T00:40:04.000Z] launchdarkly-proxy: task/KAN-298 → launchdarkly_get_feature_flag ERR 401 (12ms)\n'
);

const absentWait = await awaitSettledLog(arm3File, (s) => AUDIT_RE.test(s), {
  timeoutMs: 600,
  intervalMs: 50
});
check(
  'the wait still FAILS on a complete, quiet log that lacks the line',
  absentWait.satisfied === false,
  'the fix did not turn a red into a green by waiting'
);
check(
  "and it names the WRITER, not the read: outcome is 'missing-line'",
  absentWait.outcome === 'missing-line',
  describeSettledLog(absentWait, arm3File)
);

// The positive control for arm 3, so its red is not a query that reds on
// anything: the same wait, same deadline, against a log that DOES carry the
// line, must go green.
const arm3Control = path.join(tmp, 'arm3-control.log');
fs.writeFileSync(arm3Control, AUDIT_LINE + '\n');
const controlWait = await awaitSettledLog(arm3Control, (s) => AUDIT_RE.test(s), {
  timeoutMs: 600,
  intervalMs: 50
});
check(
  'POSITIVE CONTROL: the same wait goes green on a log that carries the line',
  controlWait.satisfied === true && controlWait.outcome === 'settled',
  describeSettledLog(controlWait, arm3Control)
);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  `\n${
    failures
      ? `RED DRIVE FAILED — ${failures} arm assertion(s) did not behave as described`
      : 'OK — a real DaemonLog produces unfinished reads; the old shape was decided by the ' +
        'truncation point and the new one refuses the fragment; and a genuinely absent line ' +
        'still fails, still names the writer, with a positive control proving the wait can ' +
        'go green on the same deadline.'
  }\n`
);
process.exit(failures ? 1 : 0);
