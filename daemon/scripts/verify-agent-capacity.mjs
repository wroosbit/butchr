// Proof for KAN-34: the concurrent-agent cap is derived from the hardware,
// travels between machines, refuses legibly, moves with load, and can be
// overridden on purpose.
//
// Five sections, one per acceptance criterion:
//
//   1. derivation    — the cap on THIS machine, with the arithmetic
//   2. portability   — the same arithmetic against hardware we don't have
//   3. refusal       — a real activate call at capacity, and what it answers
//   4. load          — the same fleet idle and busy, answering differently
//   5. override      — the refusal bypassed deliberately, and recorded
//
// Sections 3 and 5 drive the real MessageRouter.handleActivateByKey, so what
// they print is what an MCP caller actually receives — not a reconstruction.
// herdr is stubbed rather than run: this proves the capacity gate, and the
// gate refuses *before* herdr is ever asked to spawn anything.
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
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// ------------------------------------------------------- 1. derivation --
rule('1. DERIVATION — the cap on this machine, and the arithmetic behind it');

const here = readCapacity(0);
console.log(describeCapacity(here));
console.log(
  `\n  → cap on this machine: ${here.cap} concurrent agents (bound by ${here.capBoundBy}).`
);
console.log(
  '  The incident that opened this ticket was seven agents on this hardware.'
);

// ------------------------------------------------------ 2. portability --
rule('2. PORTABILITY — the same code, against hardware this machine is not');

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
  '    memory to feed them, and memory is what kills rather than slows.'
);

// -------------------------------------------------- 3 & 5. the real path --
// A herdr that reports exactly the agents we tell it to, and a registry and
// prompt loader that answer enough for handleActivateByKey to reach the gate.
function stubBridge(runningAgentNames) {
  return {
    listHerdrAgents: () =>
      runningAgentNames.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: '/tmp',
        herdrStatus: 'working'
      })),
    listActiveSessions: () => [],
    getSessionByKey: () => undefined,
    spawnSession: () => {
      throw new Error('spawnSession must not be reached when capacity refuses');
    }
  };
}

const stubRegistry = { get: () => undefined, resolve: async () => null };
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

// Fill the board to exactly the derived cap, so the refusal is produced by
// the derivation rather than by a number this script chose.
const running = Array.from({ length: here.cap }, (_, i) => `butchr-task-kan-${i + 1}`);

rule(`3. REFUSAL — ${running.length} agents running against a cap of ${here.cap}, asking for one more`);
console.log(`running: ${running.join(', ') || '(none)'}\n`);

const refused = await activate(running, { type: 'task', key: 'KAN-99' });
console.log('what the caller receives:\n');
console.log(JSON.stringify(refused.response, null, 2));
console.log(
  `\n  → success: ${refused.response.success}. The reason and the numbers are in the\n` +
  '    error text, not in a log the caller cannot see.'
);

// ------------------------------------------------------------- 4. load --
rule('4. LOAD SENSITIVITY — same machine, same agent count, different load');

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

// --------------------------------------------------------- 5. override --
rule('5. OVERRIDE — the same call, deliberately');

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
