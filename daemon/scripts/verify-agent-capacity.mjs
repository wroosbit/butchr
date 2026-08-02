// Proof for KAN-34: the concurrent-agent cap is derived from the hardware,
// travels between machines, refuses legibly, moves with load, and can be
// overridden on purpose.
//
// Extended for KAN-36, which re-measured what an agent costs and reserved a
// slot off the top for the then always-on board manager. Reworked for KAN-41:
// KAN-39 replaced that single manager with epic and story agents that are
// staffed and stood down as work comes and goes, so the reservation is gone
// and only task agents are charged at all. Epic and story agents are
// reported as `supervisors`, never charged.
//
// Extended again for KAN-56: the per-agent cost divisor is no longer only the
// 2026-07-31 constants. The daemon samples its own fleet (agent-cost.ts),
// damps the estimate (agent-cost-damping.ts), and capacity divides by the
// damped figure — with the constants demoted to a labelled seed and the env
// overrides still beating everything. Sections 10–13 prove that plumbing.
//
// Thirteen sections:
//
//   1. derivation    — the cap on THIS machine, with the arithmetic
//   2. reservation   — the removed manager reservation, before and after
//   3. supervisors   — running supervisors change no arithmetic
//   4. portability   — the same arithmetic against hardware we don't have
//   5. census        — epic + story + task through the real butchr_capacity
//   6. refusal       — a real activate call at capacity, and what it answers
//   7. re-attach     — the same call for an agent that is already running
//   8. load          — the same fleet idle and busy, answering differently
//   9. override      — the refusal bypassed deliberately, and recorded
//  10. provenance    — measured cost vs seed: the divisor moves, and says so
//  11. damping       — step response both directions: up fast, down slow
//  12. degrade       — the instrument breaks; capacity answers from the seed
//  13. precedence    — env overrides beat the measurement beats the seed
//
// Sections 5 through 7 and 9 drive the real MessageRouter — handleCapacity
// and handleActivateByKey, the same calls an MCP caller makes — so what they
// print is what a caller actually receives, not a reconstruction. herdr is
// stubbed rather than run: this proves the capacity gate, and the gate
// refuses *before* herdr is ever asked to spawn anything.
//
// Usage: node daemon/scripts/verify-agent-capacity.mjs [distDir]

import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const {
  computeCapacity,
  describeCapacity,
  readMachineFacts,
  readCapacity,
  humanReserveCores,
  humanReserveBytes,
  HERDR_OVERHEAD_CORES,
  MEASURED_AGENT_COST,
  optionsFromEnv,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { dampCost, sampleFromMeasurement, ALPHA_UP, ALPHA_DOWN } =
  await import(path.join(distDir, 'agent-cost-damping.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ------------------------------------------------------- 1. derivation --
rule('1. DERIVATION — the cap on this machine, and the arithmetic behind it');

const here = readCapacity(0, 0);
console.log(describeCapacity(here));
console.log(
  `\n  → cap on this machine: ${here.cap} concurrent task agents ` +
  `(bound by ${here.capBoundBy}). Only task agents are charged; nothing is\n` +
  '    reserved for supervisors and none are counted.'
);
console.log(
  '  The incident that opened KAN-34 was seven agents on this hardware.'
);

// ------------------------------------------------------ 2. reservation --
rule('2. THE REMOVED RESERVATION — the same hardware, before and after KAN-41');

// The fixed hardware the story was specified on — 4 cores, 15.4 GiB — so the
// numbers reproduce anywhere this script runs, not only on that laptop.
const FACTS = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(12 * GIB),
  load1: 0.2
};

// The old model, reconstructed from the constants as they stood at ce0038e:
// one supervisor slot — an agent's worth of core and memory — held off the
// top for the board manager, unconditionally. That code is gone, so it is
// recomputed here rather than re-run.
const RESERVED_SLOTS = 1;
const oldCpuBudget =
  FACTS.cores -
  humanReserveCores(FACTS.cores) -
  HERDR_OVERHEAD_CORES -
  RESERVED_SLOTS * MEASURED_AGENT_COST.cores;
const oldCapByCpu = Math.floor(Math.max(0, oldCpuBudget) / MEASURED_AGENT_COST.cores);
const oldCapByMemory = Math.floor(
  Math.max(
    0,
    FACTS.totalBytes -
      humanReserveBytes(FACTS.totalBytes) -
      RESERVED_SLOTS * MEASURED_AGENT_COST.residentBytes
  ) / MEASURED_AGENT_COST.residentBytes
);
const oldCap = Math.min(oldCapByCpu, oldCapByMemory);
const oldBoundBy = oldCapByCpu <= oldCapByMemory ? 'cpu' : 'memory';

const after = computeCapacity(FACTS, 0);

console.log(`on ${FACTS.cores} cores, ${(FACTS.totalBytes / GIB).toFixed(1)} GiB:\n`);
console.log(
  `  before (reservation, reconstructed)  cap ${oldCap}  ` +
  `(CPU allows ${oldCapByCpu}: (4 − 1 human − 0.5 herdr − 0.75 manager) ÷ 0.75; ` +
  `memory allows ${oldCapByMemory}; bound by ${oldBoundBy})`
);
console.log(
  `  after  (no reservation, live code)   cap ${after.cap}  ` +
  `(CPU allows ${after.capByCpu}, memory allows ${after.capByMemory}; ` +
  `bound by ${after.capBoundBy})`
);
console.log('\nthe live derivation line, with no manager term in it:\n');
console.log(describeCapacity(after));
console.log(
  `\n  → the cap rises by exactly the slot the reservation held: ${oldCap} → ${after.cap}. ` +
  'The reservation\n' +
  '    was right while there was one always-on manager; KAN-39 removed that\n' +
  '    agent, and the slot was being held for something that may not exist.'
);

// ------------------------------------------------------ 3. supervisors --
rule('3. SUPERVISORS — reported, never charged: the arithmetic does not move');

const quiet = computeCapacity(FACTS, 2, { supervisorsRunning: 0 });
const staffed = computeCapacity(FACTS, 2, { supervisorsRunning: 3 });

for (const [label, c] of [['supervisorsRunning: 0', quiet], ['supervisorsRunning: 3', staffed]]) {
  console.log(
    `  ${label.padEnd(22)} cap ${c.cap}, headroom ${c.headroom}, ` +
    `headroomByCap ${c.headroomByCap}, supervisors ${c.supervisors}`
  );
}
const unmoved =
  quiet.cap === staffed.cap &&
  quiet.headroom === staffed.headroom &&
  quiet.headroomByCap === staffed.headroomByCap;
console.log(
  `\n  → cap, headroom and headroomByCap identical: ${unmoved ? 'yes' : 'NO — CHECK THIS'}. ` +
  'Only the reported\n' +
  '    count differs. Epic and story agents read Jira, file tickets and wait;\n' +
  '    their real (usually small) usage is felt through the measured load and\n' +
  '    available memory, not charged in the model.'
);

// ------------------------------------------------------ 4. portability --
rule('4. PORTABILITY — the same code, against hardware this machine is not');

const idle = (cores) => Math.min(0.2, cores * 0.05);
const machines = [
  { label: 'Raspberry Pi 4',        cores: 4,  gib: 4 },
  { label: 'this laptop (4c/15G)',  cores: 4,  gib: 15 },
  { label: 'mid desktop',           cores: 8,  gib: 32 },
  { label: 'workstation',           cores: 16, gib: 64 },
  { label: 'big iron',              cores: 64, gib: 256 },
  { label: 'CPU-rich, RAM-poor',    cores: 32, gib: 8 }
];

console.log(
  'cap is task agents; nothing is reserved for supervisors on any of them.\n'
);
console.log(
  'machine                 cores      RAM   cap   by CPU   by RAM   bound by'
);
for (const m of machines) {
  const totalBytes = m.gib * GIB;
  const c = computeCapacity(
    {
      cores: m.cores,
      totalBytes,
      // A machine at rest: most RAM available, load near zero.
      availableBytes: Math.floor(totalBytes * 0.9),
      load1: idle(m.cores)
    },
    0
  );
  console.log(
    `${m.label.padEnd(22)} ${String(m.cores).padStart(5)} ${String(m.gib + 'G').padStart(8)}` +
    ` ${String(c.cap).padStart(5)} ${String(c.capByCpu).padStart(8)} ${String(c.capByMemory).padStart(8)}` +
    `   ${c.capBoundBy}`
  );
}
console.log(
  '\n  → the number moves with the hardware. The last row is the case a fixed\n' +
  '    constant gets wrong in the other direction: plenty of cores, not enough\n' +
  '    memory to feed them, and memory is what kills rather than slows.\n' +
  '    The first row is the one KAN-36 asked about: the smallest machine here\n' +
  '    still answers with a number the product can be used with, not zero.'
);

// --------------------------------------------- 5, 6, 7 & 9: the real path --
// A herdr that reports exactly the agents we tell it to, and a registry and
// prompt loader that answer enough for the router to reach the gate.
function stubBridge(runningAgentNames) {
  const agents = runningAgentNames.map((name) => ({
    name,
    agentRuntime: 'claude',
    workDir: '/tmp',
    herdrStatus: 'working'
  }));
  return {
    listHerdrAgents: () => agents,
    // The census `surveyAgents` actually asks for. KAN-21 moved it to this
    // reachability-carrying form and this stub was not updated with it, so
    // every section below that drives the real router died on a TypeError
    // instead of proving anything. A proof that cannot run is worse than no
    // proof: it is still cited.
    listHerdrAgentsChecked: () => ({ reachable: true, agents }),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    spawnSession: () => {
      throw new Error('spawnSession must not be reached when capacity refuses');
    }
  };
}

// `priorityFor` answers the floor for everything, which is what an unregistered
// type gets from the real registry too. That keeps this script about capacity:
// nothing here can outrank anything, so no refusal below is softened into a
// preemption offer. KAN-37's ordering is proved by verify-agent-preemption.mjs.
const stubRegistry = {
  get: () => undefined,
  resolve: async () => null,
  priorityFor: () => 1
};
const stubPrompts = { loadAndRender: () => '# prompt' };

function makeRouter(runningAgentNames, onRespond, onBroadcast) {
  return new MessageRouter(
    stubRegistry,
    stubPrompts,
    stubBridge(runningAgentNames),
    onRespond,
    onBroadcast ?? onRespond
  );
}

async function activate(runningAgentNames, args) {
  const events = [];
  let response;
  let reachedSpawn = false;
  const router = makeRouter(
    runningAgentNames,
    (msg) => { response = msg; },
    (msg) => { events.push(msg); }
  );
  try {
    await router.handleActivateByKey(args, (msg) => { response = msg; });
  } catch (e) {
    // The stub throws from spawnSession, which is how we know the gate let the
    // call through rather than answering it.
    if (!String(e.message).includes('spawnSession')) throw e;
    reachedSpawn = true;
  }
  return { response, events, reachedSpawn };
}

// ----------------------------------------------------------- 5. census --
rule('5. THE CENSUS — one epic, one story, one task through butchr_capacity');

// The fleet KAN-39 actually produces: an epic agent, a story agent, and one
// task agent doing the work. The names are what agentNameFor would build, so
// the router recovers each type from the name alone — the same path a real
// sessionless census takes.
const MIXED_FLEET = ['butchr-epic-kan-40', 'butchr-story-kan-41', 'butchr-task-kan-50'];
console.log(`running: ${MIXED_FLEET.join(', ')}\n`);

let censusResponse;
makeRouter(MIXED_FLEET, (msg) => { censusResponse = msg; }).handle({ action: 'capacity' });
console.log('what butchr_capacity answers:\n');
console.log(JSON.stringify(censusResponse, null, 2));
console.log(
  `\n  → running: ${censusResponse.running} (the task agent), ` +
  `supervisors: ${censusResponse.supervisors} (the epic and story agents,\n` +
  '    visible in the report, absent from every figure the arithmetic uses).' +
  (censusResponse.running === 1 && censusResponse.supervisors === 2
    ? ''
    : '\n    EXPECTED running 1 and supervisors 2 — CHECK THIS.')
);

// ---------------------------------------------------------- 6. refusal --
// Fill the board to exactly the derived cap, so the refusal is produced by
// the derivation rather than by a number this script chose — and add an epic
// and a story agent, which are running on any real board and must not consume
// a slot.
const running = [
  'butchr-epic-kan-40',
  'butchr-story-kan-41',
  ...Array.from({ length: here.cap }, (_, i) => `butchr-task-kan-${i + 1}`)
];

rule(
  `6. REFUSAL — two supervisors plus ${here.cap} task agent(s) against a cap of ${here.cap}, ` +
  'asking for one more'
);
console.log(`running: ${running.join(', ')}\n`);

const refused = await activate(running, { type: 'task', key: 'KAN-99' });
console.log('what the caller receives:\n');
console.log(JSON.stringify(refused.response, null, 2));
console.log(
  `\n  → success: ${refused.response.success}, refusedBy: ${refused.response.refusedBy}. ` +
  'The reason and the numbers are\n' +
  '    fields on the response, not buried in a log the caller cannot see and not\n' +
  '    only inside a paragraph the sidepanel would have to parse.\n' +
  `    running counts ${refused.response.capacity.running} task agent(s) and reports the ` +
  `epic and story agents\n    separately as supervisors: ${refused.response.capacity.supervisors}.`
);

// -------------------------------------------------------- 7. re-attach --
rule('7. RE-ATTACH — the same call, for an agent that is already running');

// Same over-full board, but asking for an agent that is already on it. The
// daemon holds no session for it (that map dies with the daemon while the
// herdr pane does not), so this is the path the sidepanel takes after every
// daemon restart. Refusing it would strand the panel away from work already
// in flight, and would do so exactly when the machine is busiest.
const reattach = await activate(running, { type: 'task', key: 'KAN-1' });
// The gate letting it through means the stub's spawnSession throws, so there
// is no response at all — reaching the attach path IS the result here.
console.log(
  'asking to activate task/KAN-1, which is already running as butchr-task-kan-1:\n\n' +
  `  refused: ${reattach.response?.success === false}` +
  (reattach.response?.reason ? ` (${reattach.response.reason})` : '') + '\n' +
  `  reached the spawn/attach path: ${reattach.reachedSpawn}\n`
);
console.log(
  reattach.reachedSpawn && reattach.response?.success !== false
    ? '  → allowed through. Attaching to an agent that already exists starts nothing\n' +
      '    and costs the machine nothing, so the gate has nothing to ration. This\n' +
      '    is the path the sidepanel takes after every daemon restart; gating it\n' +
      '    would strand the panel away from work already in flight.'
    : '  → REFUSED — CHECK THIS. A re-attach must never be gated on capacity.'
);

// ------------------------------------------------------------- 8. load --
rule('8. LOAD SENSITIVITY — same machine, same agent count, different load');

const facts = readMachineFacts();
for (const [label, load1] of [['idle fleet', 0.15], ['busy fleet (compiling)', facts.cores * 2]]) {
  const c = computeCapacity({ ...facts, load1 }, 1);
  console.log(
    `${label.padEnd(24)} load ${String(load1.toFixed(2)).padStart(5)}  →  headroom ${c.headroom} ` +
    `(count says ${c.headroomByCap}, load says ${c.headroomByLoad}, memory says ${c.headroomByMemory}; ` +
    `bound by ${c.headroomBoundBy})`
  );
}
console.log(
  '\n  → one agent is running in both rows. A count-only cap cannot tell these\n' +
  '    apart; the load average is what the human actually felt.'
);

// --------------------------------------------------------- 9. override --
rule('9. OVERRIDE — the same call, deliberately');

const overridden = await activate(running, { type: 'task', key: 'KAN-99', override: true });
console.log('the gate now allows it, and records that it did:\n');
console.log(JSON.stringify(overridden.events, null, 2));
console.log(
  '\n  → broadcast as capacity_override_event, logged to the daemon log with the\n' +
  '    full derivation, and echoed to the caller as capacityOverride on the\n' +
  '    activate response. The spawn itself then proceeds — this stub throws on\n' +
  `    spawnSession, which is how we know the gate was passed: ${
    overridden.reachedSpawn ? 'it was' : 'IT WAS NOT — CHECK THIS'
  }.`
);

// ----------------------------------------------------- 10. provenance --
rule('10. PROVENANCE — the same hardware, seed vs measured divisor');

const MIB = 1024 ** 2;

// A measurement shaped exactly like the daemon's sampler publishes: per-tree
// averages, already damped, with the metadata a reader needs to judge it.
const MEASURED = {
  residentBytes: 680 * MIB,
  cores: 0.3,
  sampledAt: Date.parse('2026-08-02T19:00:00Z'),
  windowSeconds: 60,
  agentTrees: 4
};

const seeded = computeCapacity(FACTS, 0);
const measuredCap = computeCapacity(FACTS, 0, { measured: MEASURED });

console.log('with nothing measured — the seed, and the report says so:\n');
console.log(describeCapacity(seeded));
console.log("\nwith the daemon's damped measurement in place of the seed:\n");
console.log(describeCapacity(measuredCap));
console.log(
  `\n  → cap ${seeded.cap} → ${measuredCap.cap} on the same hardware, because the measured tree ` +
  `(${MEASURED.cores} core)\n    is cheaper than the seed's calibrated 0.75. Every figure above carries its\n` +
  '    provenance — (seed) or (measured) — plus the window, tree count and\n' +
  '    timestamp, so the moving divisor stays checkable by hand.'
);

// -------------------------------------------------------- 11. damping --
rule('11. DAMPING — quick to believe expensive, slow to believe cheap');

const meta = { sampledAt: MEASURED.sampledAt, windowSeconds: 60, agentTrees: 4 };
const capFor = (est) => computeCapacity(FACTS, 0, { measured: { ...est, ...meta } }).cap;
const row = (i, est) =>
  console.log(
    `  window ${String(i).padStart(2)}: cost ${est.cores.toFixed(3)} core, ` +
    `${Math.round(est.residentBytes / MIB)} MB → cap ${capFor(est)}`
  );

const CHEAP = { residentBytes: 600 * MIB, cores: 0.15 };
const EXPENSIVE = { residentBytes: 900 * MIB, cores: 1.5 };

console.log(
  `cheap→expensive: the fleet wakes up (alpha up ${ALPHA_UP} — the protective direction):\n`
);
let est = { ...CHEAP };
row(0, est);
let upWindows = 0;
for (let i = 1; i <= 6; i++) {
  est = dampCost(est, EXPENSIVE);
  row(i, est);
  if (upWindows === 0 && est.cores >= EXPENSIVE.cores * 0.9) upWindows = i;
}
const capAfterUp = capFor(est);

console.log(
  `\nexpensive→cheap: the fleet goes idle (alpha down ${ALPHA_DOWN} — the sceptical direction):\n`
);
est = { ...EXPENSIVE };
row(0, est);
let downWindows = 0;
for (let i = 1; i <= 24; i++) {
  est = dampCost(est, CHEAP);
  if (i <= 4 || i % 4 === 0) row(i, est);
  if (downWindows === 0 && est.cores <= CHEAP.cores + (EXPENSIVE.cores - CHEAP.cores) * 0.1) {
    downWindows = i;
  }
}
console.log(
  `\n  → the cap falls within ${upWindows} window(s) of the fleet getting expensive and needs ` +
  `${downWindows || '>24'}\n    windows to believe it got cheap — at the daemon's 60s window, minutes down,\n` +
  '    the better part of half an hour back up. A single good-looking reading is\n' +
  '    not evidence of damping; this staircase is. Under-estimating cost makes\n' +
  '    the desktop unusable; over-estimating refuses an activation — the errors\n' +
  '    are not symmetric, so neither are the alphas.' +
  (capAfterUp <= capFor(EXPENSIVE) + 1 ? '' : '\n    EXPECTED the cap near its expensive-fleet value — CHECK THIS.')
);

// -------------------------------------------------------- 12. degrade --
rule('12. DEGRADE — the instrument breaks; capacity still answers, from the seed');

const window60 = { elapsed: 60, loadStart: 0.2, loadEnd: 0.2, agents: [] };
const badWindows = [
  ['zero agent trees ', { ...window60, totals: { agents: 0, cores: 0, residentMb: 0 } }],
  ['negative cores   ', { ...window60, totals: { agents: 3, cores: -0.2, residentMb: 1800 } }],
  ['zero cores       ', { ...window60, totals: { agents: 3, cores: 0, residentMb: 1800 } }],
  ['absurd rss       ', {
    ...window60,
    totals: { agents: 3, cores: 0.4, residentMb: (FACTS.totalBytes / MIB) * 9 }
  }],
  ['zero-length window', { ...window60, elapsed: 0, totals: { agents: 3, cores: 0.4, residentMb: 1800 } }]
];
console.log('what sampleFromMeasurement makes of windows that prove nothing:\n');
let allRejected = true;
for (const [label, m] of badWindows) {
  const s = sampleFromMeasurement(m, FACTS.totalBytes);
  allRejected &&= s === null;
  console.log(`  ${label} → ${s === null ? 'null (rejected)' : JSON.stringify(s) + ' — CHECK THIS'}`);
}
console.log(
  `\n  → every bad window rejects to null${allRejected ? '' : ' — EXCEPT SOME, CHECK THIS'}. ` +
  'The daemon clears the live measurement on\n' +
  '    null (and on a /proc read throwing), so what capacity answers is:\n'
);
console.log(describeCapacity(computeCapacity(FACTS, 1, { measured: null })));
console.log(
  '\n  → the figures are the seed constants and the report *says* seed — the same\n' +
  '    guarantee the Jira lookup makes: whatever breaks, capacity still answers,\n' +
  '    conservatively, and a figure nobody measured is labelled as such.'
);

// ----------------------------------------------------- 13. precedence --
rule('13. PRECEDENCE — the operator beats the measurement beats the seed');

console.log(
  'BUTCHR_AGENT_CORES=0.75 set by hand, memory left alone, measurement live:\n'
);
console.log(
  describeCapacity(computeCapacity(FACTS, 0, { measured: MEASURED, overrides: { cores: 0.75 } }))
);
console.log(
  '\n  → cores says (override) and the measured 0.3 is named as ignored; memory\n' +
  '    stays (measured). Overrides are per-dimension: overriding cores does not\n' +
  '    silently discard the memory measurement.\n'
);

console.log('BUTCHR_MAX_AGENTS=2 on top of everything:\n');
console.log(
  describeCapacity(
    computeCapacity(FACTS, 0, { measured: MEASURED, overrides: { cores: 0.75 }, configuredCap: 2 })
  )
);
console.log('\n  → the configured cap pins the answer and skips the derivation entirely.\n');

// The env plumbing itself, with the variables controlled for the demo and
// restored after it.
const savedEnv = {};
for (const name of ['BUTCHR_AGENT_CORES', 'BUTCHR_AGENT_MEMORY_MB', 'BUTCHR_MAX_AGENTS']) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
process.env.BUTCHR_AGENT_CORES = '0.15';
console.log('optionsFromEnv() with only BUTCHR_AGENT_CORES=0.15 in the environment:\n');
console.log(`  ${JSON.stringify(optionsFromEnv())}`);
for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
console.log(
  '\n  → only the dimension actually set becomes an override; an unset variable\n' +
  '    leaves room for the measurement rather than pinning the seed.'
);

console.log('\n== done ==');
