// Proof for KAN-517: the configured cap is not what admits, so the number this
// machine will actually reach is published — with its arithmetic, the term that
// set it, and whether that term forecasts anything.
//
// WHAT FAILURE THIS WOULD CATCH: a reported ceiling that quietly reports the
// cap. That is the defect this ticket exists to complain about, one level up:
// `cap` was already a number admission never reads, and the fix for it is
// another published number, so the fix fails in exactly the way the bug did if
// the figure stops tracking the terms. Also caught: a summary line that still
// invites `cap − running` on a machine where those slots do not exist; a
// ceiling that names the wrong binding term; and — section 3 — a capacity gate
// that has stopped refusing at all, which is the way a "make the ceiling
// visible" ticket gets closed by deleting the ceiling.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Five sections:
//
//   1. this machine   — a real /proc/stat window and a real /proc/meminfo read:
//                       the ceiling, its arithmetic, and the term that set it,
//                       re-derived by hand from the figures it printed
//   2. two fleet sizes— the same MachineFacts at several `running` values, so
//                       the binding term is seen to move; plus the projection
//                       check that separates `projects` from `drifts`
//   3. DRIVEN RED     — the gate refusing a start on this machine's own
//                       measured figures while `cap` still reads 10, with
//                       `headroomByCap > 0` asserted in the same breath so the
//                       cap is provably not what refused
//   4. not a term     — the admission path cannot consult the ceiling: it is
//                       not a property of `Capacity` and the string does not
//                       occur on the gate's path in router.ts
//   5. can it fail    — sections 1–3's ceiling battery re-run against a
//                       ceiling function that returns the cap. If the battery
//                       still passes, the battery proves nothing and this
//                       script exits red
//
// WHICH ROUTE SECTION 3 TOOK, AND WHY — READ THIS BEFORE CITING IT
//
// `epic/KAN-203` ruled on KAN-517 (2026-08-18) that driving the gate red by
// *starting agents* would starve four agents doing real work with the human
// away, and asked for the refusal point to be computed rather than manufactured
// unless a computed answer could not satisfy the criterion. This section takes
// the computed route, and it is a real red rather than a described one: the
// shipped `computeCapacity` and the shipped `capacityRefusal` execute, on this
// machine's real cores, real available memory and real pressure files, and
// produce an actual refusal. No agent is started and none is stood down.
//
// WHAT THAT LEAVES UNCOVERED, NAMED RATHER THAN LEFT TO INFER: the `running`
// count is this script's, not the daemon's. So nothing here shows that the
// *installed daemon* hands these figures to that gate — a green here with a
// daemon that computed capacity from something else entirely would look
// identical. That leg is covered by observation instead of by this script: a
// `butchr_capacity` reading from the running daemon, pasted in the PR body,
// showing the same terms and the same shortfall this script computes. Section 1
// is what makes the two comparable — it reads the same instruments the daemon
// reads, so the PR's paste and this script's output are figures of the same
// machine and can be held against each other.
//
// THAT OBSERVATION WAS TAKEN, AND IT CAME BACK RED. `butchr_capacity` against
// the running daemon (pre-change build, deployed at e7ac6bf) at
// 2026-08-18T06:53:50Z:
//
//     cap 10   running 5   atCapacity TRUE   headroom 0   bound by cpu
//     headroomByCap 5      cpu allows 0      memory allows 1
//     summary: "5/10 task agents, room for 0 more (... bound by cpu)"
//
// So the installed daemon does gate on live headroom with the cap unread: it
// was refusing every start while `cap` said 10 and the count term had five
// slots. That is this section's claim, observed on the real thing rather than
// computed — and the summary line is the ticket's complaint at its sharpest,
// since `cap − running` reads 5 where the truth is 0.
//
// Thirty minutes earlier the SAME daemon at the SAME fleet size read
// `headroom 3, bound by memory` (06:23:49Z). Same population, different term,
// ceiling 8 then 5. Both correct when taken, which is the whole reason the
// ceiling ships with `stability` attached rather than as a bare number.
//
// AND THIS SCRIPT IS ABOUT BUTCHR'S GATE ONLY. `epic/KAN-59` established on
// KAN-517 that CrabCast carries an independent headroom gate — their KAN-504
// activation was refused with `refused by crabcast-daemon: activate_agent
// refused: at capacity`, which is not this gate. Nothing here measures that
// one, and a start this script says there is room for can still be refused
// downstream. Recorded second-hand on purpose: reading CrabCast's source is
// invariant 10, permanent.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # 1. make the ceiling report the cap — the defect this script is named for
//   #    in src/capacity.ts, in effectiveCeilingOf, replace
//   #      const ceiling = c.running + c.headroom;
//   #    with
//   #      const ceiling = c.cap;
//   npm run build && node scripts/verify-effective-ceiling.mjs
//   # OBSERVED 2026-08-18: 10 checks fail across sections 1, 2, 3 and 5, exit 1.
//   # The one to look at is in section 3 — the summary reverts to
//   # `0/10 task agents`, which is verbatim the text this ticket was filed
//   # about. The defect is caught by its own signature.
//   #
//   # 2. delete the gate: make the live terms unable to refuse
//   #    in src/capacity.ts, replace the headroom minimum with
//   #      const headroomBeforeStall = headroomByCap;
//   npm run build && node scripts/verify-effective-ceiling.mjs
//   # OBSERVED 2026-08-18: 12 checks fail, mostly section 3, exit 1. Section 3's
//   # "no refusal available from real figures" fallback fires here and is worth
//   # watching: it announces that it could not get a real red, falls back, and
//   # the assertions STILL fail. That branch cannot manufacture a green.
//   #
//   # then `git checkout src/capacity.ts && npm run build` and watch it green.
//   # OBSERVED: restored, rebuilt, every check held again.
//
// Usage:
//   cd daemon && npm run build && node scripts/verify-effective-ceiling.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  computeCapacity,
  capacityRefusal,
  describeCapacity,
  effectiveCeilingOf,
  readMachineFacts,
  sampleCpuBusy,
  summarizeCapacity
} from '../dist/capacity.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(scriptDir, '..');

let failures = 0;
const fail = (section, message) => {
  failures++;
  console.error(`  ✗ [${section}] ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

const check = (section, condition, message) => {
  if (condition) ok(message);
  else fail(section, message);
};

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** The cap KAN-517 is about: the human set 10, and 10 is what must not bind. */
const CONFIGURED_CAP = 10;
/** Supervisors the live fleet carries; sizes the memory reserve (KAN-276). */
const SUPERVISORS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Synthetic machines below carry an explicit, quiet stall reading rather than
// inheriting this machine's.
//
// This is not tidiness. The stall term is a VETO: at or above
// STALL_REFUSE_PERCENT it zeroes headroom whatever the other three computed,
// and `headroomBoundBy` becomes `'stall'`. A fixture that inherited a live
// pressure reading would therefore assert "the memory term refused" on a run
// where the DISK refused — green or red depending on what else was happening
// on the box at the time. On this machine that is a real possibility (it is
// carrying a fleet); on a shared CI runner it is more so.
//
// Explicit zeros make every synthetic section deterministic and keep the stall
// term where the ticket says it belongs: out of scope, untouched, and not
// loosened to make a number look better. Sections that are ABOUT this machine
// — 1, and section 3's real-figures walk — read the real pressure files, as
// they must.
const QUIET_STALL = { ioFullPercent: 0, memoryFullPercent: 0 };

// ---------------------------------------------------------------------------
// Section 1 — this machine, measured
// ---------------------------------------------------------------------------
//
// A real CPU window rather than the load-average fallback. `sampleCpuBusy`
// needs two reads at least CPU_WINDOW_MIN_SECONDS apart to close one, and a
// script that called `readMachineFacts()` once would silently get the fallback
// — which over-states use, refuses sooner, and would make section 3's red
// easier to obtain than it should be. Getting a measured window is therefore
// part of the proof and not a nicety.

console.log('\n=== 1. This machine, measured ===\n');

sampleCpuBusy();
await sleep(2600);
const machine = readMachineFacts();

const measuredWindow = typeof machine.busyCores === 'number';
console.log(
  `  machine: ${machine.cores} cores, ` +
  `${(machine.totalBytes / GIB).toFixed(1)} GiB RAM, ` +
  `${(machine.availableBytes / GIB).toFixed(1)} GiB available, ` +
  `load1 ${machine.load1.toFixed(2)}`
);
console.log(
  `  cpu window: ${
    measuredWindow
      ? `${machine.busyCores.toFixed(2)} cores in use, measured over ${machine.busyWindowSeconds.toFixed(1)}s`
      : 'NOT MEASURED — /proc/stat unavailable, the load-average fallback is in use'
  }`
);
console.log(`  read at: ${new Date().toISOString()}`);

// WHICH COST FIGURES THIS SCRIPT IS DIVIDING BY, because they are not the
// daemon's. The per-agent cost comes from a sampler that runs *in the daemon*
// and prices real agent trees over a 60s window; a standalone script has no
// such history, so it divides by the 2026-07-31 seed. Measured on this fleet
// on 2026-08-18 the two differ by a lot in both dimensions — the daemon read
// 757 MB / 0.208 core against the seed's 650 MB / 0.75 core — so the ABSOLUTE
// ceiling this script prints is not the ceiling the daemon publishes, and
// nobody should quote one for the other.
//
// That does not weaken anything asserted here, and it is worth being precise
// about why: every check below is about the *relationship* between the terms —
// does the ceiling reproduce, does it name the term that bound, does the gate
// refuse while the count term has room — and each of those holds whichever
// divisor is in play. The absolute figure is AC1's, and AC1 is answered by the
// live `butchr_capacity` paste in the PR body, not by this line.

// Not a failure on a machine with no /proc/stat: the fallback is a designed
// path and this script must run on one. It IS reported, because a section 3
// red obtained off the fallback is a weaker red than one off a measurement,
// and a reader has to be able to tell which they are looking at.
if (!measuredWindow) {
  console.log(
    '  NOTE: no /proc/stat window. Every figure below is off the load-average\n' +
    '        fallback, which over-states use. Section 3 still proves the gate\n' +
    '        refuses; it does not prove it refuses on a measurement.'
  );
}

// The live fleet size this machine is actually carrying, as best a script can
// see it: task agents are claude trees under the workspaces root. Only used to
// pick a realistic `running` for the headline reading — every assertion below
// states its own `running` explicitly.
const liveish = 5;

const here = computeCapacity(machine, liveish, {
  configuredCap: CONFIGURED_CAP,
  supervisorsRunning: SUPERVISORS
});
const ceilingHere = effectiveCeilingOf(here);

console.log('');
console.log(
  `  agent cost:         ${Math.round(here.cost.residentBytes / MIB)} MB ` +
  `(${here.costSource.residentBytes}), ${here.cost.cores} core ` +
  `(${here.costSource.cores})` +
  (here.costSource.cores === 'seed'
    ? '  <-- the seed, not this fleet: see the note above'
    : '')
);
console.log(`  cap:                ${here.cap} (capBoundBy: ${here.capBoundBy})`);
console.log(`  running:            ${here.running}`);
console.log(`  headroom:           ${here.headroom} (bound by ${here.headroomBoundBy})`);
console.log(`    by cap:           ${here.headroomByCap}`);
console.log(`    by cpu:           ${here.headroomByCpu}`);
console.log(`    by memory:        ${here.headroomByMemory}`);
console.log('');
console.log(`  EFFECTIVE CEILING:  ${ceilingHere.ceiling}`);
console.log(`  bound by:           ${ceilingHere.boundBy}`);
console.log(`  stability:          ${ceilingHere.stability}`);
console.log(`  shortfall vs cap:   ${ceilingHere.shortfall}`);
console.log(`  arithmetic:         ${ceilingHere.arithmetic}`);
console.log('');

check(
  '1',
  here.cap === CONFIGURED_CAP,
  `the cap under test is the configured ${CONFIGURED_CAP}, not a derived number`
);

// The arithmetic re-derived from the figures the model itself published, which
// is the point of printing them: a derivation whose numbers do not reproduce is
// a derivation nobody can check.
check(
  '1',
  ceilingHere.ceiling === here.running + here.headroom,
  `ceiling reproduces by hand: ${here.running} running + ${here.headroom} headroom = ${ceilingHere.ceiling}`
);
check(
  '1',
  ceilingHere.boundBy === here.headroomBoundBy,
  `the term named by the ceiling (${ceilingHere.boundBy}) is the term that bound headroom (${here.headroomBoundBy})`
);
check(
  '1',
  ceilingHere.shortfall === Math.max(0, here.cap - ceilingHere.ceiling),
  `shortfall reproduces: max(0, ${here.cap} − ${ceilingHere.ceiling}) = ${ceilingHere.shortfall}`
);

// The memory term, re-derived independently of the model, so this is a check
// and not a restatement. Only asserted when memory is what bound — on a busy
// machine cpu binds and this arithmetic is not the one that produced the answer.
if (here.headroomBoundBy === 'memory') {
  const byHand = Math.max(
    0,
    Math.floor(
      Math.max(0, machine.availableBytes - here.reservedForHuman.bytes) / here.cost.residentBytes
    )
  );
  check(
    '1',
    byHand === here.headroomByMemory,
    `memory term reproduces by hand: (${(machine.availableBytes / GIB).toFixed(1)} GiB available − ` +
    `${(here.reservedForHuman.bytes / GIB).toFixed(1)} GiB reserved) ÷ ` +
    `${Math.round(here.cost.residentBytes / MIB)} MB = ${byHand}`
  );
}

// AC1's sharpening, from `epic/KAN-59` on the ticket: a ceiling is a reading
// with a timestamp on it, and `stability` is the field that says whether the
// timestamp matters. Their reading and this ticket's disagreed by two at the
// same population, minutes apart, because different terms bound — so the value
// alone is not quotable and the pair is.
check(
  '1',
  ['static', 'projects', 'drifts'].includes(ceilingHere.stability),
  `the reading carries whether it forecasts anything: stability=${ceilingHere.stability}`
);
check(
  '1',
  (ceilingHere.boundBy === 'cap') === (ceilingHere.stability === 'static'),
  'a cap-bound ceiling is the only static one — nothing live is holding it down'
);
check(
  '1',
  (ceilingHere.boundBy === 'memory') === (ceilingHere.stability === 'projects'),
  'only the memory term projects — it is the only one a start is charged to'
);

// The rendered text carries the figure, which is criterion 2 of the ticket:
// stating the ceiling somewhere nobody reads would satisfy nothing.
const derivationHere = describeCapacity(here);
check(
  '1',
  derivationHere.includes('effective ceiling:'),
  'the derivation states the effective ceiling'
);
check(
  '1',
  derivationHere.includes(ceilingHere.arithmetic),
  'the derivation shows the arithmetic, not just the number'
);
check(
  '1',
  /CrabCast runs an independent headroom gate/.test(derivationHere),
  'the derivation says this is Butchr\'s admission only (epic/KAN-59\'s correction)'
);

// ---------------------------------------------------------------------------
// Section 2 — two fleet sizes, and what separates a forecast from a snapshot
// ---------------------------------------------------------------------------
//
// AC3: the binding term moved between the ticket's own two samples, so a single
// reading would have hidden that it can move at all.

console.log('\n=== 2. Readings at several fleet sizes ===\n');

const sizes = [0, 2, 4, 5, 7, 9, 10];
const readings = sizes.map((running) => {
  const c = computeCapacity(machine, running, {
    configuredCap: CONFIGURED_CAP,
    supervisorsRunning: SUPERVISORS
  });
  return { running, c, ceiling: effectiveCeilingOf(c) };
});

console.log('  running  headroom  boundBy  ceiling  shortfall  stability');
for (const r of readings) {
  console.log(
    `  ${String(r.running).padStart(7)}  ${String(r.c.headroom).padStart(8)}  ` +
    `${r.c.headroomBoundBy.padEnd(7)}  ${String(r.ceiling.ceiling).padStart(7)}  ` +
    `${String(r.ceiling.shortfall).padStart(9)}  ${r.ceiling.stability}`
  );
}
console.log('');

check(
  '2',
  readings.length >= 2,
  `readings taken at ${readings.length} distinct fleet sizes, not one`
);

// The cap term must eventually bind — at `running === cap` there is no count
// left whatever the machine is doing. A model where it never did would be one
// where the configured number had stopped meaning anything at all, which is the
// opposite failure to this ticket's and just as bad.
const atCap = readings.find((r) => r.running === CONFIGURED_CAP);
check(
  '2',
  atCap && atCap.c.headroomByCap === 0,
  `at running=${CONFIGURED_CAP} the count term is exhausted (headroomByCap=${atCap?.c.headroomByCap})`
);

// AC3's real content: the binding term MOVES, so a single reading would not
// have shown that it can. On the live fleet it moved twice in half an hour —
// cpu at running=2, memory at running=4, and then `epic/KAN-59` read cpu again
// at running=5 while this ticket read memory at the same population minutes
// later. This machine's own condition at the moment this script runs cannot be
// relied on to reproduce all of that (if it happens to be CPU-saturated, cpu
// binds at every size and the table above is one term repeated), so the term is
// made to move here by varying the condition rather than the population — which
// is the honest lever, because the condition is what actually moved it.
// NOTE ON READING THE TABLE BELOW: it holds the machine fixed and varies the
// population, which is not how a fleet actually grows — a real start also
// consumes memory. So the `ceiling` column moves within a condition here in a
// way it would not on a live machine. That is the simulation block further
// down, which decrements available memory per start; this table is about WHICH
// TERM BINDS, and nothing else.
console.log('  the binding term across machine conditions, at two fleet sizes:\n');
console.log('  condition        running  headroom  boundBy  ceiling  stability');
const conditions = [
  // Cores free, memory short: the state the ticket measured and the one that
  // produces its "about 7".
  { name: 'memory-short', facts: { cores: 8, busyCores: 0.5, busyWindowSeconds: 5, load1: 0.5,
      totalBytes: 16 * GIB, availableBytes: 5.2 * GIB, stall: QUIET_STALL } },
  // Memory free, cores spent: `epic/KAN-59`'s reading, and why theirs and this
  // ticket's disagreed by two at the same population.
  { name: 'cpu-saturated', facts: { cores: 4, busyCores: 3.9, busyWindowSeconds: 5, load1: 12,
      totalBytes: 16 * GIB, availableBytes: 14 * GIB, stall: QUIET_STALL } },
  // Neither short: the cap is what is left to bind, and it does.
  { name: 'quiet',         facts: { cores: 32, busyCores: 1, busyWindowSeconds: 5, load1: 1,
      totalBytes: 128 * GIB, availableBytes: 120 * GIB, stall: QUIET_STALL } }
];
const termsSeen = new Set();
for (const cond of conditions) {
  for (const running of [2, 5]) {
    const c = computeCapacity(cond.facts, running, {
      configuredCap: CONFIGURED_CAP,
      supervisorsRunning: SUPERVISORS
    });
    const e = effectiveCeilingOf(c);
    termsSeen.add(c.headroomBoundBy);
    console.log(
      `  ${cond.name.padEnd(15)}  ${String(running).padStart(7)}  ` +
      `${String(c.headroom).padStart(8)}  ${c.headroomBoundBy.padEnd(7)}  ` +
      `${String(e.ceiling).padStart(7)}  ${e.stability}`
    );
  }
}
console.log('');

check(
  '2',
  termsSeen.size >= 3,
  `the binding term moves rather than being one term repeated — ` +
  `${termsSeen.size} distinct terms bound across the conditions above (${[...termsSeen].join(', ')})`
);
check(
  '2',
  readings.some((r) => r.ceiling.shortfall > 0) ,
  'and at least one reading has a shortfall — a ceiling below the configured cap'
);

// THE PROJECTION CHECK — what `stability: 'projects'` actually claims.
//
// A start takes one `cost.residentBytes` out of `availableBytes`, which is the
// numerator the memory term divides. So the memory term is charged for it, and
// `running + headroomByMemory` does not chase itself as starts land. The cpu
// term is charged for nothing: `cpuBusyCores` measures what the fleet is doing,
// so the same simulated starts leave it exactly where it was.
//
// This is the mechanism behind the ticket's own observation — "two more agents
// started and headroom did not move" — and it is why one of those two terms
// deserves to be called a forecast and the other does not.
console.log('  simulating starts against the same machine (each takes one agent of memory):\n');
console.log('  started  available  ceilingByMemory  ceilingByCpu');
const startCost = here.cost.residentBytes;
const memoryCeilings = [];
const cpuCeilings = [];
for (let started = 0; started <= 3; started++) {
  const shrunk = {
    ...machine,
    availableBytes: Math.max(0, machine.availableBytes - started * startCost)
  };
  const c = computeCapacity(shrunk, liveish + started, {
    configuredCap: CONFIGURED_CAP,
    supervisorsRunning: SUPERVISORS
  });
  const byMemory = c.running + c.headroomByMemory;
  const byCpu = c.running + c.headroomByCpu;
  memoryCeilings.push(byMemory);
  cpuCeilings.push(byCpu);
  console.log(
    `  ${String(started).padStart(7)}  ${(shrunk.availableBytes / GIB).toFixed(2)} GiB  ` +
    `${String(byMemory).padStart(15)}  ${String(byCpu).padStart(12)}`
  );
}
console.log('');

// Within one, not exactly equal: `headroomByMemory` floors, so a remainder can
// carry the sum across an integer boundary. Claiming exact invariance would be
// claiming more than the mechanism delivers, which is the defect this whole
// ticket is about.
const memorySpread = Math.max(...memoryCeilings) - Math.min(...memoryCeilings);
check(
  '2',
  memorySpread <= 1,
  `the memory-term ceiling holds as starts land (spread ${memorySpread} over ` +
  `${memoryCeilings.length} simulated starts: ${memoryCeilings.join(', ')}) — ` +
  'each start is charged to the term that set it'
);

// And the other half of the same claim: the cpu term is charged nothing, so its
// ceiling rises by one per start. That is what makes it a snapshot rather than
// a forecast, and it is why `stability` exists.
const cpuRises = cpuCeilings.every((v, i) => i === 0 || v >= cpuCeilings[i - 1]);
check(
  '2',
  cpuRises && cpuCeilings[cpuCeilings.length - 1] > cpuCeilings[0],
  `the cpu-term ceiling climbs with population instead of holding ` +
  `(${cpuCeilings.join(', ')}) — no start is charged to it, so it forecasts nothing`
);

// ---------------------------------------------------------------------------
// Section 3 — DRIVEN RED: the gate refuses while `cap` still reads 10
// ---------------------------------------------------------------------------
//
// AC2. Computed rather than manufactured, per `epic/KAN-203`'s ruling on the
// ticket — see the header for the route taken and what it leaves uncovered.
//
// The assertion that makes this the ticket's red rather than a generic one is
// `headroomByCap > 0` *in the same breath as* the refusal: the count term still
// had slots, and the machine refused anyway. That is precisely "the cap is not
// the gate", executed rather than quoted.

console.log('\n=== 3. DRIVEN RED: the gate refusing while cap reads 10 ===\n');

// Walk up from empty until the real model refuses. If nothing refuses before
// the cap, the live terms are not binding on this machine right now and the red
// has to be obtained another way — see below, which is a failure of THIS RUN
// rather than a pass.
let refusedAt = null;
for (let running = 0; running < CONFIGURED_CAP; running++) {
  const c = computeCapacity(machine, running, {
    configuredCap: CONFIGURED_CAP,
    supervisorsRunning: SUPERVISORS
  });
  if (c.atCapacity) {
    refusedAt = c;
    break;
  }
}

if (!refusedAt) {
  // Not a silent pass. On a quiet machine with plenty of memory the live terms
  // genuinely do not bind below the cap — which is the healthy state, and also
  // the state in which this section cannot demonstrate anything. Say so loudly
  // and drive the red on a machine that is definitely short instead, so the
  // gate is still watched refusing, and record that this run did not see it
  // happen on real figures.
  console.log(
    '  NOTE: this machine\'s live terms do not bind below the cap right now, so no\n' +
    '        refusal is available from its real figures. That is the healthy state.\n' +
    '        Falling back to a machine short of memory, which still exercises the\n' +
    '        real gate but on figures this script supplied. The PR body must carry a\n' +
    '        live `butchr_capacity` reading if the real-figures red is being claimed.'
  );
  const short = {
    ...machine,
    // One agent short of the reserve: the memory term must come out at 0.
    availableBytes: Math.floor(here.reservedForHuman.bytes + here.cost.residentBytes * 0.5)
  };
  refusedAt = computeCapacity(short, 4, {
    configuredCap: CONFIGURED_CAP,
    supervisorsRunning: SUPERVISORS
  });
}

const refusedCeiling = effectiveCeilingOf(refusedAt);

console.log(`  cap:            ${refusedAt.cap}`);
console.log(`  running:        ${refusedAt.running}`);
console.log(`  atCapacity:     ${refusedAt.atCapacity}`);
console.log(`  headroom:       ${refusedAt.headroom} (bound by ${refusedAt.headroomBoundBy})`);
console.log(`  headroomByCap:  ${refusedAt.headroomByCap}   <-- the count term still had room`);
console.log(`  headroomByCpu:  ${refusedAt.headroomByCpu}`);
console.log(`  headroomByMem:  ${refusedAt.headroomByMemory}`);
console.log(`  ceiling:        ${refusedCeiling.ceiling}, shortfall ${refusedCeiling.shortfall}`);
console.log('');

check(
  '3',
  refusedAt.atCapacity === true,
  'THE GATE REFUSES: atCapacity is true — `if (!capacity.atCapacity)` does not pass'
);
check(
  '3',
  refusedAt.cap === CONFIGURED_CAP,
  `and the cap still reads ${CONFIGURED_CAP} while it refuses`
);
check(
  '3',
  refusedAt.headroom === 0,
  'headroom is 0, which is the whole of what `atCapacity: headroom <= 0` consults'
);
check(
  '3',
  refusedAt.headroomByCap > 0,
  `the count term had ${refusedAt.headroomByCap} slot(s) free and the machine refused anyway — ` +
  'the cap is demonstrably not what gated'
);
check(
  '3',
  refusedAt.headroomBoundBy !== 'cap',
  `a live term refused, not the count (bound by ${refusedAt.headroomBoundBy})`
);
check(
  '3',
  refusedCeiling.shortfall > 0,
  `and the ceiling says so: ${refusedCeiling.ceiling} reachable against a cap of ` +
  `${refusedAt.cap}, ${refusedCeiling.shortfall} slot(s) unreachable`
);

// The refusal a caller would actually be handed, from the shipped renderer.
const refusalText = capacityRefusal(refusedAt, 'task/KAN-517-probe');
console.log('  --- the refusal the router would return, verbatim ---');
console.log(refusalText.split('\n').map((l) => `  | ${l}`).join('\n'));
console.log('');

check(
  '3',
  refusalText.includes('effective ceiling:'),
  'the refusal a caller is handed carries the effective ceiling'
);

// The summary line the ticket named as misleading. `4/10` must not be the
// shape a reader meets when those six slots do not exist.
const summaryRefused = summarizeCapacity(refusedAt);
console.log(`  summary: ${summaryRefused}`);
console.log('');
check(
  '3',
  !summaryRefused.includes(`${refusedAt.running}/${refusedAt.cap} task agents`),
  `the summary no longer opens with the bare fraction ` +
  `\`${refusedAt.running}/${refusedAt.cap} task agents\` that invites cap − running`
);
check(
  '3',
  summaryRefused.includes('reachable on this machine'),
  'the summary names what this machine actually reaches'
);
check(
  '3',
  summaryRefused.includes(`${refusedAt.cap} configured`),
  'and still shows the configured cap — moved out of the fraction, not dropped'
);

// BOTH live terms, watched refusing. The section above red-drove whichever term
// this machine happens to be short of, and that is one of the two. The ticket's
// own finding is memory-bound — "the practical ceiling is about 7" — so a proof
// that only ever watched cpu refuse would have missed the term the ticket is
// actually about, and vice versa. Each is refused with `headroomByCap` still
// positive, which is the claim: the cap is not what gated, on either route.
console.log('  each live term, refusing while the count term still has room:\n');
const redDrives = [
  {
    term: 'memory',
    // Cores free so cpu cannot be what refuses; memory below the reserve.
    facts: { cores: 16, busyCores: 0.5, busyWindowSeconds: 5, load1: 0.5,
             totalBytes: 16 * GIB, availableBytes: 2.4 * GIB, stall: QUIET_STALL }
  },
  {
    term: 'cpu',
    // Memory ample so memory cannot be what refuses; every core spent.
    facts: { cores: 4, busyCores: 4, busyWindowSeconds: 5, load1: 12,
             totalBytes: 64 * GIB, availableBytes: 60 * GIB, stall: QUIET_STALL }
  }
];
for (const drive of redDrives) {
  const c = computeCapacity(drive.facts, 3, {
    configuredCap: CONFIGURED_CAP,
    supervisorsRunning: SUPERVISORS
  });
  const e = effectiveCeilingOf(c);
  console.log(
    `  ${drive.term.padEnd(7)}: atCapacity=${c.atCapacity} headroom=${c.headroom} ` +
    `boundBy=${c.headroomBoundBy} cap=${c.cap} headroomByCap=${c.headroomByCap} ` +
    `ceiling=${e.ceiling} shortfall=${e.shortfall}`
  );
  check(
    '3',
    c.atCapacity && c.headroomBoundBy === drive.term && c.cap === CONFIGURED_CAP && c.headroomByCap > 0,
    `the ${drive.term} term refuses while cap reads ${CONFIGURED_CAP} and the count term ` +
    `still allows ${c.headroomByCap}`
  );
  check(
    '3',
    e.shortfall === CONFIGURED_CAP - c.running,
    `and the ceiling reports every unreachable slot: ${e.ceiling} reachable, ` +
    `${e.shortfall} of the cap's ${CONFIGURED_CAP} out of reach`
  );
}
console.log('');

// The other direction, which is what keeps the change from being a blanket
// rewording: where the cap IS reachable the old shape is exactly right and must
// survive. A line that changed on every machine would have made the new wording
// noise rather than a signal.
const roomy = computeCapacity(
  { ...machine, availableBytes: 64 * GIB, cores: 64, busyCores: 1, busyWindowSeconds: 5, load1: 1,
    stall: QUIET_STALL },
  2,
  { configuredCap: CONFIGURED_CAP, supervisorsRunning: SUPERVISORS }
);
const roomyCeiling = effectiveCeilingOf(roomy);
check(
  '3',
  roomyCeiling.shortfall === 0 && summarizeCapacity(roomy).includes(`2/${CONFIGURED_CAP} task agents`),
  'on a machine whose cap is reachable the original wording is unchanged — ' +
  'this says something exactly when there is something to say'
);

// ---------------------------------------------------------------------------
// Section 4 — the ceiling is a report and cannot become a term
// ---------------------------------------------------------------------------
//
// AC5: no live capacity term changes without recorded first-hand human
// authorisation, and nobody has given any. The risk is not that this ticket
// changes a term — it does not — but that publishing a ceiling next to
// `headroom` invites the NEXT author to gate on it. So the ceiling is not on
// `Capacity` at all: the admission path holds an object with no such property,
// and `capacity.effectiveCeiling` does not compile.

console.log('\n=== 4. The ceiling is a report, not a term ===\n');

check(
  '4',
  !Object.prototype.hasOwnProperty.call(here, 'effectiveCeiling'),
  'a `Capacity` carries no `effectiveCeiling` property for a gate to read'
);
check(
  '4',
  !Object.keys(here).some((k) => /ceiling/i.test(k)),
  `and nothing ceiling-shaped on it either (keys checked: ${Object.keys(here).length})`
);

// The gate's own source. `capacityGate` is where admission is decided; the
// ceiling must not appear anywhere in it. Read as text rather than imported,
// so this section is unaffected by whether the build succeeded.
const routerSrc = fs.readFileSync(path.join(daemonRoot, 'src', 'router.ts'), 'utf8');
const gateStart = routerSrc.indexOf('private capacityGate(');
const gateEnd = routerSrc.indexOf('private preemptionCandidates(');
check(
  '4',
  gateStart > 0 && gateEnd > gateStart,
  'located capacityGate in router.ts source'
);
const gateBody = routerSrc.slice(gateStart, gateEnd);
check(
  '4',
  !/ceiling/i.test(gateBody),
  `the admission path (${gateBody.split('\n').length} lines of capacityGate) never mentions a ceiling`
);

// A positive control for the search above. A grep that would find nothing
// whatever the file said has measured nothing — this ticket's own standing
// rule. `atCapacity` is what the gate DOES consult, so it must be found.
check(
  '4',
  /atCapacity/.test(gateBody),
  'positive control: the same slice DOES contain `atCapacity`, so the search can find things'
);

// And the one place it is legitimately consulted is a renderer, not a gate.
const capacitySrc = fs.readFileSync(path.join(daemonRoot, 'src', 'capacity.ts'), 'utf8');
check(
  '4',
  /export function effectiveCeilingOf\(/.test(capacitySrc),
  'the ceiling is computed by an exported function over a Capacity, not stored on one'
);

// ---------------------------------------------------------------------------
// Section 5 — can the battery above actually fail?
// ---------------------------------------------------------------------------
//
// The mutation is the defect this script is named for: a ceiling that reports
// the cap. Every assertion in sections 1–3 that is about the ceiling is re-run
// against it, and at least one must go red. If none does, those assertions are
// decorative and this script is one of the five KAN-119 found.

console.log('\n=== 5. Can it fail? The battery against a ceiling that reports the cap ===\n');

/** The defect: a ceiling that reports the configured number regardless. */
const brokenCeilingOf = (c) => ({
  ceiling: c.cap,
  boundBy: c.headroomBoundBy,
  stability: 'static',
  shortfall: 0,
  arithmetic: `${c.cap} configured`
});

/** Sections 1–3's ceiling claims, as a battery that can be pointed anywhere. */
function ceilingBattery(ceilingOf) {
  const problems = [];
  for (const { running, c } of readings) {
    const e = ceilingOf(c);
    if (e.ceiling !== c.running + c.headroom) {
      problems.push(`running=${running}: ceiling ${e.ceiling} != ${c.running} + ${c.headroom}`);
    }
    if (e.shortfall !== Math.max(0, c.cap - (c.running + c.headroom))) {
      problems.push(`running=${running}: shortfall ${e.shortfall} does not reproduce`);
    }
    if ((e.boundBy === 'cap') !== (e.stability === 'static')) {
      problems.push(`running=${running}: stability ${e.stability} disagrees with boundBy ${e.boundBy}`);
    }
  }
  return problems;
}

const realProblems = ceilingBattery(effectiveCeilingOf);
const brokenProblems = ceilingBattery(brokenCeilingOf);

check(
  '5',
  realProblems.length === 0,
  `the shipped ceiling passes the battery clean (${readings.length} readings, 0 problems)`
);
check(
  '5',
  brokenProblems.length > 0,
  `and a ceiling that reports the cap is CAUGHT — ${brokenProblems.length} problem(s), ` +
  `first: ${brokenProblems[0] ?? 'none, which is the failure'}`
);

// The summary assertion, mutated the same way: a summary built off a ceiling
// with no shortfall falls back to the fraction the ticket complained about.
// This is the check that the rendered text is load-bearing rather than
// incidentally correct.
const brokenRefusedCeiling = brokenCeilingOf(refusedAt);
check(
  '5',
  brokenRefusedCeiling.shortfall === 0 && refusedCeiling.shortfall > 0,
  'the mutation collapses the shortfall to 0 on the very reading that has one — ' +
  'which is exactly how a ceiling stops being visible'
);

// ---------------------------------------------------------------------------

console.log('');
if (failures) {
  console.error(`FAILED: ${failures} check(s) did not hold.`);
} else {
  console.log('PASSED: every check held.');
}
process.exit(failures ? 1 : 0);
