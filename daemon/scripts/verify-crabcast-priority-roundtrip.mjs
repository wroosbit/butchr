#!/usr/bin/env node
//
// WHAT FAILURE THIS WOULD CATCH: `CrabCastRuntime.provision()` sending a
// hard-coded `priority: 1` for every agent, so that Butchr's own epic-3 /
// story-2 / task-1 scale is discarded at the CrabCast seam and every agent in
// the fleet arrives at the same rank. Measured on the live fleet 2026-08-15:
// three agents activated and then `story/kan-117`, `epic/kan-59` and
// `epic/kan-39` all refused `at capacity` — two supervisors turned away while
// lower-value work held the slots. Preemption cannot rescue it either, and that
// is the sharper half: `outranks` is strictly-greater, so on a scale with one
// value nothing outranks anything and the preemption path is unreachable BY
// CONSTRUCTION. It is not broken; it is being fed a degenerate scale (KAN-482).
//
// It would equally catch the fix's own failure mode — the value arriving
// correctly at `configure_agent` and being DISCARDED by the far side, which is
// KAN-294 exactly: a field CrabCast accepted with `success: true` and simply
// did not have. §6 is the only thing on this board that can tell those two
// apart, because it reads the value back off their own published surface.
//
// CI-RUNNABLE: partial — §1–§4 read `daemon/src/*.ts` as TEXT and §5 imports
//       `daemon/dist`, and all five assert in full on a runner. §6 and §7 need
//       a LIVE CrabCast daemon on this machine's socket, which CI has not got,
//       so they announce themselves SKIPPED there. They are not mocked and
//       there is no fallback: the whole value of §6 is that the echo is
//       CrabCast's, so a reproduction of it would prove nothing. The skip is
//       reachable ONLY when the socket is absent — a socket that is present and
//       refuses FAILS instead. (KAN-482)
//
// KAN-373 — AND THE EXIT CODE NOW CARRIES THAT SENTENCE. It did not. This
// script ended `process.exit(failures ? 1 : 0)`, which consults the skip
// tally not at all, so those SKIPPED sections exited 0 on a runner and a
// caller reading the exit code could not tell a proved peer from an absent
// one. The prose above was true of the PRINTING and false of the process.
// Now: 0 every section ran and passed; 1 something failed; 2 nothing failed
// and something did not run. `--allow-skipped` asserts that an incomplete
// run is acceptable to THIS caller and gets 0 back, and `--static-only`
// already makes that assertion in this script's own vocabulary.
// See `lib/verdict-exit.mjs`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SCRIPT SUPPLIES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// §5 and §6 build their payload with the PRODUCTION `buildConfigureAgentPayload`
// out of `daemon/dist`, from a priority the PRODUCTION `WorkspaceRegistry`
// resolved — so the number under test is the one `provision()` will send, not a
// number this file chose. That is deliberate, and it is why the builder was
// extracted and exported at all.
//
// What it does NOT exercise, named rather than left to be inferred:
//
//   (a) That `provision()` calls the builder, and that `router.ts` hands the
//       seam a real priority. NOT covered by execution — §1–§3 assert it as
//       TEXT, which is weaker, and the compiler covers the rest: the seam
//       parameter is REQUIRED, so a call site that drops it does not build.
//   (b) That a real flipped daemon spawns real agents at their real ranks.
//       NOT COVERED BY ANY SCRIPT and not coverable by one — the flip is the
//       human's to drive (`cutover.sh` refuses to run inside a herdr pane). The
//       evidence to ask for is in the PR body.
//   (c) Whether CrabCast then *acts* on the value — whose capacity gate this is
//       and whose arithmetic. Out of scope here and deliberately: §6 establishes
//       that the value round-trips, which is the question KAN-294 taught us to
//       ask. Their README documents the rest and this script does not restate it.
//
// ─────────────────────────────────────────────────────────────────────────────
// BLENDED EXIT — READ THE SECTION, NOT JUST THE CODE. §1–§4 read source as TEXT
// and are unaffected by a failed build: their verdict is about what you wrote.
// §5–§7 import `daemon/dist`, so after a FAILED build they are testing the
// PREVIOUS build and both outcomes mislead. `--static-only` runs §1–§4 alone.
//
// ─────────────────────────────────────────────────────────────────────────────
// RED DRIVE — the mutation is in the source, so the reviewer runs it by hand.
// There is no flag for it deliberately: a flag that made this script send a `1`
// of its own choosing would be the script asserting on input it supplied, which
// is the defect it is written against.
//
//   sed -i 's/^    priority: input.priority,$/    priority: 1,/' \
//       daemon/src/crabcast-runtime.ts
//   grep -n 'priority: 1,' daemon/src/crabcast-runtime.ts   # ASSERT THE EDIT TOOK
//   ( cd daemon && npm run build )                          # unpiped; confirm 0
//   node daemon/scripts/verify-crabcast-priority-roundtrip.mjs
//
// Expected red: §2 fails on the text, §5 reports epic 1 where 3 was specified,
// and §6 collapses all three ranks onto 1 — the live fleet's exact condition.
// Restore with `git checkout daemon/src/crabcast-runtime.ts` and rebuild.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { reportAndExit } from './lib/verdict-exit.mjs';

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

// ───────────────────────────────────────────────────────────────────────────
rule('§1  The seam carries `priority`, and it is REQUIRED');
// ───────────────────────────────────────────────────────────────────────────
// Required is the whole of the guard. An OPTIONAL parameter here would default
// to `undefined`, which any sane implementation would floor at
// DEFAULT_WORKSPACE_PRIORITY — which is 1 — which is the defect, re-created the
// first time a call site forgot. Omission has to be a compile error.

const spawnSig = seamSrc.match(/ {2}spawnSession\(([\s\S]*?)\n {2}\): HerdrSession;/);
if (check(Boolean(spawnSig), "the interface's spawnSession signature is findable")) {
  check(
    /\n\s*priority: number,/.test(spawnSig[1]),
    'it declares `priority: number` — required, no `?`',
    spawnSig[1]
  );
  check(
    !/priority\?:/.test(spawnSig[1]),
    'the parameter is not optional',
    spawnSig[1]
  );
  // A required parameter cannot follow an optional one in TypeScript, so this
  // is really a statement about where it had to go. Asserted anyway: if a later
  // author makes `defaultAgent` required and reorders, the compiler stays happy
  // and the positional call sites all shift by one.
  const params = spawnSig[1];
  check(
    params.indexOf('priority: number') < params.indexOf('defaultAgent?'),
    'it sits ahead of the optional parameters, where a required one must',
    params
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§2  `provision()` sends the session\'s priority, never a literal');
// ───────────────────────────────────────────────────────────────────────────

const runtimeCode = code(runtimeSrc);

const builder = runtimeCode.match(
  /export function buildConfigureAgentPayload\(input: ConfigureAgentInput\): ConfigureAgentPayload \{([\s\S]*?)\n\}/
);
if (check(Boolean(builder), 'buildConfigureAgentPayload is exported and findable')) {
  check(
    /priority: input\.priority,/.test(builder[1]),
    'the payload\'s `priority` is `input.priority`',
    builder[1]
  );
  check(
    !/priority:\s*\d/.test(builder[1]),
    'no numeric literal is assigned to `priority` anywhere in it',
    builder[1]
  );
}

// The defect, stated as the thing that must not be in this file at all. It was
// `      priority: 1,` inside an inline `Record<string, unknown>`.
const literalPriorities = [...runtimeCode.matchAll(/priority:\s*(\d+)/g)].map((m) => m[0]);
check(
  literalPriorities.length === 0,
  'crabcast-runtime.ts assigns no numeric priority literal anywhere',
  literalPriorities.join(', ') || '(none)'
);

// KAN-492 inserted `supervisor` between `priority` and `defaultAgent` here. The
// assertion still pins the WHOLE argument list rather than just `priority`,
// which is what makes it catch a positional slip — but it now has to be updated
// whenever the seam grows, and that is the intended cost rather than an
// annoyance: a pattern loose enough to survive an insertion would not have
// noticed `priority` moving either.
//
// KAN-507 appended `override` and paid exactly that cost: this assertion went
// red on a change that was correct, which is the pattern working. The argument
// was added at the END rather than inserted, so no existing position moved —
// and this line is what establishes that rather than asserting it.
check(
  /this\.provision\(session, promptContent, priority, supervisor, defaultAgent, mcpServers, override\)/.test(
    runtimeCode
  ),
  'spawnSession hands the priority it was given to provision()',
  '(searched the call in spawnSession)'
);
check(
  /const configure = buildConfigureAgentPayload\(\{/.test(runtimeCode),
  'provision() builds its payload through the named builder rather than inline',
  '(searched provision())'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§3  Every router call site passes a REGISTRY-sourced priority');
// ───────────────────────────────────────────────────────────────────────────
// The ticket's own constraint: use the existing lookup, do not introduce a
// second scale. A call site passing its own literal would type-check perfectly.

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
  const fifth = args.map((a) => a[4]);
  check(
    fifth.every((a) => a === 'config.priority' || a === 'priority'),
    `both pass a resolved priority as the 5th argument (${fifth.join(' | ')})`,
    spawnCalls.map((m) => m[1]).join('\n---\n')
  );
  check(
    fifth.every((a) => !/^\d+$/.test(a)),
    'neither passes a numeric literal',
    fifth.join(' | ')
  );
}
check(
  /const priority = this\.registry\.priorityFor\(type\);/.test(routerCode),
  'the second handler resolves its priority through registry.priorityFor',
  '(searched router.ts)'
);

// ───────────────────────────────────────────────────────────────────────────
rule('§4  THE HERDR PATH IS UNCHANGED — the parameter is inert there');
// ───────────────────────────────────────────────────────────────────────────
// Acceptance criterion 3. `HerdrBridge` accepts the parameter because the seam
// declares it, and must do NOTHING with it: under herdr the capacity gate and
// the preemption comparison both run in `router.ts`, above this seam, off the
// same lookup. A `HerdrBridge` that read this value would be a second opinion
// on a decision already taken.

const herdrCode = code(herdrSrc);
const herdrMentions = [...herdrCode.matchAll(/\bpriority\b/g)];
check(
  herdrMentions.length === 1,
  `herdr.ts names \`priority\` exactly once — the parameter declaration (${herdrMentions.length} found)`,
  herdrCode
    .split('\n')
    .filter((l) => /\bpriority\b/.test(l))
    .join('\n')
);
check(
  /promptContent: string, priority: number, supervisor: boolean, defaultAgent\?: string/.test(
    herdrCode
  ),
  'and that one occurrence is the signature',
  '(searched herdr.ts)'
);

if (staticOnly) {
  // KAN-373: `--static-only` is the caller ASSERTING that an incomplete run is
  // what it wants, so this exits 0 on a clean static pass — but the unrun
  // sections are now tallied and named rather than vanishing, and the headline
  // says "did not run" instead of "all static sections passed".
  skip('§5–§7', 'not run: --static-only was passed, so nothing here drove a real peer.');
  reportAndExit({ failures, skipped, allowSkipped: true });
}

// ───────────────────────────────────────────────────────────────────────────
rule('§5  THE REAL BUILDER, THE REAL REGISTRY — epic 3, story 2, task 1');
// ───────────────────────────────────────────────────────────────────────────
// Nothing here is this script's arithmetic. `priorityFor` is the production
// lookup carrying the production Atlassian integration's registrations, and
// `buildConfigureAgentPayload` is the function `provision()` calls.

const { WorkspaceRegistry } = await import(pathToFileURL(path.join(distDir, 'registry.js')));
const { createAtlassianIntegration } = await import(
  pathToFileURL(path.join(distDir, 'integrations', 'atlassian-integration.js'))
);
const { IntegrationStateStore } = await import(
  pathToFileURL(path.join(distDir, 'integrations', 'enablement.js'))
);
const { PRIORITY_EPIC, PRIORITY_STORY, PRIORITY_TASK } = await import(
  pathToFileURL(path.join(distDir, 'priority.js'))
);
const { buildConfigureAgentPayload } = await import(
  pathToFileURL(path.join(distDir, 'crabcast-runtime.js'))
);
const { CrabCastLink, defaultCrabCastSocket } = await import(
  pathToFileURL(path.join(distDir, 'crabcast-link.js'))
);

const registry = new WorkspaceRegistry(
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan482-state-')), 'integrations.json')
  )
);
registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
registry.setEnabled('jira', true);

const RANKS = [
  { type: 'epic', expect: PRIORITY_EPIC },
  { type: 'story', expect: PRIORITY_STORY },
  { type: 'task', expect: PRIORITY_TASK }
];

console.log('  type    priorityFor   payload.priority   specified');
const payloads = [];
for (const rank of RANKS) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `kan482-${rank.type}-`));
  const resolved = registry.priorityFor(rank.type);
  const payload = buildConfigureAgentPayload({
    session: { workDir },
    priority: resolved,
    promptContent: `KAN-482 priority round-trip probe (${rank.type}). Nothing is activated.`,
    defaultAgent: 'shell',
    // KAN-496 made `channelArgv` a required input. `[]` is the kill-switch-off
    // answer and keeps this payload byte-identical to the one this proof was
    // written against; the dev-channels argv has its own round-trip proof in
    // `verify-crabcast-channel-argv.mjs` and is not what this section measures.
    channelArgv: [],
    mcpServers: undefined
  });
  console.log(
    `  ${rank.type.padEnd(7)} ${String(resolved).padStart(6)}   ${String(payload.priority).padStart(12)}   ${String(rank.expect).padStart(9)}`
  );
  payloads.push({ ...rank, workDir, payload, resolved });
}
console.log('');
for (const p of payloads) {
  check(
    p.payload.priority === p.expect,
    `the payload for a ${p.type} agent carries priority ${p.expect}`,
    `carries ${p.payload.priority}`
  );
}
// The positive control for the three above: if the builder ignored its input
// and emitted a constant, every row would agree with every other row. The
// defect this proof exists for produced exactly that.
check(
  new Set(payloads.map((p) => p.payload.priority)).size === 3,
  'the three ranks are three DIFFERENT values — a constant would collapse them',
  payloads.map((p) => `${p.type}=${p.payload.priority}`).join(' ')
);

// ───────────────────────────────────────────────────────────────────────────
rule('§6  ON THE WIRE — CrabCast reports back the value Butchr sent');
// ───────────────────────────────────────────────────────────────────────────
// KAN-294's lesson, applied before it costs anything: a value we send that the
// far side discards answers `success: true` and looks exactly like a value it
// kept. The only way to know is to read it back off their own surface.

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
  console.log('');
  check(
    daemonStatus.success === true,
    'the live CrabCast daemon answers — this is a real peer, not a stub',
    JSON.stringify(daemonStatus).slice(0, 400)
  );

  console.log('\n  type    sent   configure echo   agent_status echo');
  for (const p of payloads) {
    const configured = await link.request(p.payload);
    p.configured = configured;
    const status = await link.request({ action: 'agent_status', path: p.workDir });
    p.status = status;
    console.log(
      `  ${p.type.padEnd(7)} ${String(p.payload.priority).padStart(4)}   ` +
        `${String(configured?.config?.priority).padStart(14)}   ${String(status?.config?.priority).padStart(17)}`
    );
  }
  console.log('');

  for (const p of payloads) {
    check(
      p.configured?.success === true,
      `configure_agent accepted the ${p.type} payload`,
      JSON.stringify(p.configured).slice(0, 400)
    );
    check(
      p.configured?.config?.priority === p.payload.priority,
      `configure_response echoes config.priority ${p.payload.priority} for ${p.type}`,
      `echoed ${JSON.stringify(p.configured?.config?.priority)}`
    );
    check(
      p.status?.success === true,
      `agent_status answers for the ${p.type} path`,
      JSON.stringify(p.status).slice(0, 400)
    );
    check(
      p.status?.config?.priority === p.payload.priority,
      `agent_status reports config.priority ${p.payload.priority} for ${p.type} — IT ROUND-TRIPPED`,
      `reported ${JSON.stringify(p.status?.config?.priority)}`
    );
  }

  // THE POSITIVE CONTROL, and §6 is worth nothing without it. Three assertions
  // that a surface echoed 3, 2 and 1 are satisfied identically by a surface
  // that echoes whatever it is handed and by one that is wired to a constant —
  // if and only if you never look at more than one row. Three DISTINCT values
  // arriving back is what separates them, and it is the reading that would have
  // gone red on the fleet as it stood on 2026-08-15.
  const echoed = payloads.map((p) => p.status?.config?.priority);
  check(
    new Set(echoed).size === 3,
    'the three round trips came back as three DISTINCT values — the surface discriminates',
    `echoed: ${JSON.stringify(echoed)}`
  );
}

// ───────────────────────────────────────────────────────────────────────────
rule('§7  CLEANUP — the records this proof made are taken back out');
// ───────────────────────────────────────────────────────────────────────────
// And the delete is PROVED rather than inferred, with its own positive control:
// a `success: false` from `agent_status` means nothing unless the same call
// answered `true` a moment ago on the same path. It did, in §6.

if (!link) {
  skip('the cleanup proof', 'nothing was configured, because §6 did not run.');
} else {
  for (const p of payloads) {
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
  link.close();
}

for (const p of payloads) fs.rmSync(p.workDir, { recursive: true, force: true });

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(78)}`);
// KAN-373: was `process.exit(failures ? 1 : 0)`, and "GREEN — every assertion
// passed, 1 section(s) skipped" was a green with a hole in it printed as a
// green. See `lib/verdict-exit.mjs` for why a skip now exits 2.
console.log('='.repeat(78));
reportAndExit({ failures, skipped });
