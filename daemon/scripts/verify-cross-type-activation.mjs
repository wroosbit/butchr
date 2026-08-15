// Live proof for KAN-83: activating type B with a workspace key a live type-A
// agent holds starts B as its own agent, and leaves A alone.
//
// WHAT FAILURE THIS WOULD CATCH: an activation resolving a live session by key
// alone. Keys are shared across types by design, so that is how activating
// epic/K while task/K is live reuses task/K's session — and how the failure
// path's cleanup destroys a healthy, unrelated agent's PTY.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// The ticket's symptom: `handleActivateByKey` resolved the session with
// `getSessionByKey(key)` — a key-only match, on keys that are shared across
// types by design. Activating epic/K while task/K was live reused task/K's
// session, failed runtime confirmation against epic/K's agent name, and the
// failure path's abandonSession killed task/K's PTY: a healthy, unrelated
// agent destroyed by someone else's activation.
//
// `getSessionByKey` no longer exists — KAN-473 removed it, because the same
// key-only first-match was still reachable from the bare-key MCP verbs it did
// not fix. The sentence above is kept as the history of THIS ticket's defect;
// `verify-ambiguous-key-refusal.mjs` covers the addressing surface, and this
// script continues to own the activation path.
//
// Four sections:
//
//   1. A up      — activate task/KAN-83: the live type-A agent the ticket
//                  starts from, with its PTY pid on record
//   2. collision — activate epic/KAN-83, the same key. Fixed: a fresh session,
//                  its own workspace path, A's session active and A's PTY
//                  process alive. Unfixed: A's session is reused, the
//                  confirmation against epic's agent name fails, and A's PTY
//                  is killed.
//   3. address   — both agents answer agent_status by (key, type), each with
//                  its own session, and the census lists both
//   4. stand-down — deactivate { key, type: 'epic' } ends only epic/KAN-83;
//                  task/KAN-83 is still active and still addressable
//
// Everything on the daemon side is real: the real MessageRouter, the real
// HerdrBridge (initPty and all), the real WorkspaceRegistry, PromptLoader and
// a real on-disk AgentRegistry. What is faked is the `herdr` binary itself: a
// shim on PATH that records every invocation and answers in herdr's own JSON
// shapes without spawning anything, so the census confirmActivation consults
// contains exactly the agents that were started.
//
// Isolation is by $HOME: workspaces derive from os.homedir(), so a temp HOME
// keeps this run out of ~/.local/share/butchr entirely, and no real herdr —
// live or private — is ever contacted.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-cross-type-activation.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const KEY = 'KAN-83';
const TYPE_A = 'task';
const TYPE_B = 'epic';

// A private HOME, before any dist import: workspace paths and the daemon's
// state dir all derive from os.homedir(), which reads $HOME at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan83-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --
//
// One fake `herdr`, first on PATH. `agent start` remembers the agent so
// `agent get` / `agent list` — and through them the KAN-23 existence check —
// see exactly the agents that were started and nothing else. `agent attach`
// holds its terminal open the way a real attach does; killing that process is
// what killing an agent's PTY looks like here.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN83_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN83_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const started = fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, pane_id: found.pane, cwd: found.cwd } } });
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
  out({ result: { tab: { tab_id: '7' }, root_pane: { workspace_id: 'w1', terminal_id: 't1' } } });
} else if (a === 'pane' && b === 'list') {
  out({ result: { panes: [] } });
} else {
  out({ result: {} });
}
`);
// A wrapper with this process's node baked in, so the shim never depends on
// what PATH resolves `node` to.
fs.writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash\nexec "${process.execPath}" "${shimImpl}" "$@"\n`);
fs.chmodSync(path.join(shimDir, 'herdr'), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// ------------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor } = await import(path.join(distDir, 'herdr.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);

// Integrations are disabled until turned on, and their state is persisted — so
// every registry here gets its own throwaway state file. A proof script must
// never write into the machine's real ~/.local/share/butchr/integrations.json,
// and must not depend on what is recorded there either.
const scratchState = () =>
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-state-')), 'integrations.json')
  );
/** The production registry: empty, then filled by the Atlassian integration. */
function atlassianRegistry(issueTypeLookup) {
  const registry = new WorkspaceRegistry(scratchState());
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup }));
  registry.setEnabled('jira', true);
  return registry;
}

const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));

const bridge = new HerdrBridge();
const ended = [];
bridge.setSessionEndedListener((e) => {
  ended.push(e);
  console.log(`   [event] session ended: sessionId=${e.sessionId} type=${e.type} reason=${e.reason}`);
});

let last;
const router = new MessageRouter(
  atlassianRegistry(async () => 'Task'),
  new PromptLoader(repoRoot),
  bridge,
  (msg) => { last = msg; },
  () => {},
  { agentRegistry: new AgentRegistry(path.join(scratch, 'agents.jsonl')) }
);

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptyAlive = (pid) => {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// The capacity gate reads the real machine, and whether this box is busy
// decides nothing about session resolution. The override path is real,
// recorded, and what [Start anyway] sends. (The epic activation needs no
// override: supervisors pass the gate unconditionally.)
async function activate(type, key) {
  let sent;
  await router.handleActivateByKey(
    { action: 'activate_by_key', type, key, defaultAgent: 'claude', override: true },
    (msg) => { sent = msg; }
  );
  return sent;
}

function agentStatus(type, key) {
  last = undefined;
  router.handle({ action: 'agent_status', key, type });
  return last;
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

console.log(`fake herdr: ${path.join(shimDir, 'herdr')} (records to ${shimState})`);
console.log(`HOME for this run: ${fakeHome}`);
console.log(`one key, two types: ${agentNameFor(TYPE_A, KEY)} and ${agentNameFor(TYPE_B, KEY)}`);

// ------------------------------------------------------- 1. the live agent --

rule(`1. ${TYPE_A}/${KEY} — the live type-A agent the ticket starts from`);

const aResponse = await activate(TYPE_A, KEY);
show('activate_by_key response:', {
  success: aResponse?.success, verified: aResponse?.verified,
  sessionId: aResponse?.sessionId, workDir: aResponse?.workDir
});

const a = bridge.getSession(aResponse?.sessionId);
const aPid = a?.ptyProcess?.pid;
console.log(`\n   A's PTY pid: ${aPid} (alive: ${ptyAlive(aPid)})`);

verdict(
  aResponse?.success === true && aResponse?.verified === true && a?.status === 'active' && ptyAlive(aPid),
  `${TYPE_A}/${KEY} is up: an active session with a live PTY`,
  'the type-A agent did not come up — nothing below can demonstrate anything'
);

// --------------------------------------------------------- 2. the collision --

rule(`2. ${TYPE_B}/${KEY} — same key, other type: the ticket's collision`);

const endedBefore = ended.length;
const bResponse = await activate(TYPE_B, KEY);
show('activate_by_key response:', {
  success: bResponse?.success, verified: bResponse?.verified,
  sessionId: bResponse?.sessionId, workDir: bResponse?.workDir,
  ...(bResponse?.error ? { error: bResponse.error } : {})
});

const b = bridge.getSession(bResponse?.sessionId);
console.log(`\n   reused A's session:      ${bResponse?.sessionId === aResponse?.sessionId}`);
console.log(`   A's session status now:  ${a?.status}`);
console.log(`   A's PTY (pid ${aPid}) alive: ${ptyAlive(aPid)}`);
console.log(`   session-ended events during B's activation: ${ended.length - endedBefore}`);

verdict(
  bResponse?.success === true &&
    bResponse?.verified === true &&
    bResponse?.sessionId !== aResponse?.sessionId &&
    typeof bResponse?.workDir === 'string' &&
    bResponse.workDir !== aResponse?.workDir &&
    bResponse.workDir.includes(`${path.sep}${TYPE_B}${path.sep}`),
  `${TYPE_B}/${KEY} got a fresh session in its own workspace (${bResponse?.workDir})`,
  "the type-B activation did not produce its own fresh session — this is the key-only collision"
);
verdict(
  a?.status === 'active' && ptyAlive(aPid) && ended.length === endedBefore,
  `A is untouched: session active, PTY pid ${aPid} still running, no session-ended events`,
  "A was harmed by B's activation — the abandonSession kill the ticket describes"
);

// ---------------------------------------------------- 3. both addressable --

rule('3. both agents addressable afterwards, each by its own (key, type)');

const aStatus = agentStatus(TYPE_A, KEY);
const bStatus = agentStatus(TYPE_B, KEY);
show(`agent_status ${TYPE_A}/${KEY}:`, {
  success: aStatus?.success, agentName: aStatus?.agentName,
  sessionId: aStatus?.sessionId, type: aStatus?.type, workDir: aStatus?.workDir
});
show(`agent_status ${TYPE_B}/${KEY}:`, {
  success: bStatus?.success, agentName: bStatus?.agentName,
  sessionId: bStatus?.sessionId, type: bStatus?.type, workDir: bStatus?.workDir
});

const census = bridge.listHerdrAgents().map((agent) => agent.name);
console.log(`\n   herdr census: ${census.join(', ')}`);

verdict(
  aStatus?.success === true && aStatus?.sessionId === aResponse?.sessionId &&
    bStatus?.success === true && bStatus?.sessionId === bResponse?.sessionId &&
    census.includes(agentNameFor(TYPE_A, KEY)) && census.includes(agentNameFor(TYPE_B, KEY)),
  'each address answers with its own session, and the census lists both agents',
  'the two agents are not independently addressable by (key, type)'
);

// -------------------------------------------------------- 4. exact stand-down --

rule(`4. deactivate { key: '${KEY}', type: '${TYPE_B}' } ends only ${TYPE_B}/${KEY}`);

let downResponse;
router.handleDeactivateByKey(
  { key: KEY, type: TYPE_B },
  (msg) => { downResponse = msg; }
);
await sleep(300); // let the PTY kill land before reading statuses
show('deactivate_response:', {
  success: downResponse?.success, type: downResponse?.type,
  key: downResponse?.key, sessionId: downResponse?.sessionId
});

console.log(`\n   B's session status now:  ${b?.status}`);
console.log(`   A's session status now:  ${a?.status}`);
console.log(`   A's PTY (pid ${aPid}) alive: ${ptyAlive(aPid)}`);

const aAfter = agentStatus(TYPE_A, KEY);

verdict(
  downResponse?.success === true &&
    downResponse?.sessionId === bResponse?.sessionId &&
    b?.status === 'terminated' &&
    a?.status === 'active' &&
    ptyAlive(aPid) &&
    aAfter?.success === true &&
    aAfter?.sessionId === aResponse?.sessionId,
  `the stand-down took ${TYPE_B}/${KEY} and only it — A is still active and still addressable`,
  'the typed stand-down reached the wrong agent, or took A with it'
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
