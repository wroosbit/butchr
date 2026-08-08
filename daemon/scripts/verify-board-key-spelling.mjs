// Live proof for KAN-225: the key a human is told to go and move is spelled the
// way the board spells it, on both surfaces that print one — and the agent whose
// spelling had to be corrected is still visible to step 4 of the algorithm.
//
// WHAT FAILURE THIS WOULD CATCH: a running agent that the durable registry never
// recorded being named at a human by its pane spelling — "move kan-500 out of
// those statuses" — which names no ticket on any board. And the more dangerous
// mirror of it: fixing that by making an agent with no registry record invisible
// to the reconciler, which would leave it running, Jira-shaped, not on the board,
// and unstoppable by the loop forever. §2 is the section that would catch the
// second one, and it is the one this ticket said was still owed.
//
// WHY BOTH HALVES ARE IN ONE SCRIPT
//
// Because the defect and its tempting fix live at the same seam. `inJurisdiction`
// upper-cases a key before testing it, which is what lets the loop *see*
// `kan-500` as the Jira key it is; the bug was only ever that the same key was
// then printed without being normalised. A script that proved the spelling and
// said nothing about jurisdiction would pass just as happily against the version
// of this fix that silently narrowed step 4 — that version is a worse defect than
// the one it fixes, and it is invisible from the spelling alone.
//
// Sections:
//
//   0. the condition is real  — the subject is a `sessionless` agent the real
//                               AgentRegistry genuinely cannot spell. Nothing
//                               below is worth reading if this does not hold.
//   1. the rule               — `renderedKey` upper-cases Jira-shaped keys in any
//                               case and leaves everything else exactly as it is
//   2. still visible to step 4 — the same unregistered agent is in jurisdiction,
//                               lands in `toStop` when the board does not list
//                               it, and is really stood down by the real
//                               reconciler; and is really left alone when the
//                               board does list it
//   3. one rule, two surfaces — the daemon log line and the Agents page's Off
//                               note, from one payload, side by side
//   4. THE RED                — the same scenario against a copy of the built
//                               module with the normalisation removed, showing
//                               the wrong string reaching both surfaces
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: `renderedKey`, `inJurisdiction`, `computeBoardDiff` and `BoardReconciler`
// as shipped; a real `MessageRouter` answering a real `list_agents`; a real
// on-disk `AgentRegistry`; the real `boardControlReport`; and the extension's own
// `describeBoardControl`, imported rather than reimplemented, so the sentence
// asserted below is the sentence the page renders.
//
// **Constructed: the pane census.** A herdr stub reports the panes, because the
// alternative is this script creating real panes on the machine it runs on — and
// a real `butchr-task-kan-500` pane would be a real agent for the real board loop
// to have an opinion about. So THIS SCRIPT WRITES THE FLEET IT THEN ASSERTS ON,
// and that leaves one thing uncovered: nothing here proves that a *real* herdr
// census, read by a *real* daemon over its socket, contains agents with no
// registry record and reports them with the board's spelling.
//
// **Who covers that: section 7 of verify-off-button-honesty.mjs.** It boots a
// real `node dist/daemon.js` under a temp `$HOME` while herdr's census is
// machine-wide, so every agent that daemon sees is genuinely unrecorded, and it
// asserts the spelling off the wire. That is the real-payload half of acceptance
// criterion 1; this script is the half that can construct conditions a real
// machine will not hold still for — an agent the board has stopped wanting, and a
// build with the fix removed.
//
// **What neither covers: a real stand-down of a real unregistered agent.** §2
// stands down a constructed one through the real reconciler. Doing it for real
// would mean this script destroying a live agent's context on the machine it runs
// on, which is not a thing a proof is allowed to do. The gap is named rather than
// papered: what is real in §2 is the loop's decision, not the pane it lands on.
//
// Usage: node daemon/scripts/verify-board-key-spelling.mjs [distDir]
// Run it after `npm run build` in daemon/.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(scriptDir, '..', '..');
// Resolved, because these are handed to `import()`: a relative path there is a
// *package* specifier, and `dist-something` fails with "cannot find package".
const distDir = path.resolve(process.argv[2] ?? path.join(daemonDir, 'dist'));

if (!fs.existsSync(path.join(distDir, 'daemon.js'))) {
  console.error(`${distDir}/daemon.js is missing — run \`npm run build\` in daemon/ first.`);
  process.exit(1);
}

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

const board = await import(path.join(distDir, 'board-reconcile.js'));
const { boardControlReport } = await import(path.join(distDir, 'board-control.js'));

// The extension's own function, not a copy of it: the note asserted in §3 is the
// note the page renders, and a drift between them would fail here.
const { describeBoardControl } = await import(
  pathToFileURL(path.join(repoRoot, 'extension', 'src', 'lib', 'boardControl.js')).href
);

let failures = 0;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan225-'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
function check(ok, label, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
  return ok;
}

// --- the fleet, and what each member of it is here to prove ------------------
//
// Every pane below is in the herdr census. Only ONE of them is in the agent
// registry, and that asymmetry is the whole fixture: `recordedKeyFor` answers for
// the registered one and returns nothing for the rest, which is the condition the
// old `?? agent.key` fallback fired on.

const SUBJECT = 'butchr-task-kan-500';
const SUPERVISOR = 'butchr-epic-kan-501';

const CENSUS = [
  // The subject: Jira-shaped, in jurisdiction, no registry record. Its key comes
  // back off the census as `kan-500`, because an agent *name* is built from a
  // lower-cased key.
  SUBJECT,
  // The same case for a supervisor type, because the stand-down line for one
  // prints the key a second time *outside* the `address()` helper — a separate
  // render site, and therefore a separate way to regress.
  SUPERVISOR,
  // Registered, and wanted by the board: the contrast that shows §2 is not
  // simply standing everything down.
  'butchr-epic-kan-39',
  // Out of jurisdiction because `confluence` is not a board workspace type, and
  // its key is not Jira-shaped either. Criterion 5: untouched.
  'butchr-confluence-123456789',
  // Out of jurisdiction on the key alone — `task` *is* a board type, so this is
  // the one that proves the guard inside `renderedKey` is doing something.
  'butchr-task-scratch'
];

/** Only this one gets a durable record. Everything else is unrecorded. */
const RECORDED = [{ agentName: 'butchr-epic-kan-39', type: 'epic', key: 'KAN-39' }];

/**
 * A herdr stub whose census is whatever we say it is.
 *
 * Shape borrowed from verify-off-button-honesty.mjs's `herdrStub`, narrowed to
 * what `surveyFleet` touches. `agentRuntime` must be set: a pane without one is
 * reported as an *unbacked pane* rather than an agent, which is a different list.
 */
function herdrStub(names, workDirs) {
  const bridge = {
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: names.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: workDirs[name],
        herdrStatus: 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    listHerdrStatuses: () => new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    abandonSession: () => {},
    terminateSession: () => ({ success: true })
  };
  return bridge;
}

/** A router built the way daemon.ts builds one, over the census above. */
function makeRouter(reportBoardControl) {
  const registry = new WorkspaceRegistry();
  registry.registerIntegration(
    createAtlassianIntegration({
      issueTypeLookup: async () => null,
      credential: { status: () => ({ configured: false }) },
      state: new IntegrationStateStore(
        path.join(fs.mkdtempSync(path.join(TMP, 'state-')), 'integrations.json')
      )
    })
  );

  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const agentRegistry = new AgentRegistry(path.join(home, 'agents.jsonl'));
  const workDirs = {};
  for (const name of CENSUS) {
    workDirs[name] = path.join(home, name);
    fs.mkdirSync(workDirs[name], { recursive: true });
  }
  for (const agent of RECORDED) {
    agentRegistry.recordActivated({
      agentName: agent.agentName,
      type: agent.type,
      key: agent.key,
      workDir: workDirs[agent.agentName],
      url: null,
      defaultAgent: 'claude',
      activatedBy: null
    });
  }

  let last = null;
  const router = new MessageRouter(
    registry,
    new PromptLoader(repoRoot),
    herdrStub(CENSUS, workDirs),
    (msg) => { last = msg; },
    () => {},
    // KAN-226 replaced the positional tail with this object, which is why the
    // slot-counting comment that used to live here is gone: there are no slots
    // left to count, and a name cannot be taken by the wrong argument.
    { agentRegistry, boardControl: reportBoardControl }
  );
  return { router, list: () => { router.handle({ action: 'list_agents' }); return last; } };
}

/**
 * The scenario, so §2, §3 and §4 run the same one against different builds.
 *
 * `mods` carries the modules under test — patched in §4, shipped everywhere else.
 * `runningAgents` is wired exactly as daemon.ts wires it, `recordedKeyFor` and
 * its `??` fallback included: that fallback is *still there* in daemon.ts, and
 * leaving it in the fixture is deliberate. The fix does not depend on the caller
 * having corrected the key first, and a fixture that pre-corrected it would be
 * proving something easier than what ships.
 */
async function runScenario({ mods, boardIssues, mode = 'converge' }) {
  const reportBoardControl = (agents) => mods.boardControlReport(mode, agents);
  const { router, list } = makeRouter(reportBoardControl);

  const lines = [];
  const stoodDown = [];

  const reconciler = new mods.board.BoardReconciler({
    jira: { searchBoard: async () => ({ ok: true, issues: boardIssues }) },
    runningAgents: () =>
      router.surveyFleet().agents.map((agent) => ({
        agentName: agent.agentName,
        type: agent.type,
        key: router.recordedKeyFor(agent.agentName) ?? agent.key
      })),
    activate: async () => ({ success: true }),
    deactivate: async (agent) => { stoodDown.push(agent.agentName); return { success: true }; },
    mode: () => mode,
    isSupervisorType: (type) => type === 'epic',
    log: (...args) => lines.push(args.join(' ')),
    startStaggerMs: 0
  });

  const cycle = await reconciler.reconcileOnce();
  return { router, list, cycle, lines, stoodDown, log: lines.join('\n') };
}

const WANTS_KAN_39 = [{ key: 'KAN-39', statusName: 'In Progress', issueTypeName: 'Epic' }];
const WANTS_KAN_39_AND_500 = [
  ...WANTS_KAN_39,
  { key: 'KAN-500', statusName: 'In Progress', issueTypeName: 'Task' }
];

const SHIPPED = { board, boardControlReport };

// =============================================================================
rule('0. THE CONDITION IS REAL — an agent the registry genuinely cannot spell');
// =============================================================================
//
// Acceptance criterion 1 is about "a `sessionless` agent with no registry
// record". If this fixture does not actually produce one, every section below is
// asserting against a condition it invented, and the fallback that was the whole
// defect would never have fired. So establish it first, off a real
// `surveyFleet()` and a real `AgentRegistry`, rather than assuming it.

const zero = makeRouter((agents) => boardControlReport('converge', agents));
const surveyed = zero.router.surveyFleet().agents;
const subjectRow = surveyed.find((a) => a.agentName === SUBJECT);

check(!!subjectRow, `the census produced ${SUBJECT}`, `saw: ${surveyed.map((a) => a.agentName).join(', ')}`);
check(
  subjectRow?.sessionless === true,
  'and it is sessionless — no session of this daemon holds it',
  `sessionless: ${subjectRow?.sessionless}`
);
check(
  subjectRow?.key === 'kan-500',
  'and its key came out of the pane name lower-cased, which is the defect\'s input',
  `key: ${JSON.stringify(subjectRow?.key)}`
);
check(
  zero.router.recordedKeyFor(SUBJECT) === undefined,
  'and the real AgentRegistry cannot spell it — `recordedKeyFor` returns nothing',
  `got: ${JSON.stringify(zero.router.recordedKeyFor(SUBJECT))}`
);
check(
  zero.router.recordedKeyFor('butchr-epic-kan-39') === 'KAN-39',
  'while it does answer for the one agent that was recorded — so the fixture is asymmetric on purpose'
);

// =============================================================================
rule('1. THE RULE — Jira-shaped keys are upper-cased, everything else is not');
// =============================================================================
//
// Criterion 5. The two examples named in the ticket are here by name, along with
// the shapes that sit either side of the regex, because "leave everything else
// exactly as it is" is the half of this rule that a careless `.toUpperCase()`
// would break.

const TABLE = [
  ['kan-500', 'KAN-500', 'the defect\'s own input'],
  ['KAN-500', 'KAN-500', 'already right, and unchanged'],
  ['  kan-500  ', 'KAN-500', 'surrounding whitespace is trimmed, as inJurisdiction trims it'],
  ['Kan-500', 'KAN-500', 'mixed case'],
  ['123456789', '123456789', 'a Confluence page id — confluence/123456789'],
  ['scratch', 'scratch', 'a scratch workspace — task/scratch'],
  ['notes', 'notes', 'a name, not a key, and not to be shouted at anybody'],
  ['kan-', 'kan-', 'nearly a key and therefore exactly the input a loose regex mangles'],
  ['-500', '-500', 'no project part'],
  ['my-notes-2', 'my-notes-2', 'dashes and a digit, but not a Jira key'],
  ['', '', 'empty stays empty rather than becoming something']
];

for (const [input, expected, why] of TABLE) {
  const got = board.renderedKey(input);
  check(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} — ${why}`, `got ${JSON.stringify(got)}`);
}

// =============================================================================
rule('2. STILL VISIBLE TO STEP 4 — the section this ticket said was owed');
// =============================================================================
//
// The regression that would be worse than the defect: an agent with no registry
// record becoming invisible to "anything running that is not in that list → off".
// It is asserted three ways, because each is a different way to lose it —
// jurisdiction could exclude it, the diff could drop it, or the loop could
// compute it correctly and then not act. And then the mirror image, which is what
// stops all three from being satisfied by a loop that simply stops everything.

const types = board.boardWorkspaceTypes();
const subjectRunning = {
  agentName: SUBJECT,
  type: 'task',
  key: zero.router.recordedKeyFor(SUBJECT) ?? subjectRow.key
};
check(
  board.inJurisdiction(subjectRunning, types) === true,
  'the unregistered agent is IN jurisdiction — the loop can see it',
  `key as the loop receives it: ${JSON.stringify(subjectRunning.key)}`
);

const notWanted = await runScenario({ mods: SHIPPED, boardIssues: WANTS_KAN_39 });
const stopNames = notWanted.cycle.diff.toStop.map((a) => a.agentName);

check(
  stopNames.includes(SUBJECT),
  'and the board not listing it puts it in `toStop` — step 4 reached it',
  `toStop: ${JSON.stringify(stopNames)}`
);
check(
  notWanted.stoodDown.includes(SUBJECT),
  'and the real reconciler in converge really stood it down',
  `deactivated: ${JSON.stringify(notWanted.stoodDown)}`
);
check(
  stopNames.includes(SUPERVISOR) && notWanted.stoodDown.includes(SUPERVISOR),
  'the unregistered supervisor too — supervisors are not exempt (KAN-221)'
);
check(
  notWanted.cycle.diff.outOfJurisdiction.map((a) => a.agentName).sort().join(',') ===
    ['butchr-confluence-123456789', 'butchr-task-scratch'].join(','),
  'while the two non-Jira agents are out of jurisdiction, and neither was stopped',
  `outOfJurisdiction: ${JSON.stringify(notWanted.cycle.diff.outOfJurisdiction.map((a) => a.agentName))}`
);
check(
  !notWanted.stoodDown.includes('butchr-epic-kan-39'),
  'and the agent the board does want was left alone — the loop is reading the board, not clearing the deck'
);

// The mirror. Without it, every check above is also true of a loop that stands
// down everything it can see, which would satisfy "still visible to step 4" while
// being a far worse product.
const wanted = await runScenario({ mods: SHIPPED, boardIssues: WANTS_KAN_39_AND_500 });
check(
  !wanted.stoodDown.includes(SUBJECT),
  'and when the board DOES list it, the same agent is not stood down',
  `deactivated: ${JSON.stringify(wanted.stoodDown)}`
);
check(
  wanted.cycle.diff.unchanged.map((a) => a.agentName).includes(SUBJECT),
  'it is `unchanged` instead — matched to the board row by agent name, across the case difference',
  `unchanged: ${JSON.stringify(wanted.cycle.diff.unchanged.map((a) => a.agentName))}`
);

// =============================================================================
rule('3. ONE RULE, TWO SURFACES — the daemon log and the Off note, side by side');
// =============================================================================
//
// Criterion 6. Both strings below describe the same agent in the same cycle, and
// the point of printing them together is that a reader can see they agree —
// because a spelling rule applied on one surface and not the other is the
// disagreement this criterion exists to forbid.

const payload = notWanted.list();
const controlled = payload.boardControl?.controlled ?? {};
const uiRow = payload.agents.find((a) => a.agentName === SUBJECT);
const note = describeBoardControl(payload.boardControl, uiRow);

const logLine = notWanted.lines.find((l) => l.includes('stood down') && l.includes('/KAN-500')) ??
                notWanted.lines.find((l) => l.toLowerCase().includes('kan-500')) ?? '(no line)';
const supervisorLine = notWanted.lines.find((l) => l.includes('STAND DOWN SUPERVISOR')) ?? '(no line)';

check(
  controlled[SUBJECT] === 'KAN-500',
  'the board-control map reports the board\'s spelling for the unregistered agent',
  `got ${JSON.stringify(controlled[SUBJECT])} — the whole map: ${JSON.stringify(controlled)}`
);
check(
  !Object.values(controlled).some((k) => k !== k.toUpperCase()),
  'and nothing in the map is lower-cased',
  `map: ${JSON.stringify(controlled)}`
);
check(
  controlled['butchr-confluence-123456789'] === undefined &&
    controlled['butchr-task-scratch'] === undefined,
  'and the two non-Jira agents are absent from it — criterion 5 holds by construction here'
);

check(
  logLine.includes('task/KAN-500') && !logLine.includes('kan-500'),
  'the daemon log names it task/KAN-500 and never task/kan-500',
  `line: ${logLine}`
);
check(
  supervisorLine.includes('epic/KAN-501') && supervisorLine.includes('have KAN-501 In Progress'),
  'the supervisor line is normalised in BOTH places it prints the key',
  `line: ${supervisorLine}`
);
check(
  !notWanted.log.includes('kan-500') && !notWanted.log.includes('kan-501'),
  'and no line of the whole cycle\'s log carries a pane spelling',
  notWanted.log
);
check(
  notWanted.log.includes('confluence/123456789') && notWanted.log.includes('task/scratch'),
  'while the non-Jira agents appear in the log exactly as they are spelled'
);

check(
  note?.offNote?.action?.includes('move KAN-500 out of those statuses'),
  'and the Off note — the extension\'s own function — names the same ticket the same way',
  `action: ${JSON.stringify(note?.offNote?.action)}`
);
check(
  !JSON.stringify(note).includes('kan-500'),
  'with no lower-cased spelling anywhere in the rendered note'
);

console.log(`
  the two surfaces, on the same agent in the same cycle:

    daemon log   ${logLine.trim()}
    Off note     ${note?.offNote?.lead} ${note?.offNote?.action}

    supervisor   ${supervisorLine.trim()}
`);

// =============================================================================
rule('4. THE RED — the same scenario with the normalisation removed');
// =============================================================================
//
// Criterion 4. A gate nobody has watched fail has not been shown to be a gate, so
// this reconstructs the pre-fix rendering and asserts that the wrong string
// arrives. One patch does it, and that is itself the point: both surfaces read
// their spelling from one helper, so removing its body breaks both — which is the
// evidence for "one rule, two callers" that §3 can only assert the happy half of.
//
// The copy lives inside daemon/ so its relative imports still resolve, and the
// patch is asserted to have matched exactly once: a refactor that moves the rule
// makes this section fail loudly rather than quietly prove nothing.

/**
 * A copy of the built dist with an edit applied, and the edit asserted to have
 * matched exactly once.
 *
 * The `hits === 1` check is the part that matters: a refactor that moves or
 * rewrites the patched line would otherwise leave these sections importing a
 * pristine build, reproducing nothing, and passing — which is precisely the shape
 * of failure this whole epic keeps finding.
 */
function patchedDist(tag, edits) {
  const dir = path.join(daemonDir, `dist-${tag}-${process.pid}`);
  fs.cpSync(distDir, dir, { recursive: true });
  const report = [];
  for (const [file, from, to] of edits) {
    const target = path.join(dir, file);
    const source = fs.readFileSync(target, 'utf8');
    const hits = source.split(from).length - 1;
    report.push({ file, from, hits });
    fs.writeFileSync(target, source.split(from).join(to));
  }
  return { dir, report, ok: report.every((r) => r.hits === 1) };
}

// `keys.js` rather than `board-reconcile.js` since KAN-229, which moved the rule
// down to a module that depends on nothing so nudge.ts could reach it without
// importing the reconciliation loop. board-reconcile.js re-exports it, so every
// import below is unchanged and the patched copy still reaches both surfaces —
// the check under this call is what proved the move had happened rather than
// leaving this section silently patching nothing.
const raw = patchedDist('unnormalised', [
  ['keys.js', 'return JIRA_KEY.test(upper) ? upper : key;', 'return key;']
]);
check(
  raw.ok,
  'the patch site is where this section thinks it is',
  `${JSON.stringify(raw.report)} — \`renderedKey\` has moved or changed shape; this section proves nothing until it is updated`
);

if (raw.ok) {
  const rawBoard = await import(pathToFileURL(path.join(raw.dir, 'board-reconcile.js')).href);
  const { boardControlReport: rawReport } = await import(
    pathToFileURL(path.join(raw.dir, 'board-control.js')).href
  );
  const red = await runScenario({
    mods: { board: rawBoard, boardControlReport: rawReport },
    boardIssues: WANTS_KAN_39
  });
  const redPayload = red.list();
  const redControlled = redPayload.boardControl?.controlled ?? {};
  const redRow = redPayload.agents.find((a) => a.agentName === SUBJECT);
  const redNote = describeBoardControl(redPayload.boardControl, redRow);
  const redLine = red.lines.find((l) => l.toLowerCase().includes('kan-500')) ?? '(no line)';

  // These assert that the RED IS RED. A failure here means the defect could not be
  // reproduced, and therefore that §3 is not testing what it claims to test.
  check(
    redControlled[SUBJECT] === 'kan-500',
    'without the rule, the board-control map hands the pane spelling to the UI',
    `got ${JSON.stringify(redControlled[SUBJECT])}`
  );
  check(
    redLine.includes('task/kan-500'),
    'without the rule, the daemon log names a ticket that does not exist',
    `line: ${redLine}`
  );
  check(
    redNote?.offNote?.action?.includes('move kan-500 out of those statuses'),
    'without the rule, the Off note tells a human to go and move kan-500',
    `action: ${JSON.stringify(redNote?.offNote?.action)}`
  );
  check(
    red.stoodDown.includes(SUBJECT),
    'and the defect really was cosmetic — the unnormalised build stood the same agent down',
    `deactivated: ${JSON.stringify(red.stoodDown)} — this is why the ticket calls it a reporting bug and not a control bug`
  );

  console.log(`
  what a human saw before this fix:

    daemon log   ${redLine.trim()}
    Off note     ${redNote?.offNote?.action}

  and neither string names anything on any board.
`);
}

// =============================================================================
rule('5. HALF THE FIX — the disagreement criterion 6 exists to forbid');
// =============================================================================
//
// §4 removed the rule from both surfaces at once, which is honest but easy: any
// check at all goes red. The failure this ticket actually feared is subtler and
// is the reason it refused to ship in two parts — **normalise one surface and not
// the other, and the daemon log and the Agents page name the same agent two
// different ways.** That build is worse than the unfixed one, because it looks
// fixed from whichever surface you happen to be reading.
//
// So: restore the raw key on the board-control path only, leave `address()`
// normalised, and confirm two things. That the disagreement is real, and — the
// part that makes §3 a gate rather than a happy path — that §3's own assertion is
// the one that catches it.

const half = patchedDist('half', [['board-control.js', 'renderedKey(agent.key)', 'agent.key']]);
check(
  half.ok,
  'the half-fix patch site is where this section thinks it is',
  `${JSON.stringify(half.report)}`
);

if (half.ok) {
  const halfBoard = await import(pathToFileURL(path.join(half.dir, 'board-reconcile.js')).href);
  const { boardControlReport: halfReport } = await import(
    pathToFileURL(path.join(half.dir, 'board-control.js')).href
  );
  const split = await runScenario({
    mods: { board: halfBoard, boardControlReport: halfReport },
    boardIssues: WANTS_KAN_39
  });
  const splitPayload = split.list();
  const splitControlled = splitPayload.boardControl?.controlled ?? {};
  const splitLine = split.lines.find((l) => l.includes('stood down')) ?? '(no line)';
  const splitNote = describeBoardControl(
    splitPayload.boardControl,
    splitPayload.agents.find((a) => a.agentName === SUBJECT)
  );

  check(
    splitLine.includes('task/KAN-500') && splitControlled[SUBJECT] === 'kan-500',
    'with only one surface fixed, the log and the page really do name one agent two ways',
    `log: ${splitLine}\n        map: ${JSON.stringify(splitControlled[SUBJECT])}`
  );
  // The assertion §3 makes, re-run here against the half-fixed build. It has to be
  // FALSE, or §3 is not a gate — it would pass on a build this ticket forbids.
  const wouldCatch = !Object.values(splitControlled).some((k) => k !== k.toUpperCase());
  check(
    wouldCatch === false,
    'and §3\'s own check is false against it — so §3 is a gate, not a happy path',
    'the map check passed against a half-fixed build, which means §3 would not have caught it'
  );

  console.log(`
  one agent, one cycle, two surfaces that no longer agree:

    daemon log   ${splitLine.trim()}
    Off note     ${splitNote?.offNote?.action}
`);
}

fs.rmSync(raw.dir, { recursive: true, force: true });
fs.rmSync(half.dir, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });

console.log(
  `\n== ${failures === 0 ? 'done — every section passed' : `${failures} CHECK(S) FAILED`} ==`
);
process.exit(failures === 0 ? 0 : 1);
