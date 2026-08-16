#!/usr/bin/env node
//
// WHAT FAILURE THIS WOULD CATCH: `CrabCastRuntime.provision()` telling CrabCast
// nothing about supervisor-ness, so that every `epic` and `story` agent is
// charged a slot by a capacity gate Butchr's own model had already declined to
// charge. Measured on the cutover of 2026-08-16: the drained fleet was
// `epic/kan-59`, `epic/kan-39`, `story/kan-419`, `epic/kan-203`,
// `story/kan-117` — FIVE SUPERVISORS AND ZERO TASK AGENTS — all five charged
// against a cap of 3, and two of them refused `at capacity` on the way back.
// Butchr has exempted supervisors from its own cap since KAN-41 (capacity.ts's
// header for the argument; router.ts's `capacityGate` for the code) and told
// the daemon actually doing the rationing nothing at all (KAN-492).
//
// It would equally catch the fix's own failure mode, which is KAN-294 exactly:
// three flags Butchr sends that CrabCast accepts with `success: true` and
// silently discards, because the field names are wrong. §6 and §7 are the only
// things on this board that can tell those apart — §6 reads the flags back off
// CrabCast's own published echo, and §7 makes their gate ACT on them.
//
// CI-RUNNABLE: partial — §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports
//       `daemon/dist`, and all five assert in full on a runner. §6–§8 need a
//       LIVE CrabCast daemon on this machine's socket, which CI has not got, so
//       they announce themselves SKIPPED there. They are not mocked: the whole
//       value of §6 is that the echo is CrabCast's and of §7 that the refusal is
//       CrabCast's gate, so a reproduction would prove nothing. The skip is
//       reachable ONLY when the socket is absent — a socket that is present and
//       refuses FAILS instead.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// §5–§7 build their payload with the PRODUCTION `buildConfigureAgentPayload`
// out of `daemon/dist`, from a supervisor verdict the PRODUCTION
// `isSupervisorType` gave — so the flags under test are the ones `provision()`
// will send, not flags this file chose. That is why the builder is exported.
//
// What it does NOT exercise, named rather than left to be inferred:
//
//   (a) That `provision()` calls the builder and that `router.ts` hands the seam
//       a real verdict. NOT covered by execution — §2–§3 assert it as TEXT,
//       which is weaker, and the compiler covers the rest: the seam parameter is
//       REQUIRED, so a call site that drops it does not build.
//   (b) That a real flipped daemon spawns the real fleet at its real exemptions.
//       NOT COVERED BY ANY SCRIPT and not coverable by one — the flip is the
//       human's to drive (`cutover.sh` refuses to run inside a herdr pane). The
//       evidence to ask for is in the PR body. §7 is the closest reachable
//       thing: a real agent, really exempt, really admitted by their real gate.
//   (c) Whether exempting supervisors is the RIGHT capacity policy. That is a
//       judgement, it was the human's to make, and it is argued in the PR body
//       and in `buildConfigureAgentPayload`'s docblock from CrabCast's own
//       published arithmetic. A script cannot settle it.
//
// ─────────────────────────────────────────────────────────────────────────────
// BLENDED EXIT — READ THE SECTION, NOT JUST THE CODE. §1–§4 read source as TEXT
// and are unaffected by a failed build: their verdict is about what you wrote.
// §5–§8 import `daemon/dist`, so after a FAILED build they are testing the
// PREVIOUS build and both outcomes mislead. `--static-only` runs §1–§4 alone.
//
// ─────────────────────────────────────────────────────────────────────────────
// RED DRIVE — the mutation is in the source, so the reviewer runs it by hand.
// There is no flag for it deliberately: a flag that made this script send flags
// of its own choosing would be the script asserting on input it supplied.
//
// ⚠ COMMIT FIRST. The restore below is `git checkout <file>`, which restores
// from the INDEX — so on a tree where this work is uncommitted it silently
// reverts the whole file rather than just the mutation, and the next build is
// green for the wrong reason. The author hit exactly that while driving this
// red and had to rewrite the file. `git stash` or a commit before you start.
//
//   sed -i 's/^  const chargeable = !input.supervisor;$/  const chargeable = true;/' \
//       daemon/src/crabcast-runtime.ts
//   grep -n 'const chargeable = true;' daemon/src/crabcast-runtime.ts  # ASSERT THE EDIT TOOK
//   ( cd daemon && npm run build )                                     # unpiped; confirm 0
//   node daemon/scripts/verify-crabcast-supervisor-exemption.mjs
//   git checkout daemon/src/crabcast-runtime.ts && ( cd daemon && npm run build )
//
// Expected red: §2 fails on the text, §5 collapses the supervisor and task rows
// onto the same three flags, §6 shows CrabCast echoing `chargeable: true` for an
// epic, and §7 sees `exemptAgents` never move — the live fleet's exact condition
// on 2026-08-16. Restore with `git checkout daemon/src/crabcast-runtime.ts` and
// rebuild.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const staticOnly = process.argv.includes('--static-only');

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const srcDir = path.join(repoRoot, 'daemon', 'src');
const distDir = path.join(repoRoot, 'daemon', 'dist');

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

let failures = 0;
let skipped = 0;
function check(ok, what, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${String(detail).split('\n').join('\n        ')}`);
  }
  return ok;
}
function skip(what, why) {
  skipped++;
  console.log(`  SKIP  ${what}\n        ${why}`);
}

const read = (rel) => fs.readFileSync(path.join(srcDir, rel), 'utf8');
const seamSrc = read('agent-runtime.ts');
const runtimeSrc = read('crabcast-runtime.ts');
const routerSrc = read('router.ts');
const herdrSrc = read('herdr.ts');
/** Source with comments removed — so an assertion cannot be satisfied by prose. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** The three names, as CrabCast publishes them. Nothing here may spell them twice. */
const GATE_FLAGS = ['refusable', 'chargeable', 'preemptable'];

// ───────────────────────────────────────────────────────────────────────────
rule('§1  The seam carries `supervisor`, and it is REQUIRED');
// ───────────────────────────────────────────────────────────────────────────
// Required is the whole of the guard. An OPTIONAL parameter defaults to
// `undefined`, which reads as *not a supervisor* — which IS the defect,
// re-created silently the first time a call site forgets, on exactly the
// population (an all-supervisor fleet) that has no task agent to make the
// shortfall visible. Omission has to be a compile error.

const spawnSig = seamSrc.match(/ {2}spawnSession\(([\s\S]*?)\n {2}\): HerdrSession;/);
if (check(Boolean(spawnSig), "the interface's spawnSession signature is findable")) {
  check(
    /\n\s*supervisor: boolean,/.test(spawnSig[1]),
    'it declares `supervisor: boolean` — required, no `?`',
    spawnSig[1]
  );
  check(!/supervisor\?:/.test(spawnSig[1]), 'the parameter is not optional', spawnSig[1]);
  // A required parameter cannot follow an optional one in TypeScript, so this is
  // really a statement about where it had to go. Asserted anyway: if a later
  // author makes `defaultAgent` required and reorders, the compiler stays happy
  // and every positional call site shifts by one — which is precisely what this
  // ticket had to repair across 21 proof scripts.
  check(
    spawnSig[1].indexOf('supervisor: boolean') < spawnSig[1].indexOf('defaultAgent?'),
    'it sits ahead of the optional parameters, where a required one must',
    spawnSig[1]
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§2  The payload derives all three flags from `input.supervisor`');
// ───────────────────────────────────────────────────────────────────────────
// Two claims, and the second is the one a reader is likely to skip. First: the
// flags are sent at all. Second: they are derived from ONE input, so the six
// incoherent states — an agent that cannot be refused but can be preempted, say
// — are unreachable rather than merely unused.

const runtimeCode = code(runtimeSrc);

const payloadType = runtimeCode.match(
  /export type ConfigureAgentPayload = \{([\s\S]*?)\n\};/
);
if (check(Boolean(payloadType), 'ConfigureAgentPayload is findable')) {
  for (const flag of GATE_FLAGS) {
    check(
      new RegExp(`\\n\\s*${flag}: boolean;`).test(payloadType[1]),
      `the payload type declares \`${flag}: boolean\` — required, so it cannot be dropped`,
      payloadType[1]
    );
  }
}

const inputType = runtimeCode.match(/export interface ConfigureAgentInput \{([\s\S]*?)\n\}/);
if (check(Boolean(inputType), 'ConfigureAgentInput is findable')) {
  check(
    /\n\s*supervisor: boolean;/.test(inputType[1]),
    'its `supervisor` is required — a caller with no verdict must say so',
    inputType[1]
  );
}

const builder = runtimeCode.match(
  /export function buildConfigureAgentPayload\(input: ConfigureAgentInput\): ConfigureAgentPayload \{([\s\S]*?)\n\}/
);
if (check(Boolean(builder), 'buildConfigureAgentPayload is exported and findable')) {
  check(
    /const chargeable = !input\.supervisor;/.test(builder[1]),
    'the exemption is computed from `input.supervisor`, once',
    builder[1]
  );
  for (const flag of GATE_FLAGS) {
    check(
      new RegExp(`${flag}: chargeable,|${flag},`).test(builder[1]),
      `\`${flag}\` is that one value rather than its own expression`,
      builder[1]
    );
  }
  // The defect, stated as the thing that must not be in the builder at all: a
  // boolean literal assigned to a gate flag is a flag that stopped depending on
  // the agent, which is the condition this whole ticket is about.
  const literals = GATE_FLAGS.flatMap((flag) =>
    [...builder[1].matchAll(new RegExp(`${flag}:\\s*(true|false)`, 'g'))].map((m) => m[0])
  );
  check(
    literals.length === 0,
    'no boolean literal is assigned to any gate flag',
    literals.join(', ') || '(none)'
  );
}

// KAN-507 appended `override` to this call. As with the sibling assertion in
// `verify-crabcast-priority-roundtrip.mjs`, the whole argument list is pinned so
// that a POSITIONAL slip is caught, which means a correct change to the seam
// turns this red and the pattern is updated to match. The argument went on the
// end, so `supervisor` did not move — which this line is what establishes.
check(
  /this\.provision\(session, promptContent, priority, supervisor, defaultAgent, mcpServers, override\)/.test(
    runtimeCode
  ),
  'spawnSession hands the verdict it was given to provision()',
  '(searched the call in spawnSession)'
);
check(
  /supervisor,\n\s*promptContent,/.test(runtimeCode),
  'provision() passes it into the named builder rather than dropping it',
  '(searched provision())'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§3  Every router call site passes the EXISTING predicate');
// ───────────────────────────────────────────────────────────────────────────
// The ticket's own constraint: *"use what exists; do not invent a second notion
// of supervisor."* A call site passing its own `type === 'epic' || …` would
// type-check perfectly and would be that second notion — one that drifts the
// first time an integration registers a third supervisor type.

const routerCode = code(routerSrc);
const spawnCalls = [...routerCode.matchAll(/this\.herdrBridge\.spawnSession\(([\s\S]*?)\n {6}\);/g)];
if (
  check(
    spawnCalls.length === 2,
    `router.ts's spawnSession call sites are findable (${spawnCalls.length} found, 2 expected)`,
    'the calls moved or were reformatted — this assertion is no longer reading what it thinks it reads'
  )
) {
  const args = spawnCalls.map((m) => m[1].split(',').map((s) => s.trim()));
  const sixth = args.map((a) => a[5]);
  check(
    sixth.every((a) => /^isSupervisorType\(.+\)$/.test(a)),
    `both pass isSupervisorType(...) as the 6th argument (${sixth.join(' | ')})`,
    spawnCalls.map((m) => m[1]).join('\n---\n')
  );
  check(
    sixth.every((a) => a !== 'true' && a !== 'false'),
    'neither passes a boolean literal',
    sixth.join(' | ')
  );
  // The 5th is still `priority` — KAN-482's assertion, restated here because
  // THIS ticket is what inserted a parameter in front of the optionals and so is
  // what could have shifted it.
  const fifth = args.map((a) => a[4]);
  check(
    fifth.every((a) => a === 'config.priority' || a === 'priority'),
    `and KAN-482's priority is still the 5th argument (${fifth.join(' | ')})`,
    fifth.join(' | ')
  );
}
check(
  /import \{ WorkspaceRegistry, isSupervisorType \} from '\.\/registry\.js';/.test(routerCode),
  'router.ts takes the predicate from registry.ts and defines no local copy',
  '(searched router.ts imports)'
);
check(
  !/const\s+isSupervisor\w*\s*=/.test(routerCode),
  'router.ts declares no supervisor predicate of its own',
  '(searched router.ts)'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§4  THE HERDR PATH IS UNCHANGED — the parameter is inert there');
// ───────────────────────────────────────────────────────────────────────────
// Acceptance criterion 3. `HerdrBridge` accepts the parameter because the seam
// declares it, and must do NOTHING with it: under herdr the exemption is applied
// by `router.ts`'s `capacityGate`, above this seam, off the same predicate. A
// `HerdrBridge` that read this value would be a second opinion on a decision
// already taken.

const herdrCode = code(herdrSrc);
const herdrMentions = [...herdrCode.matchAll(/\bsupervisor\b/g)];
check(
  herdrMentions.length === 1,
  `herdr.ts names \`supervisor\` exactly once — the parameter declaration (${herdrMentions.length} found)`,
  herdrCode
    .split('\n')
    .filter((l) => /\bsupervisor\b/.test(l))
    .join('\n')
);
check(
  /priority: number, supervisor: boolean, defaultAgent\?: string/.test(herdrCode),
  'and that one occurrence is the signature',
  '(searched herdr.ts)'
);
for (const flag of GATE_FLAGS) {
  check(
    !new RegExp(`\\b${flag}\\b`).test(herdrCode),
    `herdr.ts never names \`${flag}\` — the gate flags are CrabCast's vocabulary`,
    '(searched herdr.ts)'
  );
}

if (staticOnly) {
  console.log(`\n--static-only: §5–§8 not run.\n`);
  console.log(`${failures ? 'FAILURES: ' + failures : 'all static sections passed'}`);
  process.exit(failures ? 1 : 0);
}

// ───────────────────────────────────────────────────────────────────────────
rule('§5  THE REAL BUILDER, THE REAL PREDICATE — epic/story exempt, task charged');
// ───────────────────────────────────────────────────────────────────────────
// Nothing here is this script's arithmetic. `isSupervisorType` is the production
// aggregate, carrying whatever the production Atlassian integration registered,
// and `buildConfigureAgentPayload` is the function `provision()` calls.

const { WorkspaceRegistry, isSupervisorType } = await import(
  pathToFileURL(path.join(distDir, 'registry.js'))
);
const { createAtlassianIntegration } = await import(
  pathToFileURL(path.join(distDir, 'integrations', 'atlassian-integration.js'))
);
const { IntegrationStateStore } = await import(
  pathToFileURL(path.join(distDir, 'integrations', 'enablement.js'))
);
const { buildConfigureAgentPayload } = await import(
  pathToFileURL(path.join(distDir, 'crabcast-runtime.js'))
);
const { CrabCastLink, defaultCrabCastSocket } = await import(
  pathToFileURL(path.join(distDir, 'crabcast-link.js'))
);

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan492-state-')), 'integrations.json')
  )
);
registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
registry.setEnabled('jira', true);

const KINDS = [
  { type: 'epic', supervisor: true },
  { type: 'story', supervisor: true },
  { type: 'task', supervisor: false }
];

console.log('  type    isSupervisorType   refusable  chargeable  preemptable   expected');
const probes = [];
for (const kind of KINDS) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `kan492-${kind.type}-`));
  const resolved = isSupervisorType(kind.type);
  const payload = buildConfigureAgentPayload({
    session: { workDir },
    priority: registry.priorityFor(kind.type),
    supervisor: resolved,
    promptContent: `KAN-492 supervisor-exemption probe (${kind.type}). A shell that does nothing.`,
    defaultAgent: 'shell',
    mcpServers: undefined
  });
  console.log(
    `  ${kind.type.padEnd(7)} ${String(resolved).padStart(15)}   ` +
      GATE_FLAGS.map((f) => String(payload[f]).padStart(9)).join('  ') +
      `   ${kind.supervisor ? 'exempt' : 'charged'}`
  );
  probes.push({ ...kind, workDir, payload, resolved });
}
console.log('');

for (const p of probes) {
  check(
    p.resolved === p.supervisor,
    `the production predicate calls a ${p.type} agent ${p.supervisor ? 'a supervisor' : 'not a supervisor'}`,
    `answered ${p.resolved}`
  );
  for (const flag of GATE_FLAGS) {
    check(
      p.payload[flag] === !p.supervisor,
      `the ${p.type} payload carries ${flag}: ${!p.supervisor}`,
      `carries ${JSON.stringify(p.payload[flag])}`
    );
  }
}
// The positive control for all of the above: if the builder ignored its input
// and emitted constants, every row would agree with every other row. The defect
// this proof exists for produced exactly that — three flags nobody sent, which
// their daemon defaulted to `true` for the whole fleet.
check(
  new Set(probes.map((p) => GATE_FLAGS.map((f) => p.payload[f]).join('/'))).size === 2,
  'the supervisor rows and the task row are TWO DIFFERENT shapes — a constant would collapse them',
  probes.map((p) => `${p.type}=${GATE_FLAGS.map((f) => p.payload[f]).join('/')}`).join(' ')
);

// ───────────────────────────────────────────────────────────────────────────
rule('§6  ON THE WIRE — CrabCast reports back the flags Butchr sent');
// ───────────────────────────────────────────────────────────────────────────
// KAN-294's lesson, applied before it costs anything: a field we send that the
// far side does not have is accepted with `success: true` and looks exactly like
// a field it kept. The only way to know is to read it back off their surface.
// The names under test are theirs — `crabcast configure --help` publishes
// `--refusable`, `--chargeable` and `--preemptable`, and `configure_response`
// echoes the same three under `config`.

const socketPath = defaultCrabCastSocket();
let link = null;

if (!fs.existsSync(socketPath)) {
  skip(
    'the live round trip',
    `no CrabCast socket at ${socketPath}. This is the CI case and the only reachable ` +
      'skip: a socket that EXISTS and then refuses is a failure below, not a skip.'
  );
} else {
  link = new CrabCastLink({ socketPath, log: () => {} });
  link.connect();
  await new Promise((r) => setTimeout(r, 1000));

  const daemonStatus = await link.request({ action: 'daemon_status' });
  console.log(`  peer: CrabCast at ${socketPath}`);
  console.log(`  daemon_status.success = ${JSON.stringify(daemonStatus.success)}`);
  check(
    daemonStatus.success === true,
    'the live CrabCast daemon answers — this is a real peer, not a stub',
    JSON.stringify(daemonStatus).slice(0, 400)
  );

  console.log('\n  type     sent (r/c/p)      configure echo      agent_status echo');
  for (const p of probes) {
    p.configured = await link.request(p.payload);
    p.status = await link.request({ action: 'agent_status', path: p.workDir });
    const shape = (cfg) => (cfg ? GATE_FLAGS.map((f) => cfg[f]).join('/') : String(cfg));
    console.log(
      `  ${p.type.padEnd(8)} ${GATE_FLAGS.map((f) => p.payload[f]).join('/').padEnd(17)} ` +
        `${shape(p.configured?.config).padEnd(19)} ${shape(p.status?.config)}`
    );
  }
  console.log('');

  for (const p of probes) {
    check(
      p.configured?.success === true,
      `configure_agent accepted the ${p.type} payload`,
      JSON.stringify(p.configured).slice(0, 400)
    );
    for (const flag of GATE_FLAGS) {
      check(
        p.configured?.config?.[flag] === p.payload[flag],
        `configure_response echoes config.${flag} = ${p.payload[flag]} for ${p.type}`,
        `echoed ${JSON.stringify(p.configured?.config?.[flag])}`
      );
      check(
        p.status?.config?.[flag] === p.payload[flag],
        `agent_status reports config.${flag} = ${p.payload[flag]} for ${p.type} — IT ROUND-TRIPPED`,
        `reported ${JSON.stringify(p.status?.config?.[flag])}`
      );
    }
  }

  // THE POSITIVE CONTROL, and §6 is worth nothing without it. Assertions that a
  // surface echoed `true` are satisfied identically by a surface that echoes
  // what it is handed and by one that defaults every unknown field to `true` —
  // which is precisely what CrabCast does, and precisely the state the fleet was
  // in. Only rows that DIFFER separate them.
  const echoed = probes.map((p) => GATE_FLAGS.map((f) => p.status?.config?.[f]).join('/'));
  check(
    new Set(echoed).size === 2,
    'the round trips came back as TWO DISTINCT shapes — the surface discriminates',
    `echoed: ${JSON.stringify(echoed)}`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§7  THEIR GATE ACTS ON IT — `exempt` moves, `running` does not');
// ───────────────────────────────────────────────────────────────────────────
// §6 proves the flags are stored. This proves they are USED, which is a
// different claim and the one the ticket is about: a stored flag nobody consults
// would have left the fleet exactly where it was.
//
// TWO ARMS, and which one runs depends on the machine, so the script says which
// it took. AT CAPACITY the arms are sharp — the charged probe is REFUSED and the
// exempt one is ADMITTED, which is tonight's failure and its repair in two
// calls. BELOW CAPACITY nothing can be refused, so the discriminator is the
// counters: an exempt activation must move `exemptAgents` and must NOT move
// `running`. Both arms assert the same underlying claim; neither is a skip.

const supervisorProbe = probes.find((p) => p.supervisor);
const taskProbe = probes.find((p) => !p.supervisor);

if (!link) {
  skip('the live gate', 'nothing was configured, because §6 did not run.');
} else {
  const capacityOf = async () => {
    const c = await link.request({ action: 'capacity' });
    return { running: c.running, exempt: c.exemptAgents, atCapacity: c.atCapacity, raw: c };
  };

  const before = await capacityOf();
  console.log(
    `  before: running ${before.running} · exempt ${before.exempt} · atCapacity ${before.atCapacity}`
  );
  check(
    typeof before.exempt === 'number',
    'capacity_response carries `exemptAgents` — the term this ticket moves',
    JSON.stringify(before.raw).slice(0, 300)
  );

  if (before.atCapacity) {
    console.log('  arm: AT CAPACITY — the sharp arm. A refusal is reachable.\n');
    const chargedActivation = await link.request({
      action: 'activate_agent',
      path: taskProbe.workDir
    });
    check(
      chargedActivation?.success === false && chargedActivation?.refusedBy === 'capacity',
      'the CHARGED probe is refused by their capacity gate',
      JSON.stringify({
        success: chargedActivation?.success,
        refusedBy: chargedActivation?.refusedBy
      })
    );
    const exemptActivation = await link.request({
      action: 'activate_agent',
      path: supervisorProbe.workDir
    });
    supervisorProbe.activated = exemptActivation?.success === true;
    check(
      exemptActivation?.success === true && exemptActivation?.started === true,
      'the EXEMPT probe is ADMITTED against the same cap, at the same moment — ' +
        'the three flags are the only difference between the two calls',
      JSON.stringify(exemptActivation).slice(0, 400)
    );
  } else {
    console.log('  arm: BELOW CAPACITY — nothing can be refused, so the counters discriminate.\n');
    const chargedActivation = await link.request({
      action: 'activate_agent',
      path: taskProbe.workDir
    });
    taskProbe.activated = chargedActivation?.success === true;
    check(
      chargedActivation?.success === true,
      'the CHARGED probe activates (there was room)',
      JSON.stringify(chargedActivation).slice(0, 400)
    );
    const midway = await capacityOf();
    check(
      midway.running === before.running + 1,
      `a charged activation moves \`running\` (${before.running} → ${midway.running})`,
      JSON.stringify(midway)
    );
    check(
      midway.exempt === before.exempt,
      `…and leaves \`exemptAgents\` alone (${before.exempt} → ${midway.exempt})`,
      JSON.stringify(midway)
    );
    before.running = midway.running;
    before.exempt = midway.exempt;

    const exemptActivation = await link.request({
      action: 'activate_agent',
      path: supervisorProbe.workDir
    });
    supervisorProbe.activated = exemptActivation?.success === true;
    check(
      exemptActivation?.success === true,
      'the EXEMPT probe activates',
      JSON.stringify(exemptActivation).slice(0, 400)
    );
  }

  if (supervisorProbe.activated) {
    // CrabCast recounts on its own timer; give it a moment rather than racing it.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await capacityOf();
    console.log(
      `  after:  running ${after.running} · exempt ${after.exempt} · atCapacity ${after.atCapacity}\n`
    );
    check(
      after.exempt === before.exempt + 1,
      `AC-2: an exempt supervisor moved \`exempt\` (${before.exempt} → ${after.exempt}) — ` +
        'read back off their capacity surface, not claimed',
      JSON.stringify(after.raw).slice(0, 400)
    );
    // The half that makes the line above mean something. `exempt` going up while
    // `running` also went up would be an agent counted TWICE, not an exempt one.
    check(
      after.running === before.running,
      `…and did NOT move \`running\` (${before.running} → ${after.running}) — it holds no charged slot`,
      JSON.stringify(after.raw).slice(0, 400)
    );
    // NOT FREE, AND SAID SO. Their static memory ceiling still reserves for an
    // uncharged agent — *"0.9 GiB is now held off the static memory ceiling for
    // them (KAN-275); the live memory term needs no such reserve because
    // MemAvailable has already had their memory taken out of it."* That is the
    // same split Butchr makes on its own side (capacity.ts uncounts them,
    // agent-cost.ts charges their memory), and asserting it here is what stops
    // this proof from reading as *"exemption makes supervisors cost nothing."*
    check(
      after.raw.capByMemory <= before.raw.capByMemory,
      `the memory ceiling did not RISE for the exempt agent ` +
        `(capByMemory ${before.raw.capByMemory} → ${after.raw.capByMemory}) — ` +
        'the exemption is from the count, not from memory',
      JSON.stringify({ before: before.raw.capByMemory, after: after.raw.capByMemory })
    );
  } else {
    check(false, 'the exempt probe activated, so the counters could be read', 'it did not activate');
  }
}

// ───────────────────────────────────────────────────────────────────────────
rule('§8  CLEANUP — every record and pane this proof made is taken back out');
// ───────────────────────────────────────────────────────────────────────────
// The delete is PROVED rather than inferred, with its own positive control: a
// `success: false` from `agent_status` means nothing unless the same call
// answered `true` a moment ago on the same path. It did, in §6.

if (!link) {
  skip('the cleanup proof', 'nothing was configured, because §6 did not run.');
} else {
  for (const p of probes) {
    if (p.activated) {
      const stopped = await link.request({ action: 'deactivate_agent', path: p.workDir });
      check(
        stopped?.success === true,
        `deactivate_agent stopped the ${p.type} pane this proof started`,
        JSON.stringify(stopped).slice(0, 300)
      );
    }
    const forgotten = await link.request({ action: 'forget_agent', path: p.workDir });
    check(
      forgotten?.success === true,
      `forget_agent removed the ${p.type} record`,
      JSON.stringify(forgotten).slice(0, 400)
    );
    const after = await link.request({ action: 'agent_status', path: p.workDir });
    check(
      after?.success === false,
      `agent_status no longer has a record for the ${p.type} path`,
      JSON.stringify(after).slice(0, 300)
    );
    // The control: the SAME call answered `success: true` for this same path in
    // §6, so a `false` here is the forget and not a query that fails on
    // anything. Without this line the assertion above would pass against a
    // malformed request.
    check(
      p.status?.success === true,
      `…and it had answered true for that path before the forget (the control)`,
      JSON.stringify(p.status?.success)
    );
  }
  // The fleet is left as it was found, which a reader should be able to check
  // rather than take on trust.
  const restored = await link.request({ action: 'capacity' });
  console.log(
    `\n  fleet restored: running ${restored.running} · exempt ${restored.exemptAgents}` +
      ` · atCapacity ${restored.atCapacity}`
  );
  check(
    restored.exemptAgents === 0,
    'no exempt agent of this proof is left running',
    JSON.stringify({ exemptAgents: restored.exemptAgents })
  );
  link.close();
}

for (const p of probes) fs.rmSync(p.workDir, { recursive: true, force: true });

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`);
console.log(
  failures
    ? `RED — ${failures} assertion(s) failed${skipped ? `, ${skipped} skipped` : ''}.`
    : `GREEN — every assertion passed${skipped ? `, ${skipped} section(s) skipped` : ''}.`
);
console.log('='.repeat(78));
process.exit(failures ? 1 : 0);
