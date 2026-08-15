// Proof for KAN-483: a rollback cannot report success while its subjects are
// still running.
//
// WHAT FAILURE THIS WOULD CATCH: a rollback verdict that is satisfied by the
// RECORD alone — empty registry, archived transcripts — while CrabCast agent
// processes are still alive on the machine, so the rollback logs COMPLETE and
// three unmanaged agents keep working. That is not hypothetical: it is what
// happened on 2026-08-15, when `~/butchr-cutover/rollback.sh` archived three
// post-flip transcripts at 17:24:16, printed `ROLLBACK COMPLETE` at 17:24:17,
// and all three processes were still running 31 minutes later — one of them
// having committed `26bf913`, pushed, and opened PR #210. §1 below is the
// direct reproduction: a census that says the registry is empty while the
// process count is 3 must NOT render DOWN. §4 is the other half and the one a
// later edit is likeliest to break — it asserts the verdict has a reachable
// GREEN branch as well as a red one, so this cannot rot into a predicate that
// can only ever say NOT DOWN.
//
// CI-RUNNABLE: yes — node builtins only, no build, no daemon, no herdr, no
// credential, no peer, no terminal, no network. §3 and §5 create a temporary
// unix socket and a temporary directory tree under `os.tmpdir()`, never inside
// the repository, and remove both. §3 additionally spawns two short-lived node
// children as positive controls — one held open and killed in a `finally`, one
// that prints a reading and exits — and §5 spawns the reaper three times.
// Every child is `process.execPath` and every path is under `os.tmpdir()`.
//
// THIS PROOF IMPORTS NOTHING FROM `dist`. It imports the predicate module from
// `daemon/scripts/lib/`, which is source, and spawns `cutover-reap.mjs`, which
// is source. `prompts/task.md` requires the build's exit code to be confirmed
// before a `dist`-importing proof's verdict is read, because such a proof run
// after a failed build tested the previous build rather than your mutation.
// That qualifier does not apply here and one grep settles it: there is no
// `../dist/` import below. A red from this script is about the tree as written
// and must not be discarded as build fallout.
//
// ## ⚠ THIS SCRIPT CONSTRUCTS MOST OF THE INPUT IT ASSERTS ON
//
// Named here rather than left to be inferred, because a proof that supplies
// its own input has not tested that the input arrives (KAN-145). The inputs
// below are NOT worth the same and are marked where they differ:
//
//   - §1 uses the census numbers TRANSCRIBED FROM the incident: three archived
//     transcripts, three live pids, `agents: 0`. Those are observations, quoted
//     with their timestamps on KAN-483 so a reader can go and find them.
//   - §2 and §4 CONSTRUCT minimal inputs to establish the verdict's branches.
//     That is all they claim.
//   - §3 builds a FAKE `/proc` tree — which tests the parsing and nothing about
//     the real one — and then, separately, spawns a REAL process carrying the
//     marker and scans the REAL `/proc` for it. The second is the one that says
//     the instrument works; the first is the one that says it works for reasons
//     a reader can see.
//   - §5 spawns the real `cutover-reap.mjs` against a real unix socket serving
//     a chosen frame, and asserts its EXIT CODES. That is the process boundary
//     the kit reads, not just the function.
//
// ## WHAT THIS DOES NOT COVER, AND WHO DOES
//
//   - **That `~/butchr-cutover/rollback.sh` calls this correctly, and calls it
//     BEFORE the config revert.** That directory is outside this repository and
//     outside CI's reach, exactly as `verify-cutover-health-predicate.mjs`
//     records for its own caller — and that gap is how `cutover.sh` came to
//     squeeze a three-valued answer through `[ -n "$(...)" ]`. §6 holds the
//     CONTRACT the kit reads; it cannot hold the kit. **NOBODY ELSE COVERS
//     IT.** The sandbox run that exercises the real `rollback.sh` against a
//     fake socket is pasted in the pull request, and a human drives the
//     cutover that would exercise it for real.
//   - **That `deactivate_by_key` actually stops a CrabCast process.** It is
//     CrabCast's to stop and this asserts nothing about whether it does. That
//     is precisely why the verdict counts processes instead of trusting the
//     call: the count is what turns an unanswerable question into an
//     observable one. What remains uncovered is the case where CrabCast stops
//     the process and something ELSE restarts it inside the poll window.
//   - **The marker's completeness.** §3 pins it against one recorded command
//     line. A CrabCast that stops naming the prompt file on the command line
//     makes this a positive detector with nothing to detect, and the count
//     would read a comfortable zero. That is narrowed by §3's pin and by the
//     driver printing its marker on every run; it is not closed.
//   - **Whether continuing the config revert after a failed reap is right.**
//     That is a judgement, argued in `rollback.sh`'s comments and in the pull
//     request, and the only cover for it is a reader who is not the author.
//
// ## Made to go red — the recipe, because §3's second leg and §5 need a machine
//
//   # §1, the record-only verdict returns: processes stop being a term
//   perl -pi -e 's/agents === 0 && missing === 0 && processes === 0/agents === 0 && missing === 0/' \
//     daemon/scripts/lib/cutover-reap-verdict.mjs
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- daemon/scripts/lib/cutover-reap-verdict.mjs
//
//   # §2, "I could not look" is folded into "I looked and it is bad"
//   perl -pi -e 's/^      code: 2$/      code: 1/' daemon/scripts/lib/cutover-reap-verdict.mjs
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- daemon/scripts/lib/cutover-reap-verdict.mjs
//
//   # §3, the self-match trapdoor is reopened — the scan stops excluding itself
//   perl -pi -e 's/const exclude = new Set\(opts\.excludePids \?\? \[process\.pid, process\.ppid\]\);/const exclude = new Set();/' \
//     daemon/scripts/lib/cutover-reap-verdict.mjs
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- daemon/scripts/lib/cutover-reap-verdict.mjs
//
//   # §4, the verdict can only ever be red — the green branch is deleted
//   perl -pi -e 's/const down = agents === 0 && missing === 0 && processes === 0;/const down = false;/' \
//     daemon/scripts/lib/cutover-reap-verdict.mjs
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- daemon/scripts/lib/cutover-reap-verdict.mjs
//
//   # §6, a kill verb arrives in the reaper — CrabCast's process table reached into
//   perl -pi -e 's/^import net from .net.;$/import net from "net";\nprocess.kill(1, 0);/' \
//     daemon/scripts/cutover-reap.mjs
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- daemon/scripts/cutover-reap.mjs
//
//   # §7, R3 loses the precondition that makes the ordering legible
//   perl -pi -e 's/\*\*Precondition:\*\* R2 checked\./**Precondition:** none./' \
//     docs/crabcast-cutover-sequence.md
//   node daemon/scripts/verify-cutover-reap-verdict.mjs        # exit 1
//   git checkout -- docs/crabcast-cutover-sequence.md
//
// Sections:
//   1. the incident itself: an empty registry beside live processes is NOT down
//   2. a read that did not happen is exit 2, and never 1
//   3. the process census finds a real marked process, ignores an unmarked one,
//      and does not count itself
//   4. the verdict has a reachable GREEN branch and a reachable RED one
//   5. the driver renders those verdicts as exit codes, as a process
//   6. neither file carries a verb that could stop a process
//   7. the document still states the ordering the reap depends on
//
// Usage: node daemon/scripts/verify-cutover-reap-verdict.mjs [--verbose]

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { reapVerdict, countAgentProcesses } from './lib/cutover-reap-verdict.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

/** `whyFailed` prints only on failure, `whyPassed` only under --verbose. */
function check(label, ok, whyFailed, whyPassed) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (whyFailed) console.log(`         ${String(whyFailed).split('\n').join('\n         ')}`);
  } else if (verbose && whyPassed) {
    console.log(`         ${String(whyPassed).split('\n')[0]}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan483-'));

// ─────────────────────────── 1. the incident, reproduced as a verdict ───────

rule('1. The incident: an empty registry beside three live processes is NOT down');

/**
 * TRANSCRIBED FROM THE INCIDENT, not constructed. `cutover.log` recorded three
 * transcripts archived at 17:24:16Z and `ROLLBACK COMPLETE` at 17:24:17Z; the
 * process table 31 minutes later still held pids 2102451, 2102984 and 2103319,
 * verified by `epic/KAN-203` with `ps`, `/proc/<pid>/cwd` and a CPU-delta
 * sample. The registry was empty because the rollback had emptied it.
 */
const INCIDENT = { census: { agents: 0, missing: 0 }, processes: 3 };

const incident = reapVerdict(INCIDENT);

check(
  'the 2026-08-15 state renders NOT DOWN',
  incident.down === false,
  `reapVerdict returned down=${incident.down} for agents 0, missing 0, processes 3.\n` +
    `This is the exact state the rollback printed COMPLETE in. If this verdict is true, the fix is ` +
    `undone and the record has gone back to speaking for the reality.`,
  'agents 0, missing 0, processes 3 → NOT DOWN'
);

check(
  'and it exits 1 — a verdict about the fleet, not about the instrument',
  incident.code === 1,
  `code was ${incident.code}, expected 1.`,
  'code 1'
);

check(
  'and it names the processes as the reason',
  incident.reasons.some((r) => /process/i.test(r)),
  `reasons were: ${JSON.stringify(incident.reasons)}\n` +
    `A rollback that says INCOMPLETE without saying WHICH of the three terms was non-zero sends its ` +
    `reader to look at the registry, which is the half that was already right.`,
  incident.reasons.join('; ')
);

// A record-only predicate — the one that shipped — must disagree here. This is
// the control: if it AGREED, §1 would be asserting something that was already
// true before the fix and would go green forever.
const recordOnly = INCIDENT.census.agents === 0 && INCIDENT.census.missing === 0;
check(
  'the retired record-only reading would have called this DOWN — so §1 tests the fix',
  recordOnly === true && incident.down === false,
  `record-only reading = ${recordOnly}, new verdict down = ${incident.down}.\n` +
    `These must DISAGREE on this input. If they agree, this section is satisfied by the defect as ` +
    `well as by the fix and is measuring nothing.`,
  'record-only says down, the verdict says not down'
);

// ────────────────────────────── 2. a read that did not happen ───────────────

rule('2. A read that did not happen is exit 2, and never 1');

for (const [label, input] of [
  ['socket silent', { census: null, processes: 0 }],
  ['/proc unreadable', { census: { agents: 0, missing: 0 }, processes: null }],
  ['an explicit error', { census: null, processes: null, readError: new Error('ECONNREFUSED') }]
]) {
  const v = reapVerdict(input);
  check(
    `${label} → read=false, code 2`,
    v.read === false && v.code === 2 && v.down === null,
    `got read=${v.read} code=${v.code} down=${v.down}.\n` +
      `"I could not look" and "I looked and they are alive" are different claims and the caller counts ` +
      `them separately. Folding them together makes a rollback blame the fleet for a silent socket — ` +
      `and, worse, makes an unreadable instrument indistinguishable from a clean drain if it ever folds ` +
      `the other way.`,
    'code 2, down null'
  );
}

// ──────────────────────── 3. the process census, against a real process ─────

rule('3. The process census: a real marked process is found, an unmarked one is not');

/**
 * ⚠ A CONSTRUCTED `/proc`. This leg tests the PARSING — NUL separation, the pid
 * filter, the marker — and says nothing about the real process table. The
 * second leg below is the one that does.
 */
const fakeProc = path.join(tmp, 'proc');
const AGENTS_DIR = path.join(tmp, 'share', 'crabcast', 'agents');
function fakeProcess(pid, args) {
  const d = path.join(fakeProc, String(pid));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'cmdline'), args.join('\0') + '\0');
}
fs.mkdirSync(fakeProc, { recursive: true });
fakeProcess(1001, ['claude', '--dangerously-skip-permissions', `${AGENTS_DIR}/723d79a9eb222a82/prompt.md`]);
fakeProcess(1002, ['claude', '--dangerously-skip-permissions', `${AGENTS_DIR}/96106c1ed6e8eaa3/prompt.md`]);
fakeProcess(1003, ['node', '/home/brooswit/code/wroosbit/butchr/daemon/dist/daemon.js']);
fakeProcess(1004, ['bash', '/home/brooswit/butchr-cutover/rollback.sh', 'watchdog-health-trip']);
// The directory ITSELF as an argument — this script's own driver, told where to
// look. It must not be counted as an agent, which is what the trailing
// separator in the marker is for.
fakeProcess(1005, ['node', 'cutover-reap.mjs', '--agents-dir', AGENTS_DIR]);
fs.mkdirSync(path.join(fakeProc, 'sys'), { recursive: true }); // a non-numeric entry

const fake = countAgentProcesses({ procRoot: fakeProc, agentsDir: AGENTS_DIR, excludePids: [] });

check(
  'the fake table yields exactly the two agent processes',
  fake.count === 2 && fake.pids.join(',') === '1001,1002',
  `got count=${fake.count} pids=[${fake.pids.join(', ')}], expected 2 × [1001, 1002].\n` +
    `1003 is the butchr daemon, 1004 is the rollback script itself and 1005 is the driver holding the ` +
    `agents directory as an argument. Counting any of them inflates the census and a rollback would ` +
    `refuse to report COMPLETE forever; missing 1001/1002 is the incident.`,
  `count ${fake.count}, pids ${fake.pids.join(', ')}`
);

/**
 * ⚠ THE REAL LEG. A genuine child process is spawned carrying the marker on its
 * command line, and the REAL `/proc` is scanned for it. Without this, every
 * claim above is a claim about a directory this script wrote.
 */
const markerPath = path.join(AGENTS_DIR, 'deadbeefdeadbeef', 'prompt.md');
let child;
try {
  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', markerPath], {
    stdio: 'ignore'
  });
  // Wait for the kernel to have the cmdline. Polling rather than sleeping, so a
  // slow machine does not turn this into a flake that reads as a real red.
  let seen = null;
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    seen = countAgentProcesses({ agentsDir: AGENTS_DIR });
    if (seen.count > 0) break;
    await sleep(100);
  }

  check(
    'a REAL process carrying the marker is found in the REAL /proc',
    seen && seen.count >= 1 && seen.pids.includes(child.pid),
    `scanned ${seen?.scanned ?? '?'} processes and did not find pid ${child?.pid}.\n` +
      `marker: ${seen?.marker}\n` +
      `This is the positive control for the whole instrument. Without it, a count of zero on the day of ` +
      `a rollback is indistinguishable from a scan that cannot see anything — which is the failure this ` +
      `ticket's own first measurement made in the opposite direction, reading 2 orphans off a machine ` +
      `that had none because the grep matched its own command line.`,
    `pid ${child?.pid} found among ${seen?.scanned} scanned`
  );

  // ⚠ THE SELF-MATCH TRAPDOOR, and this leg is written the way it is because the
  // OBVIOUS version of it does not work.
  //
  // The first attempt called `countAgentProcesses` from THIS process, once with
  // `excludePids: [process.pid]` and once with `[]`, and asserted the first did
  // not contain our pid. It passed — and it passed against the mutation too,
  // which is how it was caught. Two independent reasons, both worth stating
  // because either alone makes a check that cannot fail:
  //
  //   1. It passed `excludePids` EXPLICITLY, so it never exercised the DEFAULT
  //      (`?? [process.pid, process.ppid]`) that the mutation deletes.
  //   2. This process's own command line is `node …/verify-cutover-reap-verdict.mjs`,
  //      which does not contain the marker — so our pid could never have been in
  //      that list whatever the exclusion did. The assertion was true by
  //      construction, of a fact about argv rather than about the code.
  //
  // So the probe below is a SEPARATE process that genuinely holds the marker in
  // its own argv and calls the function with its DEFAULTS. It reports both
  // readings and the two must disagree: `none` proves the scan can see it (the
  // positive control — without which "not found" means nothing), and `def`
  // proves the default excluded it.
  const probePath = path.join(tmp, 'self-count-probe.mjs');
  const libUrl = new URL('./lib/cutover-reap-verdict.mjs', import.meta.url).href;
  fs.writeFileSync(
    probePath,
    `import { countAgentProcesses } from ${JSON.stringify(libUrl)};\n` +
      `const dir = process.env.KAN483_AGENTS_DIR;\n` +
      `const def = countAgentProcesses({ agentsDir: dir });\n` +
      `const none = countAgentProcesses({ agentsDir: dir, excludePids: [] });\n` +
      `console.log(JSON.stringify({ pid: process.pid, def: def.pids, none: none.pids }));\n`
  );
  const selfProbeMarker = path.join(AGENTS_DIR, 'cafebabecafebabe', 'prompt.md');
  const probeOut = await new Promise((resolve) => {
    const p = spawn(process.execPath, [probePath, selfProbeMarker], {
      env: { ...process.env, KAN483_AGENTS_DIR: AGENTS_DIR }
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
  });
  let probe = null;
  try {
    probe = JSON.parse(probeOut.trim());
  } catch {
    /* reported below */
  }

  check(
    'POSITIVE CONTROL: a process holding the marker in its own argv IS counted when nothing is excluded',
    probe !== null && probe.none.includes(probe.pid),
    `probe output: ${probeOut.trim() || '(empty)'}\n` +
      `The probe carries ${selfProbeMarker} on its command line and did not find itself with an empty ` +
      `exclusion list. Until this is true, the next assertion — that the DEFAULT excludes it — is ` +
      `satisfied by a scan that simply sees nothing, which is the failure this whole section exists to ` +
      `catch in the other direction.`,
    'the probe can see itself'
  );

  check(
    'and the DEFAULT exclusion keeps it out of its own count',
    probe !== null && probe.none.includes(probe.pid) && !probe.def.includes(probe.pid),
    `probe output: ${probeOut.trim() || '(empty)'}\n` +
      `The scan counted ITSELF. A \`pgrep -f\` for this pattern matches its own command line — measured ` +
      `while writing this ticket: \`ps -eo args | grep -c '[c]rabcast/agents'\` returned 2 on a machine ` +
      `with ZERO such processes, both hits being the shell and the grep. Believed, that reading would ` +
      `have invented a pair of orphans. If the default exclusion goes, the reaper counts itself, the ` +
      `census never reaches zero, and every rollback reports INCOMPLETE forever.`,
    'default excludes self'
  );
} finally {
  if (child && !child.killed) child.kill('SIGKILL');
}

/**
 * The marker, pinned against a command line recorded on KAN-483. A CrabCast
 * that stops naming the prompt file makes this a detector with nothing to
 * detect, and the count would read a comfortable zero.
 */
const RECORDED_CMDLINE =
  '/home/brooswit/.local/share/crabcast/agents/723d79a9eb222a82/prompt.md';
const pinned = countAgentProcesses({
  procRoot: (() => {
    const d = path.join(tmp, 'proc-pin');
    fs.mkdirSync(path.join(d, '9001'), { recursive: true });
    fs.writeFileSync(path.join(d, '9001', 'cmdline'), ['claude', RECORDED_CMDLINE].join('\0'));
    return d;
  })(),
  agentsDir: '/home/brooswit/.local/share/crabcast/agents',
  excludePids: []
});
check(
  'the marker still matches the command line recorded on the ticket',
  pinned.count === 1,
  `the recorded command line\n  ${RECORDED_CMDLINE}\nis no longer matched by the default marker.\n` +
    `Either CrabCast changed how it launches an agent, or the marker was edited. Either way the census ` +
    `now reads zero on a machine full of orphans, which is worse than not counting at all — it is the ` +
    `same reassuring silence the rollback used to produce.`,
  RECORDED_CMDLINE
);

// ─────────────────── 4. both branches are reachable ─────────────────────────

rule('4. The verdict has a reachable GREEN branch and a reachable RED one');

/**
 * A check that can only return the answer you were hoping for is not a weak
 * check — it is a check that does not exist while appearing to. §1 establishes
 * the red. This establishes that a clean rollback can still say so, and that
 * EACH of the three terms can independently deny it.
 */
const clean = reapVerdict({ census: { agents: 0, missing: 0 }, processes: 0 });
check(
  'a genuinely drained fleet renders DOWN, exit 0',
  clean.down === true && clean.code === 0 && clean.reasons.length === 0,
  `got down=${clean.down} code=${clean.code} reasons=${JSON.stringify(clean.reasons)}.\n` +
    `If nothing can make this green, every rollback reports INCOMPLETE, the signal is worthless within ` +
    `a week and somebody deletes the check.`,
  'down, code 0, no reasons'
);

for (const [term, input] of [
  ['agents', { census: { agents: 1, missing: 0 }, processes: 0 }],
  ['missing', { census: { agents: 0, missing: 1 }, processes: 0 }],
  ['processes', { census: { agents: 0, missing: 0 }, processes: 1 }]
]) {
  const v = reapVerdict(input);
  check(
    `\`${term}\` alone is enough to deny DOWN`,
    v.down === false && v.code === 1 && v.reasons.length === 1,
    `got down=${v.down} code=${v.code} reasons=${JSON.stringify(v.reasons)}.\n` +
      `Each term covers a failure the others cannot see: \`agents\` a drain that did not run, ` +
      `\`missing\` a drain that lost track, \`processes\` a drain the machine ignored. A term that ` +
      `cannot deny the verdict on its own is not in the verdict.`,
    v.reasons[0]
  );
}

// ─────────────── 5. the driver renders those verdicts as exit codes ─────────

rule('5. The driver renders the verdict as an exit code, as a process');

const DRIVER = path.join(repoRoot, 'daemon', 'scripts', 'cutover-reap.mjs');

/** A one-shot fake daemon socket serving a chosen `list_agents` frame. */
function serveFrame(sockPath, frame) {
  const server = net.createServer((conn) => {
    conn.on('data', () => conn.end(JSON.stringify(frame)));
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

/**
 * ⚠ ASYNCHRONOUS, AND THAT IS NOT STYLE. The first version of this used
 * `spawnSync`, which BLOCKS THIS PROCESS'S EVENT LOOP — so the fake socket
 * server above could never accept the connection, and all three legs failed
 * with `no complete frame within 15000ms`. That reads exactly like a driver
 * that cannot talk to a daemon, which is the verdict this section exists to
 * test, so the harness would have been reporting a defect in itself as a
 * defect in the thing under test.
 */
function runDriver(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [DRIVER, '--census'], {
      env: { ...process.env, ...env }
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// An agents dir nothing on this machine can be holding, so the process term is
// a real zero rather than an assumed one.
const EMPTY_DIR = path.join(tmp, 'no-such-agents-dir-4f2a');

{
  const sockPath = path.join(tmp, 'a.sock');
  const server = await serveFrame(sockPath, { agents: [], missingAgents: [] });
  const r = await runDriver({ BUTCHR_SOCK: sockPath, CRABCAST_AGENTS_DIR: EMPTY_DIR });
  server.close();
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* reported below */
  }
  check(
    'an empty fleet with no processes → exit 0, down true',
    r.status === 0 && parsed?.down === true,
    `exit=${r.status} stdout=${r.stdout?.slice(0, 400)} stderr=${r.stderr?.slice(0, 400)}`,
    'exit 0'
  );
  check(
    'and the JSON line survives the pipe',
    parsed !== null && typeof parsed.after?.processes === 'number',
    `could not parse the driver's stdout as JSON. The driver sets \`process.exitCode\` rather than ` +
      `calling \`process.exit()\` precisely so this line is flushed; if it has been changed back, the ` +
      `kit gets a verdict with no explanation attached on the one run that matters.`,
    'parsed'
  );
}

{
  const sockPath = path.join(tmp, 'b.sock');
  const server = await serveFrame(sockPath, {
    agents: [{ type: 'task', key: 'KAN-473', sessionId: 'abc' }],
    missingAgents: []
  });
  const r = await runDriver({ BUTCHR_SOCK: sockPath, CRABCAST_AGENTS_DIR: EMPTY_DIR });
  server.close();
  check(
    'an agent still in the census → exit 1',
    r.status === 1,
    `exit=${r.status}, expected 1. stdout=${r.stdout?.slice(0, 400)}`,
    'exit 1'
  );
}

{
  const r = await runDriver({
    BUTCHR_SOCK: path.join(tmp, 'nothing-listening.sock'),
    CRABCAST_AGENTS_DIR: EMPTY_DIR
  });
  check(
    'a silent socket → exit 2, distinct from 1',
    r.status === 2,
    `exit=${r.status}, expected 2. stdout=${r.stdout?.slice(0, 400)}\n` +
      `The kit must be able to tell "the fleet is still up" from "I could not find out". Collapsing ` +
      `them means a daemon that is merely slow to answer is reported as a fleet that would not die.`,
    'exit 2'
  );
}

// ───────────────── 6. neither file can stop a process ───────────────────────

rule("6. Neither file carries a verb that could stop a process — CrabCast's table is CrabCast's");

/**
 * KAN-483 is explicit: *"Do NOT reach into CrabCast's process table; that is
 * theirs."* The reap asks the daemon to deactivate and then COUNTS. This makes
 * that mechanical, so a later edit reaching for `kill` because the count would
 * not go to zero goes red in CI rather than in production.
 *
 * Comments are stripped first. Both files DISCUSS killing at length — the whole
 * design rests on explaining why it does not — and a leg that could not tell a
 * mention from a call would have been red on the day it was written, which is
 * the fastest way to have a check deleted.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const KILL_VERBS = [
  /process\.kill\s*\(/,
  /\bkill\s+-\d/,
  /\bpkill\b/,
  /\bSIGKILL\b/,
  /\bSIGTERM\b/,
  /crabcast\.sock/,
  /agents\.jsonl/
];

for (const rel of ['daemon/scripts/cutover-reap.mjs', 'daemon/scripts/lib/cutover-reap-verdict.mjs']) {
  const code = stripComments(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
  const hits = KILL_VERBS.filter((re) => re.test(code)).map((re) => String(re));
  check(
    `${rel} carries no process-stopping or CrabCast-internal verb`,
    hits.length === 0,
    `found: ${hits.join(', ')}\n` +
      `The reap stands agents down through the daemon's own \`deactivate_by_key\` and counts what ` +
      `happens. Reaching for a signal, for CrabCast's socket, or for \`agents.jsonl\` crosses the line ` +
      `KAN-483 drew and the hard prohibitions in the kit's lib.sh restate. If the count will not go to ` +
      `zero, the answer is to REPORT it, which is the entire point of this ticket.`,
    'clean'
  );
}

// ─────────────── 7. the document still states the ordering ──────────────────

rule('7. The document still states the ordering the reap depends on');

const DOC_REL = 'docs/crabcast-cutover-sequence.md';
const doc = fs.readFileSync(path.join(repoRoot, DOC_REL), 'utf8');
const flat = doc.replace(/\s+/g, ' ');

check(
  `${DOC_REL} still puts the drain (R2) before the config revert (R3)`,
  doc.indexOf('### Step R2') !== -1 &&
    doc.indexOf('### Step R3') !== -1 &&
    doc.indexOf('### Step R2') < doc.indexOf('### Step R3'),
  `R2 and R3 are missing or out of order in ${DOC_REL}.\n` +
    `The reap is R2 and it MUST precede R3: a herdr daemon cannot see CrabCast's panes, so an agent ` +
    `still running when the revert lands can never be stood down through the daemon again. The ` +
    `orphans become permanent at that moment.`,
  'R2 precedes R3'
);

check(
  `${DOC_REL} states R3's precondition — that R2 was checked`,
  /### Step R3[\s\S]{0,400}?\*\*Precondition:\*\* R2 checked/.test(doc),
  `R3 no longer names R2 as its precondition.\n` +
    `That sentence is the only place the document explains WHY the order matters, and \`rollback.sh\` ` +
    `and \`cutover-reap.mjs\` both cite it. Losing it leaves two scripts enforcing an ordering with ` +
    `nothing left saying what it is for.`,
  'R3 requires R2'
);

check(
  `${DOC_REL} records that the automated rollback performs the reap itself`,
  /rollback\.sh/.test(flat) && /cutover-reap/.test(flat),
  `${DOC_REL} does not name both \`rollback.sh\` and \`cutover-reap\`.\n` +
    `The rollback arm was written for a human driver, and the watchdog runs it unattended. A reader ` +
    `who does not know the script now performs R2 will either do it twice or assume it was done.`,
  'both named'
);

// ────────────────────────────────── verdict ─────────────────────────────────

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a leftover tmpdir is not a verdict */
}

rule('Verdict');
console.log(
  failures === 0
    ? '   The rollback verdict counts the machine as well as the record, and can still say so both ways.'
    : `   ${failures} failure(s). A rollback could report success while its subjects are still running.`
);

process.exit(failures ? 1 : 0);
