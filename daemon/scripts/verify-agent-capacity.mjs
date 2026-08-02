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
// Nine sections:
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
  GIB
} = await import(path.join(distDir, 'capacity.js'));
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

console.log('\n== done ==');
