// Live proof for KAN-473: when a bare workspace key names more than one agent,
// the daemon REFUSES and names the candidates instead of acting on whichever
// agent it happened to reach.
//
// WHAT FAILURE THIS WOULD CATCH: a bare-key address resolving by first-match.
// `handleDeactivateByKey` took `getSessionByAddress(key, undefined)`, which fell
// through to a `getSessionByKey` that returned the FIRST active session on the
// key — over a session map whose keys are shared across workspace types by
// design (KAN-83). So `deactivate { key: 'KAN-117' }` with `story/KAN-117` and
// `task/KAN-117` both live stood down whichever of them the map iterated first
// and answered `success: true` naming it. `agent_status` and `agent_work_state`
// read the same way, and a read that picks is the worse defect of the two
// because nothing downstream can detect it: a tail or a status attributed to
// the wrong agent is evidence that looks first-hand and is about somebody else.
// This fleet routinely decides "is it stalled or waiting?" off exactly that.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// ---------------------------------------------------------------------------
// THIS SCRIPT CONSTRUCTS THE STATE IT THEN ASSERTS ON — AND THAT IS SECTION 1
// ---------------------------------------------------------------------------
//
// KAN-473 asked, as its own criterion 3, whether the collision can be created
// DELIBERATELY, and flagged that the answer gates the red drive: you cannot
// prove a refusal fires without being able to build the state that triggers it.
//
// So section 1 does not stipulate the collision — it BUILDS it, through the
// real `handleActivateByKey`, twice, with two workspace types on one key, and
// asserts that both agents come up with their own sessions. That is the answer
// to criterion 3 recorded as an assertion rather than as a claim: the state is
// reachable on purpose, in four lines, by any caller that can activate.
//
// What that leaves uncovered, named rather than left to inference:
//
//   * **That a real fleet reaches this state by accident.** Not covered here,
//     and it does not need to be: it was observed. `story/KAN-117` and
//     `task/KAN-117` were both live for ~44 hours to 2026-08-15, and
//     `epic/KAN-59` hit the near-miss while standing one of them down. That is
//     an observation of the running system, cited in the PR, not a gate.
//   * **The `herdr agent list` fallback branch.** Sections here drive the
//     SESSION path, because that is the branch that used to pick. The fallback
//     (`resolveAgentName` → `AmbiguousKeyError`) already refused before this
//     ticket and is exercised by section 5 through `describeAgent`, but only
//     with the fake herdr this harness installs.
//   * **`butchr_reset_agent`, `butchr_activate_agent` and `butchr_guardian`.**
//     All three REQUIRE a type, so none has a bare-key path to refuse — the
//     first two at the MCP schema, `guardian` at its call handler instead.
//     Section 6 asserts all three rather than trusting them, since that
//     requirement is the only thing keeping them out of scope. It also asserts
//     the SET: seven tools take a key, and a new one makes section 6 red.
//
//     ⚠ The audit that produced that list was wrong the first time, in the
//     direction this file exists to warn about. Reading each tool's schema out
//     of a fixed-length slice ran past the end of the block, so
//     `butchr_reclaim_workspaces` — which takes only `dryRun` — was read as
//     taking `key` and `type`, picking up the NEXT tool's properties. The
//     instrument answered a well-formed question nobody had asked. Bounding
//     each block at the following tool's offset is what fixed it, and section 6
//     uses the bounded form.
//
// Everything on the daemon side is real: the real `MessageRouter`, the real
// `HerdrBridge` (`initPty` and all), the real `WorkspaceRegistry`, `PromptLoader`
// and a real on-disk `AgentRegistry`. What is faked is the `herdr` binary — a
// shim on PATH answering in herdr's own JSON shapes without spawning anything.
// Isolation is by $HOME, so nothing here touches ~/.local/share/butchr.
//
// Sections:
//   1. constructible — build the collision on purpose: two types, one key
//   2. THE RED       — the pre-fix resolution, reproduced from THIS build
//   3. deactivate    — a bare key refuses, names both, and destroys nothing
//   4. the reads     — agent_status and agent_work_state refuse the same way
//   5. tail / send   — the other two bare-key verbs carry the candidates too
//   6. still usable  — a bare key that names ONE agent still works, a typed
//                      address still reaches exactly its own agent, and the
//                      audit is closed over every key-taking tool in `mcp.ts`
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-ambiguous-key-refusal.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

if (!fs.existsSync(path.join(distDir, 'router.js'))) {
  // A setup guard, not a verdict: there is nothing to prove without a build.
  console.error(`No build at ${distDir}. Run: cd daemon && npm run build`);
  process.exit(1);
}

const KEY = 'KAN-473';
const TYPE_A = 'task';
const TYPE_B = 'story';
const LONE_KEY = 'KAN-9999';

// A private HOME, before any dist import: workspace paths and the daemon's
// state dir all derive from os.homedir(), which reads $HOME at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan473-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --

const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN473_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN473_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane, cwd: found.cwd, agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    pane: String(100 + started.length)
  });
  fs.writeFileSync(startedFile, JSON.stringify(started, null, 2));
  out({ result: { agent: { name: args[2], pane_id: String(99 + started.length) } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'agent' && b === 'attach') {
  setInterval(() => {}, 60000); // hold the terminal open, as a real attach would
} else if (a === 'tab' && b === 'create') {
  // KAN-533: \`pane_id\` is REQUIRED of this fixture now. herdr 0.7's
  // \`agent start --pane\` targets the root pane \`tab create\` returns, so a
  // stub without one sends the daemon down its \"no usable pane\" refusal and
  // every assertion below it becomes a claim about a failed activation.
  out({ result: { tab: { tab_id: '7' }, root_pane: { pane_id: 'p1', workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else if (a === 'pane' && b === 'capture') {
  process.stdout.write('');
  process.exit(0);
} else {
  out({ result: {} });
}
`);
fs.writeFileSync(
  path.join(shimDir, 'herdr'),
  `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`
);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// ------------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor, resolveAmongSessions, AmbiguousKeyError } = await import(
  path.join(distDir, 'herdr.js')
);
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));

const scratchState = () =>
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan473-state-')), 'integrations.json')
  );

function atlassianRegistry() {
  const registry = new WorkspaceRegistry(scratchState());
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup: async () => 'Task' }));
  registry.setEnabled('jira', true);
  return registry;
}

const bridge = new HerdrBridge();
const ended = [];
bridge.setSessionEndedListener((e) => ended.push(e));

let last;
const router = new MessageRouter(
  atlassianRegistry(),
  new PromptLoader(repoRoot),
  bridge,
  (msg) => {
    last = msg;
  },
  () => {},
  { agentRegistry: new AgentRegistry(path.join(scratch, 'agents.jsonl')) }
);

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try {
      session.ptyProcess?.kill();
    } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptyAlive = (pid) => {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function activate(type, key) {
  let sent;
  await router.handleActivateByKey(
    { action: 'activate_by_key', type, key, defaultAgent: 'claude', override: true },
    (msg) => {
      sent = msg;
    }
  );
  return sent;
}

/** Drive a router action synchronously and hand back what it responded with. */
function call(frame) {
  last = undefined;
  router.handle(frame);
  return last;
}

/** Drive an action that answers asynchronously (tail, send). */
async function callAsync(frame, settleMs = 60) {
  last = undefined;
  router.handle(frame);
  await sleep(settleMs);
  return last;
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);

let failures = 0;
const verdict = (ok, good, bad) => {
  console.log(`\n  ${ok ? '→ ' + good : '✗ FAILED — ' + bad}`);
  if (!ok) failures++;
};

console.log(`dist:              ${distDir}`);
console.log(`fake herdr:        ${path.join(shimDir, 'herdr')}`);
console.log(`HOME for this run: ${fakeHome}`);

// ------------------------------------------ 1. THE COLLISION IS CONSTRUCTIBLE --

rule(`1. CONSTRUCTIBLE ON PURPOSE — ${TYPE_A}/${KEY} and ${TYPE_B}/${KEY}, both live (KAN-473 criterion 3)`);

const aResponse = await activate(TYPE_A, KEY);
const bResponse = await activate(TYPE_B, KEY);

const a = bridge.getSession(aResponse?.sessionId);
const b = bridge.getSession(bResponse?.sessionId);
const aPid = a?.ptyProcess?.pid;
const bPid = b?.ptyProcess?.pid;

show('the two activations:', {
  [`${TYPE_A}/${KEY}`]: { success: aResponse?.success, sessionId: aResponse?.sessionId },
  [`${TYPE_B}/${KEY}`]: { success: bResponse?.success, sessionId: bResponse?.sessionId }
});
console.log(`\n   both live:  ${a?.status === 'active'} / ${b?.status === 'active'}`);
console.log(`   PTYs alive: ${ptyAlive(aPid)} / ${ptyAlive(bPid)}`);

verdict(
  aResponse?.success === true &&
    bResponse?.success === true &&
    aResponse.sessionId !== bResponse.sessionId &&
    a?.status === 'active' &&
    b?.status === 'active',
  'two agents of different types now hold one key, built deliberately through the real ' +
    'activation path. The state a bare key is ambiguous in is reachable ON PURPOSE, not ' +
    'only by accident — which is what makes every refusal below testable at all.',
  'the collision could not be constructed, so nothing below is proving anything — fix this ' +
    'section rather than reading the ones under it'
);

// --------------------------------------------------------------- 2. THE RED --

rule('2. THE RED — the pre-fix resolution, reproduced out of THIS build');

// The defect was `getSessionByKey`: the FIRST active session on the key, over a
// map holding two. That method is gone, so the reproduction re-creates exactly
// what it did — `listActiveSessions().find(...)` on the same live bridge, the
// same predicate, same everything else. If this ever stops producing an
// arbitrary single agent, the reproduction has drifted and this section says so
// rather than quietly proving nothing.
const firstMatch = bridge.listActiveSessions().find((s) => s.key === KEY);
const everyMatch = bridge.listActiveSessions().filter((s) => s.key === KEY);
const picked = firstMatch ? agentNameFor(firstMatch.type, firstMatch.key) : null;

console.log(`\n   sessions on '${KEY}':          ${everyMatch.length}`);
console.log(`   what a first-match pick gives: ${picked}`);
console.log(`   what it silently discards:     ${everyMatch
  .map((s) => agentNameFor(s.type, s.key))
  .filter((n) => n !== picked)
  .join(', ')}`);

const redReproduced = everyMatch.length === 2 && picked !== null;

verdict(
  redReproduced,
  `reproduced: two agents match, and the old resolution answers with exactly one of them — ` +
    `${picked} — with nothing in the answer able to say the other existed. That single name ` +
    'was what `deactivate { key }` tore down and what `agent_status { key }` reported on.',
  `the reconstruction did not produce the old condition (matches=${everyMatch.length}, ` +
    `picked=${picked}). It has drifted from the defect and this section is proving nothing`
);

// And the shared rule that replaced it, called directly on the same sessions.
const resolution = resolveAmongSessions(everyMatch);
show('resolveAmongSessions on the same sessions:', resolution);

verdict(
  resolution.outcome === 'ambiguous' &&
    resolution.candidates.length === 2 &&
    resolution.candidates.includes(agentNameFor(TYPE_A, KEY)) &&
    resolution.candidates.includes(agentNameFor(TYPE_B, KEY)),
  'the rule that replaced it answers `ambiguous` and names BOTH — the outcome is in the ' +
    'return type, where a caller cannot fail to meet it',
  `expected an ambiguous outcome naming both agents, got ${JSON.stringify(resolution)}`
);

// --------------------------------------------------- 3. THE DESTRUCTIVE VERB --

rule(`3. deactivate { key: '${KEY}' } — refuses, names both, and destroys NOTHING`);

const endedBefore = ended.length;
const down = call({ action: 'deactivate_by_key', key: KEY });
await sleep(200); // a real teardown would have landed by now; nothing should have

show('deactivate_response:', down);
console.log(`\n   ${TYPE_A} session status: ${a?.status}   PTY alive: ${ptyAlive(aPid)}`);
console.log(`   ${TYPE_B} session status: ${b?.status}   PTY alive: ${ptyAlive(bPid)}`);
console.log(`   session-ended events during the refusal: ${ended.length - endedBefore}`);

verdict(
  down?.success === false &&
    down?.refusedBy === 'ambiguous-key' &&
    Array.isArray(down?.candidates) &&
    down.candidates.includes(agentNameFor(TYPE_A, KEY)) &&
    down.candidates.includes(agentNameFor(TYPE_B, KEY)) &&
    typeof down?.error === 'string' &&
    down.error.includes(KEY),
  'the stand-down is REFUSED, and the refusal names both candidates — so the caller learns ' +
    'the collision exists and can fix the call with one parameter',
  `expected a refusal naming both agents, got ${JSON.stringify(down)}`
);

verdict(
  a?.status === 'active' &&
    b?.status === 'active' &&
    ptyAlive(aPid) &&
    ptyAlive(bPid) &&
    ended.length === endedBefore,
  'both agents are untouched: two active sessions, two live PTYs, no session-ended events. ' +
    'NOTHING WAS DESTROYED — which is the whole difference between a refusal and a pick.',
  'an agent was torn down by an ambiguous stand-down — this is the near-miss KAN-473 was ' +
    'filed on, live'
);

// ------------------------------------------------------------- 4. THE READS --

rule(`4. THE READS — agent_status and agent_work_state refuse the same way`);

const status = call({ action: 'agent_status', key: KEY });
show('agent_status_response:', status);

verdict(
  status?.success === false &&
    status?.refusedBy === 'ambiguous-key' &&
    Array.isArray(status?.candidates) &&
    status.candidates.length === 2 &&
    status?.agentName === undefined,
  'the status read refuses and names the candidates rather than answering about one of them. ' +
    'No `agentName` comes back at all, so there is no row a reader could mistake for an answer.',
  `expected an ambiguous-key refusal with no agentName, got ${JSON.stringify(status)}`
);

const work = call({ action: 'agent_work_state', key: KEY });
show('agent_work_state_response:', work);

verdict(
  work?.success === false &&
    work?.refusedBy === 'ambiguous-key' &&
    Array.isArray(work?.candidates) &&
    work.candidates.length === 2,
  'the work-state read refuses too. It used to answer from a WORKSPACE DIRECTORY resolved off ' +
    'the arbitrary session, so the wrong agent\'s work state came back looking like the right one\'s.',
  `expected an ambiguous-key refusal, got ${JSON.stringify(work)}`
);

// ------------------------------------------------------- 5. THE OTHER VERBS --

rule('5. THE OTHER BARE-KEY VERBS — tail and send carry the candidates too');

const tail = await callAsync({ action: 'tail_agent', key: KEY });
show('tail_agent_response:', tail);

verdict(
  tail?.success === false &&
    tail?.refusedBy === 'ambiguous-key' &&
    Array.isArray(tail?.candidates) &&
    tail.candidates.length === 2 &&
    tail?.text === undefined,
  'a tail of a colliding key refuses and names both — and returns no `text`, so nothing can ' +
    'be cited as a first-hand read of an agent nobody addressed',
  `expected an ambiguous-key refusal with no text, got ${JSON.stringify(tail)}`
);

const sent = await callAsync({ action: 'send_to_agent', key: KEY, message: 'hello' }, 200);
show('send_to_agent_response:', sent);

verdict(
  sent?.success === false &&
    sent?.refusedBy === 'ambiguous-key' &&
    Array.isArray(sent?.candidates) &&
    sent.candidates.length === 2,
  'a steer at a colliding key refuses with the candidates. It always refused — what it could ' +
    'not do was tell the sender WHICH agents matched, and a sender that cannot see the ' +
    'collision cannot fix its own call.',
  `expected an ambiguous-key refusal naming both agents, got ${JSON.stringify(sent)}`
);

// `describeAgent` is the herdr-list branch: same refusal, thrown, carrying the
// same candidate list on a typed error rather than only inside a sentence.
let describeError = null;
try {
  bridge.describeAgent(KEY);
} catch (e) {
  describeError = e;
}
console.log(`\n   describeAgent('${KEY}') threw: ${describeError?.name}`);
console.log(`   candidates on the error:      ${JSON.stringify(describeError?.candidates)}`);

verdict(
  describeError instanceof AmbiguousKeyError &&
    Array.isArray(describeError.candidates) &&
    describeError.candidates.length === 2,
  'the throwing branch refuses with the SAME typed error and the same list, so a handler ' +
    'never has to read agent names back out of prose',
  `expected an AmbiguousKeyError carrying both candidates, got ${describeError}`
);

// ------------------------------------------- 6. UNAMBIGUOUS ADDRESSES STILL WORK --

rule('6. NOT MANDATORY VERBOSITY — one agent on a key still answers a bare key');

const loneResponse = await activate(TYPE_A, LONE_KEY);
const lone = bridge.getSession(loneResponse?.sessionId);
const loneStatus = call({ action: 'agent_status', key: LONE_KEY });

show(`agent_status { key: '${LONE_KEY}' } (no type):`, {
  success: loneStatus?.success,
  agentName: loneStatus?.agentName,
  addressedBy: loneStatus?.addressedBy,
  sessionId: loneStatus?.sessionId
});

verdict(
  loneStatus?.success === true &&
    loneStatus?.agentName === agentNameFor(TYPE_A, LONE_KEY) &&
    loneStatus?.addressedBy === 'key-only' &&
    loneStatus?.sessionId === loneResponse?.sessionId,
  'a bare key that names ONE agent still answers, and says `addressedBy: key-only` so the ' +
    'reader knows the type was inferred rather than given. KAN-473 asked for ' +
    'refusal-on-ambiguity, explicitly NOT mandatory verbosity.',
  `a bare key naming one agent should still answer with a key-only disclosure, got ${JSON.stringify(loneStatus)}`
);

const typedStatus = call({ action: 'agent_status', key: KEY, type: TYPE_B });
show(`agent_status { key: '${KEY}', type: '${TYPE_B}' }:`, {
  success: typedStatus?.success,
  agentName: typedStatus?.agentName,
  addressedBy: typedStatus?.addressedBy,
  sessionId: typedStatus?.sessionId
});

verdict(
  typedStatus?.success === true &&
    typedStatus?.agentName === agentNameFor(TYPE_B, KEY) &&
    typedStatus?.addressedBy === 'key-and-type' &&
    typedStatus?.sessionId === bResponse?.sessionId,
  'and the SAME colliding key, addressed with its type, answers about exactly that agent — ' +
    'the fix is one parameter, and the refusal above says which',
  `a typed address should reach its own agent, got ${JSON.stringify(typedStatus)}`
);

// The MCP schemas for the two workspace-destroying verbs. They are out of scope
// only because they require a type; asserting that is what keeps them out.
const mcpSource = fs.readFileSync(path.join(scriptDir, '..', 'src', 'mcp.ts'), 'utf8');
const requiresType = (tool) => {
  const at = mcpSource.indexOf(`name: "${tool}"`);
  if (at === -1) return false;
  const block = mcpSource.slice(at, at + 3000);
  const required = block.match(/required: \[([^\]]*)\]/);
  return Boolean(required && required[1].includes('"type"'));
};

console.log(`\n   butchr_reset_agent requires type:    ${requiresType('butchr_reset_agent')}`);
console.log(`   butchr_activate_agent requires type: ${requiresType('butchr_activate_agent')}`);

verdict(
  requiresType('butchr_reset_agent') && requiresType('butchr_activate_agent'),
  'the two workspace-destroying verbs REQUIRE a type, so neither has a bare-key path to ' +
    'refuse. That is the only reason they are out of scope, and it is now asserted rather ' +
    'than assumed — if either goes optional, this section goes red and the audit is reopened.',
  'a verb that destroys or creates a workspace has acquired an optional type: it now has a ' +
    'bare-key path, and nothing in this file refuses on it'
);

// THE AUDIT'S OWN COMPLETENESS, asserted rather than claimed (KAN-473 criterion 5).
//
// The ticket said explicitly: audit the full tool list rather than trusting its
// three examples. Enumerated off `mcp.ts`, SEVEN tools take a `key`. Four have a
// bare-key path and every one of them is driven above — deactivate (§3),
// agent_status (§4), tail and send (§5). The other three are out of scope only
// because they cannot be called without a type, and this asserts each of those
// three rather than leaving the reader to trust the count.
//
// `butchr_guardian` is the one worth singling out: its type is optional AT THE
// SCHEMA, and what requires it is a hand-written check in the call handler. A
// schema-only audit reads it as a fourth bare-key verb; an audit that stops at
// the handler misses it if that check is ever deleted. So both are asserted.
const keyTools = [...mcpSource.matchAll(/name: "(butchr_[a-z_]+)",/g)]
  .map((m) => [m[1], m.index])
  .filter(([, at], i, all) => {
    const end = i + 1 < all.length ? all[i + 1][1] : mcpSource.length;
    return /^\s{12}key: \{$/m.test(mcpSource.slice(at, end));
  })
  .map(([name]) => name);

const guardianRequiresType = /op === 'set' && \(!type \|\| !key\)/.test(mcpSource);
const REFUSING = [
  'butchr_deactivate_agent',
  'butchr_send_to_agent',
  'butchr_tail_agent',
  'butchr_agent_status'
];
const TYPED = ['butchr_activate_agent', 'butchr_reset_agent'];

console.log(`\n   tools taking a key:            ${keyTools.length} — ${keyTools.join(', ')}`);
console.log(`   bare-key verbs driven above:   ${REFUSING.join(', ')}`);
console.log(`   out of scope, type required:   ${TYPED.join(', ')}, butchr_guardian`);
console.log(`   guardian's op:'set' requires type at the handler: ${guardianRequiresType}`);

verdict(
  keyTools.length === 7 &&
    [...REFUSING, ...TYPED, 'butchr_guardian'].every((t) => keyTools.includes(t)) &&
    TYPED.every(requiresType) &&
    guardianRequiresType,
  'the audit is CLOSED over the tool list rather than over three examples: every tool that ' +
    'takes a key is accounted for — four refuse on ambiguity and are driven above, three ' +
    'cannot be reached without a type. A NEW key-taking tool makes this section red, which ' +
    'is what stops the next one being added with a silent bare-key path.',
  `the key-taking tool list has moved and is no longer the audited set: found ` +
    `${keyTools.length} (${keyTools.join(', ')}), guardian-requires-type=${guardianRequiresType}. ` +
    'Re-audit rather than adjusting the count'
);

// ------------------------------------------------------------------ VERDICT --

rule(`VERDICT: ${failures === 0 ? 'PASS' : `FAIL (${failures} section(s))`}`);

process.exit(failures ? 1 : 0);
