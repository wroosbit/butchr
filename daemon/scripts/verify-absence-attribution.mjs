// Live proof for KAN-256: the board reconciler never names a condition it has
// not checked, and a ticket In Progress with an empty assignee is noticed.
//
// WHAT FAILURE THIS WOULD CATCH: a stand-down line that reports the wrong
// reason. `BOARD_JQL` has two conditions and this module used to print one
// sentence for a missing ticket whatever the cause — "the board does not have
// KAN-59 In Progress or In Review" — which on 2026-08-10 was said of a ticket
// that WAS In Progress and merely unassigned. An operator read it, went and
// checked the status, found the status correct, and was sent nowhere while an
// entire project's supervisor sat dark. A false sentence in a log line is worse
// than no sentence: it spends the reader's attention and returns a wrong answer.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// THE RED IS SECTION 1, AND IT IS THE POINT OF THE SCRIPT
//
// Sections 2-5 assert that the new lines are right, and on their own they prove
// only that today's code says today's words. Section 1 reconstructs the OLD
// line from the built module — the same reconciler, the same fixture, with the
// reason lookup patched out — and prints it next to the new one so the defect
// is *watched* rather than described. If that patch stops matching, the section
// fails loudly rather than quietly proving nothing.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the built `BoardReconciler`, its real `reconcileOnce`, the real
// `computeBoardDiff`, the real `explainAbsence`/`findNearMisses`/
// `deriveAccountId`, and the real `boardPageFrom` — section 5 feeds raw Jira
// JSON through the actual response parser rather than hand-building the row
// objects the reconciler consumes.
//
// **Stubbed: the Jira read, and THIS SCRIPT WRITES THE RECORD IT THEN ASSERTS
// ON.** The board answers below are constructed here — you cannot ask the real
// Atlassian to unassign an epic on cue — so nothing in this file tests that a
// *real* board search returns a real `assignee` field in the shape
// `boardPageFrom` expects. That is the KAN-145 hole restated: a stub that agreed
// with a client that had drifted would leave both green. Section 5 narrows it by
// parsing real-shaped JSON through the real parser, which is strictly more than
// hand-building rows, and it is still not a live response.
//
// **Who covers it: `daemon/scripts/report-board-convergence.mjs`**, whose
// section 4 runs BOTH queries through the real credential against the live
// board and prints the real near-miss list and the real assignee values. Its
// output is pasted in the PR. Run them as a pair; neither is the proof alone.
//
// **Nothing here covers the daemon's timer calling any of this**, and the
// obvious patch for that does not reach as far as it looks. Both scripts
// construct a reconciler and call `reconcileOnce` by hand, so both could be
// green while nothing was wired into daemon.ts. The PR pastes the usual
// observation — a real `node dist/daemon.js` under a temp $HOME, logging a real
// cycle from its own timer at exactly +60s — and **that run never reaches the
// code in this file**: a temp $HOME holds no Jira credential, so the cycle
// refuses at the main read and the diagnostic, which runs only after a
// successful one, never executes.
//
// So the seam is covered in three pieces and NOT end to end:
//
//   timer → reconcileOnce          the temp-$HOME daemon observation (in the PR)
//   reconcileOnce → both queries   report-board-convergence.mjs, real credential
//   the attribution itself         this script
//
// **Nobody covers the join**: no artifact shows this daemon's own timer running
// the diagnostic against a real board. Closing it means either installing this
// build over the running daemon — which would restart the live fleet, and is
// not a thing a task agent should do to prove a point — or waiting for the next
// ordinary deploy and reading the log. The honest state is that the join is
// unproven, and it is written here rather than left for a reader to assume.
//
// Sections:
//
//   1. THE RED    — the old sentence and the new one, on the same fixture: a
//                   ticket In Progress with no assignee, reported both ways
//   2. conditions — wrong status / no assignee / assigned elsewhere are three
//                   distinguishable verdicts, each naming its own condition
//   3. near-miss  — an unassigned In Progress ticket with NO agent running is
//                   still reported; this is the occurrence a stand-down line
//                   could never have covered (KAN-212)
//   4. degraded   — a diagnostic that fails reports `undetermined` and NEVER
//                   the old sentence, and it does not halt the loop
//   5. parser     — real-shaped Jira JSON through the real `boardPageFrom`:
//                   an absent assignee parses to null, a present one does not
//
// WHAT KAN-342 CHANGED IN THIS SCRIPT, AND WHY IT IS NOT A WEAKENING
//
// This script was written when the reconciler stood an agent down for *any*
// absence from `BOARD_JQL`, so §1 and §4 both asserted on the wording of a
// stand-down that had already happened. KAN-342 made the stand-down conditional
// on the board having said something, and on both of these fixtures — an
// unassigned ticket, and a diagnostic that did not answer — it now says
// nothing, so no agent is stood down and there is no stand-down line to read.
//
// The two sections are therefore reworded rather than relaxed, and each now
// asserts something strictly stronger than it did:
//
//   §1 asserted the new line names the empty assignee instead of denying the
//      status. It still does — KAN-256's sentence survives intact, moved onto
//      the line that reports the agent being LEFT ALONE — and §1 additionally
//      asserts that `stopped` is empty, which it could not have said before.
//   §4 asserted that a failed diagnostic still let the loop converge on the
//      diff it had. It no longer does, for stand-downs, and that is KAN-342's
//      deliberate and stated cost: intent cannot be established from a query
//      that did not answer. §4 now asserts the half that is unchanged — starts
//      are untouched, no refusal is recorded, the reason is `undetermined` and
//      never the old sentence — and pins the half that changed.
//
// §1's red build correspondingly needs BOTH repairs removed to reproduce the
// 2026-08-10 log: KAN-256's attribution AND KAN-342's gate. That is not the
// section getting weaker; it is two guards now standing between this daemon and
// that line, and the reconstruction has to get past both to be a reconstruction.
//
// Isolation is by $HOME, as in verify-board-reconciler-guard.mjs: no herdr is
// contacted and no real workspace is touched. This script starts and stops
// nothing — it injects `activate`/`deactivate` stubs that only record.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-absence-attribution.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan256-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const {
  BoardReconciler,
  BOARD_JQL,
  BOARD_DIAGNOSTIC_JQL,
  explainAbsence,
  findNearMisses,
  deriveAccountId
} = await import(path.join(distDir, 'board-reconcile.js'));
const { boardPageFrom } = await import(path.join(distDir, 'jira.js'));

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, good, bad) => {
  console.log(`\n  ${ok ? '→' : '✗ FAILED:'} ${ok ? good : bad}`);
  if (!ok) failures++;
};

const ME = '712020:aaaa-me';
const SOMEBODY_ELSE = '712020:bbbb-them';

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
 * A reconciler whose two queries answer independently, so a fixture can put a
 * ticket in the diagnostic answer and out of the partitioned one — which is
 * precisely the state that produced the false line.
 */
function reconcilerFor({ board, diagnostic, running, mode = 'converge' }) {
  const log = [];
  const stopped = [];
  const reconciler = new BoardReconciler({
    jira: {
      // On the PARTITIONED query being the exact constant, not on the
      // diagnostic being one: KAN-343 scopes the diagnostic by project at call
      // time, so its JQL carries a `project IN (…)` prefix and matching on
      // `BOARD_DIAGNOSTIC_JQL` verbatim would silently hand the diagnostic call
      // the partitioned answer. `BOARD_JQL` has no call-time variation.
      async searchBoard(jql) {
        if (jql === BOARD_JQL) return board;
        return diagnostic;
      }
    },
    runningAgents: () => running,
    activate: async () => ({ success: true }),
    deactivate: async (a) => {
      stopped.push(a.agentName);
      return { success: true };
    },
    mode: () => mode,
    log: (...args) => log.push(args.join(' ')),
    isSupervisorType: (type) => type === 'epic' || type === 'story'
  });
  return { reconciler, log, stopped };
}

/** The fixture that reproduces the incident: KAN-59, In Progress, unassigned. */
const INCIDENT = () => ({
  // The partitioned query cannot see it — that is the whole defect.
  board: { ok: true, issues: [] },
  // The diagnostic can: it IS In Progress, with an empty assignee.
  diagnostic: { ok: true, issues: [row('KAN-59', 'Epic', 'In Progress', null)] },
  running: [agent('epic', 'KAN-59')]
});

console.log(`dist:       ${distDir}`);
console.log(`BOARD_JQL:            ${BOARD_JQL}`);
console.log(`BOARD_DIAGNOSTIC_JQL: ${BOARD_DIAGNOSTIC_JQL}`);

// ------------------------------------------------------------- 1. THE RED --

rule('1. THE RED — the same fixture, reported the old way and the new way');

// The old behaviour, reconstructed from the built module rather than quoted:
// every stand-down sentence came from a template that took no reason at all. We
// patch the reason lookup to yield nothing, which is exactly the pre-KAN-256
// state — there was no reason to look up — and restore the old template text.
//
// SINCE KAN-342 THAT IS NOT SUFFICIENT ON ITS OWN, AND THE EXTRA PATCH IS THE
// SECOND GUARD RATHER THAN A CONVENIENCE.
//
// Disabling the attribution now leaves `partitionStandDowns` with no reason for
// this agent, and no reason is no evidence of intent, so the agent is spared and
// the reconstruction prints nothing at all. The fallback below puts back the one
// thing the pre-KAN-256 loop had in place of an attribution: the hardcoded
// sentence, asserted of every absence unconditionally. That single line
// reconstructs both repairs' absence at once — which is honest rather than
// convenient, because KAN-342's gate is built out of KAN-256's attribution and
// could not have existed before it.
const redDist = path.join(daemonDir, `dist-kan256-red-${process.pid}`);
fs.cpSync(distDir, redDist, { recursive: true });
const redFile = path.join(redDist, 'board-reconcile.js');
let redSource = fs.readFileSync(redFile, 'utf8');
const OLD_SENTENCE = 'the board does not have it In Progress or In Review';
const patches = [
  // Make the new attribution unavailable, as it was before this change...
  ['cycle.absences.push({', 'cycle.absencesDisabled_ForTheRed = true; ({'],
  // ...put the sentence it replaced back, verbatim from git history, as the
  // unconditional answer for every absence. This is the pre-KAN-256 loop: one
  // hardcoded clause, no condition, and therefore — since the condition is what
  // KAN-342 reads — no gate either. Both repairs gone, in the one line where
  // they now both live.
  [
    'const reason = reasonFor.get(agent.agentName);',
    `const reason = reasonFor.get(agent.agentName) ?? ` +
      `{ condition: 'wrong-status', statusName: null, assignee: null, detail: '${OLD_SENTENCE}' };`
  ],
  // ...remove the near-miss report, which did not exist either. Without this
  // the red build would print the new explanation right beside the old false
  // line and understate what the operator was actually working from: one
  // sentence, and nothing else in the log about KAN-59 at all.
  ['for (const miss of cycle.nearMisses ?? []) {', 'for (const miss of []) {'],
  // ...and put the OTHER old sentence back too. Both stand-down lines carried
  // the same false claim, and the `converging:` one is what daemon.log:12736
  // actually recorded during the incident. Patching only the second would leave
  // the red build printing this change's own wording beside it, which is not
  // what anybody read that morning. The word order differs from the line above
  // — the key sits inside the clause rather than in front of it — which is why
  // this is a second patch and not the same string twice.
  [
    'const detail = `${renderedKey(agent.key)}: ${reason.detail}`;',
    'const detail = `the board does not have ${renderedKey(agent.key)} In Progress or In Review`;'
  ]
];
const patchReport = [];
for (const [from, to] of patches) {
  const hits = redSource.split(from).length - 1;
  patchReport.push({ from: from.slice(0, 46) + '…', hits });
  redSource = redSource.split(from).join(to);
}
fs.writeFileSync(redFile, redSource);
const patchesApplied = patchReport.every((p) => p.hits === 1);
process.on('exit', () => fs.rmSync(redDist, { recursive: true, force: true }));

console.log('   patches applied to a copy of the built module:');
for (const p of patchReport) console.log(`     ${p.hits} × ${JSON.stringify(p.from)}`);

const { BoardReconciler: RedReconciler } = await import(redFile);

const redFixture = INCIDENT();
const redLog = [];
const red = new RedReconciler({
  jira: {
    async searchBoard(jql) {
      // See reconcilerFor above for why this pins the partitioned side (KAN-343).
      return jql === BOARD_JQL ? redFixture.board : redFixture.diagnostic;
    }
  },
  runningAgents: () => redFixture.running,
  activate: async () => ({ success: true }),
  deactivate: async () => ({ success: true }),
  mode: () => 'converge',
  log: (...args) => redLog.push(args.join(' ')),
  isSupervisorType: (type) => type === 'epic'
});
await red.reconcileOnce();

const { reconciler: green, log: greenLog, stopped: greenStopped } = reconcilerFor(INCIDENT());
const greenCycle = await green.reconcileOnce();

// Anchored on the start of the sentence, not on a substring of it: the
// near-miss line contains the words "stood down" too, and a looser match picked
// it up and compared the new report against itself.
const standDown = (lines) => lines.find((l) => l.startsWith('[board] stood down '));
const oldLine = standDown(redLog);
// KAN-342: there is no "stood down" line on this fixture any more, because
// there is no stand-down. KAN-256's sentence moved onto the line that reports
// the agent being left alone, and that is the line to compare against the old
// one — same fixture, same field, and now a different outcome rather than only
// a different wording.
const newLine = greenLog.find((l) => l.includes('nothing established that anybody asked it to stop'));

console.log('\n   the board state both runs were given:');
console.log('     KAN-59 — status "In Progress", assignee: (empty)');
console.log(`\n   OLD — everything the red build logged about KAN-59 (${redLog.length} line(s)):`);
for (const l of redLog) console.log(`     ${l}`);
console.log('\n   NEW:');
console.log(`     ${newLine}`);
console.log(`\n   OLD — agents stood down: 1 (epic/KAN-59, every cycle, for 45 minutes)`);
console.log(`   NEW — agents stood down: ${greenStopped.length}   ${JSON.stringify(greenStopped)}`);
console.log(`   NEW — spared: ${JSON.stringify(greenCycle.spared.map((s) => s.agent.agentName))}` +
  `  condition: ${greenCycle.spared[0]?.reason.condition}`);

// The old line's specific falsehood: it denies the status, and the status was
// right. The new line must not deny it, and must name the field that was empty.
const oldDeniesStatus = !!oldLine?.includes('does not have it In Progress or In Review');
const newDeniesStatus = !!newLine?.includes('does not have it In Progress or In Review');
const newNamesAssignee = !!newLine?.includes('assignee field is empty');
const newAffirmsStatus = !!newLine?.includes('IS In Progress');

// The two lines the daemon really logged during occurrence 3, copied from
// ~/.local/share/butchr/daemon.log lines 12736-12737 (2026-08-10T14:09:49.971Z
// and 14:09:50.602Z). Asserting against these is what makes the red build a
// *reconstruction* rather than this script's own idea of what used to happen:
// if the patched build's output drifts from what was actually recorded, the
// section fails and says so.
const RECORDED = {
  converging:
    '[board] converging: STAND DOWN SUPERVISOR epic/KAN-59 — the board does not have KAN-59 ' +
    'In Progress or In Review. Supervisors are not exempt from this rule (KAN-221); to keep ' +
    'one running, its ticket has to say so.',
  stoodDown:
    '[board] stood down epic/KAN-59: the board does not have it In Progress or In Review.'
};
const redConverging = redLog.find((l) => l.startsWith('[board] converging: STAND DOWN'));
const matchesRecord = redConverging === RECORDED.converging && oldLine === RECORDED.stoodDown;

console.log('\n   against the real incident (daemon.log:12736-12737, 2026-08-10T14:09:49Z):');
console.log(`     the red build reproduces both lines verbatim: ${matchesRecord}`);
if (!matchesRecord) {
  console.log(`       recorded : ${JSON.stringify(RECORDED.converging)}`);
  console.log(`       red build: ${JSON.stringify(redConverging)}`);
  console.log(`       recorded : ${JSON.stringify(RECORDED.stoodDown)}`);
  console.log(`       red build: ${JSON.stringify(oldLine)}`);
}

console.log(`\n   old line denies the status: ${oldDeniesStatus}   (the ticket WAS In Progress)`);
console.log(`   new line denies the status: ${newDeniesStatus}`);
console.log(`   new line names the empty assignee: ${newNamesAssignee}`);
console.log(`   new line affirms the correct status: ${newAffirmsStatus}`);

// KAN-342. The wording assertions above are KAN-256's and they still hold; this
// is the half that was missing, and it is the half the incident was made of. An
// operator reading a correctly-worded line about a supervisor that is already
// dead has been told the truth about an outcome that should not have happened.
const newStoodNothingDown = greenStopped.length === 0 && greenCycle.stopped.length === 0;
const newSpared = greenCycle.spared.length === 1 &&
  greenCycle.spared[0].reason.condition === 'no-assignee';

console.log(`\n   new build stood nothing down: ${newStoodNothingDown}`);
console.log(`   new build spared it as \`no-assignee\`: ${newSpared}`);

verdict(
  patchesApplied &&
    matchesRecord &&
    oldDeniesStatus &&
    !newDeniesStatus &&
    newNamesAssignee &&
    newAffirmsStatus &&
    newStoodNothingDown &&
    newSpared,
  'the red build reproduced BOTH lines the daemon really logged during the incident, verbatim, ' +
    'making the false claim on a ticket that was In Progress — and the new build does not stand ' +
    'the agent down at all, naming the empty assignee as the absence it is rather than denying a ' +
    'status that was correct',
  patchesApplied
    ? 'the new build still stands the agent down on an empty assignee, still denies the status, ' +
      'or fails to name the field — the defect is live'
    : `the old sentence could not be located in the built module (${JSON.stringify(patchReport)}) — ` +
      'this section proves nothing and must be repaired rather than deleted'
);

// --------------------------------------------------------- 2. conditions --

rule('2. CONDITIONS — three causes, three verdicts, each naming its own');

const cases = [
  {
    name: 'no assignee',
    diagnostic: [row('KAN-59', 'Epic', 'In Progress', null)],
    expect: 'no-assignee'
  },
  {
    name: 'wrong status',
    diagnostic: [],
    expect: 'wrong-status'
  },
  {
    name: 'assigned elsewhere',
    diagnostic: [row('KAN-59', 'Epic', 'In Progress', SOMEBODY_ELSE, 'Someone Else')],
    expect: 'assigned-elsewhere'
  },
  {
    name: 'both conditions hold, queries disagree',
    diagnostic: [row('KAN-59', 'Epic', 'In Progress', ME)],
    expect: 'queries-disagree'
  }
];

// KAN-470 gave `explainAbsence` the agent and the desired list rather than a
// bare key. Every case here is a KEY THE BOARD DID NOT RETURN AT ALL, so the
// desired list is empty and the new first branch cannot fire — which is what
// keeps these five cases testing exactly what they tested before. The branch
// itself is covered by `verify-same-key-other-type.mjs`.
const EPIC_59 = agent('epic', 'KAN-59');

let conditionsOk = true;
for (const c of cases) {
  const reason = explainAbsence(EPIC_59, [], c.diagnostic, ME);
  const ok = reason.condition === c.expect;
  if (!ok) conditionsOk = false;
  console.log(`\n   ${c.name}`);
  console.log(`     condition: ${reason.condition}${ok ? '' : `   EXPECTED ${c.expect}`}`);
  console.log(`     says:      ${reason.detail.slice(0, 150)}…`);
}

// The falsehood must be absent from every branch except the one where it is
// true — that is the invariant, not "the wording improved".
const deniesStatusWhenFalse = cases
  .filter((c) => c.expect !== 'wrong-status')
  .some((c) => explainAbsence(EPIC_59, [], c.diagnostic, ME).detail.includes('does not have it In Progress'));

console.log(`\n   any branch wrongly denying the status: ${deniesStatusWhenFalse}`);

verdict(
  conditionsOk && !deniesStatusWhenFalse,
  'each cause produces its own condition, and only the branch where the ticket really is not ' +
    'In Progress or In Review says so',
  'a cause was misattributed, or a branch denied a status that was correct'
);

// ---------------------------------------------------------- 3. near-miss --

rule('3. NEAR-MISS — the unassigned ticket that NO agent is running (KAN-212)');

// Nothing is running for KAN-212 and nothing is being stood down, so no
// stand-down sentence exists to be improved. This is the occurrence that was
// invisible by construction.
const nm = reconcilerFor({
  board: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress')] },
  diagnostic: {
    ok: true,
    issues: [row('KAN-39', 'Epic', 'In Progress'), row('KAN-212', 'Task', 'In Progress', null)]
  },
  running: [agent('epic', 'KAN-39')]
});
const nmCycle = await nm.reconciler.reconcileOnce();

console.log(`   stand-downs this cycle: ${nmCycle.stopped.length}`);
console.log(`   starts this cycle:      ${nmCycle.started.length}`);
console.log(`   near misses reported:   ${JSON.stringify(nmCycle.nearMisses?.map((m) => m.key))}`);
const nmLine = nm.log.find((l) => l.includes('NO ASSIGNEE'));
console.log(`\n   the line:\n     ${nmLine}`);

verdict(
  nmCycle.nearMisses?.length === 1 &&
    nmCycle.nearMisses[0].key === 'KAN-212' &&
    !!nmLine &&
    nmCycle.stopped.length === 0 &&
    nmCycle.started.length === 0,
  'a ticket In Progress with no assignee and no agent running was reported out loud, while ' +
    'the loop started and stopped nothing on account of it',
  'the near miss went unreported, or the diagnostic query changed what the loop converged'
);

// ----------------------------------------------------------- 4. degraded --

rule('4. DEGRADED — a diagnostic that fails says so, withholds the stand-down, and starts anyway');

// KAN-342 changed this section's expected outcome, and the change is the cost
// this ticket accepted rather than an incidental consequence. The stand-down
// evidence comes from the diagnostic, so a diagnostic that did not answer
// cannot establish that anybody asked for one. Before, this fixture stood the
// agent down with a vaguer sentence; now it does not stand it down.
//
// The invariant the original section was protecting is NOT "the loop converges
// regardless" — it is that **a reporting failure must not stop the loop
// working**. That still holds where it can: the read succeeded, the diff is
// real, and everything the board asked to START still starts. So the fixture
// gains a wanted-but-not-running agent, which is what makes the two halves
// separable at all; asserting only the stand-down half would have let a failed
// diagnostic quietly acquire the power to freeze the whole cycle and called it
// caution.
const deg = reconcilerFor({
  board: { ok: true, issues: [row('KAN-77', 'Task', 'In Progress')] },
  diagnostic: { ok: false, backOff: true, status: 503, error: 'board search returned HTTP 503' },
  running: [agent('epic', 'KAN-59')]
});
const degCycle = await deg.reconciler.reconcileOnce();
const degLine = deg.log.find((l) => l.includes('nothing established that anybody asked it to stop'));

console.log(`   diagnostic answered: no (HTTP 503)`);
console.log(`   near misses: ${JSON.stringify(degCycle.nearMisses)}   (null = nobody looked)`);
console.log(`   condition:   ${degCycle.absences[0]?.reason.condition}`);
console.log(`\n   the line:\n     ${degLine}`);
console.log(`\n   refusal:      ${JSON.stringify(degCycle.refusal)}   (null = the cycle was not halted)`);
console.log(`   started:      ${JSON.stringify(degCycle.started.map((s) => s.agent.agentName))}`);
console.log(`   stood down:   ${JSON.stringify(degCycle.stopped.map((s) => s.agent.agentName))}`);
console.log(`   spared:       ${JSON.stringify(degCycle.spared.map((s) => s.agent.agentName))}`);

verdict(
  degCycle.absences[0]?.reason.condition === 'undetermined' &&
    !degLine?.includes('does not have it In Progress or In Review') &&
    degCycle.nearMisses === null &&
    degCycle.stopped.length === 0 &&
    degCycle.spared.length === 1 &&
    degCycle.refusal === null &&
    degCycle.started.length === 1,
  'a failed diagnostic reports an undetermined reason rather than falling back to the false ' +
    'sentence, reports null rather than an empty near-miss list, withholds a stand-down it ' +
    'cannot justify — and still starts what the board asked for, so a reporting failure has ' +
    'not been handed the power to halt the cycle',
  'the degraded path reverted to the old sentence, claimed a clean board it never read, stood ' +
    'an agent down on evidence it did not have, or let a reporting failure stop the loop starting'
);

// ------------------------------------------------------------- 5. parser --

rule('5. PARSER — real-shaped Jira JSON through the real boardPageFrom');

// The row objects above are hand-built; this is the one place the real response
// parser runs, so an `assignee` field that Jira spells differently is caught
// here rather than in production.
const realJson = {
  isLast: true,
  issues: [
    {
      key: 'KAN-59',
      fields: { status: { name: 'In Progress' }, issuetype: { name: 'Epic' }, assignee: null }
    },
    {
      key: 'KAN-39',
      fields: {
        status: { name: 'In Review' },
        issuetype: { name: 'Epic' },
        assignee: { accountId: ME, displayName: 'Wroos Bit' }
      }
    }
  ]
};
const parsed = boardPageFrom(realJson, 100);
console.log(`   parsed ${parsed.issues.length} row(s), complete=${parsed.complete}`);
for (const issue of parsed.issues) {
  console.log(
    `     ${issue.key.padEnd(8)} ${String(issue.statusName).padEnd(12)} ` +
    `assignee=${JSON.stringify(issue.assigneeAccountId)} (${JSON.stringify(issue.assigneeDisplayName)})`
  );
}
const misses = findNearMisses(parsed.issues, new Set(['KAN']));
const derived = deriveAccountId(parsed.issues.filter((i) => i.assigneeAccountId));
console.log(`\n   findNearMisses → ${JSON.stringify(misses.map((m) => m.key))}`);
console.log(`   deriveAccountId → ${JSON.stringify(derived)}`);

verdict(
  parsed.issues[0].assigneeAccountId === null &&
    parsed.issues[1].assigneeAccountId === ME &&
    misses.length === 1 &&
    misses[0].key === 'KAN-59' &&
    derived === ME,
  'Jira\'s own null assignee parses to null, a present one survives with its account id, and ' +
    'the account this machine authenticates as is derived from the board\'s own answer',
  'the parser lost the assignee, or an unassigned row was not recognised as one'
);

// -------------------------------------------------------------- 6. scoping --

rule('6. SCOPING — other people\'s unassigned tickets are not this fleet\'s alarm');

// Found by running the live report, not by thinking about it: the first real
// run returned four unassigned tickets in Jira's own SAM1 sample project, which
// unfiltered would be four log lines a minute forever. A near-miss report that
// fires 5,760 times a day trains its reader to skim exactly the line it exists
// to make them read.
const mixed = [
  row('KAN-212', 'Task', 'In Progress', null),
  row('SAM1-3', 'Epic', 'In Progress', null),
  row('SAM1-7', 'Task', 'In Review', null)
];

const scoped = reconcilerFor({
  board: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress')] },
  diagnostic: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress'), ...mixed] },
  running: [agent('epic', 'KAN-39')]
});
const scopedCycle = await scoped.reconciler.reconcileOnce();

console.log(`   unassigned on the board: ${JSON.stringify(mixed.map((m) => m.key))}`);
console.log(`   reported:                ${JSON.stringify(scopedCycle.nearMisses?.map((m) => m.key))}`);

// And the case the scope must NOT fall silent in: everything unassigned at
// once, so the partitioned query returns nothing and only the running agents
// still name the project.
const wipeout = reconcilerFor({
  board: { ok: true, issues: [] },
  diagnostic: { ok: true, issues: [row('KAN-39', 'Epic', 'In Progress', null), ...mixed.slice(1)] },
  running: [agent('epic', 'KAN-39')]
});
const wipeoutCycle = await wipeout.reconciler.reconcileOnce();

console.log(`\n   total-unassignment: partitioned query returned 0 rows`);
console.log(`   still reported:     ${JSON.stringify(wipeoutCycle.nearMisses?.map((m) => m.key))}`);
console.log(`   (project came from the running agent, not from the empty board answer)`);

verdict(
  scopedCycle.nearMisses?.length === 1 &&
    scopedCycle.nearMisses[0].key === 'KAN-212' &&
    wipeoutCycle.nearMisses?.length === 1 &&
    wipeoutCycle.nearMisses[0].key === 'KAN-39',
  'unassigned tickets in projects this fleet is not in are ignored, and the report still fires ' +
    'when EVERY ticket is unassigned — the case where a board-derived scope alone would have ' +
    'gone silent just as the whole fleet was about to be stood down',
  'the report either spams other projects or falls silent exactly when it is most needed'
);

// ----------------------------------------------------------------- verdict --

rule(failures ? `${failures} SECTION(S) FAILED` : 'ALL SECTIONS PASSED');
process.exit(failures ? 1 : 0);
