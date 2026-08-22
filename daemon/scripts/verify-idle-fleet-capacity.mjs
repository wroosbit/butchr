// Proof for KAN-365: an idle fleet keeps what it measured, and the
// starts-in-flight ledger answers for the machine rather than for whoever asked.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity cap that collapses when the machine
// goes quiet — the 2026-08-12 reading where `agentCores` reverted from a
// measured 0.195 to the 2026-07-31 seed of 0.75 and `cap` fell from 12 to 3
// with nothing running, refusing `epic/KAN-59` three activations against a
// 68-ticket backlog. It also catches the three ways the fix can rot: retention
// that keeps a figure it should have dropped (a broken instrument, a fleet gone
// for hours, an operator who turned retention off), retention that quietly
// raises admissions instead of only the cap (the seed must still be charged to
// every start in flight), and a starts-in-flight ledger that goes back to being
// per-connection, which is what made one counter look like it oscillated
// between 0 and 1 across eight samples that were in fact constant per observer.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
// Section 1 reads this machine's real /proc for its machine facts and says so.
//
// Six sections:
//
//   1. the collapse   — reproduced before any fix, on this machine's real
//                       cores and memory: the same facts and the same fleet,
//                       with and without the measurement an idle fleet loses.
//                       Both caps are printed. This is AC1.
//   2. the decision   — `decideOnMissingSample` over every gap it can be
//                       handed. A broken instrument still discards; only an
//                       absent subject retains, and only inside the ceiling.
//   3. the floor      — AC2. Retention opens the cap and must not open the
//                       gate: the seed is still charged to every start against
//                       a stale figure, the ceiling still drops it, an operator
//                       override still beats it, and the observed-CPU bound
//                       still bounds it.
//   4. the ledger     — AC3. The oscillation reproduced as what it was: two
//                       routers, two ledgers, two answers for one machine. Then
//                       the same two routers on the shared ledger agreeing, and
//                       the age bound that stops a start being charged forever.
//   5. the seam       — the real `MessageRouter`, wired as daemon.ts wires it,
//                       showing that the ledger a router consults is the shared
//                       one rather than a copy. See the disclosure below.
//   6. can it fail    — sections 1–4 re-run against the pre-change behaviour.
//                       They must FAIL there.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Named because a green run reads as complete and this one is not (KAN-145).
//
// Sections 2–5 hand `computeCapacity` synthetic `MachineFacts`, write the
// `MeasuredAgentCost` records they then assert on, and record starts into the
// ledger directly rather than by activating an agent. Two things follow, and
// they are different sizes:
//
//   - **Covered here**: that the policy, the arithmetic and the ledger compose
//     correctly at the boundaries daemon.ts and router.ts use them across —
//     the mechanism. Section 5 goes one step further and drives the real
//     `MessageRouter.handle({action:'capacity'})`, so the ledger a router
//     actually consults is observed rather than assumed.
//   - **NOT covered here**: that a *real activation* calls `recordStart`, and
//     that the daemon's sampler calls `decideOnMissingSample` on the window
//     that finds no trees. Nothing in this file starts an agent or a daemon.
//     The first is unchanged by KAN-365 — the call site predates it — and the
//     second is one call site in `sampleFleetCost`. Section 5 asserts both
//     STATICALLY, against the source, which establishes that the branches route
//     to the right kind and nothing more. Driving `sampleFleetCost` down its
//     empty-fleet branch would mean a machine with no task agent on it, which
//     is not a state a script can arrange while it is itself running inside
//     one. `verify-capacity-survives-daemon-restart.mjs` covers the adjacent
//     live half — a real daemon on this branch publishing, persisting and
//     restoring a measurement — and its run is pasted in the PR.
//
// The gap that would survive both is worth naming rather than leaving to be
// inferred: nobody has watched a real fleet drain, sit for four hours, and come
// back. The ceiling is exercised here by arithmetic on a timestamp, not by
// waiting.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-idle-fleet-capacity.mjs
//   # strongly recommended: the pre-change build, so section 6 falsifies this
//   # battery against the real old code rather than a reconstruction of it
//   #   git archive origin/main daemon | tar -x -C /tmp/kan365-old
//   #   (cd /tmp/kan365-old/daemon && ln -s <repo>/daemon/node_modules . && npx tsc --outDir dist)
//   node scripts/verify-idle-fleet-capacity.mjs dist /tmp/kan365-old/daemon/dist

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Resolved, because a bare `dist` reaches dynamic import as a package name.
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const unfixedDir = process.argv[3] ? path.resolve(process.argv[3]) : null;

const {
  computeCapacity,
  describeCapacity,
  unobservedStartsAmong,
  startingAgentCost,
  boundCoresByObservedCpu,
  readMachineFacts,
  sampleCpuBusy,
  costSourceOf,
  MEASURED_AGENT_COST,
  UNOBSERVED_START_MAX_AGE_SECONDS,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { decideOnMissingSample, staleMeasurementMaxAgeMs, STALE_MEASUREMENT_MAX_AGE_MS } =
  await import(path.join(distDir, 'cost-sampler-policy.js'));
const { StartLedger, sharedStartLedger } = await import(path.join(distDir, 'start-ledger.js'));
const { sampleProcesses, groupByAgent, measureAgentCost } = await import(
  path.join(distDir, 'agent-cost.js')
);
const { supervisorMemoryFromMeasurement } = await import(path.join(distDir, 'agent-cost-damping.js'));
const { supervisorPredicate } = await import('./lib/supervisor-types.mjs');
// KAN-276: measureAgentCost has no default answer for "which trees are
// chargeable" — see lib/supervisor-types.mjs for why it must be asked.
const { isSupervisor } = await supervisorPredicate(distDir);

// The pre-change modules, if they were built. Everything under test is pure, so
// the old code can be handed the exact inputs the new code saw.
let old = null;
if (unfixedDir) {
  try {
    old = {
      capacity: await import(path.join(unfixedDir, 'capacity.js'))
    };
  } catch (e) {
    console.log(`(could not load the unfixed build from ${unfixedDir}: ${e.message})`);
  }
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const MIB = 1024 ** 2;
const MINUTE = 60 * 1000;

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

/**
 * The measurement this fleet published while it had agents to measure.
 *
 * The figures are the ticket's 13:02Z reading, so the arithmetic below
 * reproduces the numbers the ticket was filed on rather than numbers invented
 * here. `sampledAt` is set per use, because when it was taken is the whole
 * subject of sections 2 and 3.
 */
const liveMeasurement = (sampledAt, provenance) => ({
  residentBytes: 657 * MIB,
  cores: 0.195,
  sampledAt,
  windowSeconds: 60,
  agentTrees: 2,
  memoryAgentTrees: 5,
  supervisorResidentBytes: 640 * MIB,
  ...(provenance ? { provenance } : {})
});

// ==================================================== 1. THE COLLAPSE (AC1) ==
rule('1. THE COLLAPSE — the same machine, the same fleet, one lost measurement');

console.log(`
  This section is the "before" the ticket asks for, and it is run on this
  machine's real cores, real RAM and a real /proc/stat window (opened and closed
  above, so the CPU figure is measured rather than the labelled fallback) —
  nothing here invents the hardware. What it varies is the one thing an idle fleet changes:
  whether a measurement exists at all.

  The pre-change sampler called degradeCostMeasurement('no agent trees running,
  nothing to measure') on the first empty window, which cleared the estimate in
  memory and deleted the copy on disk. Capacity then divided by the seed. So
  "idle fleet" and "measured: null" are the same state, and that is what the
  second column is.
`);

// One call cannot measure a rate: the CPU term needs a baseline and a window
// that has closed on it, or `readMachineFacts` returns the labelled
// load-average fallback and this section's header claim about /proc/stat would
// be false. Two seconds is `CPU_WINDOW_MIN_SECONDS`, plus slack.
sampleCpuBusy();
await new Promise((r) => setTimeout(r, 2600));
const machine = readMachineFacts();
const now = Date.now();

// AC1 says re-measure rather than quote, and three readings on the filing
// machine spanned 2.9x to 4.1x — so the figure this section divides by is
// measured HERE, over whatever trees are running right now, and not the
// ticket's constant.
const liveWindow = await measureAgentCost(5, isSupervisor);
const liveTrees = groupByAgent(sampleProcesses()).size;
const measuredHere =
  liveWindow.chargeable.agents > 0 && liveWindow.totals.agents > 0
    ? {
        cores: Math.round((liveWindow.chargeable.cores / liveWindow.chargeable.agents) * 1000) / 1000,
        residentBytes:
          Math.round(liveWindow.totals.residentMb / liveWindow.totals.agents) * MIB,
        sampledAt: Date.now(),
        windowSeconds: liveWindow.elapsed,
        agentTrees: liveWindow.chargeable.agents,
        memoryAgentTrees: liveWindow.totals.agents,
        supervisorResidentBytes: supervisorMemoryFromMeasurement(liveWindow, machine.totalBytes)
      }
    : null;

if (!measuredHere) {
  console.log(
    `  NOTE: no task-agent tree is running on this machine (${liveTrees} tree(s) seen, ` +
    `${liveWindow.supervisors.agents} supervisor(s)), so there is nothing to measure and this\n` +
    "  section falls back to the ticket's 0.195 core reading. That state is itself the defect —\n" +
    '  it is exactly the window in which the daemon used to throw its measurement away.'
  );
}
const measurementInHand = measuredHere ?? liveMeasurement(now - 30 * 1000);

const withMeasurement = computeCapacity(machine, 0, { measured: measurementInHand });
const withoutMeasurement = computeCapacity(machine, 0, { measured: null });

console.log(
  `  machine: ${machine.cores} cores, ${(machine.totalBytes / GIB).toFixed(1)} GiB RAM, ` +
  `${machine.busyCores?.toFixed(2) ?? '(no window)'} cores in use\n`
);
const row = (label, c) =>
  console.log(
    `  ${label.padEnd(28)} agentCores ${String(c.cost.cores).padEnd(6)} ` +
    `source ${c.costSource.cores.padEnd(9)} cap ${String(c.cap).padEnd(3)} ` +
    `headroom ${c.headroom}   (bound by ${c.capBoundBy})`
  );
console.log(
  `  measured here, now: ${measuredHere ? `${measuredHere.cores} core / ` +
    `${Math.round(measuredHere.residentBytes / MIB)} MB per tree over ` +
    `${measuredHere.windowSeconds.toFixed(1)}s, ${measuredHere.agentTrees} task tree(s)` :
    "(nothing to measure — the ticket's figure stands in)"}\n`
);
row('a task agent is running:', withMeasurement);
row('the last one finishes:', withoutMeasurement);

const collapsed = withoutMeasurement.cap < withMeasurement.cap;
const revertedToSeed =
  withoutMeasurement.costSource.cores === 'seed' &&
  withoutMeasurement.cost.cores === MEASURED_AGENT_COST.cores;
const ratio = MEASURED_AGENT_COST.cores / withMeasurement.cost.cores;
// CORRECTION 1 on the ticket: this is not a cores-only defect. All three cost
// figures come from one record and one pick(), so all three revert together.
const allThreeReverted =
  withoutMeasurement.costSource.cores === 'seed' &&
  withoutMeasurement.costSource.residentBytes === 'seed' &&
  withoutMeasurement.supervisorReserve.source === 'seed';
const allThreeMeasured =
  withMeasurement.costSource.cores !== 'seed' &&
  withMeasurement.costSource.residentBytes !== 'seed';
console.log(
  `  and it is not only cores — all three sources flip together:\n` +
  `      agentCores       ${withMeasurement.cost.cores} (${withMeasurement.costSource.cores})` +
  ` → ${withoutMeasurement.cost.cores} (${withoutMeasurement.costSource.cores})\n` +
  `      agentMemoryMb    ${Math.round(withMeasurement.cost.residentBytes / MIB)} ` +
  `(${withMeasurement.costSource.residentBytes})` +
  ` → ${Math.round(withoutMeasurement.cost.residentBytes / MIB)} ` +
  `(${withoutMeasurement.costSource.residentBytes})\n` +
  `      supervisorReserve ${Math.round(withMeasurement.supervisorReserve.perSupervisorBytes / MIB)} ` +
  `(${withMeasurement.supervisorReserve.source})` +
  ` → ${Math.round(withoutMeasurement.supervisorReserve.perSupervisorBytes / MIB)} ` +
  `(${withoutMeasurement.supervisorReserve.source})`
);

console.log(
  `\n  The divisor went from ${withMeasurement.cost.cores} to ${withoutMeasurement.cost.cores} — ` +
  `${ratio.toFixed(1)}x — and the cap from ${withMeasurement.cap} to ${withoutMeasurement.cap}, ` +
  `with the fleet at its emptiest.`
);

verdict(
  collapsed && revertedToSeed && allThreeReverted && allThreeMeasured,
  `the collapse reproduces on this machine: cap ${withMeasurement.cap} → ${withoutMeasurement.cap}, ` +
    `agentCores ${withMeasurement.cost.cores} → ${withoutMeasurement.cost.cores} (seed).`,
  collapsed
    ? `the figure an empty fleet falls back to is not the seed (${withoutMeasurement.costSource.cores}), ` +
      'so this section is no longer reproducing the reported defect'
    : `the cap did not fall when the measurement was lost (${withMeasurement.cap} → ` +
      `${withoutMeasurement.cap}). Either the seed is no longer above this fleet's measured cost ` +
      'on this hardware, or something other than the divisor is binding — read capBoundBy above ' +
      'before concluding the defect is fixed'
);

// ====================================================== 2. THE DECISION ======
rule('2. THE DECISION — what a window that measured nothing is allowed to do');

console.log(`
  The real decideOnMissingSample, over every gap that can reach it. The rule
  being established is that the two situations the old code shared an answer for
  now have different ones — and that only ONE of them retains.
`);

const held = liveMeasurement(now - 5 * MINUTE);
const ceiling = STALE_MEASUREMENT_MAX_AGE_MS;

const cases = [
  {
    what: 'instrument failed, nothing held',
    gap: { kind: 'instrument-failed', reason: '/proc sampling failed' },
    held: null,
    expect: 'degrade'
  },
  {
    what: 'instrument failed, a fresh measurement held',
    gap: { kind: 'instrument-failed', reason: 'sample failed validation' },
    held,
    expect: 'degrade',
    why: 'the estimate may be wrong and nothing can say by how much — this is the case the ' +
      'degrade rule was written for, and it must not be weakened by the one next to it'
  },
  {
    what: 'nothing to measure, nothing ever held',
    gap: { kind: 'nothing-to-measure', reason: 'no agent trees running' },
    held: null,
    expect: 'degrade',
    why: 'a fleet that has never measured anything has nothing to retain; the seed is the only ' +
      'figure there has ever been'
  },
  {
    what: 'nothing to measure, a 5-minute-old measurement held',
    gap: { kind: 'nothing-to-measure', reason: 'no agent trees running' },
    held,
    expect: 'retain',
    why: 'THE FIX: the measurement is not wrong, it is unrefreshed'
  },
  {
    what: 'nothing to measure, only supervisors left',
    gap: { kind: 'nothing-to-measure', reason: 'no task-agent trees to measure (3 supervisor(s))' },
    held,
    expect: 'retain'
  },
  {
    what: 'nothing to measure, measurement past the ceiling',
    gap: { kind: 'nothing-to-measure', reason: 'no agent trees running' },
    held: liveMeasurement(now - ceiling - MINUTE),
    expect: 'degrade',
    why: 'past the ceiling it is a claim about another afternoon; the seed is honest again'
  },
  {
    what: 'nothing to measure, measurement stamped in the future',
    gap: { kind: 'nothing-to-measure', reason: 'no agent trees running' },
    held: liveMeasurement(now + 10 * MINUTE),
    expect: 'degrade',
    why: 'a clock that moved, not a fresh measurement — and believing it makes the ceiling ' +
      'unreachable'
  },
  {
    what: 'nothing to measure, retention disabled by the operator',
    gap: { kind: 'nothing-to-measure', reason: 'no agent trees running' },
    held,
    maxAgeMs: 0,
    expect: 'degrade',
    why: 'BUTCHR_STALE_COST_MAX_MINUTES=0 restores the pre-change behaviour exactly'
  }
];

let decisionProblems = [];
for (const c of cases) {
  const d = decideOnMissingSample(c.gap, c.held, now, c.maxAgeMs ?? ceiling);
  const ok = d.action === c.expect;
  if (!ok) decisionProblems.push(`${c.what}: expected ${c.expect}, got ${d.action}`);
  console.log(
    `  ${ok ? '✓' : '✗'} ${c.what.padEnd(48)} → ${d.action}` +
    (d.action === 'retain' ? ` (${Math.round(d.ageMs / 1000)}s old, labelled '${d.measured.provenance}')` : '')
  );
  if (c.why) console.log(`      ${c.why}`);
}

// A retained figure must be the SAME figure. Relabelled, never recomputed:
// a retention that quietly moved a number would be the guess this whole change
// is careful not to make.
const retained = decideOnMissingSample(
  { kind: 'nothing-to-measure', reason: 'no agent trees running' },
  held,
  now,
  ceiling
);
const unchanged =
  retained.action === 'retain' &&
  retained.measured.cores === held.cores &&
  retained.measured.residentBytes === held.residentBytes &&
  retained.measured.sampledAt === held.sampledAt &&
  retained.measured.windowSeconds === held.windowSeconds &&
  retained.measured.provenance === 'stale' &&
  costSourceOf(retained.measured) === 'stale';
console.log(
  `\n  retained figure vs held figure: cores ${retained.measured?.cores} / ${held.cores}, ` +
  `residentBytes ${retained.measured?.residentBytes} / ${held.residentBytes}, ` +
  `sampledAt unchanged: ${retained.measured?.sampledAt === held.sampledAt}, ` +
  `label '${retained.measured?.provenance}' → costSource '${costSourceOf(retained.measured ?? {})}'`
);

verdict(
  decisionProblems.length === 0 && unchanged,
  'only an absent subject retains, and what it retains is the measurement it already had, ' +
    "relabelled 'stale' and not recomputed.",
  decisionProblems.length
    ? `the decision is wrong for ${decisionProblems.length} gap(s): ${decisionProblems.join('; ')}`
    : 'a retained measurement is not identical to the one it was taken from, or is not labelled ' +
      "'stale' — a retention that recomputes a figure is the guess this change exists not to make"
);

// ======================================================== 3. THE FLOOR (AC2) ==
rule('3. THE FLOOR — retention opens the cap and must not open the gate');

console.log(`
  AC2: "whatever replaces the seed, show it does not overstate capacity either."
  The retained figure is LOWER than the seed, so it raises the cap. This section
  is the four things that bound what that can cost, none of which is new — the
  argument is that retention rides on protections that already existed.
`);

// A machine with room to spare, so that anything binding below is one of the
// four bounds rather than the hardware.
const idleMachine = {
  cores: 4,
  totalBytes: 16 * GIB,
  availableBytes: 12 * GIB,
  load1: 0.4,
  busyCores: 0.3,
  busyWindowSeconds: 5,
  stall: { io: { state: 'measured', fullAvg10Percent: 0 }, memory: { state: 'measured', fullAvg10Percent: 0 } }
};

const staleCost = liveMeasurement(now - 20 * MINUTE, 'stale');

// -- 3a. the ramp -----------------------------------------------------------
// Every start against a stale figure is charged the SEED, because the window
// that produced the figure closed before any of them existed. So the cap opens
// to what the hardware allows and admission still walks in one agent at a time.
// The tariff each start pays while unpriced: the larger of the estimate and the
// seed, which on a fleet cheaper than the seed is the seed.
const seedCharge = startingAgentCost({ cores: staleCost.cores, residentBytes: staleCost.residentBytes });
console.log('\n  3a. the ramp — what the live gate allows as starts pile up against a stale figure\n');
const ramp = [];
for (let k = 0; k <= 5; k++) {
  const startedAt = Array.from({ length: k }, () => now - 1000);
  const u = unobservedStartsAmong(startedAt, staleCost, now);
  const c = computeCapacity(idleMachine, 0, {
    measured: staleCost,
    unobservedStarts: u.count,
    unobservedBecause: u.because
  });
  ramp.push({ k, count: u.count, because: u.because, headroom: c.headroom, cap: c.cap });
  console.log(
    `    ${k} start(s) in flight → charged ${u.count} × ${seedCharge.cores} core ` +
    `(because: ${u.because}), cap ${c.cap}, headroom ${c.headroom}`
  );
}
const rampCloses = ramp[ramp.length - 1].headroom < ramp[0].headroom && ramp.some((r) => r.headroom === 0);
const chargedAtSeed = seedCharge.cores === MEASURED_AGENT_COST.cores;
const allCounted = ramp.every((r) => r.count === r.k);

// -- 3b. the ceiling --------------------------------------------------------
console.log('\n  3b. the ceiling — past it, this change is exactly the behaviour it replaced\n');
const pastCeiling = decideOnMissingSample(
  { kind: 'nothing-to-measure', reason: 'no agent trees running' },
  liveMeasurement(now - ceiling - MINUTE),
  now,
  ceiling
);
const afterCeiling = computeCapacity(idleMachine, 0, { measured: null });
const withinCeiling = computeCapacity(idleMachine, 0, { measured: staleCost });
console.log(
  `    inside the ceiling: agentCores ${withinCeiling.cost.cores} (${withinCeiling.costSource.cores}), ` +
  `cap ${withinCeiling.cap}\n` +
  `    past the ceiling:   agentCores ${afterCeiling.cost.cores} (${afterCeiling.costSource.cores}), ` +
  `cap ${afterCeiling.cap}   ← the pre-change answer, unchanged`
);
const ceilingDrops = pastCeiling.action === 'degrade' && afterCeiling.costSource.cores === 'seed';

// -- 3c. an override still wins --------------------------------------------
console.log('\n  3c. an operator override still beats a retained figure\n');
const overridden = computeCapacity(idleMachine, 0, {
  measured: staleCost,
  overrides: { cores: 1.5 }
});
console.log(
  `    BUTCHR_AGENT_CORES=1.5 with a stale measurement held → agentCores ${overridden.cost.cores} ` +
  `(${overridden.costSource.cores}), cap ${overridden.cap}`
);
const overrideWins = overridden.costSource.cores === 'override' && overridden.cost.cores === 1.5;

// -- 3d. the observed-CPU bound is unmoved ---------------------------------
console.log('\n  3d. the estimate still cannot claim more CPU than the machine reports\n');
const contradicting = computeCapacity(
  { ...idleMachine, busyCores: 0.2 },
  4,
  { measured: liveMeasurement(now - 20 * MINUTE, 'stale') }
);
const boundStillFires = contradicting.liveCoresBound !== null;
console.log(
  `    4 trees × ${staleCost.cores} core = ${(4 * staleCost.cores).toFixed(2)} claimed against 0.20 ` +
  `busy → liveCoresBound ${boundStillFires ? 'fired' : 'did NOT fire'}` +
  (boundStillFires ? ` (divides ${contradicting.liveCoresBound.used.toFixed(3)} instead)` : '')
);
// It may only ever lower the divisor — the direction check, on a stale figure.
const raises = boundCoresByObservedCpu(0.195, 2, 10);
const bothDirections = raises === null && boundStillFires;

// -- 3e. retention changes the label, not the arithmetic -------------------
console.log('\n  3e. a retained figure produces the cap it produced while live — no more\n');
const liveCap = computeCapacity(idleMachine, 0, { measured: liveMeasurement(now - 30 * 1000) });
const staleCap = computeCapacity(idleMachine, 0, { measured: staleCost });
console.log(
  `    live:  cap ${liveCap.cap}, source ${liveCap.costSource.cores}\n` +
  `    stale: cap ${staleCap.cap}, source ${staleCap.costSource.cores}   ` +
  `(same arithmetic, different label — retention never raises what the measurement said)`
);
const labelOnly = liveCap.cap === staleCap.cap && staleCap.costSource.cores === 'stale';

// -- 3f. all three figures are retained, because all three reverted ---------
// The ticket's CORRECTION 1: agentMemoryMb and the supervisor reserve fall back
// with agentCores, so a cores-only fix leaves two thirds of the defect.
console.log('\n  3f. retention covers every figure that reverted, not just cores\n');
const staleAll = computeCapacity(idleMachine, 0, { measured: staleCost, supervisorsRunning: 3 });
const seedAll = computeCapacity(idleMachine, 0, { measured: null, supervisorsRunning: 3 });
console.log(
  `    agentCores        ${staleAll.cost.cores} (${staleAll.costSource.cores})` +
  `      vs seed ${seedAll.cost.cores} (${seedAll.costSource.cores})\n` +
  `    agentMemoryMb     ${Math.round(staleAll.cost.residentBytes / MIB)} ` +
  `(${staleAll.costSource.residentBytes})   vs seed ` +
  `${Math.round(seedAll.cost.residentBytes / MIB)} (${seedAll.costSource.residentBytes})\n` +
  `    supervisorReserve ${Math.round(staleAll.supervisorReserve.perSupervisorBytes / MIB)} ` +
  `(${staleAll.supervisorReserve.source})     vs seed ` +
  `${Math.round(seedAll.supervisorReserve.perSupervisorBytes / MIB)} ` +
  `(${seedAll.supervisorReserve.source})`
);
const allThreeRetained =
  staleAll.costSource.cores === 'stale' &&
  staleAll.costSource.residentBytes === 'stale' &&
  staleAll.supervisorReserve.source === 'stale';

// -- 3g. "which last measurement?" — the settling interval ------------------
// epic/KAN-203 measured the same two trees six minutes apart and got 0.262 then
// 0.184 on cores, while memory rose 682 → 709. So a fleet that runs briefly and
// stops leaves a still-settling figure behind. The claim under test is that
// this needs no settledness rule, because damping starts each dimension at the
// seed: an unsettled figure is always BETWEEN the seed and the settled answer.
console.log(`
  3g. a fleet that ran briefly leaves a still-settling figure — where does it sit?
`);
const settled = { cores: 0.184, residentBytes: 709 * MIB };
const settling = { cores: 0.262, residentBytes: 682 * MIB };
const seedCost = { cores: MEASURED_AGENT_COST.cores, residentBytes: MEASURED_AGENT_COST.residentBytes };
const between = (lo, mid, hi) => (mid >= Math.min(lo, hi) && mid <= Math.max(lo, hi));
const coresBetween = between(seedCost.cores, settling.cores, settled.cores);
const memoryBetween = between(seedCost.residentBytes, settling.residentBytes, settled.residentBytes);
const capOf = (cost) =>
  computeCapacity(idleMachine, 0, {
    measured: { ...staleCost, cores: cost.cores, residentBytes: cost.residentBytes }
  }).cap;
console.log(
  `    cores:  seed ${seedCost.cores} ≥ settling ${settling.cores} ≥ settled ${settled.cores}` +
  `   → ${coresBetween ? 'between' : 'OUTSIDE the interval'}\n` +
  `    memory: seed ${Math.round(seedCost.residentBytes / MIB)} ≤ settling ` +
  `${Math.round(settling.residentBytes / MIB)} ≤ settled ${Math.round(settled.residentBytes / MIB)}` +
  `   → ${memoryBetween ? 'between' : 'OUTSIDE the interval'}\n\n` +
  `    the cap each would produce: seed ${capOf(seedCost)}, settling ${capOf(settling)}, ` +
  `settled ${capOf(settled)}\n` +
  `    so retaining the settling figure opens the cap LESS than the truth would, and more than\n` +
  `    the seed did — which is the conservative half of the interval, on the term that binds.`
);
// The direction that matters: on cores, retaining an unsettled figure can never
// open the cap wider than the settled measurement would have.
const settlingIsConservative = capOf(settling) <= capOf(settled);
// And the memory dimension's charge on a start in flight is at least the seed,
// which is what bounds the direction memory settles in.
const memoryFloorHolds =
  startingAgentCost({ cores: settling.cores, residentBytes: settling.residentBytes }).residentBytes >=
  MEASURED_AGENT_COST.residentBytes;

verdict(
  rampCloses && chargedAtSeed && allCounted && ceilingDrops && overrideWins && bothDirections &&
    labelOnly && allThreeRetained && coresBetween && memoryBetween && settlingIsConservative &&
    memoryFloorHolds,
  'retention opens the cap without opening the gate: every start against a stale figure is charged ' +
    `the ${MEASURED_AGENT_COST.cores}-core seed, the live term closes before the cap does, the ceiling ` +
    'returns the pre-change answer, an override still wins, and the observed-CPU bound is unmoved.',
  [
    !allCounted && 'starts against a stale figure are not all counted as unobserved — the retained ' +
      "window closed before they existed, so every one of them must be charged",
    !chargedAtSeed && 'a start in flight is no longer charged the seed, so retention has removed the ' +
      'one thing that made a lower divisor safe',
    !rampCloses && 'the live CPU term never closes as starts pile up, so the cap is now the only ' +
      'thing rationing admissions — which is exactly the trade AC2 forbids',
    !ceilingDrops && 'a measurement past the retention ceiling is still believed',
    !overrideWins && 'an operator override no longer beats a retained figure',
    !bothDirections && 'the observed-CPU bound no longer fires on a stale figure, or has started ' +
      'raising a divisor rather than only lowering one',
    !labelOnly && 'a retained figure produces a different cap from the live figure it came from',
    !allThreeRetained && 'retention does not cover all three cost figures — cores, agent memory and ' +
      'the supervisor reserve revert together, so a fix for one leaves two thirds of the defect',
    (!coresBetween || !memoryBetween || !settlingIsConservative) &&
      'a still-settling measurement no longer sits between the seed and the settled answer, so ' +
      'retaining one is no longer bounded by the interval this file would have chosen within anyway',
    !memoryFloorHolds && 'a start in flight is no longer charged at least the seed on memory, which ' +
      'is what bounds the dimension that settles upward'
  ].filter(Boolean).join('; ')
);

// ========================================================= 4. THE LEDGER =====
rule('4. THE LEDGER — the oscillation, reproduced as what it actually was');

console.log(`
  Eight readings were taken of unobservedStarts.count with nothing running:
  1, 1, 1, 0, 1, 0, 0, 0. Read as one counter it alternates and no mechanism
  explains it. It was never one counter: the ledger was a field on
  MessageRouter, and daemon.ts builds ONE ROUTER PER CONNECTION.
`);

// -- 4a. two ledgers, one machine ------------------------------------------
const ledgerA = new StartLedger();
const ledgerB = new StartLedger();
ledgerA.record('butchr-task-kan-999', now - 30 * 1000);

const answerFrom = (ledger, measured) => {
  const u = unobservedStartsAmong(ledger.startedAt(), measured, now);
  return { count: u.count, because: u.because };
};

const perConnection = {
  observerA: answerFrom(ledgerA, null),
  observerB: answerFrom(ledgerB, null)
};
console.log(
  `  4a. two routers, two ledgers, one machine:\n` +
  `      the connection that started an agent  → count ${perConnection.observerA.count}\n` +
  `      any other connection                  → count ${perConnection.observerB.count}\n` +
  `      ...which is 1 and 0, minutes apart, from two supervisors both reading correctly.`
);
const reproducesDisagreement = perConnection.observerA.count !== perConnection.observerB.count;

// -- 4b. one ledger, one answer --------------------------------------------
const shared = new StartLedger();
shared.record('butchr-task-kan-999', now - 30 * 1000);
const sharedAnswers = [answerFrom(shared, null), answerFrom(shared, null)];
console.log(
  `\n  4b. the same two observers on one shared ledger → ` +
  `count ${sharedAnswers[0].count} and ${sharedAnswers[1].count}`
);
const agrees = sharedAnswers[0].count === sharedAnswers[1].count;

// -- 4c. the charge that never ended ---------------------------------------
console.log(`
  4c. the other half, and the one that cost three refused activations: an entry
      whose agent never reached the census is never marked seen and never
      dropped. With no measurement there was no window for it to be older than,
      so it was charged 0.75 core for as long as the daemon ran. router.ts's own
      leak guard asserted in prose that this could not happen.
`);
const stuck = new StartLedger();
const longAgo = now - 60 * MINUTE;
stuck.record('butchr-task-kan-000', longAgo);
// Reconciled against a census it never appears in: `seen` stays false, so the
// entry survives — which is correct, and is why the age bound is the fix
// rather than a change to the pruning.
stuck.reconcile(new Set(['butchr-epic-kan-39']));
const stuckNow = unobservedStartsAmong(stuck.startedAt(), null, now);
const stuckThen = unobservedStartsAmong(stuck.startedAt(), null, longAgo + 30 * 1000);
console.log(
  `      the entry survives reconciliation (ledger size ${stuck.size}), as it must — a start is ` +
  `absent from the census for its first moments too.\n` +
  `      30s after it started:  charged ${stuckThen.count} (because: ${stuckThen.because})   ← correct\n` +
  `      60 minutes later:      charged ${stuckNow.count} (because: ${stuckNow.because})   ` +
  `← bounded at ${UNOBSERVED_START_MAX_AGE_SECONDS}s`
);
const boundedByAge = stuckThen.count === 1 && stuckNow.count === 0;

// And the bound must not reach a start that really is in flight.
const fresh = unobservedStartsAmong([now - 5 * 1000], null, now);
const freshStillCharged = fresh.count === 1;

verdict(
  reproducesDisagreement && agrees && boundedByAge && freshStillCharged,
  'the oscillation is per-connection ledgers, not a counter that moves: separate ledgers disagree ' +
    'for one machine, the shared ledger does not, and a start that never reaches the census stops ' +
    `being charged after ${UNOBSERVED_START_MAX_AGE_SECONDS}s instead of forever.`,
  [
    !reproducesDisagreement && 'two ledgers no longer produce two answers, so this section is not ' +
      'reproducing the reported readings and proves nothing about what caused them',
    !agrees && 'two observers on the shared ledger still disagree',
    !boundedByAge && 'a start that never reached the census is still charged an hour later — the ' +
      'bound router.ts already claims in prose is still not there',
    !freshStillCharged && 'a start seconds old is no longer charged, which deletes KAN-258'
  ].filter(Boolean).join('; ')
);

// ============================================================ 5. THE SEAM ====
rule('5. THE SEAM — the ledger a real router consults');

console.log(`
  Sections 2–4 drive pure functions. This one drives the real MessageRouter,
  constructed the way daemon.ts constructs one per connection, and observes
  which ledger reaches capacity. Without it, everything above would be true of a
  class nobody had shown was wired to it (KAN-145).
`);

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const stubBridge = {
  listHerdrAgents: () => [],
  listHerdrAgentsChecked: () => ({ reachable: true, agents: [] }),
  listActiveSessions: () => [],
  getSessionByAddress: () => undefined,
  // KAN-473 added this to the AgentRuntime seam, and it is DERIVED from the
  // stub's own `getSessionByAddress` rather than written twice, so a stub
  // cannot disagree with itself about what an address resolves to. The real
  // runtimes answer `ambiguous` here; no stub here holds two sessions on one
  // key, so none of them can reach that outcome — see
  // `verify-ambiguous-key-refusal.mjs` for the case that does.
  resolveSessionByAddress(key, type) {
    const session = this.getSessionByAddress(key, type);
    return session ? { outcome: 'one', session } : { outcome: 'none' };
  },
  spawnSession: () => {
    throw new Error('spawnSession must not be reached by a capacity question');
  }
};
const stubRegistry = {
  get: () => undefined,
  resolve: async () => null,
  priorityFor: () => 1,
  disabledMatch: () => null,
  disabledIntegrationForType: () => null,
  mcpServerDefinitions: () => ({}),
  declaresSupervisor: () => false
};
const stubPrompts = { loadAndRender: () => '# prompt' };

/** What `startedAt` a router hands capacity — captured through the real path. */
const startedAtSeenBy = (opts) => {
  let seen = null;
  const router = new MessageRouter(
    stubRegistry,
    stubPrompts,
    stubBridge,
    () => {},
    () => {},
    {
      ...opts,
      capacitySource: (running, supervisors, startedAt) => {
        seen = [...startedAt];
        return computeCapacity({ ...idleMachine }, running, { measured: null });
      }
    }
  );
  router.handle({ action: 'capacity' });
  return seen;
};

// Two routers wired exactly as daemon.ts wires them — no startLedger option, so
// both take the production default.
const marker = now - 10 * 1000;
sharedStartLedger.record('butchr-task-kan-seam', marker);
const connectionOne = startedAtSeenBy({});
const connectionTwo = startedAtSeenBy({});
// And one with its own ledger, which is the pre-change scoping in one option.
const isolated = startedAtSeenBy({ startLedger: new StartLedger() });

console.log(
  `  a start recorded once, then two separate routers asked for capacity:\n` +
  `      connection 1 sees: [${connectionOne?.join(', ')}]\n` +
  `      connection 2 sees: [${connectionTwo?.join(', ')}]\n` +
  `      a router given its own ledger sees: [${isolated?.join(', ')}]   ← the old scoping`
);

const bothSeeIt =
  Array.isArray(connectionOne) &&
  Array.isArray(connectionTwo) &&
  connectionOne.includes(marker) &&
  connectionTwo.includes(marker);
const isolatedBlind = Array.isArray(isolated) && !isolated.includes(marker);

// The one link this script cannot drive without spawning an agent: that the
// activation paths call recordStart at all. Asserted against the source, and
// named in the header as the seam it is.
const routerSource = fs.readFileSync(path.join(scriptDir, '..', 'src', 'router.ts'), 'utf8');
// The sampler's routing, for the same reason and with the same limit. Nothing
// here can drive `sampleFleetCost` without emptying this machine of task
// agents, so what is checkable is which KIND each of its branches reports —
// and that is the whole of what KAN-365 changed there. A branch that went back
// to calling degradeCostMeasurement directly, or that filed an empty fleet
// under `instrument-failed`, is the regression this catches.
const daemonSource = fs.readFileSync(path.join(scriptDir, '..', 'src', 'daemon.ts'), 'utf8');
const emptyFleetIsNothingToMeasure =
  /kind: 'nothing-to-measure',\s*\n\s*reason:\s*\n?\s*measurement\.totals\.agents > 0/.test(daemonSource);
const failuresAreInstrumentFailures =
  (daemonSource.match(/kind: 'instrument-failed'/g) ?? []).length >= 2;
// And the only remaining caller of the degrade path is noSampleThisWindow: a
// branch that reaches around the policy is a branch the policy does not govern.
const degradeCallers = (daemonSource.match(/degradeCostMeasurement\(/g) ?? []).length;
const policyOwnsDegrade = degradeCallers === 2; // the declaration, and the one call in noSampleThisWindow
console.log(
  `\n  static, on daemon.ts's routing: the empty-fleet branch reports ` +
  `'nothing-to-measure': ${emptyFleetIsNothingToMeasure}; the failure branches report ` +
  `'instrument-failed': ${failuresAreInstrumentFailures}; degradeCostMeasurement( appears ` +
  `${degradeCallers} time(s) — its declaration and the single call inside noSampleThisWindow`
);
const recordStartCalls = (routerSource.match(/this\.recordStart\(/g) ?? []).length;
const recordStartWritesLedger = /recordStart\(agentName: string\): void \{\s*\n\s*this\.startLedger\.record\(/.test(
  routerSource
);
console.log(
  `\n  static, because nothing here spawns an agent: this.recordStart( is called ` +
  `${recordStartCalls} time(s) in router.ts, and recordStart writes to this.startLedger: ` +
  `${recordStartWritesLedger}`
);

verdict(
  bothSeeIt && isolatedBlind && recordStartCalls >= 2 && recordStartWritesLedger &&
    emptyFleetIsNothingToMeasure && failuresAreInstrumentFailures && policyOwnsDegrade,
  'a real router takes the shared ledger by default, so a start recorded anywhere in the process ' +
    'is charged to a capacity question asked over any connection — and an injected ledger still ' +
    'isolates, which is what let section 4a reproduce the old behaviour.',
  [
    !bothSeeIt && 'two default-constructed routers do not both see a start recorded in the shared ' +
      'ledger — the per-connection scoping is back and section 4b is proving something about a ' +
      'class the daemon does not use',
    !isolatedBlind && 'an injected ledger is not actually consulted, so section 4a is not ' +
      'reproducing the old scoping',
    recordStartCalls < 2 && `only ${recordStartCalls} call(s) to recordStart remain in router.ts — ` +
      'both activation routes must record, or starts stop being charged at all (KAN-258)',
    !recordStartWritesLedger && 'recordStart no longer writes to the ledger this router consults',
    !emptyFleetIsNothingToMeasure && "daemon.ts no longer reports an empty fleet as " +
      "'nothing-to-measure', so the sampler is back to discarding a measurement whose only " +
      'defect is that nothing is left to re-measure',
    !failuresAreInstrumentFailures && 'daemon.ts no longer reports its /proc and validation ' +
      "failures as 'instrument-failed' — those must still discard",
    !policyOwnsDegrade && `degradeCostMeasurement( appears ${degradeCallers} times in daemon.ts; ` +
      'a caller that reaches around decideOnMissingSample is a branch the policy does not govern'
  ].filter(Boolean).join('; ')
);

// ========================================================= 6. CAN IT FAIL ====
rule('6. CAN IT FAIL — the same assertions against the pre-change behaviour');

console.log(`
  A battery that passes with the fix removed proves nothing. These are the two
  assertions above that the old code must FAIL, run against it.
`);

let oldModelName;
let oldUnobserved;
if (old?.capacity?.unobservedStartsAmong) {
  oldModelName = `the pre-change build in ${unfixedDir}`;
  oldUnobserved = (startedAt, measured, at) => {
    // The old signature took two arguments; a third is ignored by it, which is
    // itself the property under test.
    return old.capacity.unobservedStartsAmong(startedAt, measured, at);
  };
} else {
  oldModelName =
    'an inline reconstruction of the pre-change counter (no unfixed build supplied — pass one as ' +
    'argv[3] to falsify against the real thing)';
  oldUnobserved = (startedAt, measured) => {
    if (!measured) return { count: startedAt.length, because: 'no-measurement' };
    if (measured.provenance === 'restored') return { count: startedAt.length, because: 'restored' };
    const openedAt = measured.sampledAt - measured.windowSeconds * 1000;
    return { count: startedAt.filter((at) => at > openedAt).length, because: 'after-window' };
  };
}
console.log(`  falsifying against: ${oldModelName}\n`);

// 6a. the stuck charge — the old counter must still be charging it an hour on.
const oldStuck = oldUnobserved(stuck.startedAt(), null, now);
console.log(
  `  6a. a start 60 minutes old, never seen by the census:\n` +
  `        pre-change: charged ${oldStuck.count}   post-change: charged ${stuckNow.count}`
);
const oldStillCharges = oldStuck.count === 1 && stuckNow.count === 0;

// 6b. the sampler policy — the old build has no such module at all.
let oldPolicy = null;
if (unfixedDir) {
  try {
    oldPolicy = await import(path.join(unfixedDir, 'cost-sampler-policy.js'));
  } catch {
    oldPolicy = null;
  }
}
const oldHasNoPolicy = !unfixedDir || oldPolicy === null;
console.log(
  `  6b. the pre-change build's cost-sampler-policy module: ` +
  `${oldPolicy ? 'PRESENT — this is not the pre-change build' : 'absent, as it should be'}`
);

// 6c. the collapse itself: section 1 IS the old behaviour, and it must differ
//     from what the retained figure produces.
const oldIdle = computeCapacity(machine, 0, { measured: null });
const newIdle = computeCapacity(machine, 0, {
  measured: liveMeasurement(now - 20 * MINUTE, 'stale')
});
console.log(
  `  6c. this machine with an idle fleet:\n` +
  `        pre-change: cap ${oldIdle.cap} (${oldIdle.costSource.cores})   ` +
  `post-change: cap ${newIdle.cap} (${newIdle.costSource.cores})`
);
const capRecovered = newIdle.cap > oldIdle.cap && newIdle.costSource.cores === 'stale';

verdict(
  oldStillCharges && oldHasNoPolicy && capRecovered,
  'the pre-change behaviour fails every assertion this battery makes about it — the charge that ' +
    'never ends, the policy that did not exist, and the cap that stayed collapsed.',
  [
    !oldStillCharges && 'the pre-change counter does not charge a stuck start either, so section 4c ' +
      'is not testing the fix',
    !oldHasNoPolicy && 'the pre-change build already has cost-sampler-policy, so it is not the ' +
      'pre-change build and this section is falsifying against the wrong thing',
    !capRecovered && `the retained figure does not raise the cap on this machine ` +
      `(${oldIdle.cap} → ${newIdle.cap}), so section 1's defect is not actually fixed here`
  ].filter(Boolean).join('; ')
);

// ------------------------------------------------------------- verdict ----
rule('VERDICT');
if (failures.length === 0) {
  console.log(
    'PASS — an idle fleet keeps the measurement it took, labelled with its age; the seed is still\n' +
    'charged to every start until an instrument prices it; and the starts-in-flight ledger answers\n' +
    'for the machine rather than for whichever connection asked.\n\n' +
    'Still uncovered here, and covered by the live readings pasted in the PR: that a real\n' +
    'activation calls recordStart, and that the running daemon routes an empty window through\n' +
    'decideOnMissingSample. Nothing in this file starts an agent or a daemon. Nobody has yet\n' +
    'watched a real fleet drain, sit past the four-hour ceiling, and come back — the ceiling is\n' +
    'exercised here by arithmetic on a timestamp. See the header.'
  );
} else {
  console.log(`FAIL — ${failures.length} problem(s):\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
}
console.log(`\nsampled derivation, retained figure:\n\n${describeCapacity(newIdle)}\n`);
process.exit(failures.length ? 1 : 0);
