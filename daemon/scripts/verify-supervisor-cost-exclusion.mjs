// Supervisor trees must not price a task agent, and supervisor memory must be
// charged somewhere (KAN-276).
//
// WHAT FAILURE THIS WOULD CATCH: a per-agent cost divisor averaged over
// supervisor trees as well as task-agent ones, which understates what a task
// agent costs and therefore *inflates* headroom — the gate admitting more
// agents the fewer task agents are running, and admitting the most at cold boot
// when the sample contains no task agent at all. On the machine this was
// written on, `butchr_capacity` reported `running: 0` with
// `measuredAgentTrees: 3` and published 0.123 core/agent — a per-task-agent
// figure computed entirely from supervisors — and `capByCpu` moved between 12
// and 20 on unchanged hardware purely with what happened to be in the sample.
//
// CI-RUNNABLE: partial — the exclusion arithmetic (1-4), the enablement
// predicate (5b), the unmarked-tree discriminator (5c) and the falsifier (6)
// all assert in CI. Section 5 reads the live fleet through /proc and is
// skipped on a runner, which has no agent trees. KAN-537 is why its unmarked
// arm no longer fails on a tree that holds no MCP server at all.
//
// It also catches the second half: supervisors exempt from the cap on *both*
// dimensions, when they hold ~650 MB each and are 92% as heavy as a task agent
// in memory while being ~14x cheaper on CPU.
//
// HOW THIS IS DRIVEN, AND WHAT THAT LEAVES UNCOVERED
//
// Sections 1–4 are **fixtures**: synthetic process tables and synthetic argv,
// through the same `aggregateTrees` and `computeCapacity` the daemon calls.
// They need no /proc, no fleet and no machine, which is the point — CI runs
// where there are no agents, and a proof that could only measure a live fleet
// would assert nothing there and go green on an empty sample.
//
// **This script writes the process table it then asserts on.** So it does not
// test that a real agent tree carries the `--workspace-type` marker at all —
// only that a tree carrying one is classified and excluded correctly. That gap
// is the KAN-145 shape (two scripts each honest, the hole between them), and it
// is covered here by section 5, which reads the **live** fleet through the real
// /proc path and requires every running agent tree to be marked and classified.
// Section 5 is skipped where no fleet is running, and says so; when it is
// skipped, the marker's presence on real agents is evidenced instead by the
// live `butchr_capacity` reading and `measure-agent-cost.mjs` output pasted in
// the PR body.
//
// Section 6 is the falsifier: it re-runs sections 1–4 with the exclusion
// removed — a predicate that calls nothing a supervisor, which is exactly the
// pre-KAN-276 behaviour — and requires them to go red.
//
// WHAT SECTION 5 USED TO ASSERT, AND WHY IT WAS RED ON A CLEAN `main` (KAN-537)
//
// It required every live `claude` tree to carry the marker, and on 2026-08-18
// that went red on a pristine `origin/main` worktree with no branch changes in
// it at all. Three agents met it in one day — KAN-517 and KAN-532 each began by
// suspecting their own work, and this ticket was filed when a third did. CI
// could not see any of it: a runner has no agent trees, so the failing
// condition cannot arise there and `verify-runnable-set` passed this script
// correctly and uselessly. The cost was never the failure. It was that a real
// red and a fleet-shaped red were the same exit code and the same text, so an
// agent could only learn to discount both.
//
// The two unmarked trees were measured rather than guessed at, and the answer
// is neither of the two the ticket proposed. They were not a marking defect and
// they did not predate the marker: `story/kan-117` and `epic/kan-59` were both
// parked at Claude Code's `--dangerously-load-development-channels`
// confirmation dialog, 1h20m in, with **no child processes at all**. The marker
// rides on the butchr MCP server's argv (launchers.ts) and no MCP server is
// spawned until that dialog is answered — so neither tree held any process that
// could have carried one. The old assertion was therefore unsatisfiable in
// principle for the whole of every agent's bring-up, which is ~12s ordinarily
// and unbounded when nobody answers the dialog.
//
// So section 5 now asserts the narrower property that is actually about
// marking: **every live tree that HOLDS a butchr core MCP server carries the
// marker on it.** A tree holding no such server is reported, counted, named and
// aged — and is not a failure, because there is nothing in it that could have
// been marked. `lib/unmarked-tree-diagnosis.mjs` is that split, and its header
// carries the reasoning. This is a sharpening rather than a weakening: KAN-492's
// property survives intact for every tree that can express it, and nothing here
// changes what KAN-276 exempts or how the divisor is computed.
//
// Section 5c is that discriminator's red drive, and it exists because section 5
// cannot be one. Section 5 is a reading of whatever fleet happens to be up: on
// the fleet this was written against it found zero trees on the failing branch,
// so its green says nothing about whether that branch can go red. 5c drives the
// same `diagnose` over fixtures that put a tree on each branch deliberately, and
// then breaks the server detection to show the failure disappearing — which is
// what identifies the one change that would silently disarm section 5.

import * as path from 'path';
import * as fsLive from 'fs';
import { fileURLToPath } from 'url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const { aggregateTrees, classifyTree, groupByAgent, sampleProcesses, readCmdline } = await import(
  path.join(distDir, 'agent-cost.js')
);
const { sampleFromMeasurement, supervisorMemoryFromMeasurement } = await import(
  path.join(distDir, 'agent-cost-damping.js')
);
const { computeCapacity, describeCapacity, SUPERVISOR_MEMORY_BYTES, GIB } = await import(
  path.join(distDir, 'capacity.js')
);
const { supervisorPredicate } = await import('./lib/supervisor-types.mjs');
const { unmarkedTreeDiagnostic, isMarkingFailure, MARKING_FAILURE } = await import(
  './lib/unmarked-tree-diagnosis.mjs'
);

const MIB = 1024 ** 2;
const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

const failures = [];
// Findings about the fleet this ran on that are NOT failures of this proof, and
// that CI structurally cannot produce (KAN-537). They are kept apart from
// `failures` because conflating them is the defect this ticket was filed for —
// and surfaced in the VERDICT rather than only where they were found, so a
// clean PASS cannot quietly hide two agents parked at a startup dialog.
const environmental = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// The real predicate, read from the integration's own declarations rather than
// hardcoded — so a third supervising type reaches this proof for free.
const { isSupervisor, supervisorTypes } = await supervisorPredicate(distDir);
// The pre-KAN-276 behaviour, for section 6: every tree is chargeable.
const nothingSupervises = () => false;

// --------------------------------------------------------------------------
// The fixture fleet: three supervisors and two task agents, at the ratio
// measured on this machine on 2026-08-11 over 60s and 90s windows with a real
// compile running — task agents ~0.19 core / ~780 MB, supervisors ~0.012 core /
// ~775 MB. The point of using the measured ratio rather than round numbers is
// that the arithmetic below is what the real fleet actually produces.
// --------------------------------------------------------------------------
const CLK_TCK = 100;
const PAGE = 4096;
const WINDOW = 60;

/** One fixture tree: a `claude` root, an MCP child carrying the marker, a worker. */
function tree({ pid, type, key, cores, residentMb }) {
  const ticks = Math.round(cores * CLK_TCK * WINDOW);
  const pages = Math.round((residentMb * MIB) / PAGE);
  return {
    root: pid,
    procs: [
      // `childCpuTicks` is the reaped-children half of a tree's cost (KAN-368).
      // Zero throughout this fixture on purpose: these trees spawn nothing that
      // exits, so every tick is the root's own and the arithmetic this file
      // asserts on is unchanged by that ticket.
      { pid, comm: 'claude', ppid: 1, cpuTicks: ticks, childCpuTicks: 0, rssBytes: Math.round((pages * PAGE) / 2) },
      { pid: pid + 1, comm: 'node', ppid: pid, cpuTicks: 0, childCpuTicks: 0, rssBytes: Math.round((pages * PAGE) / 2) },
      { pid: pid + 2, comm: 'node', ppid: pid, cpuTicks: 0, childCpuTicks: 0, rssBytes: 0 }
    ],
    // The marker sits on the MCP child, exactly where launchers.ts puts it.
    argv: type === null ? {} : { [pid + 1]: ['node', 'mcp.js', '--workspace-type', type, '--workspace-key', key] }
  };
}

const FIXTURE = [
  tree({ pid: 1000, type: 'task', key: 'KAN-276', cores: 0.198, residentMb: 844 }),
  tree({ pid: 2000, type: 'task', key: 'KAN-263', cores: 0.187, residentMb: 722 }),
  tree({ pid: 3000, type: 'epic', key: 'KAN-39', cores: 0.012, residentMb: 783 }),
  tree({ pid: 4000, type: 'epic', key: 'KAN-59', cores: 0.011, residentMb: 733 }),
  tree({ pid: 5000, type: 'epic', key: 'KAN-203', cores: 0.014, residentMb: 809 })
];

function fixtureSamples(trees) {
  const before = new Map();
  const after = new Map();
  const argv = {};
  for (const t of trees) {
    Object.assign(argv, t.argv);
    for (const p of t.procs) {
      // `before` holds zero ticks, so the delta over the window is the whole of
      // each tree's cpuTicks — the figure `tree()` computed from its cores.
      before.set(p.pid, { ...p, cpuTicks: 0 });
      after.set(p.pid, { ...p });
    }
  }
  return { before, after, readArgv: (pid) => argv[pid] ?? [] };
}

/** A finished-measurement shape from the fixture, under a given predicate. */
function measure(trees, predicate) {
  const { before, after, readArgv } = fixtureSamples(trees);
  return {
    elapsed: WINDOW,
    loadStart: 1,
    loadEnd: 1,
    ...aggregateTrees(before, after, WINDOW, predicate, readArgv)
  };
}

// The machine the readings in this ticket were taken on.
const LAPTOP = {
  cores: 4,
  totalBytes: 15.4 * GIB,
  availableBytes: 8.7 * GIB,
  load1: 2.0,
  busyCores: 1.6,
  busyWindowSeconds: 5,
  stall: { ioFullPercent: 0, memoryFullPercent: 0 }
};

/** Everything sections 1–4 assert, so section 6 can re-run it under a predicate. */
function runAssertions(predicate, { quiet = false } = {}) {
  const say = quiet ? () => {} : (s) => console.log(s);
  const m = measure(FIXTURE, predicate);
  const sample = sampleFromMeasurement(m, LAPTOP.totalBytes);
  const supMemory = supervisorMemoryFromMeasurement(m, LAPTOP.totalBytes);

  const measured = sample && {
    residentBytes: Math.round(sample.residentBytes / MIB) * MIB,
    cores: Math.round(sample.cores * 1000) / 1000,
    sampledAt: Date.now(),
    windowSeconds: WINDOW,
    agentTrees: m.chargeable.agents,
    memoryAgentTrees: m.totals.agents,
    supervisorResidentBytes: supMemory
  };

  const capacity = computeCapacity(LAPTOP, m.chargeable.agents, {
    measured,
    supervisorsRunning: m.supervisors.agents
  });

  const checks = {
    // 1. No supervisor tree is in the chargeable population.
    noSupervisorCharged:
      m.chargeable.agents === 2 &&
      m.supervisors.agents === 3 &&
      m.agents
        .filter((a) => supervisorTypes.has(a.workspaceType))
        .every((a) => a.cores <= 0.02),
    // 2. The CORE divisor is the task-agent cost, not the all-tree average
    //    (task mean 0.1925, all-tree mean 0.0844) — and the MEMORY divisor is
    //    still the all-tree mean, which is what keeps headroomByMemory fixed.
    divisorIsTaskCost:
      !!measured &&
      measured.cores > 0.15 &&
      measured.cores < 0.24 &&
      Math.abs(measured.residentBytes - Math.round((m.totals.residentMb * MIB) / m.totals.agents / MIB) * MIB) < MIB,
    // 3. Supervisor memory is charged, and the reserve is the count times a
    //    per-supervisor figure rather than zero.
    supervisorMemoryCharged:
      capacity.supervisorReserve.count === 3 && capacity.supervisorReserve.bytes > 2 * GIB,
    // 4. The derivation still describes the arithmetic it performed.
    derivationHonest: (() => {
      const text = describeCapacity(capacity);
      const budget =
        LAPTOP.totalBytes -
        capacity.reservedForHuman.bytes -
        capacity.supervisorReserve.bytes;
      return (
        text.includes('supervisor memory reserve') &&
        capacity.capByMemory === Math.floor(budget / capacity.cost.residentBytes)
      );
    })()
  };

  if (!quiet) {
    say(
      `  chargeable (task) trees : ${m.chargeable.agents} — ` +
        `${(m.chargeable.cores / (m.chargeable.agents || 1)).toFixed(3)} core, ` +
        `${(m.chargeable.residentMb / (m.chargeable.agents || 1)).toFixed(0)} MB each`
    );
    say(
      `  supervisor trees held out: ${m.supervisors.agents} — ` +
        `${(m.supervisors.cores / (m.supervisors.agents || 1)).toFixed(3)} core, ` +
        `${(m.supervisors.residentMb / (m.supervisors.agents || 1)).toFixed(0)} MB each`
    );
    say(
      `  all trees (the old divisor): ${m.totals.agents} — ` +
        `${(m.totals.cores / (m.totals.agents || 1)).toFixed(3)} core each`
    );
  }
  return { m, measured, capacity, checks };
}

// ------------------------------------------------------- 1. the exclusion --
rule('1. THE EXCLUSION — a supervisor tree does not enter the cost divisor');
console.log(
  `supervisor types, read from the integration's declarations: ${[...supervisorTypes].join(', ')}\n`
);
const fixed = runAssertions(isSupervisor);
verdict(
  fixed.checks.noSupervisorCharged,
  `the 3 epic trees are held out of the chargeable population, which is the 2 task\n` +
    '    trees and nothing else.',
  'a supervisor tree reached the chargeable population, or the split lost a tree.'
);

// ------------------------------------------------------- 2. the divisor ----
rule('2. THE DIVISOR — what capacity divides by is a task agent, not an average');
const allTreeMean = fixed.m.totals.cores / fixed.m.totals.agents;
console.log(
  `  published divisor : ${fixed.measured.cores} core/agent  (task trees only)\n` +
    `  all-tree average  : ${allTreeMean.toFixed(3)} core/agent  (what it was before KAN-276)\n` +
    `  understatement    : ${(100 - (allTreeMean / fixed.measured.cores) * 100).toFixed(0)}% low`
);
verdict(
  fixed.checks.divisorIsTaskCost,
  'the divisor is the task-agent cost. The all-tree average is far below it, and a\n' +
    '    smaller divisor is a bigger headroom — which is why the contamination loosened\n' +
    '    the gate rather than tightening it.',
  `the divisor ${fixed.measured?.cores} is not the task-agent cost.`
);

// ------------------------------------------- 3. headroom must go DOWN ------
rule('3. THE DIRECTION — no dimension may loosen, on any fleet composition');
console.log(
  'The load-bearing claim of this change is that `headroomByMemory` CANNOT MOVE. It is\n' +
    'load-bearing because the first draft moved it: excluding supervisors from the memory\n' +
    'divisor too was measured on a live fleet at 795 MB -> 778 MB, which raised\n' +
    'headroomByMemory from 7 to 8. That variant was reported and not shipped.\n' +
    '\n' +
    'So this is a sweep rather than one comparison, and the compositions below are chosen\n' +
    'to attack the claim — heavy supervisors, light supervisors, one task agent, none at\n' +
    'all. If any of them moves the memory term, the claim is false and this goes red.\n'
);

/** The pre-KAN-276 model: every tree in both divisors, no supervisor reserve. */
function oldModel(trees, running) {
  const m = measure(trees, nothingSupervises);
  const s = sampleFromMeasurement(m, LAPTOP.totalBytes);
  if (!s) return null;
  return computeCapacity(LAPTOP, running, {
    measured: {
      residentBytes: Math.round(s.residentBytes / MIB) * MIB,
      cores: Math.round(s.cores * 1000) / 1000,
      sampledAt: Date.now(),
      windowSeconds: WINDOW,
      agentTrees: m.totals.agents
    },
    supervisorsRunning: m.supervisors.agents,
    supervisorMemoryOverride: 0
  });
}

/** The shipped model: cores over task trees, memory over all, reserve applied. */
function newModel(trees, running) {
  const m = measure(trees, isSupervisor);
  const s = sampleFromMeasurement(m, LAPTOP.totalBytes);
  if (!s) return null;
  return computeCapacity(LAPTOP, running, {
    measured: {
      residentBytes: Math.round(s.residentBytes / MIB) * MIB,
      cores: Math.round(s.cores * 1000) / 1000,
      sampledAt: Date.now(),
      windowSeconds: WINDOW,
      agentTrees: m.chargeable.agents,
      memoryAgentTrees: m.totals.agents,
      supervisorResidentBytes: supervisorMemoryFromMeasurement(m, LAPTOP.totalBytes)
    },
    supervisorsRunning: m.supervisors.agents
  });
}

const T = (pid, key, cores, mb) => tree({ pid, type: 'task', key, cores, residentMb: mb });
const S = (pid, key, cores, mb) => tree({ pid, type: 'epic', key, cores, residentMb: mb });

const COMPOSITIONS = [
  {
    name: 'measured fleet',
    trees: FIXTURE,
    running: 2,
    note: 'the two 2026-08-11 windows'
  },
  {
    name: 'supervisors HEAVIER',
    // The exact shape that moved headroomByMemory in the rejected variant:
    // supervisors above the task agents on memory, so dropping them from the
    // divisor would LOWER it and find extra room.
    trees: [T(1000, 'A', 0.19, 700), T(2000, 'B', 0.18, 700), S(3000, 'E1', 0.01, 900), S(4000, 'E2', 0.01, 900)],
    running: 2,
    note: 'the case that broke the rejected variant'
  },
  {
    name: 'supervisors lighter',
    trees: [T(1000, 'A', 0.19, 900), T(2000, 'B', 0.18, 900), S(3000, 'E1', 0.01, 600), S(4000, 'E2', 0.01, 600)],
    running: 2,
    note: 'the other direction'
  },
  {
    name: 'one task, four sups',
    trees: [T(1000, 'A', 0.2, 780), S(2000, 'E1', 0.01, 780), S(3000, 'E2', 0.01, 780), S(4000, 'E3', 0.01, 780), S(5000, 'E4', 0.01, 780)],
    running: 1,
    note: 'the fleet is mostly supervisors'
  },
  {
    name: 'no supervisors',
    trees: [T(1000, 'A', 0.19, 780), T(2000, 'B', 0.18, 780)],
    running: 2,
    note: 'the term must be inert'
  }
];

console.log(
  '  composition             agentCores      agentMb       capByMem   hrByMemory   headroom'
);
console.log(
  '                          old -> new     old -> new    old -> new  old -> new  old -> new'
);
let memoryTermMoved = [];
let anyLoosened = [];
let anyTightened = false;
for (const c of COMPOSITIONS) {
  const o = oldModel(c.trees, c.running);
  const n = newModel(c.trees, c.running);
  console.log(
    `  ${c.name.padEnd(23)} ${o.cost.cores.toFixed(3)}->${n.cost.cores.toFixed(3)}  ` +
      `${String(Math.round(o.cost.residentBytes / MIB)).padStart(4)}->${String(Math.round(n.cost.residentBytes / MIB)).padEnd(5)} ` +
      `${String(o.capByMemory).padStart(5)}->${String(n.capByMemory).padEnd(4)} ` +
      `${String(o.headroomByMemory).padStart(6)}->${String(n.headroomByMemory).padEnd(4)} ` +
      `${String(o.headroom).padStart(6)}->${String(n.headroom).padEnd(4)}  ${c.note}`
  );
  if (o.headroomByMemory !== n.headroomByMemory) memoryTermMoved.push(c.name);
  for (const d of ['capByCpu', 'capByMemory', 'cap', 'headroomByCpu', 'headroomByMemory', 'headroom']) {
    if (n[d] > o[d]) anyLoosened.push(`${c.name}:${d} ${o[d]}->${n[d]}`);
  }
  if (n.cap < o.cap || n.headroom < o.headroom) anyTightened = true;
}
verdict(
  memoryTermMoved.length === 0 && anyLoosened.length === 0 && anyTightened,
  `across all ${COMPOSITIONS.length} compositions: headroomByMemory is identical in every one,\n` +
    '    no dimension anywhere got larger, and the cap or headroom got strictly smaller. The\n' +
    '    memory divisor is untouched by construction, so the term the reserve does not reach\n' +
    '    cannot move — which is what makes the whole change safe to ship ahead of KAN-258.',
  (memoryTermMoved.length
    ? `headroomByMemory MOVED on: ${memoryTermMoved.join(', ')}. `
    : '') +
    (anyLoosened.length ? `dimensions that got LOOSER: ${anyLoosened.join(', ')}. ` : '') +
    (!anyTightened ? 'nothing tightened at all. ' : '') +
    'A variant that increases admissions must not ship; see the ticket.'
);
const before276 = oldModel(FIXTURE, 2);
const after276 = fixed.capacity;

// -------------------------------------------- 4. the memory is charged -----
rule('4. THE RESERVE — supervisor memory is charged, and the derivation says where');
console.log(
  `  ${after276.supervisorReserve.count} supervisor(s) × ` +
    `${Math.round(after276.supervisorReserve.perSupervisorBytes / MIB)} MB ` +
    `(${after276.supervisorReserve.source}) = ` +
    `${(after276.supervisorReserve.bytes / GIB).toFixed(1)} GiB held back from the cap\n` +
    `  seed, for reference: ${Math.round(SUPERVISOR_MEMORY_BYTES / MIB)} MB\n`
);
for (const line of describeCapacity(after276).split('\n')) {
  if (/supervisor|memory allows|cap:/.test(line)) console.log(`    ${line.trim()}`);
}
verdict(
  fixed.checks.supervisorMemoryCharged && fixed.checks.derivationHonest,
  'the reserve is sized from the running supervisors and the measured per-supervisor\n' +
    '    figure, it comes off the static cap, and capByMemory is exactly the arithmetic the\n' +
    '    derivation prints — which is what stops the derivation describing a formula the\n' +
    '    code no longer uses.',
  'supervisor memory is not charged, or the derivation no longer matches capByMemory.'
);

// ------------------------------------------------ 5. the live fleet --------
rule('5. THE LIVE FLEET — do real agent trees actually carry the marker?');
console.log(
  'Sections 1-4 built their own process table, so they cannot show that a real agent\n' +
    'is marked at all. This section reads /proc.\n'
);
const liveGroups = groupByAgent(sampleProcesses());
const liveTrees = [...liveGroups.entries()].map(([root, pids]) => ({
  root,
  pids,
  ...classifyTree(pids, readCmdline)
}));

/**
 * How long a tree's root has been alive, in seconds, or null.
 *
 * Printed beside every server-less tree because it is the reader's only handle
 * on which world they are in: ~12s is bring-up, and 80 minutes is an agent that
 * has been parked at a dialog since breakfast. The diagnostic itself will not
 * name a cause (see its header); this is the number that lets a human do it.
 */
function treeAgeSeconds(pid) {
  try {
    const uptime = Number(fsLive.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const stat = fsLive.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Same parse as sampleProcesses(): split after the last ')', so field N of
    // proc(5) is rest[N - 3]. starttime is field 22, in clock ticks since boot.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(rest[19]);
    if (!Number.isFinite(uptime) || !Number.isFinite(startTicks)) return null;
    return uptime - startTicks / CLK_TCK;
  } catch {
    return null;
  }
}

const humanAge = (seconds) => {
  if (seconds === null) return 'age unknown';
  if (seconds < 90) return `${Math.round(seconds)}s old`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m old`;
  return `${(seconds / 3600).toFixed(1)}h old`;
};

if (liveTrees.length === 0) {
  console.log(
    '  no claude trees on this machine — skipped.\n' +
      '  This is the ordinary case in CI. The marker\'s presence on real agents is\n' +
      '  evidenced by the live capacity reading and measure-agent-cost.mjs output in the PR.'
  );
} else {
  const live = await unmarkedTreeDiagnostic(distDir);
  console.log(`  core MCP entrypoint this looks for: ...${live.entrypointTail}`);
  console.log(`  workspaces root resolved to       : ${live.workspacesRoot}\n`);
  for (const t of liveTrees) {
    console.log(
      `  pid ${String(t.root).padStart(7)} → ` +
        `${t.workspaceType ? `${t.workspaceType}/${t.workspaceKey}` : '(unmarked)'}` +
        `${t.workspaceType && isSupervisor(t.workspaceType) ? '   held out of the divisor' : ''}`
    );
  }

  // The unmarked trees, split by whether the absence is ABOUT marking at all.
  // A tree holding no butchr MCP server holds nothing that could carry a
  // marker, so it is not evidence either way; a tree holding one and carrying
  // no marker is the KAN-145 defect. See lib/unmarked-tree-diagnosis.mjs.
  const diagnoses = liveTrees
    .filter((t) => t.workspaceType === null)
    .map((t) => live.diagnose(t));
  const markingFailures = diagnoses.filter(isMarkingFailure);
  const serverless = diagnoses.filter((d) => !isMarkingFailure(d));
  const markedTrees = liveTrees.filter((t) => t.workspaceType !== null);

  if (serverless.length > 0) {
    console.log(
      `\n  ENVIRONMENTAL — ${serverless.length} unmarked tree(s), none of which holds a butchr MCP\n` +
        '  server. A tree with no server has no process that could carry the marker, so this\n' +
        '  is a fact about bring-up and not about marking. It is NOT a failure of this proof,\n' +
        '  and it is a state CI cannot reproduce: a runner has no agent trees at all.'
    );
    for (const d of serverless) {
      const where =
        d.workspace === null ? 'outside the workspaces root above' : `cwd names ${d.workspace}`;
      const age = humanAge(treeAgeSeconds(d.root));
      console.log(`    pid ${String(d.root).padStart(7)}  ${age}  ${where}`);
      environmental.push(`pid ${d.root} (${where}) holds no butchr MCP server, ${age}`);
    }
    console.log(
      '\n    An age of seconds is ordinary bring-up. An age of hours is an agent parked at a\n' +
        '    startup dialog, or a server that started and exited — this proof will not choose\n' +
        '    between those, because /proc cannot. Either belongs on its own ticket, not here.'
    );
  }

  // What the assertion below actually ranged over. Stated because a fleet in
  // which EVERY tree is server-less would leave it asserting over nothing while
  // still printing a pass, which is a green that was never a claim about
  // marking.
  console.log(
    `\n  the assertion below ranges over the ${markedTrees.length + markingFailures.length} tree(s) that hold a butchr MCP server; ` +
      `${serverless.length} held none.`
  );
  if (markedTrees.length + markingFailures.length === 0) {
    console.log(
      '  That count is ZERO, so this section asserted nothing about marking on this run —\n' +
        '  read it exactly as you would read the CI skip above, and not as a pass.'
    );
  }

  verdict(
    markingFailures.length === 0,
    `every one of the ${markedTrees.length} live tree(s) holding a butchr MCP server carries the workspace\n` +
      '    marker, so the classification the fixtures exercise is the classification the daemon\n' +
      '    gets from the real fleet.',
    `${markingFailures.length} live tree(s) hold a butchr MCP server and carry NO marker — ` +
      `pid(s) ${markingFailures.map((d) => `${d.root} (server at ${d.serverPids.join(', ')})`).join('; ')}. ` +
      'That is the KAN-145 defect: the stamp launchers.ts writes is not reaching the ' +
      'process, so those trees are charged nowhere and the divisor degrades toward the seed.'
  );
}

// ------------------------------- 5b. the predicate survives a toggle -------
rule('5b. THE PREDICATE — switching an integration off must not re-contaminate');
console.log(
  'The daemon asks `registry.declaresSupervisor`, not the free `isSupervisorType`.\n' +
    'The difference only shows when an integration is disabled while its agents are\n' +
    'still running — and that is when it matters, because the free function stops\n' +
    'recognising their trees and they rejoin the divisor with nothing saying so.\n'
);
{
  const { WorkspaceRegistry, isSupervisorType: freeIsSupervisor } = await import(
    path.join(distDir, 'registry.js')
  );
  const { IntegrationStateStore } = await import(
    path.join(distDir, 'integrations', 'enablement.js')
  );
  const { createAtlassianIntegration } = await import(
    path.join(distDir, 'integrations', 'atlassian-integration.js')
  );
  const os = await import('os');
  const fs = await import('fs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan276-enablement-'));
  const registry = new WorkspaceRegistry(
    new IntegrationStateStore(path.join(scratch, 'state.json'))
  );
  registry.registerIntegration(
    createAtlassianIntegration({
      issueTypeLookup: async () => 'Task',
      // The same stub shape verify-integration-enablement.mjs uses; a
      // configured credential is what makes the integration start out enabled.
      credential: {
        status: () => ({ configured: true, storage: 'file' }),
        storageTarget: async () => ({ storage: 'file', reason: 'this script only' }),
        setCredential: async () => ({ valid: false }),
        clearCredential: async () => {}
      }
    })
  );
  const enabledFree = freeIsSupervisor('epic');
  const enabledDeclared = registry.declaresSupervisor('epic');
  registry.setEnabled('jira', false);
  const disabledFree = freeIsSupervisor('epic');
  const disabledDeclared = registry.declaresSupervisor('epic');
  fs.rmSync(scratch, { recursive: true, force: true });

  console.log(`  'epic' is a supervisor?        isSupervisorType   declaresSupervisor`);
  console.log(
    `    integration enabled            ${String(enabledFree).padStart(9)}   ` +
      `${String(enabledDeclared).padStart(18)}`
  );
  console.log(
    `    integration disabled           ${String(disabledFree).padStart(9)}   ` +
      `${String(disabledDeclared).padStart(18)}`
  );
  verdict(
    enabledDeclared === true && disabledDeclared === true && disabledFree === false,
    'the predicate the cost filter uses still calls epic a supervisor with the\n' +
      '    integration switched off, where the routing predicate no longer does. A settings\n' +
      '    toggle cannot put supervisor trees back into the per-task-agent divisor.',
    'declaresSupervisor followed enablement — a disabled integration would silently ' +
      'return the divisor to its contaminated state.'
  );
}

// ------------------- 5c. the discriminator, driven onto both branches ------
rule('5c. THE DISCRIMINATOR — can section 5 tell a real defect from a bare fleet?');
console.log(
  'Section 5 above is a reading of whichever fleet happens to be up, so its green is not\n' +
    'evidence that its red branch is reachable — on this fleet it found nothing on that\n' +
    'branch at all. This drives the SAME `diagnose` over three fixture trees, one placed\n' +
    'deliberately on each outcome, with /proc replaced by a table this section writes.\n' +
    'It needs no fleet, so unlike section 5 it asserts in CI.\n'
);
{
  const WS_ROOT = path.join(path.sep, 'fixture', 'workspaces');
  const ENTRY = path.join('daemon', 'dist', 'mcp.js');
  // Deliberately NOT the checkout this script is running from: an agent on this
  // fleet is launched by the installed daemon, whose entrypoint path differs
  // from the worktree's. A discriminator that matched the whole path would find
  // nothing in production and say so as a clean pass.
  const OTHER_CHECKOUT = path.join(path.sep, 'somewhere', 'else', ENTRY);

  const FIXTURE_TREES = [
    {
      label: 'server present, marker absent',
      tree: { root: 10, pids: [10, 11] },
      argv: { 11: ['node', OTHER_CHECKOUT] },
      cwd: { 10: path.join(WS_ROOT, 'task', 'kan-1') },
      expect: MARKING_FAILURE,
      expectWorkspace: 'task/kan-1',
      why: 'the KAN-145 defect — launchers.ts stamped nothing onto a server that IS running'
    },
    {
      label: 'no server, cwd is a workspace',
      tree: { root: 20, pids: [20] },
      argv: {},
      cwd: { 20: path.join(WS_ROOT, 'story', 'kan-117') },
      expect: 'no-server',
      expectWorkspace: 'story/kan-117',
      why: 'the 2026-08-18 fleet — parked before its MCP server was ever spawned'
    },
    {
      label: 'no server, cwd is elsewhere',
      tree: { root: 30, pids: [30, 31] },
      argv: { 31: ['node', path.join(path.sep, 'home', 'someone', 'other-tool', 'mcp.js')] },
      cwd: { 30: path.join(path.sep, 'home', 'someone', 'project') },
      expect: 'no-server',
      expectWorkspace: null,
      why: "a human's own claude, or another tool — the case agent-cost.ts's header names"
    }
  ];

  /** One diagnostic over the fixture table, with the entrypoint tail injected. */
  const fixtureDiagnostic = (entrypointTail) => {
    const argv = {};
    const cwd = {};
    for (const f of FIXTURE_TREES) {
      Object.assign(argv, f.argv);
      Object.assign(cwd, f.cwd);
    }
    return unmarkedTreeDiagnostic(distDir, {
      entrypointTail,
      workspacesRoot: WS_ROOT,
      // No `?? []` / `?? null` shorthand: a fixture pid the table forgot must
      // read as a hole in the fixture rather than as a silent empty argv, which
      // is what would let a mis-keyed table pass as a clean sweep.
      readArgv: (pid) => {
        if (!Object.hasOwn(argv, pid)) return [];
        return argv[pid];
      },
      readCwd: (pid) => {
        if (!Object.hasOwn(cwd, pid)) return null;
        return cwd[pid];
      }
    });
  };

  const armed = await fixtureDiagnostic(ENTRY);
  console.log('  fixture tree                     finding           workspace      is a failure?');
  const wrong = [];
  for (const f of FIXTURE_TREES) {
    const d = armed.diagnose(f.tree);
    const ok = d.finding === f.expect && d.workspace === f.expectWorkspace;
    if (!ok) {
      wrong.push(
        `${f.label}: expected ${f.expect}/${f.expectWorkspace}, got ${d.finding}/${d.workspace}`
      );
    }
    console.log(
      `  ${f.label.padEnd(32)} ${d.finding.padEnd(17)} ${String(d.workspace).padEnd(14)} ` +
        `${isMarkingFailure(d) ? 'YES' : 'no'}${ok ? '' : '   <- UNEXPECTED'}`
    );
    console.log(`      ${f.why}`);
  }
  const armedFailures = FIXTURE_TREES.filter((f) => isMarkingFailure(armed.diagnose(f.tree)));

  // The falsifier. Break the one thing the split rests on — finding the server
  // — and the failing tree must stop being a failure. This is what says the red
  // branch is reachable AND names the single change that would disarm section 5
  // without changing a word of its output.
  const blind = await fixtureDiagnostic(path.join('daemon', 'dist', 'not-the-server.js'));
  const blindFailures = FIXTURE_TREES.filter((f) => isMarkingFailure(blind.diagnose(f.tree)));
  console.log(
    `\n  with the real entrypoint (...${ENTRY}) : ${armedFailures.length} failure(s)\n` +
      `  with a tail that matches no process         : ${blindFailures.length} failure(s)\n` +
      '\n  The second line is the disarmament, stated so it is not a surprise later: if the\n' +
      '  core server is ever renamed or moved and this tail is not moved with it, section 5\n' +
      '  reclassifies every real defect as ENVIRONMENTAL and goes green saying so.'
  );

  verdict(
    wrong.length === 0 && armedFailures.length === 1 && blindFailures.length === 0,
    'the discriminator puts each fixture on the branch it was built for, calls exactly the\n' +
      '    server-holding unmarked tree a failure, and stops calling it one when server detection\n' +
      '    is broken. So section 5 has a red branch the world can reach, and this is what reaches it.',
    (wrong.length ? `misclassified: ${wrong.join('; ')}. ` : '') +
      (armedFailures.length !== 1
        ? `armed run reported ${armedFailures.length} failure(s) rather than exactly 1. `
        : '') +
      (blindFailures.length !== 0
        ? `blind run still reported ${blindFailures.length} failure(s), so the verdict does not depend on finding the server. `
        : '')
  );
}

// ------------------------------------------------ 6. can this fail? --------
rule('6. CAN THIS PROOF FAIL? — sections 1-4 with the exclusion removed');
console.log(
  'Re-running them against a predicate that calls nothing a supervisor, and a capacity\n' +
    'call with no supervisor reserve — which together are the pre-KAN-276 behaviour.\n'
);
const broken = runAssertions(nothingSupervises, { quiet: true });
const brokenCapacity = computeCapacity(LAPTOP, broken.m.chargeable.agents, {
  measured: broken.measured,
  supervisorsRunning: 0
});
const brokenChecks = {
  ...broken.checks,
  supervisorMemoryCharged: brokenCapacity.supervisorReserve.bytes > 2 * GIB,
  derivationHonest: describeCapacity(brokenCapacity).includes('supervisor memory reserve')
};
const names = {
  noSupervisorCharged: '1. supervisors excluded from the divisor',
  divisorIsTaskCost: '2. the divisor is a task agent',
  supervisorMemoryCharged: '3. supervisor memory is charged',
  derivationHonest: '4. the derivation matches the arithmetic'
};
console.log('  assertion                                  with the fix   with it removed');
for (const [k, label] of Object.entries(names)) {
  console.log(
    `  ${label.padEnd(42)} ${(fixed.checks[k] ? 'pass' : 'FAIL').padStart(9)}   ` +
      `${(brokenChecks[k] ? 'pass' : 'FAIL').padStart(12)}`
  );
}
console.log(
  `\n  and the number that matters: with the exclusion removed the divisor is ` +
    `${broken.measured.cores} core/agent\n  against the honest ${fixed.measured.cores}, ` +
    `so capByCpu reads ${brokenCapacity.capByCpu} where it should read ${after276.capByCpu} ` +
    `and headroom\n  reads ${brokenCapacity.headroom} where it should read ${after276.headroom}. ` +
    'That gap is the defect, in agents.'
);
const everyAssertionCanFail = Object.keys(names).every((k) => !brokenChecks[k]);
verdict(
  everyAssertionCanFail,
  'every one of the four goes red when the exclusion is removed. None of them is\n' +
    '    satisfied by the code this change replaced, so their green above is evidence\n' +
    '    about this change rather than about arithmetic that was always true.',
  'at least one assertion still passes with the exclusion removed, so it proves nothing: ' +
    Object.keys(names)
      .filter((k) => brokenChecks[k])
      .join(', ')
);

// ------------------------------------------------------------- verdict -----
rule('VERDICT');
if (failures.length === 0) {
  console.log(
    'PASS — supervisor trees do not price a task agent, their memory is charged against\n' +
      'the cap, no dimension of the gate got looser, and the whole battery has been shown\n' +
      'to go red against the code that lacked the exclusion.\n\n' +
      'Not covered here: that a real agent is launched with the marker in the first place.\n' +
      'Section 5 checks it whenever a fleet is running and is skipped in CI; the live\n' +
      'reading in the PR body is what covers it there.'
  );
} else {
  console.log(`FAIL — ${failures.length} problem(s):\n`);
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}\n`));
}

// Printed on BOTH paths and after the verdict, so it is the last thing a local
// runner reads. It never changes the exit code: these are readings of a live
// fleet, and a machine's fleet state is not a property of this branch (KAN-537).
if (environmental.length > 0) {
  console.log(
    `\nENVIRONMENTAL — ${environmental.length} observation(s) about the fleet this ran on. NOT counted\n` +
      'above and NOT reflected in the exit code:\n'
  );
  environmental.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  console.log(
    '\n  These are the states CI cannot reproduce, and separating them is what KAN-537 asked\n' +
      '  for: before it, a bare fleet and a broken marker were the same exit code and the same\n' +
      '  text, so three agents in one day each spent time deciding whether they had broken\n' +
      '  something. A tree parked for hours is still worth chasing — on its own ticket.'
  );
}
process.exit(failures.length ? 1 : 0);
