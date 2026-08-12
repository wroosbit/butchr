// Live proof for KAN-342: the board reconciler stands an agent down only where
// the board SAID something, and never merely because a field was empty.
//
// WHAT FAILURE THIS WOULD CATCH: a reconciler that reads "the partitioned query
// did not return this ticket" as "somebody decided this agent should stop". On
// 2026-08-12 `KAN-203` sat In Progress with `assignee: null`; the loop concluded
// no agent should exist for it and stood down the running supervisor once every
// sixty seconds for about forty-five minutes. The human restarted it by hand
// roughly eight times and was the only instrument that noticed, because the
// guardian that reports agents dying was the agent being killed. `BOARD_JQL`
// reads two fields and this file's own header already said a missing
// `issuetype` must protect rather than kill; the other field killed.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
// Section 5 additionally shells out to the repo's own `tsc`.
//
// THE RED IS SECTION 1 AND THE OVER-BROAD FIX IS CAUGHT BY SECTION 3
//
// KAN-342 records two rulings that were proposed and withdrawn, both of which
// look right and both of which are over-broad in the same direction — they stop
// the loop acting on things it *should* act on. So a green run of §1 alone
// would be worthless: "no agent was stood down" is trivially true of a loop that
// has stopped standing agents down at all. §3 is what stops §1 being vacuous. It
// puts four *deliberate* stops through the same loop — Done, To Do, a ticket the
// board has lost entirely, and one reassigned to another account — on a
// supervisor and on a task agent, and requires every one of them to still kill
// its agent within the cycle. Neither section is the proof by itself.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the built `BoardReconciler` and its real `reconcileOnce`, the real
// `computeBoardDiff`, `explainAbsence`, `deriveAccountId`, `partitionStandDowns`
// and `isIntent`, and in §5 the repository's own TypeScript compiler over the
// real `daemon/src` sources.
//
// **Stubbed: the Jira read, and THIS SCRIPT WRITES THE RECORD IT THEN ASSERTS
// ON.** Every board answer below is constructed here — you cannot ask the real
// Atlassian to unassign an epic on cue — so nothing in this file tests that a
// real board search *produces* the rows `computeBoardDiff` is fed, nor that a
// real `assignee: null` arrives as `assigneeAccountId: null`. A stub that agreed
// with a client that had drifted would leave both halves green, which is KAN-145
// exactly.
//
// **Who covers what this leaves open:**
//
//   the real response shape      `verify-absence-attribution.mjs` §5, which
//                                parses real-shaped Jira JSON through the real
//                                `boardPageFrom`
//   the real query, live         `report-board-convergence.mjs`, which runs both
//                                queries through the real credential against the
//                                live board and prints the real partition. Its
//                                output is pasted in the PR
//   the fleet really dying       `verify-board-reconciler-guard.mjs`, which
//                                converges against a real MessageRouter and real
//                                panes rather than `deactivate` stubs. §3a there
//                                is this ticket's gate on the failed-read path
//
// **Nobody covers the join, and it is the same join KAN-256's script names**: no
// artifact shows this daemon's own timer running this decision against a real
// board. Closing it means installing this build over the running daemon, which
// restarts the live fleet and is not a thing a task agent should do to prove a
// point. The honest state is that the join is unproven and it is written here
// rather than left to be assumed.
//
// **What this script deliberately does not assert:** that a spared agent is
// reported. It is — one line per spared agent, replacing the line that used to
// announce the stand-down — but KAN-342 AC5 is explicit that visibility is not
// the fix, and a proof that leaned on the log line would be measuring the thing
// the ticket says does not matter. The assertions below are all on `stopped`,
// `spared` and the fleet, never on prose.
//
// Sections:
//
//   1. THE RED     — the incident: an epic In Progress with an empty assignee.
//                    Against a build with this fix patched out it is stood down;
//                    against today's build it is not. One variable
//   2. not about   — the same absence on a task agent, spared identically, and
//      supervisors   the supervisor predicate proved irrelevant by running the
//                    whole of §1 and §2 again with `isSupervisorType` removed
//   3. intent      — FOUR deliberate stops × TWO agent types: Done, To Do, off
//                    the board entirely, and reassigned to another account. All
//                    eight still die. This is what stops §1 being vacuous
//   4. the cost    — the two absences that are not the missing field: a
//                    diagnostic that did not answer, and an assignee that could
//                    not be compared. Both spared, and starts still happen
//   5. the type    — the guard is not an `if` a later author can delete: the
//                    repo's own tsc refuses a StandDown built from a
//                    non-intent condition, and accepts the identical object
//                    built from an intent one
//
// Isolation is by $HOME, as in verify-board-reconciler-guard.mjs. This script
// starts and stops nothing: `activate`/`deactivate` are stubs that record.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-absence-is-not-intent.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan342-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const {
  BoardReconciler,
  BOARD_JQL,
  BOARD_DIAGNOSTIC_JQL,
  INTENT_CONDITIONS,
  isIntent,
  partitionStandDowns
} = await import(path.join(distDir, 'board-reconcile.js'));

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, good, bad) => {
  console.log(`\n  ${ok ? '→' : '✗ FAILED:'} ${ok ? good : bad}`);
  if (!ok) failures++;
};

const ME = '712020:619ec5ec-me';
const SOMEBODY_ELSE = '712020:0000-them';

/** A board row as `boardPageFrom` would produce one. */
const row = (key, type, status, accountId = ME, displayName = 'Wroos Bit') => ({
  key,
  statusName: status,
  issueTypeName: type,
  assigneeAccountId: accountId,
  assigneeDisplayName: accountId ? displayName : null
});

const agent = (type, key) => ({ agentName: `butchr-${type}-${key.toLowerCase()}`, type, key });

/**
 * One cycle, with both queries answering independently.
 *
 * `Class` is how the red build is driven through the identical harness: same
 * fixture, same stubs, same assertions, one variable.
 */
async function cycleOf({ board, diagnostic, running, Class = BoardReconciler, supervisors = true }) {
  const log = [];
  const stopped = [];
  const started = [];
  const reconciler = new Class({
    jira: {
      async searchBoard(jql) {
        return jql === BOARD_DIAGNOSTIC_JQL ? diagnostic : board;
      }
    },
    runningAgents: () => running,
    activate: async (a) => {
      started.push(a.agentName);
      return { success: true };
    },
    deactivate: async (a) => {
      stopped.push(a.agentName);
      return { success: true };
    },
    mode: () => 'converge',
    log: (...args) => log.push(args.join(' ')),
    ...(supervisors ? { isSupervisorType: (type) => type === 'epic' || type === 'story' } : {})
  });
  const cycle = await reconciler.reconcileOnce();
  return { cycle, log, stopped, started };
}

// ------------------------------------------------------- the red build, once --
//
// The pre-KAN-342 rule, restored in the built module rather than quoted: every
// absence from the partitioned query counted as an instruction to stop, so
// `isIntent` answering yes to everything IS that rule. One replacement, asserted
// to have matched exactly once, so a refactor that moves the gate makes this
// section fail loudly rather than silently prove nothing.
//
// This anchor is the right one *here* and it is not the one
// verify-board-reconciler-guard.mjs uses, which is worth a sentence because the
// difference is a trap. On that script's path the main read has failed, the
// diagnostic block throws, `cycle.absences` is cleared as designed, and
// `isIntent` is never reached — so patching it there would leave the fleet
// standing and report it as the guard holding. Here the main read succeeds and
// every candidate carries a real condition, so this is the gate.
const redDist = path.join(daemonDir, `dist-kan342-red-${process.pid}`);
fs.cpSync(distDir, redDist, { recursive: true });
const redFile = path.join(redDist, 'board-reconcile.js');
const GATE = 'return INTENT_CONDITIONS.includes(condition);';
const redSource = fs.readFileSync(redFile, 'utf8');
const gateHits = redSource.split(GATE).length - 1;
fs.writeFileSync(redFile, redSource.split(GATE).join('return true;'));
const { BoardReconciler: RedReconciler } = await import(redFile);
process.on('exit', () => fs.rmSync(redDist, { recursive: true, force: true }));

console.log(`dist:                 ${distDir}`);
console.log(`red build:            ${redDist}`);
console.log(`BOARD_JQL:            ${BOARD_JQL}`);
console.log(`BOARD_DIAGNOSTIC_JQL: ${BOARD_DIAGNOSTIC_JQL}`);
console.log(`INTENT_CONDITIONS:    ${JSON.stringify(INTENT_CONDITIONS)}`);
console.log(`the gate, patched out of the red build: ${gateHits} × ${JSON.stringify(GATE)}`);

/**
 * The incident, as a fixture: In Progress, and nobody in the assignee field.
 *
 * The status half of `BOARD_JQL` passes and the assignee half does not, so the
 * partitioned query returns nothing while the diagnostic sees the ticket sitting
 * there In Progress — which is exactly what the board looked like at 11:05:31Z
 * on 2026-08-12.
 */
const UNASSIGNED = (type, key, issueType) => ({
  board: { ok: true, issues: [] },
  diagnostic: { ok: true, issues: [row(key, issueType, 'In Progress', null)] },
  running: [agent(type, key)]
});

// ------------------------------------------------------------- 1. THE RED --

rule('1. THE RED — an epic In Progress with an empty assignee, both builds');

const redRun = await cycleOf({ ...UNASSIGNED('epic', 'KAN-203', 'Epic'), Class: RedReconciler });
const greenRun = await cycleOf(UNASSIGNED('epic', 'KAN-203', 'Epic'));

console.log('\n   the board state both runs were given:');
console.log('     KAN-203 — status "In Progress", assignee: (empty), epic/KAN-203 running');
console.log(`\n   OLD (gate removed)  stood down: ${JSON.stringify(redRun.stopped)}`);
console.log(`   NEW                 stood down: ${JSON.stringify(greenRun.stopped)}`);
console.log(`   NEW                 spared:     ${JSON.stringify(greenRun.cycle.spared.map((s) => s.agent.agentName))}` +
  `   condition: ${greenRun.cycle.spared[0]?.reason.condition}`);
console.log(`\n   both builds saw the same candidate set: ` +
  `${JSON.stringify(redRun.cycle.diff.toStop.map((a) => a.agentName))} === ` +
  `${JSON.stringify(greenRun.cycle.diff.toStop.map((a) => a.agentName))}`);

// The candidate sets must be IDENTICAL. If the fix had changed `computeBoardDiff`
// instead of gating the action, this line would differ and the diagnostic query
// would have started feeding the diff — which is the one thing BOARD_DIAGNOSTIC_JQL
// promises it never does.
const sameCandidates =
  JSON.stringify(redRun.cycle.diff.toStop.map((a) => a.agentName)) ===
  JSON.stringify(greenRun.cycle.diff.toStop.map((a) => a.agentName));

verdict(
  gateHits === 1 &&
    redRun.stopped.length === 1 &&
    greenRun.stopped.length === 0 &&
    greenRun.cycle.spared.length === 1 &&
    greenRun.cycle.spared[0].reason.condition === 'no-assignee' &&
    sameCandidates,
  'with the gate removed the identical fixture stood the supervisor down within the cycle, and ' +
    'with it in place the same loop, given the same board, the same fleet and the same ' +
    'stand-down CANDIDATE, left it running and named the empty field',
  gateHits === 1
    ? 'the fix did not change the outcome on the fixture the incident was made of, or it ' +
      'changed the candidate set rather than the action — the diagnostic must not feed the diff'
    : `the gate could not be located in the built module (${gateHits} hit(s)) — this section ` +
      'proves nothing and must be repaired rather than deleted'
);

// ------------------------------------------------- 2. not about supervisors --

rule('2. NOT A SUPERVISOR RULE — the same absence on a task agent, and with the predicate gone');

const taskRun = await cycleOf(UNASSIGNED('task', 'KAN-317', 'Task'));
const taskRed = await cycleOf({ ...UNASSIGNED('task', 'KAN-317', 'Task'), Class: RedReconciler });

// `isSupervisorType` is optional on the options object, so leaving it out is the
// strongest available statement that the decision does not read it: the loop
// cannot consult a predicate it was not given, and the outcome is unchanged.
const epicNoPredicate = await cycleOf({ ...UNASSIGNED('epic', 'KAN-203', 'Epic'), supervisors: false });
const taskNoPredicate = await cycleOf({ ...UNASSIGNED('task', 'KAN-317', 'Task'), supervisors: false });

console.log(`\n   task/KAN-317, gate removed   stood down: ${JSON.stringify(taskRed.stopped)}`);
console.log(`   task/KAN-317, today          stood down: ${JSON.stringify(taskRun.stopped)}` +
  `   spared as: ${taskRun.cycle.spared[0]?.reason.condition}`);
console.log(`\n   with no isSupervisorType supplied at all:`);
console.log(`     epic/KAN-203  stood down: ${JSON.stringify(epicNoPredicate.stopped)}` +
  `   spared: ${epicNoPredicate.cycle.spared.length}`);
console.log(`     task/KAN-317  stood down: ${JSON.stringify(taskNoPredicate.stopped)}` +
  `   spared: ${taskNoPredicate.cycle.spared.length}`);

verdict(
  taskRed.stopped.length === 1 &&
    taskRun.stopped.length === 0 &&
    taskRun.cycle.spared[0]?.reason.condition === 'no-assignee' &&
    epicNoPredicate.stopped.length === 0 &&
    epicNoPredicate.cycle.spared.length === 1 &&
    taskNoPredicate.stopped.length === 0 &&
    taskNoPredicate.cycle.spared.length === 1,
  'a task agent is spared by exactly the same branch as the supervisor, and both are spared ' +
    'identically when the loop is given no supervisor predicate at all — this is a rule about ' +
    'absence, not a supervisor exemption (KAN-221 :98-110 stands)',
  'the task agent was treated differently from the supervisor, or the outcome moved when the ' +
    'supervisor predicate was withdrawn — which would make this the exemption KAN-221 refused'
);

// ------------------------------------------------------------- 3. intent --

rule('3. INTENT STILL KILLS — four deliberate stops × two agent types, all eight die');

// Each of these is a value the board carries, and each is somebody having
// decided something. This is the section that catches an over-broad fix, and
// KAN-342 names an over-broad fix as the likelier failure here.
const DELIBERATE = [
  {
    name: 'moved to Done',
    // Neither query returns it: `BOARD_DIAGNOSTIC_JQL` is the status half alone,
    // so a Done ticket is absent from that too.
    diagnostic: () => ({ ok: true, issues: [] }),
    expect: 'wrong-status'
  },
  {
    name: 'moved back to To Do',
    diagnostic: () => ({ ok: true, issues: [] }),
    expect: 'wrong-status'
  },
  {
    name: 'gone from the board entirely (deleted or renamed)',
    diagnostic: () => ({ ok: true, issues: [] }),
    expect: 'wrong-status'
  },
  {
    name: 'still In Progress, reassigned to another account',
    diagnostic: (key, issueType) => ({
      ok: true,
      issues: [row(key, issueType, 'In Progress', SOMEBODY_ELSE, 'Someone Else')]
    }),
    expect: 'assigned-elsewhere'
  }
];

let intentOk = true;
for (const [type, key, issueType] of [['epic', 'KAN-203', 'Epic'], ['task', 'KAN-317', 'Task']]) {
  for (const c of DELIBERATE) {
    // A second, unrelated ticket keeps the partitioned query non-empty so
    // `deriveAccountId` can learn this machine's id — which is what makes
    // `assigned-elsewhere` a comparison rather than an inference. Without it the
    // condition would be `assignee-uncompared` and §4 is where that belongs.
    const run = await cycleOf({
      board: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress')] },
      diagnostic: c.diagnostic(key, issueType),
      running: [agent(type, key), agent('epic', 'KAN-39')]
    });
    const died = run.stopped.length === 1 && run.stopped[0] === agent(type, key).agentName;
    const condition = run.cycle.stopped.length
      ? run.cycle.absences.find((a) => a.agentName === agent(type, key).agentName)?.reason.condition
      : undefined;
    const ok = died && condition === c.expect && isIntent(condition) === true;
    if (!ok) intentOk = false;
    console.log(`\n   ${type}/${key} — ${c.name}`);
    console.log(`     stood down: ${died}   condition: ${condition}` +
      `${ok ? '' : `   EXPECTED ${c.expect}, stood down`}`);
  }
}

verdict(
  intentOk,
  'every deliberate stop still stands its agent down within the cycle — Done, To Do, off the ' +
    'board, and reassigned — on a supervisor and on a task agent alike. The fix withholds the ' +
    'action only where nothing was decided, which is what stops section 1 being the vacuous ' +
    'claim that this loop no longer stops anything',
  'a deliberate stop no longer works: the fix is over-broad, and it has broken the mechanism ' +
    'KAN-221 built rather than the defect KAN-342 filed'
);

// -------------------------------------------------------------- 4. the cost --

rule('4. THE COST — the other two absences, and the half that must not change');

// KAN-342 accepted a real cost: the evidence for intent comes from the
// diagnostic, so a diagnostic that did not answer now withholds stand-downs. The
// invariant that must survive is narrower and it is the one KAN-256 wrote down —
// a REPORTING failure must not stop the loop working. So each fixture below also
// has something the board wants started, and the start has to happen.
const COST = [
  {
    name: 'the diagnostic did not answer (HTTP 503)',
    board: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress')] },
    diagnostic: { ok: false, backOff: true, status: 503, error: 'board search returned HTTP 503' },
    expect: 'undetermined'
  },
  {
    name: 'assignee present, but no row to learn this account id from',
    // The partitioned query returned nothing at all, so `deriveAccountId` is
    // null and the assignee on the diagnostic row cannot be compared against it.
    // Probably somebody else's; indistinguishable from the two searches
    // disagreeing, and the shape of a whole board vanishing at once.
    board: { ok: true, issues: [] },
    diagnostic: {
      ok: true,
      issues: [row('KAN-203', 'Epic', 'In Progress', SOMEBODY_ELSE, 'Someone Else')]
    },
    expect: 'assignee-uncompared'
  }
];

let costOk = true;
for (const c of COST) {
  const run = await cycleOf({
    board: c.board,
    diagnostic: c.diagnostic,
    running: [agent('epic', 'KAN-203')]
  });
  const condition = run.cycle.spared[0]?.reason.condition;
  // The start half. Fixture 2's board is empty by construction — that is what
  // makes the account id unlearnable — so there is nothing for it to start, and
  // requiring one would be requiring the fixture to contradict itself.
  const wanted = c.board.issues.length;
  const startsHappened = run.started.length === wanted;
  const ok =
    run.stopped.length === 0 &&
    condition === c.expect &&
    isIntent(condition) === false &&
    run.cycle.refusal === null &&
    startsHappened;
  if (!ok) costOk = false;
  console.log(`\n   ${c.name}`);
  console.log(`     stood down: ${run.stopped.length}   spared as: ${condition}` +
    `${ok ? '' : `   EXPECTED ${c.expect}`}`);
  console.log(`     refusal: ${JSON.stringify(run.cycle.refusal)}   ` +
    `started ${run.started.length} of ${wanted} wanted`);
}

// And the direct one: the partition is a pure function, so the whole rule can be
// stated as a table rather than inferred from five cycles.
console.log('\n   isIntent, over every condition the loop can produce:');
const ALL_CONDITIONS = [
  'wrong-status',
  'assigned-elsewhere',
  'no-assignee',
  'assignee-uncompared',
  'queries-disagree',
  'undetermined'
];
for (const c of ALL_CONDITIONS) {
  console.log(`     ${c.padEnd(22)} ${isIntent(c) ? 'STAND DOWN' : 'leave it alone'}`);
}
const tableOk =
  ALL_CONDITIONS.filter((c) => isIntent(c)).join(',') === 'wrong-status,assigned-elsewhere';

// A candidate with no absence entry at all — the state the loop lands in when
// the whole diagnostic block throws — must be spared, not stood down.
const noEntry = partitionStandDowns([agent('epic', 'KAN-203')], []);
console.log(`\n   a candidate with NO absence entry recorded: ` +
  `${noEntry.standDowns.length} stand-down(s), ${noEntry.spared.length} spared`);

verdict(
  costOk && tableOk && noEntry.standDowns.length === 0 && noEntry.spared.length === 1,
  'an unanswered diagnostic and an uncomparable assignee are both absences and both spare the ' +
    'agent, exactly two conditions stand anything down, a candidate nobody recorded a reason ' +
    'for is spared — and the loop still starts what the board asked for, so a reporting ' +
    'failure has not been handed the power to halt the cycle',
  'an absence stood an agent down, an intent failed to, or a reporting failure stopped the ' +
    'loop starting what the board wanted'
);

// --------------------------------------------------------------- 5. the type --

rule('5. THE TYPE — the gate is not an `if` a later author can quietly delete');

// KAN-342's guard is expressed as a narrowed type as well as a branch, on the
// argument in prompts/task.md: an assertion can be deleted and the build still
// passes, while an unrepresentable state cannot be introduced at all. This
// section is what makes that claim checkable rather than aspirational — and it
// needs BOTH halves, because a tsc invocation that failed for an unrelated
// reason would "prove" the guard while proving nothing.
const tscDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan342-tsc-'));
const fixture = (condition) => `
import type { StandDown, AbsenceReason } from ${JSON.stringify(path.join(daemonDir, 'src', 'board-reconcile.js'))};
const reason: AbsenceReason = {
  condition: '${condition}',
  statusName: 'In Progress',
  assignee: null,
  detail: 'the assignee field is empty'
};
export const standDown: StandDown = {
  agent: { agentName: 'butchr-epic-kan-203', type: 'epic', key: 'KAN-203' },
  reason: { ...reason, condition: '${condition}' }
};
`;

const typecheck = (condition) => {
  const file = path.join(tscDir, `kan342-${condition}.ts`);
  fs.writeFileSync(file, fixture(condition));
  try {
    execFileSync(
      process.execPath,
      [
        path.join(daemonDir, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit', '--strict',
        '--target', 'es2022',
        '--module', 'nodenext',
        '--moduleResolution', 'nodenext',
        file
      ],
      { cwd: daemonDir, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { compiled: true, output: '' };
  } catch (e) {
    return { compiled: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

const refused = typecheck('no-assignee');
const accepted = typecheck('wrong-status');
fs.rmSync(tscDir, { recursive: true, force: true });

console.log(`\n   a StandDown built from condition 'no-assignee'  → compiles: ${refused.compiled}`);
if (!refused.compiled) {
  for (const line of refused.output.split('\n').slice(0, 3)) console.log(`     ${line}`);
}
console.log(`\n   a StandDown built from condition 'wrong-status' → compiles: ${accepted.compiled}`);
if (!accepted.compiled) {
  for (const line of accepted.output.split('\n').slice(0, 5)) console.log(`     ${line}`);
}

// The error has to be about the condition, and about THIS condition. A tsc that
// failed because it could not resolve the import would be a green verdict for a
// check that never ran — the shape this repository keeps re-finding. Matched on
// the bare token rather than on a quoted form: tsc quotes type literals as
// `'"no-assignee"'`, and an assertion pinned to one spelling of that is a check
// that goes quietly false when the compiler changes its punctuation.
const refusedForTheRightReason =
  !refused.compiled &&
  refused.output.includes('no-assignee') &&
  /not assignable/.test(refused.output);

verdict(
  refusedForTheRightReason && accepted.compiled,
  'the compiler refuses a stand-down constructed from a non-intent condition and accepts the ' +
    'identical object constructed from an intent one — so reinstating the 2026-08-12 behaviour ' +
    'means widening INTENT_CONDITIONS in the open, not deleting a branch',
  !accepted.compiled
    ? 'the control case did not compile either — this section failed for a reason that has ' +
      'nothing to do with the guard and proves nothing about it'
    : refused.compiled
      ? 'a StandDown can be built from an absence, so the guard is a deletable `if` after all'
      : 'the non-intent case was refused, but not for being a non-intent condition — the ' +
        'error names something else, so this section did not test what it claims to'
);

// ----------------------------------------------------------------- verdict --

rule(failures ? `${failures} SECTION(S) FAILED` : 'ALL SECTIONS PASSED');
process.exit(failures ? 1 : 0);
