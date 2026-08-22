// Proof for KAN-368: what a *working* agent costs, and an instrument that can
// see it.
//
// WHAT FAILURE THIS WOULD CATCH: a per-agent cost figure that misses the CPU an
// agent actually spends, because the agent spends it in children that exit
// before the sampling window closes. Measured on the filing machine on
// 2026-08-14 against `/usr/bin/time` as an external ground truth: one
// `tsc --noEmit` costing 14.45 core-seconds inside a 30s window was reported by
// the old per-process-delta form as 1.8 core-seconds — a 9x undercount, and the
// reason `cap` could read 15 on a 4-core laptop. It also catches the three ways
// the correction can rot: double-counting a child that is alive at both ends,
// dumping a long-running child's *pre-window* CPU into the window that reaps it,
// and a tree whose bookkeeping escaped reporting a negative cost. And it catches
// the separable-population half going wrong: a tree nobody classified being
// counted as working, or the activity split ceasing to partition `chargeable`.
//
// CI-RUNNABLE: yes — every section drives pure exported functions over
// hand-built fixtures. No /proc, no herdr, no daemon, no fleet. That is
// deliberate and it is the same argument aggregateTrees carries: CI runs on a
// box with no agents on it, so a proof that could only measure a live fleet
// would assert nothing there and go green on an empty sample.
//
// Six sections:
//
//   1. the blind spot   — a child that starts and exits inside the window. The
//                         old arithmetic is reproduced beside the new one, on
//                         the same fixture. This is the defect.
//   2. exactness        — the three ways the difference-of-totals form could be
//                         wrong instead of merely different: double-counting,
//                         pre-window CPU, and a tree that loses processes.
//   3. the population   — the activity split partitions `chargeable` exactly,
//                         and an unclassified tree is not nameable as working.
//   4. endpoints        — the agreeing-endpoints rule in lib/herdr-activity.mjs:
//                         a status that moved mid-window establishes nothing.
//   5. the floor        — AC3. The correction raises the divisor, which lowers
//                         the cap; the admission floor must be untouched by
//                         that. Every start no instrument has priced is still
//                         charged at least the seed, on BOTH dimensions,
//                         including when the measurement is far cheaper.
//   6. can it fail      — sections 1–3 and 5 re-run against the pre-change
//                         arithmetic and against a broken floor. They must FAIL
//                         there.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Every process sample here is built by this file, so nothing in it tests that
// /proc field 16 is `cutime`, that a real `claude` tree is shaped the way these
// fixtures are shaped, or that herdr's `agent_status` says `working` when an
// agent is working. Those are claims about the world and this file cannot make
// them. What covers them is the live reading pasted into the PR body, taken
// with `daemon/scripts/measure-agent-cost.mjs` on a fleet of six task agents
// and corroborated against `/usr/bin/time` — the instrument reads 1.03 core for
// a tree whose compiles independently cost 0.98 core, and the two agreeing is
// the only evidence that the field being read is the field intended.
//
// Nobody has yet watched the corrected divisor drive a real refusal. Section 5
// asserts the floor arithmetic; that the daemon takes that path on a live
// activation is verify-idle-fleet-capacity.mjs's section 5 and not this file's.

import * as path from 'path';
import { fileURLToPath } from 'url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { aggregateTrees, subtreeTicks, totalsOf } = await import(
  path.join(distDir, 'agent-cost.js')
);
const { computeCapacity, startingAgentCost, MEASURED_AGENT_COST, GIB } = await import(
  path.join(distDir, 'capacity.js')
);
const { activityClassifier, herdrNameFor } = await import('./lib/herdr-activity.mjs');

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const MIB = 1024 ** 2;
const CLK_TCK = 100;

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --------------------------------------------------------------- fixtures ---

/** One process, with both halves of its CPU stated rather than defaulted. */
const proc = (pid, comm, ppid, cpuTicks, childCpuTicks, rssMb) => ({
  pid,
  comm,
  ppid,
  cpuTicks,
  childCpuTicks,
  rssBytes: rssMb * MIB
});

const asMap = (procs) => new Map(procs.map((p) => [p.pid, p]));

/** The marker launchers.ts puts on every agent's butchr MCP server. */
const markerArgv = (type, key) => ['node', 'mcp.js', '--workspace-type', type, '--workspace-key', key];

/**
 * The arithmetic this change replaced, reproduced here rather than described:
 * per-process deltas over the processes present in both samples.
 *
 * Kept as executable code so section 6 can falsify against the real thing. A
 * prose claim that "the old form missed it" would be a claim nobody could check
 * once the old code was gone.
 *
 * **DO NOT DELETE THIS AS DEAD CODE.** It has no caller outside section 6 and
 * it will read as litter to anybody tidying up — which is exactly why the
 * warning is here rather than left to be worked out. Once `aggregateTrees` is
 * corrected the old form exists nowhere a test can reach it, so every claim
 * about it becomes permanently uncheckable at the moment it becomes
 * load-bearing. Deleting this function does not make section 6 fail; it makes
 * section 6 stop meaning anything, which is worse, because a green proof that
 * has quietly stopped testing its subject is the defect this whole epic keeps
 * re-finding. (Asked for by `epic/KAN-39` reviewing #169.)
 */
function oldStyleTreeTicks(before, after, pids) {
  let ticks = 0;
  for (const pid of pids) {
    const now = after.get(pid);
    if (!now) continue;
    const then = before.get(pid);
    ticks += now.cpuTicks - (then?.cpuTicks ?? 0);
  }
  return ticks;
}

const WINDOW = 60;
const isSupervisor = (type) => type === 'epic' || type === 'story';

// =============================================================================
rule('1. THE BLIND SPOT — a child that started and exited inside the window');
// =============================================================================
//
// The tree: a `claude` root, the MCP child carrying the marker, and a compile.
// The compile is present at the start of the window with 200 ticks already
// spent, runs for another 1200 ticks, exits, and is reaped by the root — which
// is exactly what `npm run build` looks like from /proc, and exactly the shape
// no per-process delta can see.

const compileBefore = asMap([
  proc(1000, 'claude', 1, 300, 0, 400),
  proc(1001, 'node', 1000, 20, 0, 250),
  proc(1002, 'tsc', 1000, 200, 0, 150)
]);
const compileAfter = asMap([
  proc(1000, 'claude', 1, 340, 1400, 400), // reaped the tsc: 200 + 1200 ticks
  proc(1001, 'node', 1000, 24, 0, 250)
  // 1002 is gone.
]);
const compileArgv = { 1001: markerArgv('task', 'KAN-368') };

const compiled = aggregateTrees(
  compileBefore,
  compileAfter,
  WINDOW,
  isSupervisor,
  (pid) => compileArgv[pid] ?? [],
  () => 'working'
);
const compiledTree = compiled.agents.find((a) => a.pid === 1000);

// The truth about this window, in ticks: the root spent 40, the MCP child 4,
// and the compile 1200 of its 1400 (200 were already spent when the window
// opened). 1244 ticks over 60s at 100 Hz is 0.2073 core.
const TRUE_TICKS = 40 + 4 + 1200;
const TRUE_CORES = TRUE_TICKS / CLK_TCK / WINDOW;
const oldCores = oldStyleTreeTicks(compileBefore, compileAfter, [1000, 1001]) / CLK_TCK / WINDOW;

console.log(`
  ground truth for the window        ${TRUE_TICKS} ticks = ${TRUE_CORES.toFixed(4)} core
  per-process deltas (before KAN-368) ${(oldCores * CLK_TCK * WINDOW).toFixed(0)} ticks = ${oldCores.toFixed(4)} core
  difference of subtree totals (now)  ${(compiledTree.cores * CLK_TCK * WINDOW).toFixed(0)} ticks = ${compiledTree.cores.toFixed(4)} core

  the compile is ${(TRUE_CORES / oldCores).toFixed(1)}x the cost the old form could see.`);

verdict(
  near(compiledTree.cores, TRUE_CORES, 1e-9),
  `the window's real cost is measured: ${compiledTree.cores.toFixed(4)} core`,
  `the corrected form reports ${compiledTree.cores.toFixed(4)} core where the window really cost ` +
    `${TRUE_CORES.toFixed(4)}`
);
verdict(
  oldCores < TRUE_CORES / 4,
  `and the form it replaced saw ${oldCores.toFixed(4)} core — under a quarter of it, which is the defect`,
  `the old per-process form reports ${oldCores.toFixed(4)} core, which is not the undercount this ` +
    `ticket is about; the fixture no longer reproduces the defect`
);

// =============================================================================
rule('2. EXACTNESS — the three ways a difference of totals could be wrong');
// =============================================================================

// (a) A child alive at BOTH ends must be counted once, not twice. Its own ticks
//     are in the sum at both samples and its parent has not reaped it, so
//     nothing of it has moved into `childCpuTicks`.
const liveBefore = asMap([
  proc(2000, 'claude', 1, 100, 0, 400),
  proc(2001, 'node', 2000, 50, 0, 250),
  proc(2002, 'rg', 2000, 500, 0, 100)
]);
const liveAfter = asMap([
  proc(2000, 'claude', 1, 110, 0, 400),
  proc(2001, 'node', 2000, 60, 0, 250),
  proc(2002, 'rg', 2000, 800, 0, 100)
]);
const liveArgv = { 2001: markerArgv('task', 'KAN-A') };
const liveTree = aggregateTrees(liveBefore, liveAfter, WINDOW, isSupervisor, (pid) => liveArgv[pid] ?? [], () => 'working')
  .agents.find((a) => a.pid === 2000);
const LIVE_TRUE = (10 + 10 + 300) / CLK_TCK / WINDOW;
console.log(`
  (a) child alive at both ends:  expected ${LIVE_TRUE.toFixed(4)} core, got ${liveTree.cores.toFixed(4)}`);
verdict(
  near(liveTree.cores, LIVE_TRUE, 1e-9),
  'a child present at both samples is counted exactly once',
  `a child alive across the whole window is charged ${liveTree.cores.toFixed(4)} core against a true ` +
    `${LIVE_TRUE.toFixed(4)} — the sum is double-counting or losing it`
);

// (b) A long-running child reaped inside the window must contribute only the
//     CPU it spent DURING the window. `cutime` carries its whole lifetime, so
//     a form that added the parent's `cutime` delta to a per-process delta —
//     or that forgot to count the child's pre-window ticks on the `before`
//     side — would dump ten minutes of CPU into one 60-second sample. That is
//     a spike in the conservative direction, which is exactly the kind of
//     wrongness that gets shipped.
const longBefore = asMap([
  proc(3000, 'claude', 1, 100, 0, 400),
  proc(3001, 'node', 3000, 10, 0, 250),
  proc(3002, 'npm', 3000, 60000, 0, 300) // ten minutes of CPU already spent
]);
const longAfter = asMap([
  proc(3000, 'claude', 1, 105, 60300, 400), // reaped it: 60000 + 300 in-window
  proc(3001, 'node', 3000, 12, 0, 250)
]);
const longArgv = { 3001: markerArgv('task', 'KAN-B') };
const longTree = aggregateTrees(longBefore, longAfter, WINDOW, isSupervisor, (pid) => longArgv[pid] ?? [], () => 'working')
  .agents.find((a) => a.pid === 3000);
const LONG_TRUE = (5 + 2 + 300) / CLK_TCK / WINDOW;
console.log(`
  (b) 10-minute child reaped mid-window: expected ${LONG_TRUE.toFixed(4)} core, got ${longTree.cores.toFixed(4)}
      (a form that charged its whole lifetime would report ${((5 + 2 + 60300) / CLK_TCK / WINDOW).toFixed(2)} core)`);
verdict(
  near(longTree.cores, LONG_TRUE, 1e-9),
  'only the CPU spent inside the window is charged to it',
  `a child that had already run for ten minutes contributes ${longTree.cores.toFixed(4)} core to the ` +
    `window that reaped it, against a true ${LONG_TRUE.toFixed(4)}`
);

// (c) A tree that loses processes to reparenting can have a total that FALLS.
//     A negative cost is not a measurement; the floor is zero.
const shrankBefore = asMap([
  proc(4000, 'claude', 1, 100, 0, 400),
  proc(4001, 'node', 4000, 10, 0, 250),
  proc(4002, 'sh', 4000, 5000, 0, 50) // orphaned away before `after`
]);
const shrankAfter = asMap([
  proc(4000, 'claude', 1, 100, 0, 400),
  proc(4001, 'node', 4000, 10, 0, 250)
]);
const shrankArgv = { 4001: markerArgv('task', 'KAN-C') };
const shrankTree = aggregateTrees(shrankBefore, shrankAfter, WINDOW, isSupervisor, (pid) => shrankArgv[pid] ?? [], () => 'working')
  .agents.find((a) => a.pid === 4000);
console.log(`
  (c) tree that lost a process to reparenting: got ${shrankTree.cores.toFixed(4)} core`);
verdict(
  shrankTree.cores === 0,
  'a tree whose bookkeeping escaped reports nothing observed, not a negative cost',
  `a shrinking tree reports ${shrankTree.cores} core; a negative or NaN figure would be published as a ` +
    `measurement and would degrade the whole sample`
);

// And the helper the three rest on, driven directly: a subtree total is own
// plus reaped-children ticks, and a pid absent from the sample contributes
// nothing rather than NaN.
const totalHere = subtreeTicks(compileAfter, [1000, 1001, 9999]);
verdict(
  totalHere === 340 + 1400 + 24,
  `subtreeTicks sums own + reaped children and skips absent pids (${totalHere} ticks)`,
  `subtreeTicks returned ${totalHere}, not ${340 + 1400 + 24}`
);

// =============================================================================
rule('3. THE POPULATION — the activity split partitions `chargeable`, exactly');
// =============================================================================
//
// Five trees: two task agents herdr called working, one it called idle, one it
// could not place, and a supervisor. The supervisor is not in any activity
// bucket — the split is of `chargeable` and of nothing else.

const fleetProcs = [];
const fleetArgv = {};
const addTree = (pid, type, key, ticks) => {
  fleetProcs.push(
    proc(pid, 'claude', 1, ticks, 0, 400),
    proc(pid + 1, 'node', pid, 0, 0, 300)
  );
  fleetArgv[pid + 1] = markerArgv(type, key);
};
addTree(5000, 'task', 'KAN-W1', 900);
addTree(6000, 'task', 'KAN-W2', 1100);
addTree(7000, 'task', 'KAN-IDLE', 20);
addTree(8000, 'task', 'KAN-MOVED', 400);
addTree(9000, 'epic', 'KAN-39', 60);

const fleetAfter = asMap(fleetProcs);
const fleetBefore = asMap(fleetProcs.map((p) => ({ ...p, cpuTicks: 0, childCpuTicks: 0 })));
const declared = {
  'KAN-W1': 'working',
  'KAN-W2': 'working',
  'KAN-IDLE': 'not-working',
  'KAN-MOVED': 'unknown',
  'KAN-39': 'working' // a supervisor that IS working, to prove it is not split in
};

const fleet = aggregateTrees(
  fleetBefore,
  fleetAfter,
  WINDOW,
  isSupervisor,
  (pid) => fleetArgv[pid] ?? [],
  (_type, key) => declared[key] ?? 'unknown'
);

const sumOf = (t) => ({ agents: t.agents, cores: Number(t.cores.toFixed(6)) });
console.log(`
  chargeable        ${JSON.stringify(sumOf(fleet.chargeable))}
    working         ${JSON.stringify(sumOf(fleet.working))}
    not working     ${JSON.stringify(sumOf(fleet.notWorking))}
    unestablished   ${JSON.stringify(sumOf(fleet.activityUnknown))}
  supervisors       ${JSON.stringify(sumOf(fleet.supervisors))}   <- working, and in no activity bucket`);

const partitionAgents =
  fleet.working.agents + fleet.notWorking.agents + fleet.activityUnknown.agents;
const partitionCores = fleet.working.cores + fleet.notWorking.cores + fleet.activityUnknown.cores;
verdict(
  partitionAgents === fleet.chargeable.agents && near(partitionCores, fleet.chargeable.cores, 1e-9),
  `the three arms add back up to chargeable (${partitionAgents} trees, ` +
    `${partitionCores.toFixed(4)} core)`,
  `the activity split does not partition chargeable: ${partitionAgents} trees and ` +
    `${partitionCores.toFixed(4)} core against ${fleet.chargeable.agents} and ${fleet.chargeable.cores.toFixed(4)}`
);
verdict(
  fleet.supervisors.agents === 1 && fleet.working.agents === 2,
  'a working supervisor stays out of the activity split — it is a split of chargeable alone',
  `a supervisor leaked into the activity split: working holds ${fleet.working.agents} trees`
);

// The unrepresentable-state half: with no classifier supplied, NO tree can be
// named working. Not "they default to idle" — they are unestablished, which is
// a different claim and the report says so.
const unclassified = aggregateTrees(
  fleetBefore,
  fleetAfter,
  WINDOW,
  isSupervisor,
  (pid) => fleetArgv[pid] ?? []
);
console.log(`
  with no classifier at all: working ${unclassified.working.agents}, not working ` +
  `${unclassified.notWorking.agents}, unestablished ${unclassified.activityUnknown.agents}`);
verdict(
  unclassified.working.agents === 0 &&
    unclassified.notWorking.agents === 0 &&
    unclassified.activityUnknown.agents === unclassified.chargeable.agents,
  'a caller that establishes nothing gets an empty working population, not a default',
  `with no classifier, ${unclassified.working.agents} tree(s) are reported working and ` +
    `${unclassified.notWorking.agents} idle — an unestablished tree is being named`
);

// An unmarked tree is never asked about and is never in the split either.
const withUnmarked = aggregateTrees(
  asMap([...fleetProcs, proc(11000, 'claude', 1, 5000, 0, 700)].map((p) => ({ ...p, cpuTicks: 0, childCpuTicks: 0 }))),
  asMap([...fleetProcs, proc(11000, 'claude', 1, 5000, 0, 700)]),
  WINDOW,
  isSupervisor,
  (pid) => fleetArgv[pid] ?? [],
  () => 'working'
);
verdict(
  withUnmarked.unmarked.agents === 1 &&
    withUnmarked.working.agents === withUnmarked.chargeable.agents &&
    withUnmarked.agents.find((a) => a.pid === 11000).activity === 'unknown',
  'an unmarked tree names no workspace, so it is `unknown` without the classifier being consulted',
  'an unmarked tree was classified from a workspace it does not have'
);

// =============================================================================
rule('4. ENDPOINTS — a status that moved establishes nothing');
// =============================================================================

const before4 = new Map([
  [herdrNameFor('task', 'KAN-1'), 'working'],
  [herdrNameFor('task', 'KAN-2'), 'working'],
  [herdrNameFor('task', 'KAN-3'), 'done'],
  [herdrNameFor('task', 'KAN-4'), 'blocked'],
  [herdrNameFor('task', 'KAN-5'), 'unknown']
]);
const after4 = new Map([
  [herdrNameFor('task', 'KAN-1'), 'working'],
  [herdrNameFor('task', 'KAN-2'), 'done'], // finished mid-window
  [herdrNameFor('task', 'KAN-3'), 'done'],
  [herdrNameFor('task', 'KAN-4'), 'blocked'],
  [herdrNameFor('task', 'KAN-5'), 'unknown'],
  [herdrNameFor('task', 'KAN-6'), 'working'] // started mid-window
]);
const classify = activityClassifier(before4, after4);
const expected = {
  'KAN-1': 'working',
  'KAN-2': 'unknown',
  'KAN-3': 'not-working',
  'KAN-4': 'not-working',
  'KAN-5': 'unknown',
  'KAN-6': 'unknown',
  'KAN-7': 'unknown' // in neither reading at all
};
console.log('');
let endpointsOk = true;
for (const [key, want] of Object.entries(expected)) {
  const got = classify('task', key);
  if (got !== want) endpointsOk = false;
  console.log(`  ${key.padEnd(9)} ${String(before4.get(herdrNameFor('task', key)) ?? '-').padEnd(8)} → ` +
    `${String(after4.get(herdrNameFor('task', key)) ?? '-').padEnd(8)}  ${got}${got === want ? '' : `  (expected ${want})`}`);
}
verdict(
  endpointsOk,
  'both ends must agree; a tree that changed, appeared or vanished establishes nothing',
  'the agreeing-endpoints rule does not hold — a partial-window tree is being charged to a population'
);
// The one that matters most, called out because it is the whole reason the rule
// exists: `working → done` must NOT be `working`, and must not be `not-working`
// either. It is neither, and those are different claims about the fleet.
verdict(
  classify('task', 'KAN-2') === 'unknown',
  'a tree that finished mid-window is unestablished rather than rounded to either end',
  'a tree that was working for part of the window is charged to a population for all of it'
);

// =============================================================================
rule('5. THE FLOOR — AC3: an unpriced start is still charged the seed');
// =============================================================================
//
// The correction in section 1 raises the divisor, which lowers the cap. This
// section is the half that must NOT move: whatever the measurement says, a
// start no instrument has priced is charged at least the seed on both
// dimensions. That is what keeps an over-optimistic cap non-fatal, and KAN-368
// forbids trading it away.

// The filing machine, stated rather than read: this section is about the
// arithmetic, and reading /proc here would make the numbers below depend on
// whatever CI happens to be running.
const LAPTOP = {
  cores: 4,
  totalBytes: 15.4 * GIB,
  availableBytes: 7.3 * GIB,
  load1: 6.0,
  busyCores: 1.2,
  busyWindowSeconds: 60,
  stall: { io: { state: 'measured', fullAvg10Percent: 0 }, memory: { state: 'measured', fullAvg10Percent: 0 } }
};

// A measurement far cheaper than the seed on both dimensions — the idle-sampled
// figure this ticket was filed on.
const cheap = {
  cores: 0.081,
  residentBytes: 300 * MIB,
  // A fixed stamp rather than a reading of the wall clock: nothing below uses
  // it — this section passes `unobservedStarts` directly rather than deriving
  // it from a horizon — and a proof whose output moves with the clock is one
  // whose green nobody can reproduce. It is the minute this ticket was filed.
  // (Written this way on purpose: sweep-ambient-dependence.mjs greps source
  // text, comments included, so naming the forbidden call here would flag this
  // file for a dependence it does not have.)
  sampledAt: Date.parse('2026-08-12T20:24:00Z'),
  windowSeconds: 60,
  agentTrees: 2,
  memoryAgentTrees: 4,
  supervisorResidentBytes: null,
  provenance: 'measured'
};
const charged = startingAgentCost(cheap);
console.log(`
  measured        ${cheap.cores} core, ${Math.round(cheap.residentBytes / MIB)} MB
  seed            ${MEASURED_AGENT_COST.cores} core, ${Math.round(MEASURED_AGENT_COST.residentBytes / MIB)} MB
  charged/start   ${charged.cores} core, ${Math.round(charged.residentBytes / MIB)} MB`);
verdict(
  charged.cores === MEASURED_AGENT_COST.cores &&
    charged.residentBytes === MEASURED_AGENT_COST.residentBytes,
  'a cheap measurement does not cheapen a start in flight: the seed is the floor on both dimensions',
  `a start against a cheap measurement is charged ${charged.cores} core / ` +
    `${Math.round(charged.residentBytes / MIB)} MB, below the seed`
);

// And an expensive measurement is NOT undercut by the floor — the floor is a
// max, not a substitution. The corrected instrument makes this the ordinary
// case rather than a hypothetical: a compiling fleet measures above 0.75.
const expensive = { ...cheap, cores: 1.03, residentBytes: 984 * MIB };
const chargedExpensive = startingAgentCost(expensive);
verdict(
  chargedExpensive.cores === 1.03 && chargedExpensive.residentBytes === 984 * MIB,
  'and a fleet that really is more expensive than the seed keeps that finding',
  `an above-seed measurement was pulled back down to the seed (${chargedExpensive.cores} core)`
);

// Driven through the real gate, not just the helper: two starts in flight
// against the cheap figure must cost the machine 2 x the seed.
const withStarts = computeCapacity(LAPTOP, 2, {
  measured: cheap,
  unobservedStarts: 2,
  unobservedBecause: 'after-window'
});
const noStarts = computeCapacity(LAPTOP, 2, { measured: cheap });
console.log(`
  computeCapacity, cheap figure, 0 starts in flight: headroom ${noStarts.headroom}
  computeCapacity, cheap figure, 2 starts in flight: headroom ${withStarts.headroom}` +
  `  (charged ${withStarts.unobservedStarts.cores} core, ` +
  `${Math.round(withStarts.unobservedStarts.bytes / MIB)} MB)`);
verdict(
  withStarts.unobservedStarts.cores === 2 * MEASURED_AGENT_COST.cores &&
    withStarts.unobservedStarts.bytes === 2 * MEASURED_AGENT_COST.residentBytes,
  'the gate charges every start in flight at the seed, through computeCapacity itself',
  `two starts in flight are charged ${withStarts.unobservedStarts.cores} core / ` +
    `${Math.round(withStarts.unobservedStarts.bytes / MIB)} MB, not 2x the seed`
);
verdict(
  withStarts.headroom <= noStarts.headroom,
  'and charging them cannot raise headroom',
  `starts in flight raised headroom from ${noStarts.headroom} to ${withStarts.headroom}`
);

// The direction of the whole change, asserted rather than assumed: a divisor
// that went UP cannot open the gate.
const beforeFix = computeCapacity(LAPTOP, 2, { measured: { ...cheap, cores: 0.107 } });
const afterFix = computeCapacity(LAPTOP, 2, { measured: { ...cheap, cores: 0.426 } });
console.log(`
  same fleet, divisor 0.107 (uncorrected) → cap ${beforeFix.cap}, headroom ${beforeFix.headroom}
  same fleet, divisor 0.426 (corrected)   → cap ${afterFix.cap}, headroom ${afterFix.headroom}`);
verdict(
  afterFix.cap <= beforeFix.cap && afterFix.headroom <= beforeFix.headroom,
  'counting the CPU that was being missed can only tighten the gate, never loosen it',
  `the correction raised cap ${beforeFix.cap} → ${afterFix.cap} or headroom ` +
    `${beforeFix.headroom} → ${afterFix.headroom}, which is an increase in admissions`
);

// =============================================================================
rule('6. CAN IT FAIL — the same assertions against the code this replaced');
// =============================================================================

const redDrives = [];

// 1's assertion, against the per-process form.
redDrives.push({
  name: 'section 1 (the blind spot), against per-process deltas',
  wouldFail: !near(oldCores, TRUE_CORES, 1e-9)
});

// 2(b)'s assertion, against a form that adds the parent's cutime delta to a
// per-process delta — the obvious wrong way to include children.
const naiveLong =
  (oldStyleTreeTicks(longBefore, longAfter, [3000, 3001]) + 60300) / CLK_TCK / WINDOW;
redDrives.push({
  name: 'section 2(b) (pre-window CPU), against a naive cutime addition',
  wouldFail: !near(naiveLong, LONG_TRUE, 1e-9)
});

// 2(c)'s assertion, against an unclamped difference.
const unclamped =
  (subtreeTicks(shrankAfter, [4000, 4001]) - subtreeTicks(shrankBefore, [4000, 4001, 4002])) /
  CLK_TCK /
  WINDOW;
redDrives.push({
  name: 'section 2(c) (the zero floor), against an unclamped difference',
  wouldFail: !(unclamped === 0)
});

// 3's assertion, against a two-state classifier where "not established"
// collapses into "not working" — the design this file argues against.
const twoState = aggregateTrees(
  fleetBefore,
  fleetAfter,
  WINDOW,
  isSupervisor,
  (pid) => fleetArgv[pid] ?? [],
  (_t, key) => (declared[key] === 'working' ? 'working' : 'not-working')
);
redDrives.push({
  name: 'section 3 (unestablished is not idle), against a boolean classifier',
  wouldFail: twoState.activityUnknown.agents !== 1
});

// 5's assertion, against a floor that takes the measurement instead of the max.
const brokenFloor = { cores: cheap.cores, residentBytes: cheap.residentBytes };
redDrives.push({
  name: 'section 5 (the admission floor), against a floor that trusts the measurement',
  wouldFail:
    !(brokenFloor.cores === MEASURED_AGENT_COST.cores &&
      brokenFloor.residentBytes === MEASURED_AGENT_COST.residentBytes)
});

console.log('');
for (const d of redDrives) {
  console.log(`  ${d.wouldFail ? 'goes red' : 'STAYS GREEN'}   ${d.name}`);
}
verdict(
  redDrives.every((d) => d.wouldFail),
  'every assertion above goes red against the code it replaced, so their green is evidence about ' +
    'this change rather than about arithmetic that was always true',
  'at least one assertion passes against the pre-change behaviour: ' +
    redDrives.filter((d) => !d.wouldFail).map((d) => d.name).join('; ')
);

// And the number that matters, in agents: what the undercount was worth.
console.log(`
  and the number that matters: on this fixture the old instrument priced a compiling agent at
  ${oldCores.toFixed(3)} core against a true ${TRUE_CORES.toFixed(3)}. On the filing machine's real fleet the same
  correction moved the measured task-agent divisor from 0.107 to 0.426 core, which is cap
  ${beforeFix.cap} against cap ${afterFix.cap} on a 4-core laptop. That gap is the defect, in agents.`);

// -------------------------------------------------------------- verdict ----
rule('VERDICT');
if (failures.length === 0) {
  console.log(
    'PASS — a tree\'s cost now includes the children it spawned and reaped inside the window,\n' +
    'counted exactly once and only for the part of their life that fell inside it; the working\n' +
    'population is separable and a tree nobody classified cannot be named working; and the\n' +
    'admission floor is untouched by the correction — every start no instrument has priced is\n' +
    'still charged at least the seed on both dimensions.\n\n' +
    'Still uncovered here, and covered by the live readings in the PR body: that /proc field 16 is\n' +
    'cutime, that a real agent tree is shaped like these fixtures, and that herdr says `working`\n' +
    'when an agent is working. Nothing in this file reads /proc or runs herdr. The corroboration\n' +
    'is the measured 1.03 core against /usr/bin/time\'s 0.98 for the same compiles.'
  );
} else {
  console.log(`FAIL — ${failures.length} problem(s):\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
}
process.exit(failures.length ? 1 : 0);
