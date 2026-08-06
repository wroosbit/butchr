// Proof for KAN-34: the concurrent-agent cap is derived from the hardware,
// travels between machines, refuses legibly, moves with what the machine is
// actually spending, and can be overridden on purpose.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity model that stops rationing — a cap
// that is not the minimum of what CPU and memory allow, a gate that admits an
// agent past a full board, a supervisor charged a slot it was never meant to
// cost (or refused on CPU it does not consume), a measured
// per-agent cost adopted undamped or from a window that measured nothing, or a
// refusal whose headline blames a constraint that did not bind. Each of those
// has happened at least once on this board; each has a section below.
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
// Extended for KAN-57: the gate itself now honours what the model decided.
// Supervisor activations — epic and story agents — are never refused on
// capacity or headroom grounds; their cost was never charged, so there was
// nothing for the gate to ration. Section 14 proves it at zero headroom.
//
// Extended for KAN-60: what a refusal *says* now names the constraint that
// bound. A load-bound refusal had been headlined "at capacity" with the cap
// count leading — false by its own figures. Section 15 proves the headline
// renders from headroomBoundBy on both the CPU-bound and count-bound paths.
//
// Reworked for KAN-201: the live term that used to divide a 1-minute load
// average now divides cores actually in use, read from /proc/stat — the same
// units, and the same shape, as the memory term. Sections 8, 14 and 15 assert
// against the new term because they asserted against the old one; what they
// claim is unchanged. That the loosened gate still closes is a separate
// script's subject, verify-cpu-headroom-gate.mjs, which also owns the proof
// that a real measurement reaches the arithmetic — nothing here measures this
// machine's CPU, and a section below that forces zero headroom does it through
// an env override rather than by spending anything.
//
// Fifteen sections:
//
//   1. derivation    — the cap on THIS machine, with the arithmetic
//   2. reservation   — the removed manager reservation, before and after
//   3. supervisors   — running supervisors change no arithmetic
//   4. portability   — the same arithmetic against hardware we don't have
//   5. census        — epic + story + task through the real butchr_capacity
//   6. refusal       — a real activate call at capacity, and what it answers
//   7. re-attach     — the same call for an agent that is already running
//   8. cpu           — the same fleet idle and busy, answering differently
//   9. override      — the refusal bypassed deliberately, and recorded
//  10. provenance    — measured cost vs seed: the divisor moves, and says so
//  11. damping       — step response both directions: up fast, down slow
//  12. degrade       — the instrument breaks; capacity answers from the seed
//  13. precedence    — env overrides beat the measurement beats the seed
//  14. supervisor gate — epic/story activate at zero headroom, no override
//  15. refusal headline — the headline names the constraint that bound
//
// Sections 5 through 7 and 9 drive the real MessageRouter — handleCapacity
// and handleActivateByKey, the same calls an MCP caller makes — so what they
// print is what a caller actually receives, not a reconstruction. herdr is
// stubbed rather than run: this proves the capacity gate, and the gate
// refuses *before* herdr is ever asked to spawn anything.
//
// Usage: node daemon/scripts/verify-agent-capacity.mjs [distDir]

import fs from 'fs';
import os from 'os';
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
  capacityRefusal,
  summarizeCapacity,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { dampCost, sampleFromMeasurement, ALPHA_UP, ALPHA_DOWN } =
  await import(path.join(distDir, 'agent-cost-damping.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// --- verdicts ---------------------------------------------------------------
//
// Until KAN-119 this script had no exit path of any kind: fifteen sections of
// real output, several of which computed the right boolean and rendered it as
// "CHECK THIS" prose, and then exited 0 whatever it found. Those booleans are
// now verdicts, and the sections that had none have been given them — a section
// that only prints is a demonstration, and this file is cited as a proof.
const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

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

// The derivation's own invariant: the cap is whichever resource runs out first,
// and it says which. A cap that exceeded either term would be admitting agents
// the hardware cannot hold — the KAN-34 incident exactly.
verdict(
  here.cap === Math.min(here.capByCpu, here.capByMemory) &&
    here.cap >= 1 &&
    here.capBoundBy === (here.capByCpu <= here.capByMemory ? 'cpu' : 'memory'),
  `the cap is the binding minimum (CPU allows ${here.capByCpu}, memory allows ${here.capByMemory}), ` +
    `at least 1, and names ${here.capBoundBy} as what bound.`,
  `the cap ${here.cap} is not min(cpu ${here.capByCpu}, memory ${here.capByMemory}) ` +
    `or capBoundBy (${here.capBoundBy}) names the wrong constraint.`
);

// ------------------------------------------------------ 2. reservation --
rule('2. THE REMOVED RESERVATION — the same hardware, before and after KAN-41');

// The fixed hardware the story was specified on — 4 cores, 15.4 GiB — so the
// numbers reproduce anywhere this script runs, not only on that laptop.
const FACTS = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(12 * GIB),
  load1: 0.2,
  // Stated rather than left to the load-average fallback: since KAN-201 the
  // live term divides cores in use, and a fixture that omitted them would be
  // exercising the degraded path while claiming to exercise the model.
  busyCores: 0.2,
  busyWindowSeconds: 5
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
  '  The reservation was right while there was one always-on manager; KAN-39\n' +
  '  removed that agent, and the slot was being held for something that may not\n' +
  '  exist.'
);
verdict(
  after.cap === oldCap + RESERVED_SLOTS,
  `the cap rises by exactly the slot the reservation held: ${oldCap} → ${after.cap}.`,
  `expected the cap to rise by exactly ${RESERVED_SLOTS} slot when the reservation went ` +
    `(${oldCap} → ${oldCap + RESERVED_SLOTS}), got ${after.cap}.`
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
console.log(
  '\n  Epic and story agents read Jira, file tickets and wait; their real (usually\n' +
  '  small) usage is felt through the measured load and available memory, not\n' +
  '  charged in the model.'
);
verdict(
  quiet.cap === staffed.cap &&
    quiet.headroom === staffed.headroom &&
    quiet.headroomByCap === staffed.headroomByCap &&
    staffed.supervisors === 3,
  'cap, headroom and headroomByCap are identical with three supervisors running and\n' +
    '    with none. Only the reported count differs.',
  `three running supervisors moved the arithmetic: cap ${quiet.cap}→${staffed.cap}, ` +
    `headroom ${quiet.headroom}→${staffed.headroom}, headroomByCap ` +
    `${quiet.headroomByCap}→${staffed.headroomByCap}, reported supervisors ${staffed.supervisors}.`
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
const caps = {};
for (const m of machines) {
  const totalBytes = m.gib * GIB;
  const c = computeCapacity(
    {
      cores: m.cores,
      totalBytes,
      // A machine at rest: most RAM available, load and CPU near zero.
      availableBytes: Math.floor(totalBytes * 0.9),
      load1: idle(m.cores),
      busyCores: idle(m.cores),
      busyWindowSeconds: 5
    },
    0
  );
  caps[m.label] = c;
  console.log(
    `${m.label.padEnd(22)} ${String(m.cores).padStart(5)} ${String(m.gib + 'G').padStart(8)}` +
    ` ${String(c.cap).padStart(5)} ${String(c.capByCpu).padStart(8)} ${String(c.capByMemory).padStart(8)}` +
    `   ${c.capBoundBy}`
  );
}
console.log(
  '\n  The last row is the case a fixed constant gets wrong in the other direction:\n' +
  '  plenty of cores, not enough memory to feed them, and memory is what kills\n' +
  '  rather than slows.'
);

const pi = caps['Raspberry Pi 4'];
const skewed = caps['CPU-rich, RAM-poor'];
const iron = caps['big iron'];
verdict(
  // Three separate claims the table is making, each of which a fixed constant
  // would get wrong: the number tracks the hardware, the smallest machine is
  // still usable rather than zero, and memory binds when memory is what is short.
  iron.cap > pi.cap &&
    pi.cap >= 1 &&
    skewed.capBoundBy === 'memory' &&
    skewed.cap < skewed.capByCpu,
  `the number moves with the hardware (Pi ${pi.cap} → big iron ${iron.cap}), the smallest\n` +
    `    machine still answers ${pi.cap} rather than zero, and the CPU-rich/RAM-poor row is\n` +
    `    bound by memory (${skewed.cap}, though CPU alone would allow ${skewed.capByCpu}).`,
  `portability broke: Pi ${pi.cap}, big iron ${iron.cap}, ` +
    `CPU-rich/RAM-poor ${skewed.cap} bound by ${skewed.capBoundBy} (CPU allows ${skewed.capByCpu}).`
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
    // The same drift again, one ticket later: KAN-83 moved session lookup from
    // key alone to (key, type) and the router now asks for this one, so every
    // section below that drives the real router died on a TypeError before
    // reaching the gate it exists to prove. Answering `undefined` is what
    // `getSessionByKey` answered — no session exists in these sections — so the
    // repair restores the proof rather than changing what it asserts.
    getSessionByAddress: () => undefined,
    spawnSession: () => {
      throw new Error('spawnSession must not be reached when capacity refuses');
    }
  };
}

// The real workspace types, registered for one reason: supervisor-ness is not a
// property of this stub at all. `isSupervisorType` answers from a module-level
// set that `WorkspaceRegistry.register` maintains, so a stub that registers
// nothing leaves *every* type looking like a charged worker — the epic and story
// agents in the fleets below get counted in `running`, and the supervisor
// exemption section 14 exists to prove cannot fire at all.
//
// This is the third time this stub has drifted from the code it stands in for
// (KAN-21's census shape, KAN-83's session lookup, now this), and the first time
// the drift was load-bearing on a verdict rather than on a crash: with no exit
// code, sections 5, 6 and 14 printed the wrong numbers and the script still went
// green. Registering the real types restores what the sections assert rather
// than changing it — verify-agent-preemption.mjs section 6 proves the same
// exemption against the real registry, and agrees.
const typeRegistry = new WorkspaceRegistry(
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan119-capacity-')), 'integrations.json')
  )
);
typeRegistry.registerIntegration(createAtlassianIntegration());
typeRegistry.setEnabled('jira', true);

// `priorityFor` answers the floor for everything, which is what an unregistered
// type gets from the real registry too. That keeps this script about capacity:
// nothing here can outrank anything, so no refusal below is softened into a
// preemption offer. KAN-37's ordering is proved by verify-agent-preemption.mjs.
const stubRegistry = {
  // Delegated so the router's DTOs read the same supervisor flag the census
  // does; everything else below stays stubbed.
  get: (type) => typeRegistry.get(type),
  resolve: async () => null,
  priorityFor: () => 1,
  // "No integration is switched off" — the answers that keep this script about
  // capacity. An unregistered type here is genuinely unknown rather than one
  // whose integration is disabled, which is a refusal with a different reason
  // (KAN-85) and a different script.
  disabledMatch: () => null,
  disabledIntegrationForType: () => null,
  // No integrations, so no integration-owned MCP servers. The activations
  // below never reach a spawn — the gate answers them — and what a spawn would
  // have written is verify-mcp-assembly.mjs's subject, not this script's.
  mcpServerDefinitions: () => ({})
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
verdict(
  censusResponse.running === 1 && censusResponse.supervisors === 2,
  `running: ${censusResponse.running} (the task agent), supervisors: ${censusResponse.supervisors} ` +
    '(the epic and story\n    agents, visible in the report, absent from every figure the arithmetic uses).',
  `expected running 1 and supervisors 2 from ${MIXED_FLEET.length} agents, got running ` +
    `${censusResponse.running} and supervisors ${censusResponse.supervisors}.`
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
verdict(
  refused.response.success === false &&
    refused.response.refusedBy === 'capacity' &&
    refused.reachedSpawn === false &&
    refused.response.capacity.running === here.cap &&
    refused.response.capacity.supervisors === 2,
  `success: ${refused.response.success}, refusedBy: ${refused.response.refusedBy}, and nothing ` +
    'reached the spawn.\n    The reason and the numbers are fields on the response, not buried in a log the\n' +
    `    caller cannot see. running counts ${refused.response.capacity.running} task agent(s) and reports the epic and\n` +
    `    story agents separately as supervisors: ${refused.response.capacity.supervisors}.`,
  `a full board did not refuse: success=${refused.response.success} ` +
    `refusedBy=${refused.response.refusedBy} reachedSpawn=${refused.reachedSpawn} ` +
    `running=${refused.response.capacity?.running} (cap ${here.cap}) ` +
    `supervisors=${refused.response.capacity?.supervisors}.`
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
verdict(
  reattach.reachedSpawn && reattach.response?.success !== false,
  'allowed through. Attaching to an agent that already exists starts nothing\n' +
    '    and costs the machine nothing, so the gate has nothing to ration. This\n' +
    '    is the path the sidepanel takes after every daemon restart; gating it\n' +
    '    would strand the panel away from work already in flight.',
  'a re-attach to an already-running agent was gated on capacity — the sidepanel ' +
    'would be stranded away from work already in flight after every daemon restart.'
);

// -------------------------------------------------------------- 8. cpu --
rule('8. CPU SENSITIVITY — same machine, same agent count, different CPU in use');

// KAN-201 replaced the load average here with cores actually in use. What this
// section claims did not change: the live term is what tells an idle fleet from
// a compiling one, and a count-only cap cannot. The busy row is now a machine
// whose cores are spent rather than one whose run queue is long — and on the
// evidence in capacity.ts's header those were never the same thing.
const facts = readMachineFacts();
const byCpu = {};
for (const [label, busyCores] of [
  ['idle fleet', 0.15],
  ['busy fleet (compiling)', facts.cores]
]) {
  const c = computeCapacity({ ...facts, busyCores, busyWindowSeconds: 5 }, 1);
  byCpu[label] = c;
  console.log(
    `${label.padEnd(24)} ${String(busyCores.toFixed(2)).padStart(5)} of ${facts.cores} cores in use ` +
    `→  headroom ${c.headroom} ` +
    `(count says ${c.headroomByCap}, cpu says ${c.headroomByCpu}, memory says ${c.headroomByMemory}; ` +
    `bound by ${c.headroomBoundBy})`
  );
}

const idleFleet = byCpu['idle fleet'];
const busyFleet = byCpu['busy fleet (compiling)'];
verdict(
  // Same machine, same one agent running, same count headroom — and a different
  // answer. If these two rows ever agree, the live term has stopped working and
  // the model has silently become the count-only cap KAN-34 replaced.
  busyFleet.headroom < idleFleet.headroom &&
    busyFleet.headroomByCpu === 0 &&
    busyFleet.headroomBoundBy === 'cpu' &&
    idleFleet.headroomByCap === busyFleet.headroomByCap,
  `one agent is running in both rows and the count says ${idleFleet.headroomByCap} in both, yet ` +
    `headroom falls\n    ${idleFleet.headroom} → ${busyFleet.headroom} and the busy row is bound by cpu. A count-only cap cannot\n` +
    '    tell these apart; a spent machine is what the human actually felt.',
  `CPU in use made no difference: headroom ${idleFleet.headroom} idle vs ${busyFleet.headroom} busy ` +
    `(busy headroomByCpu ${busyFleet.headroomByCpu}, bound by ${busyFleet.headroomBoundBy}).`
);

// --------------------------------------------------------- 9. override --
rule('9. OVERRIDE — the same call, deliberately');

const overridden = await activate(running, { type: 'task', key: 'KAN-99', override: true });
console.log('the gate now allows it, and records that it did:\n');
console.log(JSON.stringify(overridden.events, null, 2));
verdict(
  // An override that is not recorded is indistinguishable from a gate that
  // never fired — the deliberate part is the whole point of the feature.
  overridden.reachedSpawn &&
    overridden.events.some((e) => e.action === 'capacity_override_event'),
  'broadcast as capacity_override_event, logged to the daemon log with the\n' +
    '    full derivation, and echoed to the caller as capacityOverride on the\n' +
    '    activate response. The spawn itself then proceeds — this stub throws on\n' +
    '    spawnSession, which is how we know the gate was passed.',
  `override did not both pass the gate and record itself: reachedSpawn=${overridden.reachedSpawn}, ` +
    `capacity_override_event broadcast=${overridden.events.some((e) => e.action === 'capacity_override_event')}.`
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
verdict(
  // The divisor must actually move the answer, and the answer must say which
  // divisor it used. A report that silently switched provenance would leave
  // every cap in the logs unattributable after the fact.
  measuredCap.cap > seeded.cap &&
    /\(seed\)/.test(describeCapacity(seeded)) &&
    /\(measured\)/.test(describeCapacity(measuredCap)),
  `cap ${seeded.cap} → ${measuredCap.cap} on the same hardware, because the measured tree ` +
    `(${MEASURED.cores} core)\n    is cheaper than the seed's calibrated 0.75. Every figure carries its provenance —\n` +
    '    (seed) or (measured) — plus the window, tree count and timestamp, so the moving\n' +
    '    divisor stays checkable by hand.',
  `provenance broke: seeded cap ${seeded.cap}, measured cap ${measuredCap.cap}, ` +
    `and the two reports did not label themselves (seed) and (measured) respectively.`
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
  "\n  At the daemon's 60s window that is minutes down and the better part of half\n" +
  '  an hour back up. A single good-looking reading is not evidence of damping;\n' +
  '  this staircase is. Under-estimating cost makes the desktop unusable;\n' +
  '  over-estimating refuses an activation — the errors are not symmetric, so\n' +
  '  neither are the alphas.'
);
verdict(
  // The asymmetry IS the feature. Equal alphas would pass a "does it damp?"
  // check while throwing away the protection the damping exists to give.
  upWindows > 0 &&
    (downWindows === 0 || downWindows > upWindows) &&
    capAfterUp <= capFor(EXPENSIVE) + 1,
  `the cap falls within ${upWindows} window(s) of the fleet getting expensive and needs ` +
    `${downWindows || '>24'}\n    windows to believe it got cheap — the protective direction is the fast one, and\n` +
    '    the cap ends where the expensive fleet puts it.',
  `damping is not asymmetric or did not converge: up in ${upWindows} window(s), down in ` +
    `${downWindows || '>24'}, cap after the rise ${capAfterUp} against an expensive-fleet cap of ` +
    `${capFor(EXPENSIVE)}.`
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
  '\n  The daemon clears the live measurement on null (and on a /proc read\n' +
  '  throwing), so what capacity answers is:\n'
);
const degraded = describeCapacity(computeCapacity(FACTS, 1, { measured: null }));
console.log(degraded);
verdict(
  // A bad window adopted as a divisor is worse than no measurement: it would
  // set the cap from noise and label the result as measured.
  allRejected && /\(seed\)/.test(degraded) && !/\(measured\)/.test(degraded),
  'every bad window rejects to null, and the figures that follow are the seed\n' +
    '    constants with the report *saying* seed — the same guarantee the Jira lookup\n' +
    '    makes: whatever breaks, capacity still answers, conservatively, and a figure\n' +
    '    nobody measured is labelled as such.',
  allRejected
    ? 'the degraded report did not fall back to the seed, or did not label itself (seed).'
    : 'a window that measured nothing was accepted as a per-agent cost.'
);

// ----------------------------------------------------- 13. precedence --
rule('13. PRECEDENCE — the operator beats the measurement beats the seed');

console.log(
  'BUTCHR_AGENT_CORES=0.75 set by hand, memory left alone, measurement live:\n'
);
const perDimension = describeCapacity(
  computeCapacity(FACTS, 0, { measured: MEASURED, overrides: { cores: 0.75 } })
);
console.log(perDimension);
verdict(
  // Per-dimension is the whole claim. An override that quietly reverted the
  // other dimension to the seed would discard a live measurement nobody asked
  // it to discard, and the report would not say so.
  /\(override\)/.test(perDimension) && /\(measured\)/.test(perDimension),
  'cores says (override) and the measured 0.3 is named as ignored; memory stays\n' +
    '    (measured). Overrides are per-dimension: overriding cores does not silently\n' +
    '    discard the memory measurement.',
  'the override was not per-dimension — the report did not show both (override) and ' +
    '(measured) side by side.'
);

console.log('\nBUTCHR_MAX_AGENTS=2 on top of everything:\n');
const pinned = computeCapacity(FACTS, 0, {
  measured: MEASURED,
  overrides: { cores: 0.75 },
  configuredCap: 2
});
console.log(describeCapacity(pinned));
verdict(
  pinned.cap === 2,
  'the configured cap pins the answer and skips the derivation entirely.',
  `BUTCHR_MAX_AGENTS=2 did not pin the cap — got ${pinned.cap}.`
);

// The env plumbing itself, with the variables controlled for the demo and
// restored after it.
const savedEnv = {};
for (const name of ['BUTCHR_AGENT_CORES', 'BUTCHR_AGENT_MEMORY_MB', 'BUTCHR_MAX_AGENTS']) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
process.env.BUTCHR_AGENT_CORES = '0.15';
console.log('optionsFromEnv() with only BUTCHR_AGENT_CORES=0.15 in the environment:\n');
const fromEnv = optionsFromEnv();
console.log(`  ${JSON.stringify(fromEnv)}`);
for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
verdict(
  // `configuredCap` is reported as null rather than omitted — "asked and not
  // set", which is the distinction the precedence chain is built on.
  fromEnv.overrides?.cores === 0.15 &&
    fromEnv.overrides?.residentBytes == null &&
    fromEnv.configuredCap == null,
  'only the dimension actually set becomes an override; an unset variable leaves\n' +
    '    room for the measurement rather than pinning the seed.',
  `an unset variable still produced an override: ${JSON.stringify(fromEnv)}.`
);

// ------------------------------------------------ 14. supervisor gate --
rule('14. SUPERVISOR GATE — epic and story activate at zero headroom, no override');

// KAN-57. The model has never charged supervisors (sections 3 and 5), but the
// gate still refused them whenever headroom hit 0 — and desktop baseline load
// alone could pin the live term at 0 indefinitely, so always-on infrastructure
// could not start or auto-restore without a human pressing "Start anyway".
//
// Zero headroom is forced the same way an operator could force it: a per-agent
// core cost so large that the CPU term answers 0 on any machine this script
// runs on. That drives the refusal through the real readCapacity/env path
// rather than through figures this script invented.
const savedCores = process.env.BUTCHR_AGENT_CORES;
process.env.BUTCHR_AGENT_CORES = '1000';

const gateCheck = readCapacity(0, 0);
console.log(
  `with BUTCHR_AGENT_CORES=1000: headroomByCpu ${gateCheck.headroomByCpu}, ` +
  `headroom ${gateCheck.headroom}, atCapacity ${gateCheck.atCapacity} ` +
  `(bound by ${gateCheck.headroomBoundBy})\n`
);

// Nothing is running at all — the KAN-39 epic incident exactly: an empty
// machine whose load average alone said no.
const epicAtZero = await activate([], { type: 'epic', key: 'KAN-40' });
const storyAtZero = await activate([], { type: 'story', key: 'KAN-41' });
const taskAtZero = await activate([], { type: 'task', key: 'KAN-99' });

const overrideEvents = [...epicAtZero.events, ...storyAtZero.events]
  .filter((e) => e.action === 'capacity_override_event');

console.log(
  `  epic/KAN-40  (no override) → refused: ${epicAtZero.response?.success === false}, ` +
  `reached spawn: ${epicAtZero.reachedSpawn}\n` +
  `  story/KAN-41 (no override) → refused: ${storyAtZero.response?.success === false}, ` +
  `reached spawn: ${storyAtZero.reachedSpawn}\n` +
  `  task/KAN-99  (no override) → refused: ${taskAtZero.response?.success === false}` +
  (taskAtZero.response?.reason ? ` (${taskAtZero.response.reason})` : '') + '\n' +
  `  capacity_override_event broadcast for the supervisors: ${overrideEvents.length}\n`
);

const supervisorsPassed =
  epicAtZero.reachedSpawn && storyAtZero.reachedSpawn && overrideEvents.length === 0;
const taskStillRefused =
  taskAtZero.response?.success === false &&
  taskAtZero.response?.refusedBy === 'capacity' &&
  String(taskAtZero.response?.reason ?? '').includes('cores are already in use');

verdict(
  supervisorsPassed,
  'both supervisors pass the gate with no override asked for and none\n' +
    '    recorded. Their cost was reserved by the model from the start —\n' +
    '    never counted in running, never charged a slot — so a refusal here\n' +
    '    was the gate arguing with its own arithmetic.',
  `a supervisor was refused at zero headroom, or an override was recorded to let it ` +
    `through: epic reached spawn=${epicAtZero.reachedSpawn}, story reached spawn=` +
    `${storyAtZero.reachedSpawn}, override events=${overrideEvents.length}.`
);
verdict(
  // The other half, and the one that keeps the exemption honest: if the task
  // agent also sailed through, the gate would have stopped rationing anything.
  taskStillRefused,
  'the task agent is still refused, cpu-bound, with the same legible\n' +
    '    reason as before: the exemption is exactly as wide as the supervisor\n' +
    '    set and no wider.',
  `the task agent was not refused cpu-bound at zero headroom: success=` +
    `${taskAtZero.response?.success}, refusedBy=${taskAtZero.response?.refusedBy}, ` +
    `reason=${taskAtZero.response?.reason ?? '(none)'}.`
);

if (savedCores === undefined) delete process.env.BUTCHR_AGENT_CORES;
else process.env.BUTCHR_AGENT_CORES = savedCores;

// ---------------------------------------------- 15. refusal headline --
rule('15. REFUSAL HEADLINE — the headline names the constraint that bound');

// KAN-60. An epic activation during a load spike was refused with a message
// read as "2 of 10, at capacity" — false by its own numbers (2 running
// against a cap of 10), and leading with the count when what bound was the
// load. The refusal string, the one-line summary and the sidepanel headline
// all render from headroomBoundBy now (KAN-201 renamed its 'load' value to
// 'cpu' along with the term), so "at capacity" appears only when
// the count is what bound.

// CPU-bound, count headroom positive: the same env trick as section 14 —
// a per-agent core cost so large the CPU term answers 0 on any machine this
// script runs on, while the count term still has room (nothing is running).
{
  const saved = process.env.BUTCHR_AGENT_CORES;
  process.env.BUTCHR_AGENT_CORES = '1000';

  const loadBound = await activate([], { type: 'task', key: 'KAN-99' });
  const error = String(loadBound.response?.error ?? '');
  const headline = error.split('\n')[0];
  const summary = String(loadBound.response?.capacity?.summary ?? '');

  console.log('cpu-bound (headroomByCpu 0, headroomByCap positive), the refusal headline:\n');
  console.log(`  ${headline}\n`);
  console.log(`and the one-line summary:\n\n  ${summary}\n`);

  const headlineOk =
    /not enough cpu/.test(headline) &&
    /[\d.]+ of this machine's \d+ cores are already in use/.test(headline) &&
    !/at capacity/i.test(headline) &&
    !/\d+ of \d+ task|\d+\/\d+/.test(headline);
  verdict(
    headlineOk && summary.startsWith('not enough cpu'),
    'the headline names cpu, quotes the cores in use against the cores there are,\n' +
      '    and says neither "at capacity" nor "N of cap". The summary leads the same way.',
    'a cpu-bound refusal was headlined with the count — the KAN-60 defect exactly: ' +
      `"${headline}" / summary "${summary}".`
  );

  if (saved === undefined) delete process.env.BUTCHR_AGENT_CORES;
  else process.env.BUTCHR_AGENT_CORES = saved;
}

// Count-bound: the cap genuinely reached, on an otherwise idle machine.
// Synthetic facts through the pure function, so a busy host running this
// script cannot flip the binding constraint to load.
{
  const idle = {
    cores: 8,
    totalBytes: 16 * GIB,
    availableBytes: 12 * GIB,
    load1: 0.5,
    busyCores: 0.5,
    busyWindowSeconds: 5
  };
  const c = computeCapacity(idle, computeCapacity(idle, 0).cap);
  const headline = capacityRefusal(c, 'task/KAN-99').split('\n')[0];
  const summary = summarizeCapacity(c);

  console.log(`\ncount-bound (${c.running} running against a cap of ${c.cap}, load ${idle.load1}), the refusal headline:\n`);
  console.log(`  ${headline}\n`);
  console.log(`and the one-line summary:\n\n  ${summary}\n`);

  const headlineOk =
    c.headroomBoundBy === 'cap' &&
    /at capacity/.test(headline) &&
    headline.includes(`${c.running} task agents are already running against a cap of ${c.cap}`);
  verdict(
    headlineOk && summary.startsWith(`at capacity: ${c.running}/${c.cap}`),
    'at capacity is said here, with N of cap — because here the count is\n' +
      '    the constraint that bound, and the headline is rendered from it.',
    'a count-bound refusal did not say "at capacity" with N of cap: ' +
      `"${headline}" / summary "${summary}" (bound by ${c.headroomBoundBy}).`
  );
}

console.log(
  failures.length
    ? `\n${failures.length} of 15 sections FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS — all 15 sections.'
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
