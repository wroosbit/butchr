// Proof for KAN-34: the concurrent-agent cap is derived from the hardware,
// travels between machines, refuses legibly, moves with load, and can be
// overridden on purpose.
//
// Extended for KAN-36, which found the cap correct in every one of those
// respects and still unusable: on a 4-core machine it allowed the user exactly
// one task agent, and the sidepanel showed nothing when it refused the second.
//
// Eight sections:
//
//   1. derivation    — the cap on THIS machine, with the arithmetic
//   2. manager       — where the board manager is charged, and what that buys
//   3. portability   — the same arithmetic against hardware we don't have
//   4. reported bug  — the exact configuration KAN-36 was filed about
//   5. refusal       — a real activate call at capacity, and what it answers
//   6. re-attach     — the same call for an agent that is already running
//   7. load          — the same fleet idle and busy, answering differently
//   8. override      — the refusal bypassed deliberately, and recorded
//
// Sections 4 through 6 and 8 drive the real MessageRouter.handleActivateByKey,
// so what they print is what an MCP caller actually receives — not a
// reconstruction. herdr is stubbed rather than run: this proves the capacity
// gate, and the gate refuses *before* herdr is ever asked to spawn anything.
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
  MEASURED_AGENT_COST,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ------------------------------------------------------- 1. derivation --
rule('1. DERIVATION — the cap on this machine, and the arithmetic behind it');

const here = readCapacity(0, 1);
console.log(describeCapacity(here));
console.log(
  `\n  → cap on this machine: ${here.cap} concurrent task agents ` +
  `(bound by ${here.capBoundBy}), on top of the board manager.`
);
console.log(
  '  The incident that opened KAN-34 was seven agents on this hardware.'
);

// ---------------------------------------------------------- 2. manager --
rule('2. THE MANAGER — counted against the cap, or reserved before it');

// KAN-36 changed two things at once — where the manager is charged, and what
// an agent costs — and the ticket's hypothesis was that the first was the
// defect. Run them separately against the same hardware, because a fix nobody
// has separated from its neighbour is a fix nobody has tested.
const facts0 = readMachineFacts();
const KAN34_COST = { residentBytes: 480 * 1024 ** 2, cores: 1.0 };

// The question every row answers: with the board manager up, how many task
// agents may the user start? Under "counted" the manager occupies a slot, so
// that is cap − 1; under "reserved" it occupies none, so it is cap.
const variants = [
  { label: 'KAN-34 as shipped', cost: KAN34_COST, reserved: false },
  { label: 'manager reserved only', cost: KAN34_COST, reserved: true },
  { label: 're-measured cost only', cost: MEASURED_AGENT_COST, reserved: false },
  { label: 'KAN-36 (both)', cost: MEASURED_AGENT_COST, reserved: true }
];

console.log(
  `on this machine (${facts0.cores} cores), with the board manager running:\n`
);
console.log('  model                     cost/agent      cap   task agents the user can start');
for (const v of variants) {
  const c = computeCapacity(facts0, v.reserved ? 0 : 1, {
    cost: v.cost,
    supervisorAgents: v.reserved ? 1 : 0,
    supervisorsRunning: 1
  });
  console.log(
    `  ${v.label.padEnd(24)} ${(v.cost.cores + ' core').padEnd(15)} ` +
    `${String(c.cap).padStart(3)}   ${String(c.headroomByCap).padStart(3)}`
  );
}
console.log(
  '\n  → the ticket supposed that counting the manager is what made the cap\n' +
  '    nearly useless. It is not: reserving the manager while keeping 1 core per\n' +
  '    agent lands on the same one task agent, by a different route. What\n' +
  '    restored a usable number was re-measuring the cost — row 3 does it with\n' +
  '    the manager still counted.\n\n' +
  '    Reserving it is still right, for a reason that is not arithmetic. `cap`\n' +
  '    is the number a person reads and acts on, and "2 agents against a cap of\n' +
  '    2" when you have started one is a report that looks like a bug. It also\n' +
  '    stops the number moving: under "counted" the same hardware advertises a\n' +
  '    different capacity depending on whether the manager happens to be up.'
);

// ------------------------------------------------------ 3. portability --
rule('3. PORTABILITY — the same code, against hardware this machine is not');

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
  'cap is task agents; the board manager already has its slot reserved.\n'
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

// --------------------------------------------- 4, 5, 6 & 8: the real path --
// A herdr that reports exactly the agents we tell it to, and a registry and
// prompt loader that answer enough for handleActivateByKey to reach the gate.
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

async function activate(runningAgentNames, args) {
  const events = [];
  let response;
  let reachedSpawn = false;
  const router = new MessageRouter(
    stubRegistry,
    stubPrompts,
    stubBridge(runningAgentNames),
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

// ---------------------------------------------- 4. the reported failure --
rule('4. THE REPORTED FAILURE — the manager plus one task agent, asking for a second');

// The precise configuration KAN-36 was filed about: the board manager, one
// task agent, and a user asking for a second.
//
// The two halves are not proved the same way, and saying so matters. KAN-34's
// verdict is arithmetic — its model counted the manager as a running agent and
// that code is gone, so it is recomputed here rather than re-run. Today's
// verdict is the real MessageRouter.handleActivateByKey, the same call the
// sidepanel toggle makes, against a census of exactly that fleet.
const REPORTED_FLEET = ['butchr-manage-work', 'butchr-task-kan-1'];

console.log(`running: ${REPORTED_FLEET.join(', ')}\n`);

// KAN-34: no supervisor reservation, and the manager among the running agents.
const thenC = computeCapacity(facts0, 2, { cost: KAN34_COST, supervisorAgents: 0 });
console.log(
  `  KAN-34 as shipped    ${thenC.atCapacity ? 'REFUSED' : 'started '} — ` +
  `cap ${thenC.cap}, running ${thenC.running} (the manager is one of them), ` +
  `headroom ${thenC.headroom}`
);

const now = await activate(REPORTED_FLEET, { type: 'task', key: 'KAN-99' });
const nowRefused = now.response?.success === false;
console.log(
  `  KAN-36               ${nowRefused ? 'REFUSED' : 'started '} — ` +
  (nowRefused
    ? now.response.reason
    : `the gate passed and the attach was reached: ${now.reachedSpawn}`)
);

console.log(
  '\n  → the bug as reported, and the fix. Under the old model the user could\n' +
  '    start one task agent and no more, and the panel showed them nothing when\n' +
  '    it refused the second. The second row is the live activate path.'
);

// Fill the board to exactly the derived cap, so the refusal is produced by
// the derivation rather than by a number this script chose — and add the board
// manager, which is running on any real board and must not consume a slot.
const running = [
  'butchr-manage-work',
  ...Array.from({ length: here.cap }, (_, i) => `butchr-task-kan-${i + 1}`)
];

rule(
  `5. REFUSAL — the manager plus ${here.cap} task agent(s) against a cap of ${here.cap}, ` +
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
  `manager separately as\n    supervisors: ${refused.response.capacity.supervisors}.`
);

// -------------------------------------------------------- 6. re-attach --
rule('6. RE-ATTACH — the same call, for an agent that is already running');

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

// ------------------------------------------------------------- 7. load --
rule('7. LOAD SENSITIVITY — same machine, same agent count, different load');

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

// --------------------------------------------------------- 8. override --
rule('8. OVERRIDE — the same call, deliberately');

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
