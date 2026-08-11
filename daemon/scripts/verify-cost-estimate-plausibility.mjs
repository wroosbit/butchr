// Proof for KAN-204: the per-agent core estimate the CPU cap divides by is
// never allowed to assert more CPU than the machine says is in use, and it
// survives a daemon restart instead of restarting its twenty-five-minute walk
// down from a 2026-07-31 constant.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity cap that collapses after every
// daemon restart because it divides by a damped estimate still warming up from
// the seed — the KAN-201 regression, where `cap 19 (bound by memory)` became
// `cap 3 (bound by cpu)` on the same machine doing the same work, off an
// estimate labelled `measured` that claimed 3.15 cores of agent CPU while the
// machine reported 1.94 cores busy in total. It also catches the two ways the
// fix can rot: a plausibility bound that stops firing (the estimate is believed
// again, and the collapse comes back), and a bound that fires when it must not
// — over an operator's explicit override, or off the load-average fallback,
// either of which would be a gate quietly loosening itself on a figure nobody
// measured.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Five sections:
//
//   1. the walk      — the damping arithmetic from the seed, window by window,
//                      with the cap each window would have produced. This is
//                      the "~25 minutes" claim made checkable rather than
//                      asserted.
//   2. the invariant — this machine's real /proc: real agent trees, a real
//                      /proc/stat window, and the estimate an unfixed daemon
//                      would be publishing two windows after a restart. The
//                      contradiction is shown against numbers nothing here
//                      invented.
//   3. the bound     — every case the bound must and must not fire on, run
//                      through the real computeCapacity, including the two
//                      exemptions and the direction check (it may only ever
//                      lower the divisor, never raise it).
//   4. the restart   — the real store, round-tripped: publish, save, load,
//                      resume damping. The cap before and after, against the
//                      cap the same restart produces without it. Plus every
//                      rejection the store owes: stale, future-dated,
//                      malformed, absent, larger than the machine.
//   5. can it fail   — sections 3 and 4 re-run against the pre-change build.
//                      They must FAIL there. A battery that passes with the fix
//                      removed is a battery that proves nothing, and this
//                      script exits red when that happens.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Section 4 writes the estimate file it then reads back, and sections 1, 3 and
// 4 hand `computeCapacity` synthetic MachineFacts. A round trip through a
// record the test wrote has not shown that anything writes that record in
// production — that is exactly the KAN-145 shape, where two scripts proved the
// daemon carried `activatedBy` correctly by constructing registry entries that
// already had it, while every real activation produced null.
//
// So, precisely: what is proved here is that the store, the damping and the
// bound compose correctly at the boundary daemon.ts uses them across — the
// mechanism. What is NOT proved here is the wiring: that the running daemon
// calls `saveCostEstimate` on every publish and `restoreCostEstimate` before
// its first window. Nothing here starts a daemon. Section 2 is the closest this
// script gets to the live system — it reads this machine's real trees and real
// /proc/stat — and it still does not exercise daemon.ts.
//
// WHO COVERS IT: a `butchr_capacity` reading taken before and after a real
// daemon restart on this machine, with this branch installed, pasted into the
// PR. That is acceptance criterion 1 on KAN-204 and it is deliberately not
// automatable from here — the state it observes exists only in a live process
// in the minute after a restart, which is the same seam that let the KAN-201
// PR pass while the deployment regressed.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # remove the bound: in src/capacity.ts, make computeCapacity ignore it —
//   #   const coresBound = null;
//   npm run build && node scripts/verify-cost-estimate-plausibility.mjs
//   # section 3 fails and the script exits 1. Then remove the other half:
//   #   in src/daemon.ts delete the restoreCostEstimate() call, or in
//   #   src/agent-cost-store.ts make loadCostEstimate() return null always
//   npm run build && node scripts/verify-cost-estimate-plausibility.mjs
//   # section 4 fails too. `git checkout src/ && npm run build` to come back.
//
// Usage:
//   cd daemon && npm run build
//   # strongly recommended: the pre-change build, so section 5 falsifies this
//   # battery against the real old code rather than a reconstruction of it
//   git show $(git merge-base HEAD origin/main):daemon/src/capacity.ts > /tmp/kan204-old-capacity.ts
//   mkdir -p /tmp/kan204-unfixed && cp -r src/* /tmp/kan204-unfixed/ \
//     && cp /tmp/kan204-old-capacity.ts /tmp/kan204-unfixed/capacity.ts \
//     && npx tsc --outDir dist-unfixed --rootDir /tmp/kan204-unfixed /tmp/kan204-unfixed/capacity.ts
//   node scripts/verify-cost-estimate-plausibility.mjs dist dist-unfixed
//
// Section 5 falls back to an inline reconstruction of the unbounded divisor
// when the pre-change build is not supplied, and says which it used.

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
  boundCoresByObservedCpu,
  readMachineFacts,
  humanReserveCores,
  MEASURED_AGENT_COST,
  HERDR_OVERHEAD_CORES,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { dampCost, ALPHA_DOWN } = await import(path.join(distDir, 'agent-cost-damping.js'));
const { saveCostEstimate, loadCostEstimate, clearCostEstimate, COST_ESTIMATE_MAX_AGE_MS } =
  await import(path.join(distDir, 'agent-cost-store.js'));
const { sampleProcesses, groupByAgent, measureAgentCost } = await import(
  path.join(distDir, 'agent-cost.js')
);
const { supervisorPredicate } = await import('./lib/supervisor-types.mjs');
// KAN-276: measureAgentCost has no default answer for "which trees are
// chargeable" — see lib/supervisor-types.mjs for why it must be asked.
const { isSupervisor } = await supervisorPredicate(distDir);

// The pre-change model, if it was built. `computeCapacity` is pure, so the old
// formula can be handed the exact facts the new one saw.
let oldComputeCapacity = null;
if (unfixedDir) {
  try {
    ({ computeCapacity: oldComputeCapacity } = await import(path.join(unfixedDir, 'capacity.js')));
  } catch (e) {
    console.log(`(could not load the unfixed build from ${unfixedDir}: ${e.message})`);
  }
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const MIB = 1024 ** 2;

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

/**
 * The unbounded divisor, as it stood before this change: whatever the estimate
 * published, believed. Used by section 5 when no pre-change build was supplied,
 * and it is deliberately the smallest possible reconstruction — the two lines
 * of arithmetic the bound sits in front of.
 */
const reconstructedOldCapacity = (machine, running, options = {}) => {
  const cost = options.overrides?.cores ?? options.measured?.cores ?? MEASURED_AGENT_COST.cores;
  const reserved = humanReserveCores(machine.cores);
  const busy =
    typeof machine.busyCores === 'number'
      ? Math.max(0, Math.min(machine.cores, machine.busyCores))
      : Math.max(0, Math.min(machine.cores, machine.load1));
  return {
    cost: { cores: cost },
    liveCoresBound: null,
    capByCpu: Math.floor(Math.max(0, machine.cores - reserved - HERDR_OVERHEAD_CORES) / cost),
    headroomByCpu: Math.max(0, Math.floor((machine.cores - busy - reserved) / cost))
  };
};
const oldModel = oldComputeCapacity ?? reconstructedOldCapacity;
const oldModelName = oldComputeCapacity
  ? `the pre-change build in ${unfixedDir}`
  : 'an inline reconstruction of the pre-change divisor (no unfixed build supplied)';

// --------------------------------------------------------------- 1. walk --
rule('1. THE WALK — what the damping publishes for 25 minutes after a restart');

// The machine the ticket was filed from, so the arithmetic below reproduces
// the figures on it. Nothing live here: this section is the filter's step
// response, which is arithmetic and has no machine in it.
const LAPTOP = {
  cores: 4,
  totalBytes: 15.4 * GIB,
  availableBytes: 7.3 * GIB,
  load1: 3.3,
  busyCores: 1.94,
  busyWindowSeconds: 3
};
// What this fleet actually costs, from the range the ticket records for the
// same fleet doing the same work earlier the same day (0.037–0.094).
const TRUE_CORES = 0.05;
const TRUE_RESIDENT = 680 * MIB;
const FLEET = 5;

console.log(
  `a fleet of ${FLEET} agent trees that truly cost ${TRUE_CORES} core each (${(TRUE_CORES * FLEET).toFixed(2)}\n` +
  `cores of agent CPU) on a ${LAPTOP.cores}-core machine reporting ${LAPTOP.busyCores} cores busy in total.\n` +
  `The daemon restarts at window 0 and the filter seeds from ${MEASURED_AGENT_COST.cores} (ALPHA_DOWN=${ALPHA_DOWN},\n` +
  'one 60s window per row).\n'
);
console.log('  window  minutes  published  implied fleet cpu  possible?   cap  cpu headroom (unbounded → bounded)');
console.log('  ------  -------  ---------  -----------------  ---------   ---  ---------------------------------');

let est = { residentBytes: MEASURED_AGENT_COST.residentBytes, cores: MEASURED_AGENT_COST.cores };
const sample = { residentBytes: TRUE_RESIDENT, cores: TRUE_CORES };
let windowsUntilPlausible = null;
let windowsUntilNearTrue = null;
const walk = [];
for (let w = 0; w <= 25; w++) {
  if (w > 0) est = dampCost(est, sample);
  const published = Math.round(est.cores * 1000) / 1000;
  const measured = {
    residentBytes: est.residentBytes,
    cores: published,
    sampledAt: Date.now(),
    windowSeconds: 60,
    agentTrees: FLEET
  };
  const opts = { measured, supervisorsRunning: 0 };
  const fixed = computeCapacity(LAPTOP, FLEET, opts);
  const unfixed = oldModel(LAPTOP, FLEET, opts);
  const implied = published * FLEET;
  const possible = implied <= LAPTOP.busyCores;
  if (possible && windowsUntilPlausible === null) windowsUntilPlausible = w;
  if (published <= TRUE_CORES * 2 && windowsUntilNearTrue === null) windowsUntilNearTrue = w;
  walk.push({
    w,
    published,
    implied,
    possible,
    cap: fixed.cap,
    capByCpu: fixed.capByCpu,
    oldCapByCpu: unfixed.capByCpu,
    unboundedHeadroom: unfixed.headroomByCpu,
    boundedHeadroom: fixed.headroomByCpu
  });
  if (w <= 5 || w % 5 === 0) {
    console.log(
      `  ${String(w).padStart(6)}  ${String(w).padStart(7)}  ${published.toFixed(3).padStart(9)}  ` +
      `${implied.toFixed(2).padStart(17)}  ${(possible ? 'yes' : 'NO').padStart(9)}   ` +
      `${String(fixed.cap).padStart(3)}  ` +
      `${String(unfixed.headroomByCpu).padStart(15)} → ${fixed.headroomByCpu}`
    );
  }
}

const memoryCap = computeCapacity(LAPTOP, FLEET, {
  measured: {
    residentBytes: TRUE_RESIDENT,
    cores: TRUE_CORES,
    sampledAt: Date.now(),
    windowSeconds: 60,
    agentTrees: FLEET
  }
}).capByMemory;
console.log(
  `\n  the warm answer, once the walk finishes: memory allows ${memoryCap}, which is what this\n` +
  '  machine reported as its cap before KAN-201 deployed. The cap column above is what a reader\n' +
  '  of the board actually saw for the whole of that walk, and it is the same column with or\n' +
  '  without the bound — the bound governs the live term, nothing else.\n' +
  `\n  windows before the published estimate stops asserting the impossible: ${windowsUntilPlausible}` +
  `\n  windows before it is within 2x of the truth: ${windowsUntilNearTrue}` +
  ` (${windowsUntilNearTrue} minutes)`
);

verdict(
  windowsUntilNearTrue !== null && windowsUntilNearTrue >= 15 && walk[0].cap <= 3,
  `the ticket's claim reproduces: from the seed the estimate needs ${windowsUntilNearTrue} windows to come\n` +
    `    within 2x of the truth, and the cap it produces on arrival is ${walk[0].cap} against a warm answer of ${memoryCap}.\n` +
    '    That is the regression — cap 19 bound by memory becoming cap 3 bound by cpu — in arithmetic.\n' +
    '    Nothing in section 3 fixes this column; the cap is fixed by carrying the estimate across the\n' +
    '    restart at all, which is section 4.',
  `the walk did not reproduce the regression: ${windowsUntilNearTrue} windows to converge, ` +
    `first cap ${walk[0].cap}. Either ALPHA_DOWN or the seed changed, and this script's premise ` +
    'no longer describes the code — re-derive it before trusting any section below.'
);

const impossibleWindows = walk.filter((r) => !r.possible);
const relieved = impossibleWindows.filter((r) => r.boundedHeadroom > r.unboundedHeadroom);
const capsUnmoved = walk.every((r) => r.capByCpu === r.oldCapByCpu);
verdict(
  relieved.length > 0 && capsUnmoved,
  `and while the estimate is asserting the impossible — ${impossibleWindows.length} of the ${walk.length} windows — the live\n` +
    `    term declines to divide by it: cpu headroom is relieved in ${relieved.length} of those windows. The cap column is\n` +
    '    byte-identical to the unfixed model in every window, which is the point: the bound touches the\n' +
    '    live term only, so the static cap stays a property of the hardware.',
  capsUnmoved
    ? `the bound never relieved the live term in any of the ${impossibleWindows.length} windows where the estimate ` +
      `asserted more CPU than the machine reported busy. It is not firing.`
    : 'the bound moved capByCpu. The static cap must not depend on an instantaneous busy reading — ' +
      'see capacity.ts\'s header, and verify-agent-capacity.mjs section 8, which encodes it.'
);

// ---------------------------------------------------------- 2. invariant --
rule('2. THE INVARIANT, ON THIS MACHINE — real trees, a real /proc/stat window');

// Nothing invented in this section. The tree count is whatever is running on
// this machine right now, and the busy figure is a window this script closed.
readMachineFacts(); // opens the /proc/stat baseline; one reading measures no rate
const liveMeasurement = await measureAgentCost(5, isSupervisor);
const liveFacts = readMachineFacts();
const liveTrees = groupByAgent(sampleProcesses()).size;

const haveLive =
  typeof liveFacts.busyCores === 'number' && liveTrees > 0 && liveMeasurement.totals.agents > 0;
console.log(
  `this machine: ${liveFacts.cores} cores, ${liveTrees} agent tree(s) running\n` +
  `  cores in use (measured over ${liveFacts.busyWindowSeconds?.toFixed(1) ?? '—'}s): ` +
  `${typeof liveFacts.busyCores === 'number' ? liveFacts.busyCores.toFixed(2) : '(none)'}\n` +
  `  what those trees actually cost, over a ${liveMeasurement.elapsed.toFixed(1)}s window: ` +
  `${(liveMeasurement.totals.cores / Math.max(1, liveMeasurement.totals.agents)).toFixed(3)} core each ` +
  `(${liveMeasurement.totals.cores.toFixed(2)} cores across the fleet)\n`
);

if (!haveLive) {
  console.log(
    '  no live reading available (no /proc/stat window, or no agent trees on this machine).\n' +
    '  This section cannot run here; the sections that supply their own facts still can.'
  );
} else {
  // Two windows after a restart, the unfixed daemon publishes this. It is not
  // a number this script chose — it is dampCost applied twice from the shipped
  // seed, which is what the shipped daemon does.
  let warmup = { residentBytes: MEASURED_AGENT_COST.residentBytes, cores: MEASURED_AGENT_COST.cores };
  const trueSample = {
    residentBytes: liveMeasurement.totals.residentMb * MIB / liveMeasurement.totals.agents,
    cores: liveMeasurement.totals.cores / liveMeasurement.totals.agents
  };
  warmup = dampCost(dampCost(warmup, trueSample), trueSample);
  const warmupCores = Math.round(warmup.cores * 1000) / 1000;
  const impliedNow = warmupCores * liveTrees;

  console.log(
    `  two damping windows after a restart the daemon would publish ${warmupCores} core/tree, and\n` +
    `  label it \`measured\`. Against the ${liveTrees} trees actually on this machine that asserts\n` +
    `  ${impliedNow.toFixed(2)} cores of agent CPU, on a machine reporting ${liveFacts.busyCores.toFixed(2)} cores busy in TOTAL —\n` +
    '  human, browser, herdr and all. The fleet is a subset of what is busy, so this is not\n' +
    '  an unlikely reading; it is an impossible one.\n'
  );

  const bound = boundCoresByObservedCpu(warmupCores, liveTrees, liveFacts.busyCores);
  verdict(
    impliedNow > liveFacts.busyCores && bound !== null && bound.used < warmupCores,
    `the invariant catches it on this machine's own numbers: ${warmupCores} × ${liveTrees} = ` +
      `${impliedNow.toFixed(2)} > ${liveFacts.busyCores.toFixed(2)},\n` +
      `    so the divisor is bounded to ${bound?.used.toFixed(3)} — which still charges the fleet for every busy\n` +
      '    core on this machine, so it remains an over-estimate of what one agent costs.',
    impliedNow <= liveFacts.busyCores
      ? `this machine is too busy to falsify the warm-up estimate right now (${impliedNow.toFixed(2)} implied ` +
        `vs ${liveFacts.busyCores.toFixed(2)} busy). The invariant is sound but this run did not exercise it; ` +
        'section 3 does, on supplied facts.'
      : `the invariant did NOT fire on an estimate asserting ${impliedNow.toFixed(2)} cores against ` +
        `${liveFacts.busyCores.toFixed(2)} busy. boundCoresByObservedCpu returned ${JSON.stringify(bound)}.`
  );

  // And the honest half of the same comparison: the bound must NOT fire on the
  // figure a warm sampler produces from this same fleet.
  const trueCores = Math.round(trueSample.cores * 1000) / 1000;
  const warmBound = boundCoresByObservedCpu(trueCores, liveTrees, liveFacts.busyCores);
  verdict(
    warmBound === null,
    `and it leaves the warm figure alone: ${trueCores} × ${liveTrees} = ` +
      `${(trueCores * liveTrees).toFixed(2)} ≤ ${liveFacts.busyCores.toFixed(2)}, so a real\n` +
      '    measurement of this fleet passes the invariant untouched. The bound is a falsifier, not a cap on\n' +
      '    the estimate.',
    `the bound fired on a real measurement of this fleet (${trueCores} core/tree over ` +
      `${liveTrees} trees against ${liveFacts.busyCores.toFixed(2)} busy). It is not a falsifier, it is ` +
      'a second estimator, and it will fight the sampler forever.'
  );
}

// -------------------------------------------------------------- 3. bound --
rule('3. THE BOUND — every case it must fire on, and every case it must not');

// A machine held constant so the only variable is the estimate and the fleet.
const M = { cores: 4, totalBytes: 16 * GIB, availableBytes: 8 * GIB, load1: 3.5, busyCores: 2.0, busyWindowSeconds: 3 };
const measuredAt = Date.now();
const asMeasured = (cores, trees, provenance) => ({
  residentBytes: 680 * MIB,
  cores,
  sampledAt: measuredAt,
  windowSeconds: 60,
  agentTrees: trees,
  ...(provenance ? { provenance } : {})
});

const CASES = [
  {
    name: 'seed, mid warm-up, 5 trees',
    facts: M,
    running: 5,
    options: { measured: asMeasured(0.617, 5) },
    fires: true,
    why: '0.617 × 5 = 3.09 cores claimed against 2.00 busy'
  },
  {
    name: 'warm measurement, 5 trees',
    facts: M,
    running: 5,
    options: { measured: asMeasured(0.06, 5) },
    fires: false,
    why: '0.06 × 5 = 0.30 ≤ 2.00 — a plausible estimate is believed'
  },
  {
    name: 'exactly at the bound',
    facts: M,
    running: 4,
    options: { measured: asMeasured(0.5, 4) },
    fires: false,
    why: '0.5 × 4 = 2.00, equal to busy — equality is possible, so it is believed'
  },
  {
    name: 'operator override, implausible',
    facts: M,
    running: 5,
    options: { overrides: { cores: 0.9 }, measured: asMeasured(0.06, 5) },
    fires: false,
    why: 'someone typed 0.9 into their environment; a fleet that argues with its operator gets turned off'
  },
  {
    name: 'load-average fallback, implausible',
    facts: { ...M, busyCores: null, busyWindowSeconds: null },
    running: 5,
    options: { measured: asMeasured(0.617, 5) },
    fires: false,
    why: 'busyCores is min(load1, cores), not a measurement — it cannot falsify one'
  },
  {
    name: 'no agents running',
    facts: M,
    running: 0,
    options: { measured: asMeasured(0.617, 0) },
    fires: false,
    why: 'nothing to multiply by; the estimate asserts nothing about an empty fleet'
  },
  {
    // This case asserted the opposite until KAN-276, and the assertion moved
    // because the quantity underneath it did. `cost.cores` was the average over
    // *every* claude tree, so multiplying it by every tree — supervisors
    // included — was a sound claim about total fleet CPU, and 0.617 × 6 = 3.70
    // against 2.00 busy was a genuine contradiction. It is now the cost of a
    // **task agent** specifically, measured at ~14x what a supervisor spends,
    // so multiplying it by 6 would claim a fleet CPU the estimate never
    // asserted and manufacture a contradiction out of the arithmetic.
    //
    // The trade-off is real and is the reason this comment is long: the bound
    // now fires less often, so it catches a post-restart fiction less often
    // too, which is what KAN-204 built it for. That is accepted because it
    // errs toward the *larger* divisor — here headroom 1 where the old model
    // said 3 — and because KAN-204's primary fix, carrying the estimate across
    // the restart so there is no fiction to catch, is untouched and is proved
    // by section 4.
    name: 'supervisors alongside one task agent',
    facts: M,
    running: 1,
    options: { measured: asMeasured(0.617, 1), supervisorsRunning: 5 },
    fires: false,
    why: 'the estimate is per *task* agent since KAN-276: 0.617 × 1 = 0.62, under 2.00 busy'
  },
  {
    // The other half of the same rule, so the case above is evidence that the
    // multiplication counts task agents rather than evidence that the bound
    // has been quietly disabled: same supervisors, same busy machine, a task
    // fleet large enough for the estimate to contradict it on its own.
    name: 'task fleet large enough to contradict',
    facts: M,
    running: 6,
    options: { measured: asMeasured(0.617, 6), supervisorsRunning: 5 },
    fires: true,
    why: 'six task agents at 0.617 = 3.70 against 2.00 busy — the estimate still loses to the machine'
  },
  {
    name: 'idle machine, zero busy',
    facts: { ...M, busyCores: 0 },
    running: 5,
    options: { measured: asMeasured(0.617, 5) },
    fires: false,
    why: 'bounding to 0 ÷ 5 would divide by zero; the larger divisor is the safe answer'
  },
  {
    name: 'restored estimate, implausible',
    facts: M,
    running: 5,
    options: { measured: asMeasured(0.617, 5, 'restored') },
    fires: true,
    why: 'a restored figure gets no more benefit of the doubt than a fresh one'
  }
];

console.log('  case                                  fires  cost.cores  live divisor  capByCpu  why');
console.log('  ------------------------------------  -----  ----------  ------------  --------  ---');
for (const c of CASES) {
  const got = computeCapacity(c.facts, c.running, c.options);
  const fired = got.liveCoresBound !== null;
  const published = c.options.overrides?.cores ?? c.options.measured.cores;
  const liveDivisor = got.liveCoresBound ? got.liveCoresBound.used : got.cost.cores;
  console.log(
    `  ${c.name.padEnd(36)}  ${(fired ? 'yes' : 'no').padStart(5)}  ` +
    `${got.cost.cores.toFixed(3).padStart(10)}  ${liveDivisor.toFixed(3).padStart(12)}  ` +
    `${String(got.capByCpu).padStart(8)}  ${c.why}`
  );
  if (fired !== c.fires) {
    failures.push(
      `case "${c.name}": expected the bound to ${c.fires ? 'fire' : 'stay out of it'} and it ` +
      `${fired ? 'fired' : 'did not'}. ${c.why}`
    );
  }
  // The cost figure the report prints, and every static term, must be the
  // estimate — untouched, whether the bound fired or not.
  if (Math.abs(got.cost.cores - published) > 1e-9) {
    failures.push(
      `case "${c.name}": cost.cores moved, ${published} → ${got.cost.cores}. The bound governs the live ` +
      'term only; moving the published cost figure moves the static cap with it.'
    );
  }
  // And the static cap must be exactly what it would be with no bound at all.
  const capWithoutBound = Math.floor(
    Math.max(0, c.facts.cores - humanReserveCores(c.facts.cores) - HERDR_OVERHEAD_CORES) / published
  );
  if (got.capByCpu !== capWithoutBound) {
    failures.push(
      `case "${c.name}": capByCpu is ${got.capByCpu} where the unbounded estimate gives ` +
      `${capWithoutBound}. The static cap must not move with an instantaneous busy reading — that is ` +
      'KAN-34, and verify-agent-capacity.mjs section 8 encodes it.'
    );
  }
  // The live divisor may only ever go down, never up.
  if (liveDivisor > published + 1e-9) {
    failures.push(
      `case "${c.name}": the live divisor went UP, from ${published} to ${liveDivisor}. The bound may ` +
      'only ever lower it; raising it is a throttle nobody asked for.'
    );
  }
  if (!fired && Math.abs(liveDivisor - published) > 1e-9) {
    failures.push(
      `case "${c.name}": the bound did not fire but the live divisor moved, ${published} → ${liveDivisor}.`
    );
  }
}
verdict(
  failures.length === 0,
  `all ${CASES.length} cases behaved: the bound fires exactly when the estimate asserts more CPU than the\n` +
    '    machine reports in use, is skipped for an override and for the load-average fallback, never raises\n' +
    '    the live divisor, and in every single case leaves cost.cores and capByCpu exactly as the\n' +
    '    unbounded estimate would have them.',
  'the bound fired (or failed to fire) on a case it should not have, or it reached the static cap — ' +
    'see the entries above.'
);

// The derivation has to say so, or the cap divides by a figure it does not print.
rule('   (and the derivation says it, so the cap stays reproducible by hand)');
const boundedCapacity = computeCapacity(M, 5, { measured: asMeasured(0.617, 5) });
console.log(describeCapacity(boundedCapacity));
const text = describeCapacity(boundedCapacity);
verdict(
  text.includes('contradicted') &&
    text.includes('0.617') &&
    text.includes(String(boundedCapacity.liveCoresBound.agentTrees)) &&
    text.includes(boundedCapacity.liveCoresBound.busyCores.toFixed(2)) &&
    text.includes(boundedCapacity.liveCoresBound.used.toFixed(3)),
  'the derivation prints the estimate that was contradicted, the tree count, the busy figure that\n' +
    '    contradicted it, and the figure the headroom line then divided by — so a reader can re-run both\n' +
    '    the comparison and the division rather than take either on trust.',
  'the derivation does not disclose the bound. A term that divides by a figure other than the one the ' +
    'report prints is the hand-reproducibility promise broken, and it breaks it silently.'
);

// ------------------------------------------------------------ 4. restart --
rule('4. THE RESTART — the real store, round-tripped, and what it refuses');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan204-'));
const storeFile = path.join(tmpDir, 'agent-cost.json');

// The estimate a warm daemon would have been publishing when the deploy landed.
const warm = asMeasured(0.06, 5);
const saved = saveCostEstimate(warm, storeFile);
const restored = loadCostEstimate(storeFile);

console.log(
  `  published before the restart: ${warm.cores} core/tree over ${warm.agentTrees} trees\n` +
  `  written to ${storeFile}: ${saved}\n` +
  `  read back: ${restored ? `${restored.cores} core/tree, provenance='${restored.provenance}'` : 'null'}\n`
);

verdict(
  saved && restored !== null && restored.cores === warm.cores &&
    restored.residentBytes === warm.residentBytes && restored.provenance === 'restored',
  "the estimate survives the round trip intact and comes back labelled 'restored' — not 'measured',\n" +
    '    because the daemon publishing it did not take it.',
  `the round trip lost or mislabelled the estimate: saved=${saved}, restored=${JSON.stringify(restored)}.`
);

// The whole point: what the cap is, in the minute after a restart, with and
// without the estimate having been carried across.
//
// When the store fails to return anything, these fall through to exactly what
// the daemon falls through to — the seed — rather than throwing. A proof whose
// response to the defect it is looking for is a stack trace reports a broken
// script; what the reader needs to see is the collapse.
const restoredOrSeed = restored ?? MEASURED_AGENT_COST;
const coldStart = computeCapacity(LAPTOP, FLEET, { measured: null, supervisorsRunning: 0 });
const restoredStart = computeCapacity(LAPTOP, FLEET, { measured: restored, supervisorsRunning: 0 });
const warmBefore = computeCapacity(LAPTOP, FLEET, { measured: warm, supervisorsRunning: 0 });
// And one window later: damping resumes from the restored figure rather than
// from the seed, which is the half of the fix that outlives the first minute.
const resumedEstimate = dampCost(
  { residentBytes: restoredOrSeed.residentBytes, cores: restoredOrSeed.cores },
  { residentBytes: TRUE_RESIDENT, cores: TRUE_CORES }
);
const resumed = computeCapacity(LAPTOP, FLEET, {
  measured: asMeasured(Math.round(resumedEstimate.cores * 1000) / 1000, FLEET),
  supervisorsRunning: 0
});
const coldResumed = computeCapacity(LAPTOP, FLEET, {
  measured: asMeasured(
    Math.round(dampCost(MEASURED_AGENT_COST, { residentBytes: TRUE_RESIDENT, cores: TRUE_CORES }).cores * 1000) / 1000,
    FLEET
  ),
  supervisorsRunning: 0
});

console.log('  moment                                    divisor   capByCpu  cap  bound by');
console.log('  ----------------------------------------  --------  --------  ---  --------');
const row = (label, c) =>
  console.log(
    `  ${label.padEnd(40)}  ${c.cost.cores.toFixed(3).padStart(8)}  ${String(c.capByCpu).padStart(8)}  ` +
    `${String(c.cap).padStart(3)}  ${c.capBoundBy}`
  );
row('before the restart (warm)', warmBefore);
row('after, estimate NOT carried across', coldStart);
row('after, estimate carried across', restoredStart);
row('one window later, from the seed', coldResumed);
row('one window later, resumed from restored', resumed);

verdict(
  restoredStart.cap >= warmBefore.cap && restoredStart.cap > coldStart.cap,
  `the cap does not collapse across the restart: ${warmBefore.cap} before, ${restoredStart.cap} after. Without the\n` +
    `    estimate being carried across it would have been ${coldStart.cap}${coldStart.coresBound ? ' (and that is WITH the bound already softening it)' : ''}.`,
  `the cap collapsed across the restart anyway: ${warmBefore.cap} before, ${restoredStart.cap} after ` +
    `(cold start would give ${coldStart.cap}). Carrying the estimate across is not doing what it is for.`
);
verdict(
  resumed.cap > coldResumed.cap,
  `and the damping resumes from it rather than restarting the walk: one window after the restart the\n` +
    `    resumed filter publishes ${resumed.cost.cores} (cap ${resumed.cap}), where a filter reseeded from the\n` +
    `    constant publishes ${coldResumed.cost.cores} (cap ${coldResumed.cap}) and has 20-odd windows still to walk.`,
  `damping did not resume from the restored estimate: resumed cap ${resumed.cap} vs cold ${coldResumed.cap}. ` +
    'The estimate is being published but not fed back into the filter, so the walk still happens, ' +
    'one minute later.'
);

rule('   (what the store refuses, and why each refusal is safe)');
const REJECTIONS = [
  {
    name: 'no file at all',
    write: () => clearCostEstimate(storeFile),
    why: 'a machine that has never run a daemon; the seed is the only honest answer'
  },
  {
    name: 'unparseable',
    write: () => fs.writeFileSync(storeFile, '{not json'),
    why: 'a torn write; the previous estimate is gone and inventing one is worse than the seed'
  },
  {
    name: 'older than the max age',
    write: () =>
      fs.writeFileSync(
        storeFile,
        JSON.stringify({ ...warm, sampledAt: Date.now() - COST_ESTIMATE_MAX_AGE_MS - 1000 })
      ),
    why: 'a machine that has been off; that fleet was doing different work'
  },
  {
    name: 'dated in the future',
    write: () =>
      fs.writeFileSync(storeFile, JSON.stringify({ ...warm, sampledAt: Date.now() + 3600_000 })),
    why: 'the clock moved, so the age test cannot be trusted either'
  },
  {
    name: 'cores missing',
    write: () => fs.writeFileSync(storeFile, JSON.stringify({ ...warm, cores: undefined })),
    why: 'half an estimate is not an estimate'
  },
  {
    name: 'cores zero',
    write: () => fs.writeFileSync(storeFile, JSON.stringify({ ...warm, cores: 0 })),
    why: 'the cap would divide by it'
  },
  {
    name: 'more memory than the machine has',
    write: () =>
      fs.writeFileSync(storeFile, JSON.stringify({ ...warm, residentBytes: 64 * GIB })),
    why: 'the same ceiling a live window has to pass'
  }
];
console.log('  written                              loaded  why null is the safe answer');
console.log('  -----------------------------------  ------  ---------------------------');
for (const r of REJECTIONS) {
  r.write();
  const got = loadCostEstimate(storeFile, Date.now(), 16 * GIB);
  console.log(`  ${r.name.padEnd(35)}  ${(got === null ? 'null' : 'VALUE').padStart(6)}  ${r.why}`);
  if (got !== null) {
    failures.push(
      `the store accepted "${r.name}" and returned ${JSON.stringify(got)}. Every one of these must ` +
      'degrade to the seed, which is the behaviour that predates this file.'
    );
  }
}
verdict(
  !failures.some((f) => f.startsWith('the store accepted')),
  `all ${REJECTIONS.length} malformed or stale records were refused, so every failure of the store degrades to\n` +
    '    the pre-KAN-204 behaviour rather than to a new one.',
  'the store accepted a record it should have refused — see above.'
);
fs.rmSync(tmpDir, { recursive: true, force: true });

// ------------------------------------------------------- 5. can it fail? --
rule('5. CAN THIS BATTERY FAIL? — sections 3 and 4 against the pre-change build');

console.log(`  falsifying against: ${oldModelName}\n`);

// Section 3's firing cases, through the old model. Every one of them must come
// back unbounded there, and every one must throttle the live term harder than
// the fixed model does — if the old code already declined to divide by an
// impossible estimate, section 3 is testing something that was never broken.
const firing = CASES.filter((c) => c.fires);
let oldBounded = 0;
let oldThrottled = 0;
for (const c of firing) {
  const got = oldModel(c.facts, c.running, c.options);
  if (got.liveCoresBound) oldBounded++;
  const fixed = computeCapacity(c.facts, c.running, c.options);
  if (got.headroomByCpu < fixed.headroomByCpu) oldThrottled++;
  // `?? cost.cores` rather than a bare dereference: when the fix is removed
  // this loop must still print a comparison and let the verdict below report
  // it, not die halfway through section 5 with a stack trace.
  const fixedDivisor = fixed.liveCoresBound?.used ?? fixed.cost.cores;
  console.log(
    `  ${c.name.padEnd(36)}  old: divisor ${got.cost.cores.toFixed(3)}, cpu headroom ${got.headroomByCpu}` +
    `  →  fixed: divisor ${fixedDivisor.toFixed(3)}, cpu headroom ${fixed.headroomByCpu}`
  );
}
verdict(
  oldBounded === 0 && oldThrottled === firing.length,
  `section 3's battery FAILS against the pre-change model: none of its ${firing.length} firing cases is bounded there,\n` +
    '    and every one of them throttles the live cpu term harder than the fixed model does. The battery\n' +
    '    can tell the two apart, which is the only thing that makes its green mean anything.',
  `section 3's battery does NOT distinguish the pre-change model: ${oldBounded} case(s) already bounded, ` +
    `${oldThrottled} of ${firing.length} throttled. Either the falsifier is not the old code, or the battery ` +
    'would pass with the fix removed — in which case it proves nothing.'
);

// And section 4's half: the store is new, so the pre-change build has no such
// module. A build that does have one is not the pre-change build.
let oldStore = null;
if (unfixedDir) {
  try {
    oldStore = await import(path.join(unfixedDir, 'agent-cost-store.js'));
  } catch {
    oldStore = null;
  }
}
const coldVsRestored = coldStart.cap < restoredStart.cap;
verdict(
  coldVsRestored && (!unfixedDir || oldStore === null),
  'and section 4 distinguishes them too: with no estimate carried across — which is precisely what\n' +
    `    the pre-change daemon does, having no store to carry it in — the cap is ${coldStart.cap} against ${restoredStart.cap}.` +
    (unfixedDir ? '\n    The pre-change build has no agent-cost-store module at all, as it should not.' : ''),
  oldStore !== null
    ? 'the pre-change build already has an agent-cost-store module, so it is not the pre-change build ' +
      'and section 5 is falsifying against the wrong thing.'
    : `section 4 does not distinguish a restart that carries the estimate from one that does not ` +
      `(${coldStart.cap} vs ${restoredStart.cap}).`
);

// ------------------------------------------------------------- verdict ----
rule('VERDICT');
if (failures.length === 0) {
  console.log(
    'PASS — the estimate cannot assert more CPU than the machine reports in use, it survives a\n' +
    'restart, and this battery has been shown to fail against the code that lacked both.\n\n' +
    'Still uncovered here, and covered by the live reading pasted in the PR: that the running\n' +
    'daemon actually calls saveCostEstimate on publish and restoreCostEstimate before its first\n' +
    'window. Nothing in this file starts a daemon. See the header.'
  );
} else {
  console.log(`FAIL — ${failures.length} problem(s):\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
}
process.exit(failures.length ? 1 : 0);
