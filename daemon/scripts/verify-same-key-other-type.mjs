// Live proof for KAN-470: when two agents run on one Jira key, the board
// reconciler names what it actually observed instead of blaming Jira's search
// index — and it still leaves the second agent running.
//
// WHAT FAILURE THIS WOULD CATCH: a stand-down line asserting that `BOARD_JQL`
// did not return a ticket that `BOARD_JQL` returned. `computeBoardDiff` matches
// an agent on type AND key together (KAN-83); `explainAbsence` was handed a bare
// `key` and matched on that alone. So a key whose board row resolved to a
// different workspace type reached the last branch with its status right, its
// assignee right and no explanation left, and was reported as
// `queries-disagree` — "the two searches disagreed with each other. Suspect
// Jira's search index". They had not disagreed; both returned the ticket every
// time. That line ran 1307 times over 44 hours against `task/KAN-117` while
// `story/KAN-117` held the same key, and the docblock above the branch told
// every reader it had never fired.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// THE RED IS SECTION 2, AND IT IS WHY THIS SCRIPT EXISTS
//
// Section 2 reproduces the defect out of the CURRENT build rather than
// describing it, by re-creating the exact blindness the old signature had. The
// pre-KAN-470 `explainAbsence(key, diagnostic, accountId)` could not see the
// desired list at all — there was no parameter for it — so calling today's
// function with an EMPTY desired list reproduces that blindness faithfully:
// same module, same fixture, same everything else. It returns
// `queries-disagree` and blames the index. Section 3 then makes the single
// change of handing it the desired list the diff actually computed, and the
// same fixture reports `same-key-other-type`. If that reproduction ever stops
// producing the old condition, section 2 fails loudly rather than quietly
// proving nothing.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the built `BoardReconciler` and its real `reconcileOnce`, the real
// `computeBoardDiff`, the real `explainAbsence`, the real `partitionStandDowns`
// and `isIntent`, and the real `INTENT_CONDITIONS`.
//
// **Stubbed: the Jira read, and THIS SCRIPT WRITES THE RECORD IT THEN ASSERTS
// ON.** The board answers are constructed here. So nothing in this file proves
// that a real fleet ever gets into this state — it proves that when it does, the
// reconciler says the right thing and spares the agent.
//
// **Who covers that it happens for real: nobody, in a script.** It is covered by
// observation, and the observation is pasted in the PR — 1307 `grep -a` hits in
// the live `daemon.log`, every one naming `task/KAN-117`, against a live board
// where `story/KAN-117` and `task/KAN-117` are both running and KAN-117 is a
// Story. That is a reading of the running system at one moment, not a gate, and
// it will go stale the moment the fleet changes. Named here so the reader is not
// left inferring a coverage that does not exist.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kan470-'));
process.env.HOME = tmpHome;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));

const {
  BoardReconciler,
  BOARD_JQL,
  computeBoardDiff,
  explainAbsence,
  partitionStandDowns,
  isIntent,
  INTENT_CONDITIONS
} = await import(path.join(distDir, 'board-reconcile.js'));

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, good, bad) => {
  console.log(`\n  ${ok ? '→' : '✗ FAILED:'} ${ok ? good : bad}`);
  if (!ok) failures++;
};

const ME = '712020:aaaa-me';

const row = (key, type, status, accountId = ME, displayName = 'Wroos Bit') => ({
  key,
  statusName: status,
  issueTypeName: type,
  assigneeAccountId: accountId,
  assigneeDisplayName: accountId ? displayName : null
});

const agent = (type, key) => ({ agentName: `butchr-${type}-${key.toLowerCase()}`, type, key });

/**
 * PRODUCTION, as measured on 2026-08-15. KAN-117 is a Story, In Progress,
 * assigned to this machine's account, and BOTH `story/KAN-117` and
 * `task/KAN-117` are running. Both queries return the ticket — that is the
 * point, and it is what the old line denied.
 */
const FIXTURE = () => ({
  board: { ok: true, issues: [row('KAN-117', 'Story', 'In Progress')] },
  diagnostic: { ok: true, issues: [row('KAN-117', 'Story', 'In Progress')] },
  running: [agent('story', 'KAN-117'), agent('task', 'KAN-117')]
});

function reconcilerFor({ board, diagnostic, running, mode = 'converge' }) {
  const log = [];
  const stopped = [];
  const reconciler = new BoardReconciler({
    jira: {
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

console.log(`dist:      ${distDir}`);
console.log(`BOARD_JQL: ${BOARD_JQL}`);

// ------------------------------------------------- 1. THE BOARD DID RETURN IT --

rule('1. THE PREMISE — `BOARD_JQL` returns KAN-117, and the diff is still right to flag task/KAN-117');

const f1 = FIXTURE();
const diff = computeBoardDiff(f1.board.issues, f1.running);

console.log(`\n   board returned:  ${JSON.stringify(f1.board.issues.map((i) => `${i.key} (${i.issueTypeName})`))}`);
console.log(`   desired:         ${JSON.stringify(diff.desired.map((d) => d.agentName))}`);
console.log(`   unchanged:       ${JSON.stringify(diff.unchanged.map((a) => a.agentName))}`);
console.log(`   toStop:          ${JSON.stringify(diff.toStop.map((a) => a.agentName))}`);

const keyIsOnBoard = f1.board.issues.some((i) => i.key === 'KAN-117');
const storyKept = diff.unchanged.some((a) => a.agentName === 'butchr-story-kan-117');
const taskFlagged = diff.toStop.some((a) => a.agentName === 'butchr-task-kan-117');

verdict(
  keyIsOnBoard && storyKept && taskFlagged,
  'the KEY is on the board and story/KAN-117 is satisfied by it; task/KAN-117 is a candidate ' +
    'because its ADDRESS is not. Both facts hold at once — that is the whole bug.',
  `expected KAN-117 on the board (${keyIsOnBoard}), story kept (${storyKept}), task flagged (${taskFlagged})`
);

// --------------------------------------------------------------- 2. THE RED --

rule('2. THE RED — the pre-KAN-470 blindness, reproduced from this same build');

// The old signature took no desired list. Passing an empty one reproduces that
// exactly: the function cannot see that the board resolved this key to another
// type, which is precisely what it could not see before.
const blind = explainAbsence(agent('task', 'KAN-117'), [], f1.diagnostic.issues, ME);

console.log(`\n   condition: ${blind.condition}`);
console.log(`   says:      ${blind.detail}`);

const redReproduced =
  blind.condition === 'queries-disagree' && blind.detail.includes("Suspect Jira's search index");

verdict(
  redReproduced,
  'reproduced: blind to the desired list, the reconciler asserts the two searches disagreed and ' +
    'sends the reader to Jira\'s search index. Both queries had returned KAN-117.',
  `the reconstruction did not produce the old condition (got \`${blind.condition}\`). The ` +
    'reproduction has drifted from the defect and this section is proving nothing — fix it ' +
    'rather than deleting it.'
);

// -------------------------------------------------------------- 3. THE GREEN --

rule('3. THE FIX — the same call, handed the desired list the diff computed');

const seeing = explainAbsence(agent('task', 'KAN-117'), diff.desired, f1.diagnostic.issues, ME);

console.log(`\n   condition: ${seeing.condition}`);
console.log(`   says:      ${seeing.detail}`);

const namesTheOtherAgent = seeing.detail.includes('butchr-story-kan-117');
const blamesNobody = !seeing.detail.includes("Suspect Jira's search index");
const affirmsTheReturn = seeing.detail.includes(`\`${BOARD_JQL}\` DID return KAN-117`);

verdict(
  seeing.condition === 'same-key-other-type' && namesTheOtherAgent && blamesNobody && affirmsTheReturn,
  'the condition names what was observed — one key, two agents — states that the query DID ' +
    'return the ticket, and names the agent the board actually asked for.',
  `condition=${seeing.condition}, names other agent=${namesTheOtherAgent}, ` +
    `blames nobody=${blamesNobody}, affirms the return=${affirmsTheReturn}`
);

// ------------------------------------------ 4. THE BEHAVIOUR MUST NOT CHANGE --

rule('4. THE SPARING IS UNCHANGED — this is a sentence fix, not a stand-down rule');

const inIntent = INTENT_CONDITIONS.includes('same-key-other-type');
const { standDowns, spared } = partitionStandDowns(diff.toStop, [
  { agentName: 'butchr-task-kan-117', reason: seeing }
]);

console.log(`\n   INTENT_CONDITIONS:                 ${JSON.stringify([...INTENT_CONDITIONS])}`);
console.log(`   'same-key-other-type' among them:  ${inIntent}`);
console.log(`   isIntent('same-key-other-type'):   ${isIntent('same-key-other-type')}`);
console.log(`   would stand down:                  ${JSON.stringify(standDowns.map((s) => s.agent.agentName))}`);
console.log(`   spared:                            ${JSON.stringify(spared.map((s) => s.agent.agentName))}`);

verdict(
  !inIntent &&
    !isIntent('same-key-other-type') &&
    standDowns.length === 0 &&
    spared.some((s) => s.agent.agentName === 'butchr-task-kan-117'),
  'task/KAN-117 is left running, exactly as it was for all 1307 cycles. The new condition is ' +
    'not an intent and cannot become one without widening INTENT_CONDITIONS in the open.',
  `inIntent=${inIntent}, standDowns=${standDowns.length}, spared=${spared.length} — a sentence ` +
    'fix has changed who lives, which is the one outcome this ticket ruled out'
);

// -------------------------------------------------- 5. END TO END, REAL LOOP --

rule('5. END TO END — a real reconcileOnce, and the log line it actually writes');

const f5 = FIXTURE();
const { reconciler, log, stopped } = reconcilerFor(f5);
const cycle = await reconciler.reconcileOnce();

for (const line of log) console.log(`   ${line}`);

const sparedLine = log.find((l) => l.includes('task/KAN-117') && l.includes('Leaving it running'));
const deniesTheReturn = log.some((l) => l.includes('`' + BOARD_JQL + '` did not return it'));
const nothingStopped = stopped.length === 0;
const conditionOnCycle = (cycle.spared ?? []).find(
  (s) => s.agent.agentName === 'butchr-task-kan-117'
)?.reason.condition;

console.log(`\n   stopped:            ${JSON.stringify(stopped)}`);
console.log(`   spared condition:   ${conditionOnCycle}`);
console.log(`   any line claiming the query did not return it: ${deniesTheReturn}`);

verdict(
  Boolean(sparedLine) &&
    !deniesTheReturn &&
    nothingStopped &&
    conditionOnCycle === 'same-key-other-type',
  'the running loop spares task/KAN-117, reports `same-key-other-type`, and no line in the ' +
    'cycle claims the board query failed to return a ticket it returned.',
  `sparedLine=${Boolean(sparedLine)}, deniesTheReturn=${deniesTheReturn}, ` +
    `stopped=${JSON.stringify(stopped)}, condition=${conditionOnCycle}`
);

// ------------------------------------------------------------------ VERDICT --

rule(`VERDICT: ${failures === 0 ? 'PASS' : `FAIL (${failures} section(s))`}`);

process.exit(failures ? 1 : 0);
