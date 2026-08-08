// Live proof for KAN-221: a Jira read that failed converges nothing, and the
// same loop with that one check removed destroys the fleet.
//
// WHAT FAILURE THIS WOULD CATCH: a board-driven reconciler that cannot tell "the
// board says nothing should be running" from "the board did not answer". Both
// produce an empty issue list, and steps 3 and 4 of the algorithm turn an empty
// list into *stand the entire fleet down*. Atlassian was unreachable for about
// two hours on 2026-08-04 (KAN-157); under a loop without this check, that
// outage tears down every running agent, and an agent's context does not
// survive its pane. It is the one failure in this design that is unrecoverable.
//
// A GREEN RUN OF THIS SCRIPT PROVES NOTHING ON ITS OWN, WHICH IS WHY SECTION 1
// EXISTS
//
// "The loop stood nothing down" is trivially true of a loop that never stands
// anything down. So section 1 converges for real first — starts a wanted agent,
// stops an unwanted one, against a real MessageRouter — and only then does
// section 2 hand the same loop the same fleet with a failed read. Section 3
// then removes the guard from a copy of the built module and shows the fleet
// being torn down. The three together are the claim; any one alone is not.
//
// WHAT IS REAL HERE AND WHAT IS NOT — READ THIS BEFORE CITING THIS SCRIPT
//
// Real: the reconciler itself, `computeBoardDiff`, the real MessageRouter, the
// real HerdrBridge (initPty and all), the real WorkspaceRegistry with the real
// Atlassian integration registered, a real on-disk AgentRegistry, and — in §7 —
// the real capacity gate inside the real `handleActivateByKey`, refusing a real
// activation and producing its own refusal sentence.
//
// Faked: the `herdr` binary, by a shim on PATH that answers in herdr's own JSON
// shapes without spawning anything — so the census the router consults contains
// exactly the agents that were started.
//
// **Held still: the machine.** Capacity is injected rather than measured, and
// this is the fourth thing the script isolates rather than a convenience. herdr
// is a fake binary, `$HOME` is a temp directory, the registry is a scratch
// file — and capacity used to be read off whatever else the box was doing, so
// the verdict moved with the load. Reviewed on a machine at 2.88 of 4 cores,
// §1 was refused by the real gate and this script exited 1 with the product
// working perfectly (PR #89 review). It reproduced on the author's machine too.
//
// That is worse than an ordinary flaky test, for a reason specific to this
// file: §1 is what stops §2 being vacuous, so a §1 that fails environmentally
// invites the next reader to weaken or delete the one section that gives the
// rest of it meaning. `override: true` was considered as the fix and refused on
// review — it would have left §7 exercising a path every other section
// bypassed. Injection is the same move as the fake `herdr`: hold the
// environment still so the subject is the only variable.
//
// **Both fixtures go through the real `computeCapacity`.** Nothing here types
// out a capacity number or a refusal sentence; it states what the machine looks
// like and the product does the arithmetic. The real machine's figures are
// printed at startup, unused, so a reader can see what the verdict did not
// depend on.
//
// **Stubbed: the Jira read.** This script constructs the board's answers,
// because you cannot ask the real Atlassian to fail on cue. THAT IS A HOLE, AND
// IT IS THIS ONE: nothing here tests that the real `searchBoard` — real
// endpoint, real credential, real response shape — produces the input
// `computeBoardDiff` is fed below. A stub that agreed with a client that had
// drifted would leave both halves green and the loop dead. Who covers it:
// `daemon/scripts/report-board-convergence.mjs`, which runs the real query
// through the real credential against the live board and computes a real diff
// against the running daemon's real fleet. Its output is pasted in the PR. Run
// them as a pair; neither is the proof by itself.
//
// **The third seam, and it is not covered by a script at all:** that the
// daemon's own timer calls any of this. Both scripts construct a reconciler and
// call `reconcileOnce` by hand, so between them they could both be green while
// `boardReconciler.start()` was never wired into daemon.ts. That is covered by
// an observation rather than by a proof: a real `node dist/daemon.js`, run for
// 75 seconds under a temp `$HOME`, logs the startup line and then — at exactly
// +60s, from its own timer — a cycle that reaches this guard. Pasted in the PR.
//
// KAN-145 is why these three paragraphs exist. Two scripts asserted that the
// daemon carried `activatedBy` correctly, by constructing registry records that
// already had the field in them; neither exercised an activation *producing*
// one. `activatedBy` was null for every agent in production and both scripts
// stayed green. Nothing was wrong with either script. The gap was between them,
// and no script owned it — so this header names the edges of this one.
//
// Sections:
//
//   1. converge   — the loop starts what the board wants and stops what it does
//                   not. The fleet either side, from the real census.
//   2. guarded    — same fleet, Jira read fails: nothing started, nothing
//                   stopped, and the refusal names the failed read
//   3. guardless  — THE RED. The same scenario against a copy of the built
//                   module with the guard patched out, so a failed read yields
//                   an empty list the way it would have before: the fleet goes
//   4. partial    — a truncated search page is a failed read, not a small board
//   5. unresolved — a board row with no issue type starts nothing AND protects
//                   the agent on that key from stand-down
//   6. jurisdiction — agents a Jira query could never describe are left alone
//   7. capacity   — the REAL gate, on a stated full machine: it refuses, the
//                   loop reports the constraint in the gate's own words,
//                   retries next cycle, and never forces
//   8. partition  — the query is `assignee = currentUser()`, and only what it
//                   returned can ever be started
//
// Isolation is by $HOME: workspaces derive from os.homedir(), so a temp HOME
// keeps this run out of ~/.local/share/butchr entirely, and no real herdr —
// live or private — is ever contacted.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-board-reconciler-guard.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');

if (!fs.existsSync(path.join(distDir, 'board-reconcile.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`no build at ${distDir} — run \`npm run build\` in daemon/ first`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan221-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH. `agent start` remembers the agent so
// `agent get` / `agent list` — and through them the existence check the router
// confirms activations with — see exactly the agents that were started.
//
// `pane close` is the one that matters here and it is not decoration:
// `terminateSession` tears an agent down by resolving `agent get <name>` to a
// pane id and closing that pane, so a shim that answered `pane close` with an
// empty success would keep listing every agent it had ever started. The census
// would then show a fleet that stand-downs never touched — and sections 1 and 3
// would report "stopped: 3" over an unchanged fleet, which is exactly the
// failure-as-success shape this repository keeps re-learning. It is modelled
// properly instead: closing a pane forgets its agent, and the next `agent list`
// says so.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN221_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN221_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const read = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const write = (v) => fs.writeFileSync(startedFile, JSON.stringify(v, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const started = read();
const [a, b] = args;

// Pane ids are allocated from a counter that never rewinds, so a pane closed
// and an agent started later never share one — reusing ids would let a
// stand-down close somebody else's pane and the script would not notice.
const nextPaneFile = path.join(state, 'next-pane.json');
const nextPane = () => {
  const n = fs.existsSync(nextPaneFile) ? JSON.parse(fs.readFileSync(nextPaneFile, 'utf8')) : 100;
  fs.writeFileSync(nextPaneFile, JSON.stringify(n + 1));
  return String(n);
};

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane, cwd: found.cwd } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no such agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  const pane = nextPane();
  started.push({ name: args[2], cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1], pane });
  write(started);
  out({ result: { agent: { name: args[2], pane_id: pane } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'pane' && b === 'close') {
  const remaining = started.filter((s) => s.pane !== args[2]);
  if (remaining.length === started.length) {
    process.stderr.write(JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } }));
    process.exit(1);
  }
  write(remaining);
  out({ result: {} });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach does
} else if (a === 'tab' && b === 'create') {
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// ------------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry, isSupervisorType } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(path.join(distDir, 'integrations', 'enablement.js'));
const { computeCapacity, capacityRefusal, readCapacity, summarizeCapacity } = await import(
  path.join(distDir, 'capacity.js')
);

// ------------------------------------------------------- capacity, held still --
//
// The fourth thing this script isolates, and the one it used to leave to
// chance. herdr is a fake binary, `$HOME` is a temp directory, the registry is
// a scratch file — and capacity was still read off whatever the machine
// happened to be doing, so the verdict moved with the load. Reviewed on a box
// at 2.88 of 4 cores, §1 was refused by the real gate and this script exited 1
// with the product working perfectly (KAN-221, PR #89 review).
//
// Both fixtures are computed by the **real** `computeCapacity` from stated
// machine facts, so every number and every refusal sentence below is the
// product's own arithmetic — held still, not faked.
const GIB = 1024 * 1024 * 1024;

/** A machine with room to spare, for the sections that are not about capacity. */
const ROOMY_MACHINE = {
  cores: 16,
  totalBytes: Math.round(64 * GIB),
  availableBytes: Math.round(48 * GIB),
  load1: 0.4,
  busyCores: 0.4,
  busyWindowSeconds: 5
};

/** A machine with none, for §7, which is about exactly that. */
const FULL_MACHINE = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(0.2 * GIB),
  load1: 8,
  busyCores: 3.9,
  busyWindowSeconds: 5
};

/**
 * The knob the sections turn. One router is built with this as its capacity
 * source, so a section changes what the machine looks like without rebuilding
 * anything — and the **real** capacity gate runs either way, against facts it
 * was handed instead of facts it measured.
 */
let machineNow = ROOMY_MACHINE;
const capacitySource = (running, supervisors) =>
  computeCapacity(machineNow, running, { supervisorsRunning: supervisors });
const { boardPageFrom } = await import(path.join(distDir, 'jira.js'));
const {
  BoardReconciler,
  computeBoardDiff,
  BOARD_JQL
} = await import(path.join(distDir, 'board-reconcile.js'));

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration());
registry.setEnabled('jira', true);

const bridge = new HerdrBridge();
const router = new MessageRouter(
  registry,
  new PromptLoader(repoRoot),
  bridge,
  () => {},
  () => {},
  undefined,
  undefined,
  new AgentRegistry(path.join(scratch, 'agents.jsonl')),
  undefined,
  capacitySource
);

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(guardlessDist, { recursive: true, force: true });
}
process.on('exit', cleanup);

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

/** The fleet as the reconciler sees it, from the real census. */
const census = () =>
  router.surveyFleet().agents.map((agent) => ({
    agentName: agent.agentName,
    type: agent.type,
    key: router.recordedKeyFor(agent.agentName) ?? agent.key
  }));

const showFleet = (label) => {
  const fleet = census();
  console.log(`   ${label} (${fleet.length}):`);
  for (const agent of fleet.sort((a, b) => a.agentName.localeCompare(b.agentName))) {
    console.log(`     ${agent.type}/${agent.key}`);
  }
  return fleet;
};

/**
 * Put an agent up outside the loop, so the loop meets a fleet it did not build.
 *
 * No `override: true`. It used to carry one, which was defensible while
 * capacity was the machine's and staging could be refused by an unrelated
 * build running next door — but with the gate held still there is nothing to
 * override, and a proof whose setup bypasses the gate is one edit away from a
 * proof whose subject does. Review refused `override` as the fix for §1 for
 * the same reason; leaving it in the staging path would have kept the smell
 * without the excuse.
 */
async function preexisting(type, key) {
  let response;
  await router.handleActivateByKey(
    { type, key, defaultAgent: 'claude' },
    (msg) => { response = msg; }
  );
  if (response?.success !== true) {
    console.error(`could not stage ${type}/${key}: ${response?.error}`);
    process.exit(1); // setup guard: the sections below cannot mean anything
  }
}

/**
 * Stage exactly this fleet, whatever is running now.
 *
 * Every section says outright what it starts from rather than inheriting the
 * last one's leftovers. Two sections deliberately tear the fleet down, so
 * threading state between them would make a later section's verdict depend on
 * an earlier section's outcome — and a proof whose sections cannot fail
 * independently reports the first failure eight times.
 */
async function stageFleet(agents) {
  for (const agent of census()) {
    router.handleDeactivateByKey({ type: agent.type ?? undefined, key: agent.key }, () => {});
  }
  const left = census();
  if (left.length) {
    console.error(`could not clear the fleet; ${left.length} agent(s) remain`);
    process.exit(1); // setup guard
  }
  for (const [type, key] of agents) await preexisting(type, key);
}

const issue = (key, issueTypeName, statusName = 'In Progress') => ({
  key,
  issueTypeName,
  statusName
});

/** A reconciler wired to the real router, with the board's answer supplied. */
function reconciler(boardAnswer, opts = {}) {
  return new (opts.Class ?? BoardReconciler)({
    jira: { searchBoard: async () => boardAnswer },
    runningAgents: opts.runningAgents ?? census,
    activate: opts.activate ?? (async (agent) => {
      let response;
      await router.handleActivateByKey(
        { type: agent.type, key: agent.key, defaultAgent: 'claude' },
        (msg) => { response = msg; }
      );
      return {
        success: response?.success === true,
        ...(response?.error ? { error: response.error } : {}),
        ...(response?.refusedBy ? { refusedBy: response.refusedBy } : {})
      };
    }),
    deactivate: opts.deactivate ?? (async (agent) => {
      let response;
      router.handleDeactivateByKey(
        { type: agent.type ?? undefined, key: agent.key },
        (msg) => { response = msg; }
      );
      return { success: response?.success === true, ...(response?.error ? { error: response.error } : {}) };
    }),
    mode: () => opts.mode ?? 'converge',
    isSupervisorType,
    log: opts.quiet ? () => {} : (...args) => console.log('    ', ...args),
    startStaggerMs: 0
  });
}

// ------------------------------------------------ 3's build, prepared early --
//
// A copy of the built module with the guard patched out — the pre-guard
// behaviour the ticket describes, reconstructed exactly: "a failed query and a
// genuinely empty board produce the same empty list". Two replacements, each
// asserted to have matched exactly once, so a refactor that moved the guard
// makes this section fail loudly rather than silently prove nothing.
//
// The copy lives inside daemon/ so its relative imports and node_modules still
// resolve; it is removed on exit.
const guardlessDist = path.join(daemonDir, `dist-guardless-${process.pid}`);
fs.cpSync(distDir, guardlessDist, { recursive: true });
const guardlessFile = path.join(guardlessDist, 'board-reconcile.js');
let guardlessSource = fs.readFileSync(guardlessFile, 'utf8');
const patches = [
  ['if (!outcome.ok) {', 'if (false) {'],
  ['computeBoardDiff(outcome.issues, running)', 'computeBoardDiff(outcome.issues ?? [], running)']
];
const patchReport = [];
for (const [from, to] of patches) {
  const hits = guardlessSource.split(from).length - 1;
  patchReport.push({ from, hits });
  guardlessSource = guardlessSource.split(from).join(to);
}
fs.writeFileSync(guardlessFile, guardlessSource);
const patchesApplied = patchReport.every((p) => p.hits === 1);
const { BoardReconciler: GuardlessReconciler } = await import(guardlessFile);

console.log(`fake herdr: ${path.join(shimDir, 'herdr')}`);
console.log(`HOME for this run: ${fakeHome}`);
console.log(`guardless build: ${guardlessDist}`);

// The machine this run is actually on, printed and then deliberately not used.
// It is here so a reader can see for themselves that the verdict below did not
// depend on it: this script was reviewed on a box where the real gate refused
// §1 and the script exited 1 with the product working perfectly, and the
// numbers on this line are what that would have been decided from.
const realHere = readCapacity(0, 0);
console.log(
  `\nthe real machine, for reference only — no section below consults it:\n` +
  `  ${summarizeCapacity(realHere)}\n` +
  `  (§1–§6 run against a stated 16-core machine, §7 against a stated full one;\n` +
  `   both are computed by the real capacity model from facts this file states.)`
);

// ------------------------------------------------------------ 1. converge --

rule('1. CONVERGE — the loop starts what the board wants and stops what it does not');

await stageFleet([['epic', 'KAN-902'], ['task', 'KAN-903']]);
const before1 = showFleet('fleet before');

const board1 = {
  ok: true,
  issues: [issue('KAN-901', 'Task'), issue('KAN-902', 'Epic')]
};
console.log(`\n   board says: ${board1.issues.map((i) => `${i.key}(${i.issueTypeName})`).join(', ')}\n`);

const cycle1 = await reconciler(board1).reconcileOnce();
const after1 = showFleet('\n   fleet after');

const names1 = new Set(after1.map((a) => a.agentName));
verdict(
  cycle1.converged === true &&
    names1.has(agentNameFor('task', 'KAN-901')) &&
    names1.has(agentNameFor('epic', 'KAN-902')) &&
    !names1.has(agentNameFor('task', 'KAN-903')) &&
    before1.length === 2 && after1.length === 2,
  'the loop converged: task/KAN-901 started, task/KAN-903 stood down, epic/KAN-902 left alone. ' +
    'It can start and it can stop — which is what makes section 2 mean something.',
  'the loop did not converge, so nothing below can distinguish a working guard from a loop that never acts'
);

// ------------------------------------------------------------- 2. guarded --

rule('2. GUARDED — the same fleet, and a Jira read that failed');

await stageFleet([['epic', 'KAN-902'], ['task', 'KAN-901'], ['task', 'KAN-903']]);
const before2 = showFleet('fleet before');
const failedRead = {
  ok: false,
  backOff: true,
  status: 503,
  error: 'board search returned HTTP 503'
};
console.log(`\n   board answers: ${JSON.stringify(failedRead)}\n`);

const cycle2 = await reconciler(failedRead).reconcileOnce();
const after2 = showFleet('\n   fleet after');

console.log(`\n   refusal: ${JSON.stringify(cycle2.refusal)}`);
console.log(`   started: ${cycle2.started.length}   stopped: ${cycle2.stopped.length}   diff: ${cycle2.diff}`);

verdict(
  cycle2.refusal?.reason === 'jira-read-failed' &&
    cycle2.started.length === 0 &&
    cycle2.stopped.length === 0 &&
    cycle2.diff === null &&
    cycle2.converged === false &&
    after2.length === before2.length,
  `the read failed, the loop converged nothing, and all ${after2.length} agent(s) are still running`,
  'a failed Jira read moved the fleet — this is the unrecoverable failure this ticket exists to prevent'
);

// ----------------------------------------------------------- 3. guardless --

rule('3. GUARDLESS — THE RED: the same failed read, with the guard patched out');

console.log('   patches applied to the built module:');
for (const p of patchReport) console.log(`     ${p.hits} × ${JSON.stringify(p.from)}`);

await stageFleet([['epic', 'KAN-902'], ['task', 'KAN-901'], ['task', 'KAN-903']]);
const before3 = showFleet('\n   fleet before');
const cycle3 = await reconciler(failedRead, { Class: GuardlessReconciler, quiet: true }).reconcileOnce();
const after3 = showFleet('\n   fleet after');

console.log(`\n   started: ${cycle3.started.length}   stopped: ${cycle3.stopped.length}`);

verdict(
  patchesApplied &&
    cycle3.stopped.length === before3.length &&
    after3.length === 0,
  `without the guard the identical failed read tore down all ${before3.length} agent(s) — ` +
    `that is what section 2 is preventing, watched rather than asserted`,
  patchesApplied
    ? 'the guardless build did not tear the fleet down, so section 2 proves nothing about the guard'
    : `the guard could not be located in the built module (${JSON.stringify(patchReport)}) — ` +
      'this section did not test what it claims to'
);

// ------------------------------------------------------------- 4. partial --

rule('4. PARTIAL — a truncated search page is a failed read, not a small board');

const truncated = boardPageFrom(
  { issues: [{ key: 'KAN-902', fields: { status: { name: 'In Progress' }, issuetype: { name: 'Epic' } } }] },
  1
);
const explicitlyLast = boardPageFrom(
  { isLast: true, issues: [{ key: 'KAN-902', fields: { status: { name: 'In Progress' }, issuetype: { name: 'Epic' } } }] },
  100
);
const tokenCarrying = boardPageFrom(
  { nextPageToken: 'more', issues: [{ key: 'KAN-902', fields: { issuetype: { name: 'Epic' } } }] },
  100
);

console.log(`   one row, asked for 1, no isLast → complete: ${truncated.complete}`);
console.log(`   one row, isLast: true          → complete: ${explicitlyLast.complete}`);
console.log(`   one row, nextPageToken present → complete: ${tokenCarrying.complete}`);

await stageFleet([['epic', 'KAN-902'], ['task', 'KAN-903']]);
const before4 = showFleet('\n   fleet before');
const cycle4 = await reconciler({
  ok: false,
  backOff: false,
  error: 'the board search returned a partial page (1 issue(s), asked for up to 1, and Jira did not say that was all of them)'
}).reconcileOnce();
const after4 = showFleet('\n   fleet after');

verdict(
  truncated.complete === false &&
    explicitlyLast.complete === true &&
    tokenCarrying.complete === false &&
    cycle4.stopped.length === 0 &&
    after4.length === before4.length,
  'a page Jira did not declare complete reads as incomplete, and an incomplete page stands nothing down',
  'a partial page was treated as the whole board — every agent whose ticket fell off the page would be stood down'
);

// ---------------------------------------------------------- 5. unresolved --

rule('5. UNRESOLVED — an unknown issue type starts nothing and kills nothing');

await stageFleet([['epic', 'KAN-902'], ['task', 'KAN-903']]);
const before5 = showFleet('fleet before');
const board5 = {
  ok: true,
  issues: [
    issue('KAN-902', 'Epic'),
    // KAN-903 is on the board and its agent is running, but the row carries no
    // type. The pre-KAN-196 reflex is to call it a `task` and carry on.
    { key: 'KAN-903', issueTypeName: null, statusName: 'In Progress' },
    { key: 'KAN-904', issueTypeName: 'Epicc', statusName: 'In Progress' }
  ]
};
const diff5 = computeBoardDiff(board5.issues, before5);
console.log(`\n   unresolved rows: ${JSON.stringify(diff5.unresolved.map((u) => u.key))}`);
console.log(`   would start:     ${JSON.stringify(diff5.toStart.map((a) => `${a.type}/${a.key}`))}`);
console.log(`   would stop:      ${JSON.stringify(diff5.toStop.map((a) => `${a.type}/${a.key}`))}`);
console.log(`   spared:          ${JSON.stringify(diff5.protectedByUnresolved.map((a) => `${a.type}/${a.key}`))}`);

const cycle5 = await reconciler(board5, { quiet: true }).reconcileOnce();
const after5 = showFleet('\n   fleet after');

verdict(
  diff5.unresolved.length === 2 &&
    diff5.toStart.length === 0 &&
    diff5.toStop.length === 0 &&
    diff5.protectedByUnresolved.some((a) => a.key === 'KAN-903') &&
    after5.length === before5.length &&
    cycle5.started.length === 0,
  'a row with no resolvable type started nothing, and the agent on that key was spared rather than stopped',
  'an unresolvable issue type was guessed at or turned into a stand-down — KAN-196 on a timer'
);

// -------------------------------------------------------- 6. jurisdiction --

rule('6. JURISDICTION — what a Jira query could never describe is left alone');

await stageFleet([['epic', 'KAN-902'], ['confluence', '123456789'], ['task', 'scratch']]);
const before6 = showFleet('fleet before');

// The board mentions neither the Confluence agent nor anything else here.
const board6 = { ok: true, issues: [issue('KAN-902', 'Epic')] };
const diff6 = computeBoardDiff(board6.issues, before6);
console.log(`\n   outside jurisdiction: ${JSON.stringify(diff6.outOfJurisdiction.map((a) => `${a.type}/${a.key}`))}`);
console.log(`   would stop:           ${JSON.stringify(diff6.toStop.map((a) => `${a.type}/${a.key}`))}`);

const cycle6 = await reconciler(board6, { quiet: true }).reconcileOnce();
const after6 = showFleet('\n   fleet after');
const names6 = new Set(after6.map((a) => a.agentName));

verdict(
  diff6.outOfJurisdiction.some((a) => a.type === 'confluence') &&
    !diff6.toStop.some((a) => a.type === 'confluence') &&
    names6.has(agentNameFor('confluence', '123456789')) &&
    cycle6.stopped.every((s) => s.agent.type !== 'confluence'),
  'the Confluence agent survived a board that never mentioned it — a Jira issue search cannot ' +
    'express its desired state, so this loop has no opinion about it',
  'an agent this query is incapable of describing was stood down for not appearing in it'
);

// ------------------------------------------------------------ 7. capacity --

rule('7. CAPACITY — the real gate, on a machine with no room: reported and retried, never forced');

// The one section where capacity IS the subject, so it gets the real gate
// rather than a stubbed answer. The machine it runs against is stated rather
// than measured — that is the whole point of the change this section motivated
// — but everything downstream of the facts is the product: the real
// `capacityGate` inside the real `handleActivateByKey`, refusing a real
// activation, and the refusal sentence built by the real `capacityRefusal`
// from the real `computeCapacity`.
//
// This is strictly stronger than what stood here before, which handed the
// reconciler a refusal this script had constructed. That version could not
// have told a working gate from a reconciler being fed a sentence; this one
// exercises the gate producing it.

await stageFleet([['epic', 'KAN-902']]);
machineNow = FULL_MACHINE;

const fullCapacity = capacitySource(1, 1);
console.log(`   stated machine: ${FULL_MACHINE.cores} cores, ${FULL_MACHINE.busyCores} in use, ` +
  `${(FULL_MACHINE.availableBytes / GIB).toFixed(1)} GiB available`);
console.log(`   the real model says: atCapacity=${fullCapacity.atCapacity} headroom=${fullCapacity.headroom} ` +
  `(bound by ${fullCapacity.headroomBoundBy})`);

const attempts = [];
const capped = reconciler(
  { ok: true, issues: [issue('KAN-902', 'Epic'), issue('KAN-905', 'Task')] },
  {
    quiet: true,
    // The real activate path — no stub. `attempts` only records what the loop
    // asked for; whether it succeeds is the gate's answer, not this script's.
    activate: async (agent) => {
      attempts.push(agent);
      let response;
      await router.handleActivateByKey(
        { type: agent.type, key: agent.key, defaultAgent: 'claude' },
        (msg) => { response = msg; }
      );
      return {
        success: response?.success === true,
        ...(response?.error ? { error: response.error } : {}),
        ...(response?.refusedBy ? { refusedBy: response.refusedBy } : {})
      };
    }
  }
);

const cycle7a = await capped.reconcileOnce();
const cycle7b = await capped.reconcileOnce();

const refusal = cycle7a.started[0]?.outcome;
const refusedBy = refusal?.refusedBy;
const sentence = refusal?.error ?? '';
// The same sentence the gate would have produced, rebuilt here independently.
// Equality is the check that the loop reported the gate's words rather than a
// paraphrase of its own.
const expected = capacityRefusal(capacitySource(1, 1), 'task/KAN-905');

const source = fs.readFileSync(path.join(distDir, 'board-reconcile.js'), 'utf8');
const forces = /override\s*:\s*true|preempt\s*:\s*true/.test(source);
const stillRunning = new Set(census().map((a) => a.agentName));

console.log(`\n   what the loop tried, cycle 1: ${attempts.slice(0, 1).map((a) => `${a.type}/${a.key}`)}`);
console.log(`   what the loop tried, cycle 2: ${attempts.slice(1).map((a) => `${a.type}/${a.key}`)}`);
console.log(`   the gate refused it:          ${refusedBy === 'capacity'}`);
console.log(`   reported in the gate's words: ${sentence.startsWith(expected.split('\n')[0])}`);
console.log(`   the built module can override/preempt: ${forces}`);
console.log(`\n   the refusal the loop passed on:\n${sentence.replace(/^/gm, '       ')}`);

verdict(
  attempts.length === 2 &&
    attempts.every((a) => a.key === 'KAN-905') &&
    refusedBy === 'capacity' &&
    sentence.includes('Refusing to activate task/KAN-905') &&
    sentence.startsWith(expected.split('\n')[0]) &&
    !stillRunning.has(agentNameFor('task', 'KAN-905')) &&
    cycle7a.stopped.length === 0 &&
    !forces,
  'the real gate refused it, the loop reported the binding constraint in the gate\'s own words, ' +
    'the agent stayed desired and was tried again next cycle, nothing was queued, and the loop ' +
    'has no way to override or preempt',
  'a refused agent was dropped, forced, silently swallowed, or started anyway'
);

machineNow = ROOMY_MACHINE;

// ----------------------------------------------------------- 8. partition --

rule('8. PARTITION — the query is per account, and only what it returned can start');

console.log(`   BOARD_JQL: ${BOARD_JQL}`);

// A ticket assigned to another account is In Progress on somebody's board and
// simply absent from this query's answer. There is no second path by which the
// loop could learn of it: `toStart` is derived from the returned rows alone.
const board8 = { ok: true, issues: [issue('KAN-902', 'Epic')] };
const diff8 = computeBoardDiff(board8.issues, census());
console.log(`   the answer held ${board8.issues.length} row(s); toStart derives from those rows only.`);
console.log(`   would start: ${JSON.stringify(diff8.toStart.map((a) => `${a.type}/${a.key}`))}`);

verdict(
  BOARD_JQL.includes('assignee = currentUser()') &&
    diff8.toStart.every((agent) => board8.issues.some((i) => i.key === agent.key)),
  'the partition is the query itself: every started agent traces to a row this account\'s query ' +
    'returned, and a ticket assigned elsewhere never appears in one',
  'the loop could start an agent for an issue its own query did not return'
);

// ------------------------------------------------------------------ verdict --

rule(failures ? `${failures} SECTION(S) FAILED` : 'ALL SECTIONS PASSED');
process.exit(failures ? 1 : 0);
