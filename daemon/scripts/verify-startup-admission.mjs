// Proof for KAN-258: a reconciler cannot admit an unbounded number of agents
// between two observations, because starts it has already made are now charged
// against the headroom it believes.
//
// WHAT FAILURE THIS WOULD CATCH: a capacity gate that is correct on every
// individual activation and blind in aggregate — the shape that cost this
// machine load 29.14 on four cores at two minutes' uptime and cost the human a
// hard power-off on 2026-08-10. Every decision in that sequence was right. The
// aggregate was not, because each start was measured against a machine that did
// not yet contain the previous ones. Specifically caught: (a) the CPU headroom
// term rising as agents are started, (b) the board reconciler converging to the
// whole desired fleet in one cycle on a machine that cannot carry it, (c) boot
// restoration bringing back a fleet with the gate switched off, and (d) any of
// those happening silently — a deferral nobody logged is indistinguishable from
// a machine that had room.
//
// WHY THE OBVIOUS PROOF WOULD PROVE NOTHING
//
// "The gate refused" is trivially true of a gate on a full machine, and this
// defect lives entirely on a machine that looks EMPTY. So the fixture holds
// `busyCores` still — which is not a cheat, it is the defect stated as a
// fixture: an observation that has not yet caught the agents just started is
// exactly an observation that does not move when they start. Section 2 is what
// makes that legible: with the machine held still, the pre-fix CPU term does
// not merely fail to fall, it RISES, and the more agents are mid-start the more
// room it reports. Nothing about that is a simulation artefact — it is the real
// `computeCapacity` and the real `boundCoresByObservedCpu`, on stated facts.
//
// WHERE THIS SCRIPT SUPPLIES ITS OWN INPUT, AND WHAT THAT LEAVES UNCOVERED
//
// Sections 2-6 hand `computeCapacity` synthetic MachineFacts, and sections 4-6
// drive the real reconcilers over a fake herdr that spawns nothing. So this
// script does NOT establish:
//
//   * **What an agent really costs while it is starting.** Nothing here spawns
//     a node process, an MCP server or a model connection, so the ramp is
//     modelled by holding the observation still rather than measured. That is
//     deliberate — reproducing the pile-on for real means making a human's
//     workstation unusable, which is the thing this ticket exists to stop — and
//     it is a real hole. Who covers it: section 1 takes a live /proc/stat
//     window on this machine so the instrument itself is shown to be real, and
//     the PR pastes a `butchr_capacity` reading from the running daemon after
//     this branch is installed, plus the live cold-restart run the ticket's AC1
//     asks for. **Neither this script nor that observation is the proof alone.**
//   * **That daemon.ts wires any of this.** Both reconcilers are constructed
//     here by hand. Section 6 mitigates half of it by running the real
//     `reconcileAgents` the daemon calls, but nothing here starts a daemon.
//
// KAN-145 is why those paragraphs exist: two scripts proved the daemon carried
// `activatedBy` by building records that already had it, and it was null in
// production for months with both green. The gap was between them and no script
// owned it. This header marks the edge of this one.
//
// Sections:
//
//   1. instrument  — a live /proc/stat window on this machine, to settle that
//                    the CPU term is seconds fresh and NOT the 120s-stale
//                    reading the ticket's first hypothesis assumed
//   2. amplifier   — THE RED, as arithmetic: busy held still, agents starting.
//                    Pre-fix, `headroomByCpu` goes UP with every start
//   3. charged     — the same facts with the fix: the term falls and closes,
//                    and every figure in the derivation reproduces by hand
//   4. board RED   — the real BoardReconciler, converge, 10 wanted on a 4-core
//                    machine, pre-fix capacity source: all ten admitted
//   5. board GREEN — same loop, same board, same machine, fix in: a survivable
//                    subset starts, the rest are deferred, and the log NAMES
//                    them (a silent deferral is the KAN-256 defect again)
//   6. boot        — the real `reconcileAgents`. THE RED is a copy of the built
//                    module with `override: true` patched back in, which is
//                    what shipped: it restores the whole recorded fleet with
//                    the gate off. Then the same fixture on this build defers
//   7. can it fail — sections 3 and 5's assertions run against a capacity model
//                    with the new term removed. If they still pass, they prove
//                    nothing and this script exits red
//
// Isolation is by $HOME, as verify-board-reconciler-guard.mjs does it: a temp
// HOME keeps this out of ~/.local/share/butchr and no real herdr is contacted.
//
// HOW TO WATCH IT GO RED (do this rather than trusting the green):
//   cd daemon && npm run build
//   # 1. delete the charge, and sections 3, 5 and 7 go red:
//   #    in dist/capacity.js, change the liveCpuBudget line to drop
//   #    `- unobservedStarts.cores`
//   # 2. delete the LOG, keeping the behaviour, and section 5 alone goes red:
//   #    remove the `converged to N of M wanted start(s)` line from
//   #    dist/board-reconcile.js
//   # 3. put the bypass back, and section 6's green half goes red:
//   #    re-add `override: true` to the activate payload in dist/reconcile.js
//   node scripts/verify-startup-admission.mjs
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-startup-admission.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const daemonDir = path.resolve(scriptDir, '..');
const distDir = path.resolve(daemonDir, process.argv[2] ?? 'dist');

if (!fs.existsSync(path.join(distDir, 'capacity.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`no build at ${distDir} — run \`npm run build\` in daemon/ first`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan258-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

let failures = 0;
const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH, modelled on verify-board-reconciler-guard's:
// `agent start` remembers the agent so the census — and the existence check the
// router confirms activations with — sees exactly what was started. It spawns
// no process, which is what makes it safe to run this on the machine the
// incident happened to, and is also the hole the header names.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN258_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';
const state = process.env.KAN258_SHIM_STATE;
const args = process.argv.slice(2);
const startedFile = path.join(state, 'started.json');
const read = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const write = (v) => fs.writeFileSync(startedFile, JSON.stringify(v, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const started = read();
const [a, b] = args;
const nextPaneFile = path.join(state, 'next-pane.json');
const nextPane = () => {
  const n = fs.existsSync(nextPaneFile) ? JSON.parse(fs.readFileSync(nextPaneFile, 'utf8')) : 100;
  fs.writeFileSync(nextPaneFile, JSON.stringify(n + 1));
  return String(n);
};
if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane, cwd: found.cwd } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: 'no such agent' } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  const pane = nextPane();
  started.push({ name: args[2], cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1], pane });
  write(started);
  out({ result: { agent: { name: args[2], pane_id: pane } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'pane' && b === 'close') {
  const remaining = started.filter((s) => s.pane !== args[2]);
  if (remaining.length === started.length) {
    process.stderr.write(JSON.stringify({ error: { code: 'pane_not_found', message: 'no such pane' } }));
    process.exit(1);
  }
  write(remaining);
  out({ result: {} });
}
if (a === 'agent' && b === 'attach') { setInterval(() => {}, 60000); }
else if (a === 'tab' && b === 'create') { out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } }); }
else if (a === 'pane' && b === 'list') { out({ result: { panes: [] } }); }
else { out({ result: {} }); }
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// A fresh state directory per run rather than deleting files in a shared one.
// The difference is not tidiness: a killed PTY's `herdr agent attach` can still
// be on its way out and write to the old file, and a run that cleared state
// underneath it saw its first activation fail the router's existence check
// twenty seconds later — a flaky red in a script whose whole job is to be
// believed about a red.
let shimRun = 0;
const resetShim = () => {
  const dir = path.join(shimState, `run-${++shimRun}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.KAN258_SHIM_STATE = dir;
};

// ------------------------------------------------------------- the harness --

const {
  computeCapacity,
  unobservedStartsAmong,
  startingAgentCost,
  describeCapacity,
  capacityReason,
  readMachineFacts,
  MEASURED_AGENT_COST
} = await import(path.join(distDir, 'capacity.js'));
const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(path.join(distDir, 'integrations', 'enablement.js'));
const { BoardReconciler } = await import(path.join(distDir, 'board-reconcile.js'));
const { boardPageFrom } = await import(path.join(distDir, 'jira.js'));

const GIB = 1024 * 1024 * 1024;

// The machine the incident happened on, as stated in KAN-258: four cores, and
// at a cold boot essentially nothing in use. `availableBytes` is generous on
// purpose — this defect is about the CPU term, and a memory-bound fixture would
// prove the wrong gate closed.
const BOOT_MACHINE = {
  cores: 4,
  totalBytes: Math.round(15.4 * GIB),
  availableBytes: Math.round(12 * GIB),
  load1: 0.3,
  busyCores: 0.3,
  busyWindowSeconds: 5,
  stall: { ioFullPercent: 0, memoryFullPercent: 0 }
};

// The cost figure the daemon actually had at the moment of the incident: a
// damped measurement carried across the restart by agent-cost-store. This is
// the whole reason ten agents were admissible — 0.217 core each against 2.5
// spare cores is eleven agents by the arithmetic — and `provenance: 'restored'`
// is not decoration: it is what makes every start since this daemon came up
// unpriced, because the figure was sampled by the daemon that died.
const RESTORED_COST = {
  cores: 0.217,
  residentBytes: 666 * 1024 * 1024,
  sampledAt: Date.now() - 1000,
  windowSeconds: 60,
  agentTrees: 4,
  provenance: 'restored'
};

/** The gate as it shipped: starts in flight are not charged for. */
const preFixCapacity = (running, supervisors) =>
  computeCapacity(BOOT_MACHINE, running, {
    measured: RESTORED_COST,
    supervisorsRunning: supervisors
  });

/** The gate with KAN-258's term, using the real pure function to count. */
const postFixCapacity = (running, supervisors, startedAt = []) => {
  const u = unobservedStartsAmong(startedAt, RESTORED_COST);
  return computeCapacity(BOOT_MACHINE, running, {
    measured: RESTORED_COST,
    supervisorsRunning: supervisors,
    unobservedStarts: u.count,
    unobservedBecause: u.because
  });
};

// ============================================================ 1. instrument ==
rule('1. THE INSTRUMENT — the CPU term is seconds fresh, not two minutes stale');
console.log(`
  KAN-258's first hypothesis was that ~40 starts are gated against one CPU
  reading, by analogy with CrabCast's KAN-263. That needs the sample to be
  stale. It is not, and this section is here so nobody fixes staleness.
`);
{
  const first = readMachineFacts();
  const spinUntil = Date.now() + 2500;
  while (Date.now() < spinUntil) Math.sqrt(Math.random());
  const second = readMachineFacts();
  console.log(`   first  reading: busyCores=${first.busyCores?.toFixed?.(2) ?? first.busyCores}` +
    ` over ${first.busyWindowSeconds ?? 'n/a'}s`);
  console.log(`   second reading: busyCores=${second.busyCores?.toFixed?.(2) ?? second.busyCores}` +
    ` over ${second.busyWindowSeconds ?? 'n/a'}s`);
  const measured = typeof second.busyCores === 'number';
  const fresh = measured && second.busyWindowSeconds !== null && second.busyWindowSeconds <= 30;
  verdict(
    measured && fresh,
    `the window is ${second.busyWindowSeconds}s — the observation is fresh, so ` +
      'staleness is NOT the defect and the fix must not be a re-sampler',
    'no measured /proc/stat window on this machine; this section cannot settle the question ' +
      '(on a non-Linux box that is expected and the remaining sections still stand)'
  );
}

// ============================================================= 2. amplifier ==
rule('2. THE RED, as arithmetic — pre-fix, headroom RISES as agents start');
console.log(`
  The machine is held still: 0.30 of 4 cores in use, which is what "the
  observation has not caught them yet" looks like as a fixture. Only the agent
  COUNT moves. A term that could see the fleet arriving would fall.
`);
{
  console.log('   running   headroomByCpu   headroomByCap   headroom   atCapacity');
  const cpuTerm = [];
  for (const n of [0, 1, 2, 3, 4, 6, 9]) {
    const c = preFixCapacity(n, 0);
    cpuTerm.push({ n, cpu: c.headroomByCpu });
    console.log(
      `   ${String(n).padStart(7)}   ${String(c.headroomByCpu).padStart(13)}   ` +
      `${String(c.headroomByCap).padStart(13)}   ${String(c.headroom).padStart(8)}   ${c.atCapacity}`
    );
  }
  const rises = cpuTerm[cpuTerm.length - 1].cpu > cpuTerm[0].cpu;
  console.log(`
   The CPU term goes ${cpuTerm.map((r) => r.cpu).join(' → ')}. It does not merely
   fail to fall: it RISES, and the more agents are mid-start the more room it
   reports. That is \`liveCoresBound\` (capacity.ts) doing exactly what it was
   written to do — the per-agent estimate implies more CPU than the machine
   reports in use, so it lowers the divisor to busyCores ÷ agentTrees — on a
   fleet that has not begun spending. **The term that exists to catch an
   over-estimate reads a not-yet-materialised fleet as evidence that agents are
   cheap.** Only the count cap stops it, at eleven, on four cores.`);
  verdict(
    rises,
    'reproduced: the pre-fix CPU headroom term increases with the number of ' +
      'starts it cannot see — positive feedback pointed at the failure',
    'the pre-fix term did not rise; the fixture is not reproducing the defect ' +
      'and every section after this one is measuring something else'
  );
}

// =============================================================== 3. charged ==
rule('3. THE FIX — the same facts, with starts in flight charged');
{
  console.log('   running   headroomByCpu   headroom   atCapacity   charged');
  let closedAt = null;
  for (const n of [0, 1, 2, 3, 4, 6, 9]) {
    const startedAt = Array.from({ length: n }, () => Date.now());
    const c = postFixCapacity(n, 0, startedAt);
    if (closedAt === null && c.atCapacity) closedAt = n;
    console.log(
      `   ${String(n).padStart(7)}   ${String(c.headroomByCpu).padStart(13)}   ` +
      `${String(c.headroom).padStart(8)}   ${String(c.atCapacity).padStart(10)}   ` +
      `${c.unobservedStarts.count} × ${c.unobservedStarts.cost.cores} = ` +
      `${c.unobservedStarts.cores.toFixed(2)} cores (${c.unobservedStarts.because})`
    );
  }

  const four = postFixCapacity(4, 0, Array.from({ length: 4 }, () => Date.now()));
  console.log('\n   The derivation at the point it closes, in full:\n');
  console.log(describeCapacity(four).split('\n').map((l) => `     ${l}`).join('\n'));

  // Every figure re-derived by hand from the figures the derivation prints.
  // A term that quietly divides by something other than what it reports is the
  // reproducibility promise broken (KAN-204's rule, applied to this term).
  const charged = startingAgentCost({ cores: 0.217, residentBytes: 666 * 1024 * 1024 });
  const expectedCores = 4 * charged.cores;
  const budget = 4 - BOOT_MACHINE.busyCores - four.reservedForHuman.cores - expectedCores;
  const expectedCpu = Math.max(0, Math.floor(budget / four.cost.cores));
  console.log(`
   By hand: charged ${charged.cores} core each (max of the 0.217 estimate and the
   ${MEASURED_AGENT_COST.cores} seed, because the estimate measures agents that have settled);
   4 × ${charged.cores} = ${expectedCores.toFixed(2)}; (4 − ${BOOT_MACHINE.busyCores} in use − ${four.reservedForHuman.cores} reserved
   − ${expectedCores.toFixed(2)} in flight) ÷ ${four.cost.cores} = ${expectedCpu}.`);

  verdict(
    closedAt !== null && closedAt <= 6 && four.headroomByCpu === expectedCpu &&
      four.unobservedStarts.count === 4 && four.unobservedStarts.because === 'restored',
    `the term falls and closes at ${closedAt} starts, and the derivation reproduces by hand ` +
      `(headroomByCpu ${four.headroomByCpu} = ${expectedCpu})`,
    'the charged term did not close the gate, or its derivation does not reproduce from ' +
      'the figures it prints'
  );
}

// ------------------------------------------------- the reconciler harness ----

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(scratch, 'integrations.json'))
);
registry.registerIntegration(createAtlassianIntegration());
registry.setEnabled('jira', true);

// One bridge per run, not one shared across the script. A bridge remembers its
// sessions by address, so a section that reused it would meet the *previous*
// section's dead session for the same key — which showed up as the first
// activation of §5 failing the router's existence check twenty seconds later,
// while the shim's fresh state knew nothing about that agent. Sections that
// share a fixture must not share the state the fixture is about.
const bridges = [];
const newBridge = () => {
  const b = new HerdrBridge();
  bridges.push(b);
  return b;
};
const killAll = () => {
  for (const b of bridges) {
    for (const session of b.listActiveSessions()) {
      try { session.ptyProcess?.kill(); } catch {}
    }
  }
};

/** A board of N task tickets, all In Progress and all assigned to this account. */
const boardOf = (n) =>
  boardPageFrom({
    issues: Array.from({ length: n }, (_, i) => ({
      key: `KAN-${900 + i}`,
      fields: {
        summary: `fixture ${i}`,
        status: { name: 'In Progress' },
        issuetype: { name: 'Task' },
        assignee: { accountId: 'acct-1' }
      }
    })),
    total: n,
    maxResults: 100,
    startAt: 0
  });

/**
 * Drive the real BoardReconciler over the real MessageRouter with the given
 * capacity source, and report what it started.
 *
 * The stagger is set to 0 — this is the one dial turned for the script's sake,
 * and it is turned because the stagger is NOT what is under test: KAN-263's
 * sentence is that a stagger spaces starts without making the instrument notice
 * them, and holding `busyCores` still is exactly a fixture in which no amount of
 * spacing helps. A 3-second stagger would add 30 seconds and change no verdict.
 */
async function runBoard(capacitySource, wanted) {
  resetShim();
  const bridge = newBridge();
  const router = new MessageRouter(
    registry,
    new PromptLoader(repoRoot),
    bridge,
    () => {},
    () => {},
    {
      agentRegistry: new AgentRegistry(path.join(scratch, `agents-${Math.random()}.jsonl`)),
      capacitySource
    }
  );
  const log = [];
  const reconciler = new BoardReconciler({
    jira: { searchBoard: async () => ({ ok: true, issues: boardOf(wanted).issues }) },
    runningAgents: () =>
      router.surveyFleet().agents.map((a) => ({
        agentName: a.agentName,
        type: a.type,
        key: router.recordedKeyFor(a.agentName) ?? a.key
      })),
    activate: async (agent) => {
      let response = null;
      await router.handleActivateByKey(
        { type: agent.type, key: agent.key, defaultAgent: 'claude' },
        (msg) => { response = msg; }
      );
      return {
        success: response?.success === true,
        ...(response?.error ? { error: response.error } : {}),
        ...(response?.refusedBy ? { refusedBy: response.refusedBy } : {})
      };
    },
    deactivate: async () => ({ success: true }),
    mode: () => 'converge',
    log: (...args) => log.push(args.join(' ')),
    startStaggerMs: 0
  });
  const cycle = await reconciler.reconcileOnce();
  const started = cycle.started.filter((s) => s.outcome.success);
  const deferred = cycle.started.filter(
    (s) => !s.outcome.success && s.outcome.refusedBy === 'capacity'
  );
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  return { started, deferred, log, cycle };
}

// ============================================================== 4. board RED ==
rule('4. THE RED, produced — the real reconciler, 10 wanted, 4 cores, gate as it shipped');
{
  const { started, deferred } = await runBoard(preFixCapacity, 10);
  console.log(`   started: ${started.length}   deferred for capacity: ${deferred.length}`);
  console.log(`   ${started.map((s) => s.agent.key).join(', ')}`);
  console.log(`
   Ten agents admitted onto four cores, one at a time, each through the real
   \`handleActivateByKey\` and the real gate, none overridden and none forced.
   That is the incident: the board had ten tickets In Progress and the machine
   reached load 29.14 at two minutes' uptime (KAN-258).`);
  verdict(
    started.length === 10 && deferred.length === 0,
    `reproduced: the shipped gate admits all ${started.length} on a machine that cannot carry them`,
    `expected all 10 admitted pre-fix, saw ${started.length} started / ${deferred.length} deferred ` +
      '— the fixture is not reproducing the defect, so the green below proves nothing'
  );
}

// ============================================================ 5. board GREEN ==
rule('5. THE FIX, produced — same loop, same board, same machine');
{
  const { started, deferred, log } = await runBoard(postFixCapacity, 10);
  console.log(`   started: ${started.length}   deferred for capacity: ${deferred.length}`);
  console.log(`   started:  ${started.map((s) => s.agent.key).join(', ') || '(none)'}`);
  console.log(`   deferred: ${deferred.map((s) => s.agent.key).join(', ') || '(none)'}`);

  const summary = log.find((l) => l.includes('converged to'));
  console.log('\n   The cycle summary line, which is what an operator reads:\n');
  console.log(summary ? `     ${summary.replace(/\n/g, '\n     ')}` : '     (NONE — nothing said what it held back)');

  const oneRefusal = deferred[0]?.outcome.error ?? '';
  console.log('\n   And one refusal, which has to name the term that refused:\n');
  console.log(oneRefusal.split('\n').slice(0, 6).map((l) => `     ${l}`).join('\n'));

  const namesStartsInFlight = /start\(s\) in flight|starts in flight/.test(oneRefusal);
  const survivable = started.length > 0 && started.length < 10;
  const namedInLog =
    !!summary && deferred.every((d) => summary.includes(d.agent.key));

  verdict(
    survivable && deferred.length === 10 - started.length && namesStartsInFlight && namedInLog,
    `converged to ${started.length} of 10 and deferred ${deferred.length}, naming every ` +
      'deferred key in the log and naming starts-in-flight in the refusal',
    `expected a survivable subset with the rest deferred AND named: started=${started.length}, ` +
      `deferred=${deferred.length}, refusal names the term=${namesStartsInFlight}, ` +
      `log names every deferred key=${namedInLog}`
  );
}

// ================================================================== 6. boot ==
rule('6. THE BOOT PATH — the bypass that shipped, and its removal');
console.log(`
  This is the path the incident actually took, twice: a cold boot restores every
  agent the registry recorded as active. As it shipped, \`reconcile.ts\` passed
  \`override: true\` — so the gate was not consulted at all, on the reasoning
  that the machine "has already demonstrated it can hold them". A hard power-off
  is the machine demonstrating that it could not.
`);
{
  const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));

  // THE RED: the built module with the bypass patched back in, which is exactly
  // what shipped. This is the "demonstrating the failure needs the pre-fix
  // build" recipe, and it is a one-line patch rather than a checkout.
  //
  // Written as a sibling INSIDE dist rather than into a copy of it under /tmp:
  // the module imports `./router.js` relatively and `node-pty` from
  // node_modules, and a copy somewhere else resolves neither. It is removed
  // again on exit, including on a throw.
  const bypassFile = path.join(distDir, 'reconcile.kan258-bypass.js');
  const src = fs.readFileSync(path.join(distDir, 'reconcile.js'), 'utf8');
  const patched = src.replace(/resume: cause\b/, 'resume: cause, override: true');
  if (patched === src) {
    console.error('could not patch the bypass back in — the source shape changed');
    failures++;
  }
  fs.writeFileSync(bypassFile, patched);
  process.on('exit', () => fs.rmSync(bypassFile, { force: true }));
  const { reconcileAgents: reconcileWithBypass } = await import(bypassFile);

  const expectedFleet = Array.from({ length: 10 }, (_, i) => ({
    agentName: `butchr-task-kan-${900 + i}`,
    type: 'task',
    key: `KAN-${900 + i}`,
    workDir: path.join(scratch, `ws-${i}`),
    defaultAgent: 'claude',
    activatedBy: null
  }));

  const runBoot = async (fn, capacitySource) => {
    resetShim();
    const bridge = newBridge();
    const agentRegistry = new AgentRegistry(path.join(scratch, `boot-${Math.random()}.jsonl`));
    for (const record of expectedFleet) {
      fs.mkdirSync(record.workDir, { recursive: true });
      agentRegistry.recordActivated({ ...record, mcpServers: [] });
    }
    const router = new MessageRouter(
      registry, new PromptLoader(repoRoot), bridge, () => {}, () => {},
      { agentRegistry, capacitySource }
    );
    const log = [];
    const result = await fn({
      registry: agentRegistry,
      herdrBridge: bridge,
      router,
      cause: 'reboot',
      log: (...args) => log.push(args.join(' '))
    });
    for (const session of bridge.listActiveSessions()) {
      try { session.ptyProcess?.kill(); } catch {}
    }
    return { result, log };
  };

  const red = await runBoot(reconcileWithBypass, postFixCapacity);
  const redRestored = red.result.outcomes.filter((o) => o.result === 'restored').length;
  const redDeferred = red.result.outcomes.filter((o) => o.result === 'deferred').length;
  console.log(`   with \`override: true\` (as shipped): restored ${redRestored}, deferred ${redDeferred}`);
  console.log(`   → the gate is not consulted; the fix above cannot help, and does not.`);

  const green = await runBoot(reconcileAgents, postFixCapacity);
  const greenRestored = green.result.outcomes.filter((o) => o.result === 'restored').length;
  const greenDeferred = green.result.outcomes.filter((o) => o.result === 'deferred').length;
  console.log(`\n   on this build:                     restored ${greenRestored}, deferred ${greenDeferred}`);
  const deferLine = green.log.find((l) => l.includes('DEFERRED'));
  console.log('\n   A deferral, which must read as the gate working rather than an outage:\n');
  console.log(deferLine
    ? `     ${deferLine.split('\n').slice(0, 3).join('\n     ')}`
    : '     (NONE — the restoration held agents back and said nothing)');

  verdict(
    redRestored === 10 && redDeferred === 0 &&
      greenRestored > 0 && greenRestored < 10 && greenDeferred === 10 - greenRestored &&
      !!deferLine,
    `the bypass restores all ${redRestored} with the gate off; without it, restoration ` +
      `converges to ${greenRestored} and says out loud what it deferred`,
    `expected 10 restored through the bypass and a survivable subset without it: ` +
      `red=${redRestored}/${redDeferred}, green=${greenRestored}/${greenDeferred}, ` +
      `deferral logged=${!!deferLine}`
  );
}

// =========================================================== 7. can it fail ==
rule('7. CAN IT FAIL — sections 3 and 5 run against a model with the term removed');
console.log(`
  A battery that has only ever passed is evidence of nothing. This re-runs the
  two assertions that matter against a capacity source with KAN-258's term taken
  out — which is precisely the pre-fix build — and demands that they FAIL.
`);
{
  // Section 3's assertion, against the term-less model.
  const four = preFixCapacity(4, 0);
  const closedPreFix = four.atCapacity;
  const chargedPreFix = four.unobservedStarts.count;

  // Section 5's assertion, against the term-less model.
  const { started, deferred, log } = await runBoard(preFixCapacity, 10);
  const survivablePreFix = started.length > 0 && started.length < 10;
  const summaryPreFix = log.find((l) => l.includes('converged to'));

  console.log(`   §3 assertion under the removed term: gate closes at 4 starts = ${closedPreFix} ` +
    `(charged ${chargedPreFix})`);
  console.log(`   §5 assertion under the removed term: survivable subset = ${survivablePreFix} ` +
    `(started ${started.length}, deferred ${deferred.length}, summary line = ${!!summaryPreFix})`);

  verdict(
    !closedPreFix && chargedPreFix === 0 && !survivablePreFix && !summaryPreFix,
    'both assertions fail when the term is removed — so passing them says something',
    'an assertion still passed with the term removed; it is not testing the term ' +
      'and its green above proves nothing'
  );
}

// ===================================================================== done ==
rule(failures ? `FAILED — ${failures} section(s)` : 'ALL SECTIONS PASSED');
if (failures === 0) {
  console.log(`
  What is established: a reconciler that has already started N agents can no
  longer be told there is room for N more, on either start path, and it says
  what it held back.

  What is NOT established, restated because a green run reads as complete: what
  an agent really costs while it is starting. Nothing here spawned one. The PR
  carries the live half — a \`butchr_capacity\` reading from the running daemon
  on this branch, and the cold-restart run KAN-258's AC1 asks for.`);
}

killAll();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
