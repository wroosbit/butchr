// Proof for KAN-201: the live headroom term now divides CPU actually in use,
// measured from /proc/stat, instead of a 1-minute load average — and the gate
// it belongs to still closes.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity gate that was loosened into a gate
// that no longer refuses at all. Removing a safety limit and removing its
// enforcement produce the same green test, and this ticket is a deliberate
// loosening, which is the condition under which that mistake gets made and
// shipped. Also caught: a refusal whose sentence still explains the retired
// load-average arithmetic (a refusal explaining an arithmetic that is no
// longer the arithmetic is worse than no explanation), a derivation whose
// figures no longer reproduce by hand, and a `busyCores` that is silently the
// load-average fallback everywhere because nothing ever measures the real one.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Six sections:
//
//   1. instrument   — a real /proc/stat window on this machine: cores in use
//                     against the load average that used to stand in for them
//   2. before/after — the SAME MachineFacts through the old formula and the
//                     new one, so the comparison cannot be an artefact of the
//                     machine having got quieter between two readings
//   3. hand-check   — every term of the derivation string re-derived from the
//                     figures the derivation itself prints
//   4. the gate     — three synthetic machines, one per binding constraint,
//                     each refused, each naming the constraint that bound
//   5. live refusal — this machine's cores deliberately spent, a real
//                     activation through the real MessageRouter, refused on a
//                     measured figure rather than a supposed one
//   6. can it fail  — section 4's battery run against a capacity model whose
//                     CPU term has been removed. If the battery still passes,
//                     the battery proves nothing and this script exits red
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED:
// section 4 hands `computeCapacity` synthetic MachineFacts. A gate that refuses
// correctly on figures a test invented has not been shown to receive real ones
// — that is exactly how KAN-145's two scripts stayed green while `activatedBy`
// was null in production. So the real reading is what sections 1 and 5 are for:
// section 1 proves `readMachineFacts()` produces a measured `busyCores` from
// this machine's /proc/stat, and section 5 spends this machine's cores for real
// and takes the refusal that comes back from the real router. What none of them
// covers is daemon.ts's five-second sampler *timer* actually firing in the
// installed daemon; nothing here starts a daemon. That is deliberately not load
// bearing — `readMachineFacts()` advances the same sampler on every capacity
// question, so the timer only affects how fresh the first answer after a quiet
// spell is — and the observation that closes it is a `butchr_capacity` reading
// from the running daemon after this branch is installed, pasted in the PR.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # delete the gate: make the CPU term unable to refuse
//   #   in src/capacity.ts, replace the headroom minimum with
//   #   `Math.min(headroomByCap, headroomByMemory)`
//   npm run build && node scripts/verify-cpu-headroom-gate.mjs
//   # sections 4 and 5 fail and the script exits 1; then `git checkout
//   # src/capacity.ts && npm run build` and watch it come back green.
//
// Usage:
//   cd daemon && npm run build
//   # optional but recommended: the pre-change formula, built from the merge
//   # base, so section 2 compares against the real old code rather than a
//   # reconstruction of it
//   cp src/capacity.ts /tmp/kan201-capacity.ts
//   git show $(git merge-base HEAD origin/main):daemon/src/capacity.ts > src/capacity.ts
//   git show $(git merge-base HEAD origin/main):daemon/src/router.ts  > src/router.ts
//   git show $(git merge-base HEAD origin/main):daemon/src/daemon.ts  > src/daemon.ts
//   npx tsc --outDir dist-unfixed
//   git checkout src/router.ts src/daemon.ts && cp /tmp/kan201-capacity.ts src/capacity.ts
//   npm run build
//   node scripts/verify-cpu-headroom-gate.mjs dist dist-unfixed
//
// Section 2 falls back to an inline reconstruction of the old term when the
// unfixed dist is not supplied, and says which it used.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Resolved, because a bare `dist` reaches dynamic import as a package name.
const distDir = path.resolve(process.argv[2] ?? path.join(scriptDir, '..', 'dist'));
const unfixedDir = process.argv[3] ?? null;

const {
  computeCapacity,
  describeCapacity,
  readMachineFacts,
  sampleCpuBusy,
  capacityRefusal,
  setMeasuredAgentCost,
  humanReserveCores,
  GIB
} = await import(path.join(distDir, 'capacity.js'));
const { measureAgentCost } = await import(path.join(distDir, 'agent-cost.js'));
const { sampleFromMeasurement } = await import(path.join(distDir, 'agent-cost-damping.js'));
const { supervisorPredicate } = await import('./lib/supervisor-types.mjs');
// KAN-276: which trees are chargeable. Read from the integration's own
// declarations rather than hardcoded here — see lib/supervisor-types.mjs.
const { isSupervisor } = await supervisorPredicate(distDir);
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

// The pre-change model, if it was built. `computeCapacity` is pure, so the old
// formula can be handed the exact facts the new one saw.
let oldComputeCapacity = null;
if (unfixedDir) {
  try {
    ({ computeCapacity: oldComputeCapacity } = await import(
      path.join(path.resolve(unfixedDir), 'capacity.js')
    ));
  } catch (e) {
    console.log(`(could not load the unfixed build from ${unfixedDir}: ${e.message})`);
  }
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const MIB = 1024 ** 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// --------------------------------------------------------- 1. instrument --
rule('1. THE INSTRUMENT — cores actually in use, against the load average');

// Two readings a window apart; one reading of a cumulative counter says
// nothing, which is why readMachineFacts() cannot answer on its first call and
// says so rather than guessing.
const firstFacts = readMachineFacts();
console.log(
  `first call, no window closed yet: busyCores ${firstFacts.busyCores}` +
  ` (the labelled load-average fallback is what capacity uses until one does)\n`
);
await sleep(3000);
const facts = readMachineFacts();

const measuredBusy = typeof facts.busyCores === 'number';
console.log(
  `this machine: ${facts.cores} cores, ${(facts.totalBytes / GIB).toFixed(1)} GiB ` +
  `(${(facts.availableBytes / GIB).toFixed(1)} GiB available)\n\n` +
  `  load average (1 min)   ${facts.load1.toFixed(2)}\n` +
  `  cores in use (measured) ${measuredBusy ? facts.busyCores.toFixed(2) : '(none)'} ` +
  `over a ${facts.busyWindowSeconds?.toFixed(1) ?? '—'}s window\n`
);
if (measuredBusy) {
  console.log(
    `  the two disagree by ${(facts.load1 - facts.busyCores).toFixed(2)} cores' worth. That gap is the\n` +
    '  ticket: the load average is a run queue — runnable plus uninterruptible-sleep\n' +
    '  tasks — and the old gate subtracted it from a core count as though it were\n' +
    '  utilisation.'
  );
}
verdict(
  measuredBusy &&
    facts.busyCores >= 0 &&
    facts.busyCores <= facts.cores &&
    facts.busyWindowSeconds >= 2,
  `readMachineFacts() returns a measured ${measuredBusy ? facts.busyCores.toFixed(2) : '?'} cores in ` +
    `use over ${facts.busyWindowSeconds?.toFixed(1)}s — a real reading off this machine's\n` +
    '    /proc/stat, not a figure this script supplied. The first call returned null and the\n' +
    '    fallback was labelled, which is the degraded path behaving as documented.',
  `no measured CPU figure arrived: busyCores=${facts.busyCores}, window=${facts.busyWindowSeconds}. ` +
    'Every capacity answer would be running on the load-average fallback, and the ' +
    'change would be inert while looking installed.'
);

// The divisor the daemon would be using: the real instrument, over a real
// window, so sections 2 and 3 report production numbers rather than the seed.
rule('   (measuring what one agent tree costs, the way the daemon does)');
const measurement = await measureAgentCost(10, isSupervisor);
const sample = sampleFromMeasurement(measurement, os.totalmem());
// Rounded exactly as daemon.ts publishes it (whole MB, 3-decimal cores), so
// the figures printed below are the figures the arithmetic divides — which is
// the hand-reproducibility describeCapacity promises and section 3 checks.
const measured = sample
  ? {
      residentBytes: Math.round(sample.residentBytes / MIB) * MIB,
      cores: Math.round(sample.cores * 1000) / 1000,
      sampledAt: Date.now(),
      windowSeconds: measurement.elapsed,
      // Task-agent trees, matching what the divisor beside it was averaged
      // over (KAN-276).
      agentTrees: measurement.chargeable.agents
    }
  : null;
// The live path (section 5) divides by whatever the daemon last published, so
// give it the same figure rather than letting it fall back to the seed — the
// point of that section is to be the production path, not a version of it.
setMeasuredAgentCost(measured);
console.log(
  sample
    ? `  ${measurement.totals.agents} agent tree(s) over ${measurement.elapsed.toFixed(1)}s: ` +
      `${Math.round(sample.residentBytes / MIB)} MB, ${sample.cores.toFixed(3)} core each\n` +
      '  (undamped — one window, the daemon damps across windows; used here so the figures\n' +
      '  below are this fleet\'s rather than the 2026-07-31 seed\'s)'
    : '  no agent trees to measure; everything below answers from the labelled seed'
);

// ------------------------------------------------------- 2. before/after --
rule('2. BEFORE / AFTER — the same machine facts through both formulas');

const RUNNING = 0; // headroom for an empty board, so the count term cannot mask
const options = { measured, supervisorsRunning: 0 };
const now = computeCapacity(facts, RUNNING, options);

// The old term, as it stood at the merge base:
//   headroomByLoad = (cores − reservedForHuman − load1) ÷ costPerAgentCores
const reserved = humanReserveCores(facts.cores);
const reconstructedOldLoadTerm = Math.max(
  0,
  Math.floor((facts.cores - reserved - facts.load1) / now.cost.cores)
);
let before = null;
if (oldComputeCapacity) {
  before = oldComputeCapacity(facts, RUNNING, options);
  console.log(`old formula: the real build from ${unfixedDir}\n`);
} else {
  console.log('old formula: reconstructed inline (no unfixed build supplied)\n');
}
const oldLoadTerm = before ? before.headroomByLoad : reconstructedOldLoadTerm;
const oldHeadroom = before
  ? before.headroom
  : Math.min(now.headroomByCap, oldLoadTerm, now.headroomByMemory);
const oldBoundBy = before
  ? before.headroomBoundBy
  : now.headroomByCap <= oldLoadTerm && now.headroomByCap <= now.headroomByMemory
    ? 'cap'
    : oldLoadTerm <= now.headroomByMemory
      ? 'load'
      : 'memory';

console.log(
  `  before   headroom ${String(oldHeadroom).padStart(3)}   ` +
  `count ${now.headroomByCap}, load ${oldLoadTerm} ((${facts.cores} − ${reserved} reserved − ` +
  `${facts.load1.toFixed(2)} load) ÷ ${now.cost.cores}), memory ${now.headroomByMemory}` +
  `   bound by ${oldBoundBy}`
);
console.log(
  `  after    headroom ${String(now.headroom).padStart(3)}   ` +
  `count ${now.headroomByCap}, cpu ${now.headroomByCpu} ((${facts.cores} − ` +
  `${now.cpuBusyCores.toFixed(2)} in use − ${reserved} reserved) ÷ ${now.cost.cores}), ` +
  `memory ${now.headroomByMemory}   bound by ${now.headroomBoundBy}`
);
console.log(
  `\n  concurrent task agents this machine will now admit: ${oldHeadroom} → ${now.headroom}` +
  (oldHeadroom > 0
    ? ` (${(now.headroom / oldHeadroom).toFixed(1)}x)`
    : ' (the old term was zero, so this is not a multiple of anything — ' +
      'the machine went\n  from refusing everything to admitting a fleet)')
);
if (before && before.headroomByLoad !== reconstructedOldLoadTerm) {
  console.log(
    `\n  NOTE: the inline reconstruction (${reconstructedOldLoadTerm}) disagrees with the real old ` +
    `build (${before.headroomByLoad}).`
  );
}

verdict(
  // Directional, not a target: the target ("about 2x") is a judgement about
  // this machine on this day and belongs in the ticket, but a change that made
  // the gate *tighter* would be the opposite of what was asked for, and a
  // change that left it identical would mean nothing was wired up.
  now.headroom >= oldHeadroom &&
    now.headroomByCpu >= oldLoadTerm &&
    (!before || before.headroomByLoad === reconstructedOldLoadTerm),
  `on identical facts the new term admits ${now.headroomByCpu} where the load term admitted ` +
    `${oldLoadTerm},\n    and headroom went ${oldHeadroom} → ${now.headroom}, bound by ${now.headroomBoundBy}. Same machine, same\n` +
    '    instant, same divisor — the comparison cannot be the machine having gone quiet.',
  `the new term did not loosen the gate on identical facts: headroom ${oldHeadroom} → ` +
    `${now.headroom}, cpu term ${now.headroomByCpu} against the old load term ${oldLoadTerm}` +
    (before && before.headroomByLoad !== reconstructedOldLoadTerm
      ? ' (and the inline reconstruction of the old term disagrees with the real old build)'
      : '')
);

// --------------------------------------------------------- 3. hand-check --
rule('3. HAND-CHECK — the derivation re-derived from the figures it prints');

const derivation = describeCapacity(now);
console.log(derivation);

// Parse the numbers back out of the sentence and recompute each term from
// them. This is the promise the derivation makes — "reproducible by hand" —
// enforced rather than asserted.
const headroomLine = derivation.split('\n').find((l) => l.startsWith('headroom:'));
const cpuLine = derivation.split('\n').find((l) => l.startsWith('cpu in use:'));
const printed = headroomLine.match(
  /count allows (\d+) \((\d+) cap − (\d+) running\), cpu allows (\d+) \(\((\d+) cores − ([\d.]+) in use − (\d+) reserved\) ÷ ([\d.]+)\)/
);
const handChecks = [];
if (!printed) {
  handChecks.push('the headroom line did not parse — its shape changed without this check');
} else {
  const [, byCap, cap, run, byCpu, cores, busy, res, per] = printed.map(Number);
  const handCap = Math.max(0, cap - run);
  const handCpu = Math.max(0, Math.floor((cores - busy - res) / per));
  console.log(
    `\n  count : ${cap} − ${run} = ${handCap}  (printed ${byCap})\n` +
    `  cpu   : (${cores} − ${busy} − ${res}) ÷ ${per} = ${((cores - busy - res) / per).toFixed(2)} ` +
    `→ ${handCpu}  (printed ${byCpu})\n` +
    `  min   : ${Math.min(byCap, byCpu, now.headroomByMemory)}  (printed headroom ${now.headroom})`
  );
  if (handCap !== byCap) handChecks.push(`count term: hand ${handCap} vs printed ${byCap}`);
  // The printed busy figure is rounded to 2dp, so the hand-computed term can
  // legitimately land one either side of the exact one.
  if (Math.abs(handCpu - byCpu) > 1) handChecks.push(`cpu term: hand ${handCpu} vs printed ${byCpu}`);
  if (now.headroom !== Math.min(byCap, byCpu, now.headroomByMemory)) {
    handChecks.push(`headroom ${now.headroom} is not the minimum of the three printed terms`);
  }
}
if (!/measured over \d+s|load-average fallback/.test(cpuLine ?? '')) {
  handChecks.push('the cpu-in-use line does not say where its figure came from');
}
verdict(
  handChecks.length === 0,
  'every term recomputes from the numbers printed beside it, and the cores-in-use\n' +
    '    line names its provenance. A reader can check today\'s answer with a calculator\n' +
    '    even though the divisor moves.',
  `the derivation does not reproduce by hand: ${handChecks.join('; ')}`
);

// ------------------------------------------------------------ 4. the gate --
rule('4. THE GATE STILL CLOSES — one synthetic machine per binding constraint');

// Deliberately synthetic: each machine isolates one term, which no real
// machine will do on demand. What that leaves uncovered — that the real
// machine's figures ever reach this arithmetic — is sections 1 and 5.
const SPENT_CPU = {
  cores: 4,
  totalBytes: 32 * GIB,        // memory and count deliberately generous, so
  availableBytes: 30 * GIB,    // the only thing that can refuse is CPU
  load1: 0.1,                  // and the load average says the machine is idle
  busyCores: 3.9,
  busyWindowSeconds: 5
};
const SPENT_MEMORY = {
  cores: 16,
  totalBytes: 16 * GIB,
  availableBytes: 2.2 * GIB,
  load1: 0.1,
  busyCores: 0.2,
  busyWindowSeconds: 5
};
const IDLE_BIG = {
  cores: 8,
  totalBytes: 16 * GIB,
  availableBytes: 12 * GIB,
  load1: 0.5,
  busyCores: 0.5,
  busyWindowSeconds: 5
};

/**
 * The battery, factored out so section 6 can run the identical checks against
 * a model whose CPU term has been removed. A check that has only ever been run
 * against the passing case has not been shown to be able to fail.
 */
function gateBattery(compute) {
  const problems = [];

  // (a) CPU spent: 3.9 of 4 cores in use, nothing running, memory to spare.
  const cpuBound = compute(SPENT_CPU, 0, { measured: null });
  const cpuRefusal = capacityRefusal(cpuBound, 'task/KAN-999');
  if (!cpuBound.atCapacity) {
    problems.push(
      `a machine with ${SPENT_CPU.busyCores} of ${SPENT_CPU.cores} cores in use admitted ` +
      `${cpuBound.headroom} more agent(s) — the gate does not close on CPU at all`
    );
  } else if (cpuBound.headroomBoundBy !== 'cpu') {
    problems.push(`CPU-bound machine reported bound by ${cpuBound.headroomBoundBy}`);
  } else if (!/not enough cpu/.test(cpuRefusal) || !/cores are already in use/.test(cpuRefusal)) {
    problems.push(`the CPU refusal does not name CPU: "${cpuRefusal.split('\n')[0]}"`);
  } else if (!cpuRefusal.includes(`${SPENT_CPU.busyCores.toFixed(2)} of this machine's ${SPENT_CPU.cores} cores`)) {
    problems.push('the CPU refusal does not quote the figures it refused on');
  }

  // (b) Memory short, CPU idle: the term that binds first on a real laptop
  // once CPU stops lying, and the one this ticket deliberately did not touch.
  const memBound = compute(SPENT_MEMORY, 0, { measured: null });
  if (!memBound.atCapacity || memBound.headroomBoundBy !== 'memory') {
    problems.push(
      `a machine with ${(SPENT_MEMORY.availableBytes / GIB).toFixed(1)} GiB available admitted ` +
      `${memBound.headroom} (bound by ${memBound.headroomBoundBy})`
    );
  } else if (!/not enough memory/.test(capacityRefusal(memBound, 'task/KAN-999'))) {
    problems.push('the memory refusal does not name memory');
  }

  // (c) The board genuinely full on an idle machine: the count term.
  const full = compute(IDLE_BIG, compute(IDLE_BIG, 0, { measured: null }).cap, { measured: null });
  if (!full.atCapacity || full.headroomBoundBy !== 'cap') {
    problems.push(
      `a full board admitted ${full.headroom} more (bound by ${full.headroomBoundBy})`
    );
  } else if (!/at capacity/.test(capacityRefusal(full, 'task/KAN-999'))) {
    problems.push('the count refusal does not say "at capacity"');
  }

  return { problems, cpuBound, cpuRefusal, memBound, full };
}

const battery = gateBattery(computeCapacity);
console.log('(a) 3.9 of 4 cores in use, 30 GiB free, nothing running — load average says 0.10:\n');
console.log(battery.cpuRefusal);
console.log('\n(b) 2.2 GiB available of 16, 16 cores idle:\n');
console.log(`  ${capacityRefusal(battery.memBound, 'task/KAN-999').split('\n')[0]}`);
console.log('\n(c) an idle 8-core machine with the board full:\n');
console.log(`  ${capacityRefusal(battery.full, 'task/KAN-999').split('\n')[0]}`);
console.log(
  '\n  (a) is the one this ticket could have broken. Note what it is refusing on: a\n' +
  '  machine whose load average is 0.10 and whose cores are nonetheless spent. The\n' +
  '  old term would have admitted agents here — which is the other half of the\n' +
  '  argument, and the reason this is a correction rather than a relaxation.'
);
verdict(
  battery.problems.length === 0,
  'all three constraints still refuse, and each refusal names the constraint that\n' +
    '    bound with the figures it bound on. Loosening the CPU term did not remove it.',
  `the gate stopped refusing: ${battery.problems.join('; ')}`
);

// ------------------------------------------------------- 5. live refusal --
rule('5. LIVE REFUSAL — this machine\'s cores spent for real, through the real router');

// Sections 1–4 are arithmetic. This one spends the cores: `facts.cores`
// short-lived busy loops, long enough for a /proc/stat window to close on a
// genuinely saturated machine, and then a real activation through the real
// MessageRouter — the same call an MCP client makes.
function stubBridge(runningAgentNames) {
  const agents = runningAgentNames.map((name) => ({
    name,
    agentRuntime: 'claude',
    workDir: '/tmp',
    herdrStatus: 'working'
  }));
  return {
    listHerdrAgents: () => agents,
    listHerdrAgentsChecked: () => ({ reachable: true, agents }),
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
      throw new Error('spawnSession must not be reached when capacity refuses');
    }
  };
}
const typeRegistry = new WorkspaceRegistry(
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan201-capacity-')), 'integrations.json')
  )
);
typeRegistry.registerIntegration(createAtlassianIntegration());
typeRegistry.setEnabled('jira', true);
const stubRegistry = {
  get: (type) => typeRegistry.get(type),
  resolve: async () => null,
  priorityFor: () => 1,
  disabledMatch: () => null,
  disabledIntegrationForType: () => null,
  mcpServerDefinitions: () => ({})
};
const stubPrompts = { loadAndRender: () => '# prompt' };

async function activate(runningAgentNames, args) {
  let response;
  let reachedSpawn = false;
  const events = [];
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
    if (!String(e.message).includes('spawnSession')) throw e;
    reachedSpawn = true;
  }
  return { response, events, reachedSpawn };
}

// A child that burns a core until it is killed. `fork` with an eval'd body
// keeps this to one file.
const burnerSource = path.join(os.tmpdir(), `kan201-burn-${process.pid}.mjs`);
fs.writeFileSync(burnerSource, 'let x = 0; for (;;) { x = (x + 1) % 1e9; }\n');
const burners = Array.from({ length: os.cpus().length || 1 }, () =>
  fork(burnerSource, [], { stdio: 'ignore' })
);
console.log(`  ${burners.length} busy loop(s) started; waiting for a window to close on them…\n`);
// Long enough for the sampler's 2s floor plus slack, and for the measurement
// to be of the loaded machine rather than of the moment before it.
sampleCpuBusy();
await sleep(6000);
const loaded = readMachineFacts();
const liveRefusal = await activate([], { type: 'task', key: 'KAN-999' });
for (const b of burners) b.kill('SIGKILL');
fs.rmSync(burnerSource, { force: true });

console.log(
  `  cores in use while loaded: ${loaded.busyCores?.toFixed(2) ?? '(none)'} of ${loaded.cores} ` +
  `(load average ${loaded.load1.toFixed(2)})\n`
);
console.log('what the caller receives:\n');
console.log(
  JSON.stringify(
    {
      success: liveRefusal.response?.success,
      refusedBy: liveRefusal.response?.refusedBy,
      reason: liveRefusal.response?.reason,
      capacity: liveRefusal.response?.capacity && {
        headroom: liveRefusal.response.capacity.headroom,
        headroomBoundBy: liveRefusal.response.capacity.headroomBoundBy,
        headroomByCap: liveRefusal.response.capacity.headroomByCap,
        headroomByCpu: liveRefusal.response.capacity.headroomByCpu,
        headroomByMemory: liveRefusal.response.capacity.headroomByMemory,
        cpuBusyCores: liveRefusal.response.capacity.cpuBusyCores,
        cpuBusySource: liveRefusal.response.capacity.cpuBusySource,
        load1: liveRefusal.response.capacity.load1,
        summary: liveRefusal.response.capacity.summary
      }
    },
    null,
    2
  )
);
const liveCap = liveRefusal.response?.capacity;
const liveOk =
  liveRefusal.response?.success === false &&
  liveRefusal.response?.refusedBy === 'capacity' &&
  liveRefusal.reachedSpawn === false &&
  liveCap?.headroomBoundBy === 'cpu' &&
  liveCap?.cpuBusySource === 'measured' &&
  /cores are already in use/.test(String(liveRefusal.response?.reason ?? ''));
verdict(
  liveOk,
  'a real activation, on a machine whose cores were really spent, was really\n' +
    '    refused — bound by cpu, on a *measured* figure, with the sentence naming what\n' +
    '    bound and quoting it. Nothing reached the spawn.',
  'the live refusal did not happen or did not name CPU: success=' +
    `${liveRefusal.response?.success}, refusedBy=${liveRefusal.response?.refusedBy}, ` +
    `boundBy=${liveCap?.headroomBoundBy}, source=${liveCap?.cpuBusySource}, ` +
    `reachedSpawn=${liveRefusal.reachedSpawn}, reason="${liveRefusal.response?.reason ?? ''}". ` +
    'Either the gate does not close on real CPU exhaustion, or the measured figure ' +
    'never reaches it.'
);

// ------------------------------------------------------- 6. can it fail --
rule('6. CAN THE BATTERY FAIL — section 4 run against a model with no CPU term');

// The mutant is what "the gate stopped refusing" looks like from outside:
// headroom stops consulting CPU. If section 4's checks still pass against it,
// section 4 is decoration and its green says nothing — so this script goes red
// on the battery passing, which is the one place in it where passing is failure.
function noCpuTerm(machine, running, opts) {
  const c = computeCapacity(machine, running, opts);
  const headroom = Math.min(c.headroomByCap, c.headroomByMemory);
  return {
    ...c,
    headroomByCpu: Number.POSITIVE_INFINITY,
    headroom,
    headroomBoundBy: c.headroomByCap <= c.headroomByMemory ? 'cap' : 'memory',
    atCapacity: headroom <= 0
  };
}
const mutant = gateBattery(noCpuTerm);
console.log(
  `  with the CPU term removed, the 3.9-of-4-cores machine admits ` +
  `${noCpuTerm(SPENT_CPU, 0, { measured: null }).headroom} agents.\n\n` +
  `  section 4's battery reports ${mutant.problems.length} problem(s) against it:\n` +
  mutant.problems.map((p) => `    - ${p}`).join('\n')
);
verdict(
  mutant.problems.length > 0 &&
    mutant.problems.some((p) => /gate does not close on CPU|bound by/.test(p)),
  'the battery rejects a gate-less model, so its verdict on the real one is worth\n' +
    '    something. This is the check that keeps section 4 from being a green light\n' +
    '    wired to nothing.',
  'section 4\'s battery passed a capacity model with no CPU term at all — it cannot ' +
    'detect the failure this script exists to detect, and its green means nothing.'
);

console.log(
  failures.length
    ? `\n${failures.length} of 6 sections FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS — all 6 sections.'
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
