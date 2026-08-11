// Live proof for KAN-196: a recorded stand-down survives a reboot, and an
// activation nobody asked for cannot revoke it.
//
// WHAT FAILURE THIS WOULD CATCH: an unintended activation overwriting an
// agent's `deactivated` record, after which boot-time reconciliation restores
// that agent on every reboot — unattended, and correctly, because the registry
// now says it should be running.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// WHAT THE TICKET ASKED, AND WHAT IS ACTUALLY TRUE
//
// KAN-196 was filed as "the post-reboot restore re-activates deliberately
// stood-down agents". It does not. The restore path is `reconcileAgents` in
// daemon/src/reconcile.ts, its input is `AgentRegistry.expected()`, and that
// filters the log's last-event-per-agent to `activated`:
//
//     public expected(): AgentRecord[] {
//       return Array.from(this.intents().values())
//         .filter((intent) => intent.event === 'activated')
//         .map((intent) => intent.record);
//     }
//
// Section 1 exercises exactly that. On the machine this was filed from, 274 of
// the 280 agents ever recorded have `deactivated` as their last event, and
// both reboots logged `[reconcile] Registry expects 5 agent(s) to be running` —
// so 274 of 274 stand-downs were honoured.
//
// `butchr-task-kan-39` came back because its stand-down (2026-08-03T13:32:52Z)
// had been *overwritten* by an `activated` record at 2026-08-05T00:57:26.750Z,
// seven seconds after the journal recorded
//
//     jira: issue-type lookup for KAN-39 failed (… timed out); falling back to
//     the default workspace type
//
// The URL of an Epic resolved to the fallback type `task`, the sidepanel's
// automatic re-attach sent a plain `activate` for it, and the daemon started
// and recorded `task/KAN-39` — beside the live `epic/KAN-39`, which is the
// (key, type) collision invariant 5 exists to prevent. Sections 4 and 5 are
// that sequence, and they are the sections that go red against `origin/main`.
//
// WHAT THIS SCRIPT WRITES ITSELF, AND WHAT THAT LEAVES UNCOVERED
//
// This script constructs its own registry state and calls the router directly,
// so it does not test that any of these messages arrive over the native port.
// That is the KAN-145 hole and it is named here rather than left to be
// inferred. Precisely:
//
//   - It does NOT prove Chrome delivers `reattachOnly`. Section 4b(i) reads the
//     two extension files and the daemon's field name and checks they agree,
//     which catches the way this actually breaks — a rename on one side — but
//     is static. Nothing in CI drives the real re-attach effect;
//     `extension/scripts/verify-sidepanel-survives-daemon-restart.mjs` drives
//     the real bundle but recovers via `status`, so it never reaches that
//     effect. It is the sibling that would be the right home for it, and it
//     does not cover it today.
//   - It does NOT prove that an unintended activation ever arrives at all. What
//     covers that is the production evidence pasted into the PR:
//     `~/.local/share/butchr/agents.jsonl` lines 63/311/430, the daemon log at
//     2026-08-05T00:57:25Z, and the journal line above. That is a record of the
//     real arrival this script only simulates.
//
// What this script does own is everything downstream of the arrival: the
// resolution, the refusal, the registry write that does not happen, and the
// restore that leaves the agent down.
//
// Sections:
//
//   1. restore reads intent  — reconcile brings back the `activated` agent and
//                              leaves the `deactivated` one alone
//   2. the stand-down        — through the real deactivate_by_key. Its second
//                              half reaches the `alreadyGone` branch and holds
//                              its note to what the record delivers. RED on
//                              origin/main, whose note says "it will not be
//                              restored" full stop
//   3. baseline restore      — the stood-down agent stays down. This section
//                              passes against origin/main too, and is here to
//                              show the restore path was never the defect
//   4. the revocation        — a degraded URL activation for KAN-39 while
//                              epic/KAN-39 is live. RED on origin/main
//   5. the consequence       — reconcile after 4. RED on origin/main
//
// Section 4d is the control: an ordinary stood-down agent with no live sibling
// is still startable from its own page. Without it, a guard that refused every
// activation would pass 4b and 4c.
//
// Everything daemon-side is real: the real MessageRouter, HerdrBridge,
// WorkspaceRegistry, PromptLoader, AgentRegistry and reconcileAgents. What is
// faked is the `herdr` binary — a shim on PATH answering in herdr's own JSON
// shapes — and the Jira issue-type lookup, which answers null, which is what a
// timed-out lookup answers.
//
// Isolation is by $HOME: workspaces derive from os.homedir(), so a temp HOME
// keeps this out of ~/.local/share/butchr and no real herdr is contacted.
//
// Usage:
//   cd daemon && npm run build
//   node scripts/verify-standdown-survives-degraded-activation.mjs [distDir]
//
// To watch it go red, build origin/main into a throwaway dist and pass it:
//   git worktree add /tmp/kan196-main origin/main
//   cd /tmp/kan196-main/daemon && npm install && npm run build
//   node <this script> /tmp/kan196-main/daemon/dist

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const SITE = 'https://wroosbit.atlassian.net';
/** The collision key from the ticket: an Epic whose artifact task agent exists. */
const KEY = 'KAN-39';
/** A stood-down agent with no live sibling — section 4d's control. */
const LONE_KEY = 'KAN-999';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kan196-'));
const fakeHome = path.join(scratch, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;

// ---------------------------------------------------------------- the shim --
//
// `agent start` remembers the agent; `agent get` and `agent list` report the
// ones that were started, both carrying herdr's inner `agent` field so they
// read as live runtimes rather than as bare name registrations; `pane close`
// forgets one, which is what a stand-down does to the census.
const shimState = path.join(scratch, 'shim-state');
const shimDir = path.join(scratch, 'bin');
fs.mkdirSync(shimState, { recursive: true });
fs.mkdirSync(shimDir, { recursive: true });
process.env.KAN196_SHIM_STATE = shimState;

const shimImpl = path.join(shimDir, 'herdr-shim.mjs');
fs.writeFileSync(shimImpl, `
import fs from 'fs';
import path from 'path';

const state = process.env.KAN196_SHIM_STATE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'invocations.jsonl'), JSON.stringify(args) + '\\n');

const startedFile = path.join(state, 'started.json');
const read = () => fs.existsSync(startedFile) ? JSON.parse(fs.readFileSync(startedFile, 'utf8')) : [];
const write = (v) => fs.writeFileSync(startedFile, JSON.stringify(v, null, 2));
const started = read();
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const [a, b] = args;

if (a === 'agent' && b === 'get') {
  const found = started.find((s) => s.name === args[2]);
  if (found) out({ result: { agent: { name: found.name, agent: 'claude', pane_id: found.pane, cwd: found.cwd, agent_status: 'working' } } });
  process.stderr.write(JSON.stringify({ error: { code: 'agent_not_found', message: \`no agent '\${args[2]}'\` } }));
  process.exit(1);
}
if (a === 'agent' && b === 'start') {
  const cwdIdx = args.indexOf('--cwd');
  started.push({
    name: args[2],
    cwd: cwdIdx === -1 ? '' : args[cwdIdx + 1],
    pane: String(100 + started.length)
  });
  write(started);
  out({ result: { agent: { name: args[2], pane_id: String(99 + started.length) } } });
}
if (a === 'agent' && b === 'list') {
  out({ result: { agents: started.map((s) => ({ name: s.name, agent: 'claude', cwd: s.cwd, agent_status: 'working' })) } });
}
if (a === 'pane' && b === 'close') {
  write(started.filter((s) => s.pane !== args[2]));
  out({ result: {} });
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
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { reconcileAgents } = await import(path.join(distDir, 'reconcile.js'));

/**
 * The lookup, answering exactly as a timed-out one does.
 *
 * `JiraIssueTypeService.getIssueTypeName` resolves to null on every failure —
 * timeout, 401, unreachable host — and Jira's refine hook maps null through
 * `workspaceTypeForJiraIssueType`, which returns the fallback `task`. This is
 * that path, not an imitation of it: the null is the same null.
 */
const lookupTimedOut = async () => null;
/** The same lookup on a day Jira answers, for the contrast in section 4a. */
const lookupAnswers = async () => 'Epic';

function atlassianRegistry(issueTypeLookup) {
  const registry = new WorkspaceRegistry(
    new IntegrationStateStore(path.join(scratch, `integrations-${Math.random()}.json`))
  );
  registry.registerIntegration(createAtlassianIntegration({ issueTypeLookup }));
  registry.setEnabled('jira', true);
  return registry;
}

const registryFile = path.join(scratch, 'agents.jsonl');
const agentRegistry = new AgentRegistry(registryFile);
const bridge = new HerdrBridge();

let last;
const router = new MessageRouter(
  atlassianRegistry(lookupTimedOut),
  new PromptLoader(repoRoot),
  bridge,
  (msg) => { last = msg; },
  () => {},
  { agentRegistry }
);

function cleanup() {
  for (const session of bridge.listActiveSessions()) {
    try { session.ptyProcess?.kill(); } catch {}
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

/** `override: true` everywhere a start is *meant* to happen, so that a busy
 *  machine's capacity refusal can never be mistaken for one of these guards.
 *  Every refusal below is checked by `refusedBy`, not merely by `success`. */
const activateByKey = async (type, key) => {
  let sent;
  await router.handleActivateByKey(
    { action: 'activate_by_key', type, key, defaultAgent: 'claude', override: true },
    (msg) => { sent = msg; }
  );
  return sent;
};

const activateByUrl = async (url, extra = {}) => {
  let sent;
  await router.handleActivate(
    { action: 'activate', url, defaultAgent: 'claude', override: true, ...extra },
    (msg) => { sent = msg; }
  );
  return sent;
};

const standDown = (type, key) => {
  let sent;
  router.handleDeactivateByKey({ key, type }, (msg) => { sent = msg; });
  return sent;
};

const intentOf = (type, key) => agentRegistry.intents().get(agentNameFor(type, key))?.event ?? null;
const census = () =>
  bridge.listHerdrAgents().filter((a) => a.agentRuntime !== null).map((a) => a.name).sort();
const expectedNames = () => agentRegistry.expected().map((r) => r.agentName).sort();

const runReconcile = async () => {
  const lines = [];
  const result = await reconcileAgents({
    registry: agentRegistry,
    herdrBridge: bridge,
    router,
    cause: 'reboot',
    log: (...args) => { const line = args.join(' '); lines.push(line); console.log(`     ${line}`); }
  });
  return { result, lines };
};

console.log(`fake herdr: ${path.join(shimDir, 'herdr')}`);
console.log(`HOME for this run: ${fakeHome}`);
console.log(`registry: ${registryFile}`);
console.log(`dist under test: ${distDir}`);

// ------------------------------------------- 1. restore reads intent, not history --

rule('1. the restore path reads intent: `activated` comes back, `deactivated` does not');

console.log(`\n   starting epic/${KEY} (the supervisor the ticket wants restored)`);
const epicUp = await activateByKey('epic', KEY);
console.log(`   starting task/${KEY} (the cutover artifact, before it is stood down)`);
const artifactUp = await activateByKey('task', KEY);

show('both up:', {
  [`epic/${KEY}`]: { success: epicUp?.success, verified: epicUp?.verified },
  [`task/${KEY}`]: { success: artifactUp?.success, verified: artifactUp?.verified }
});

verdict(
  epicUp?.success === true && artifactUp?.success === true &&
    intentOf('epic', KEY) === 'activated' && intentOf('task', KEY) === 'activated',
  'both agents are up and both are recorded `activated` — the state the cutover started from',
  'the two agents could not be started; nothing below can demonstrate anything'
);

// ------------------------------------------------------------- 2. the stand-down --

rule(`2. standing task/${KEY} down through the real deactivate_by_key`);

const downResponse = standDown('task', KEY);
show('deactivate_response:', downResponse);

const logLines = fs.readFileSync(registryFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const standDownRecord = [...logLines].reverse().find((e) => e.agentName === agentNameFor('task', KEY));
show('the registry line it wrote:', standDownRecord);

verdict(
  downResponse?.success === true &&
    standDownRecord?.event === 'deactivated' &&
    intentOf('task', KEY) === 'deactivated',
  'the stand-down is recorded as `deactivated`',
  'the stand-down did not record, and nothing below is about the case the ticket describes'
);

// The sentence the ticket quotes is on the *other* branch: `alreadyGone`, taken
// when there is no session and herdr has no such agent. Standing the same agent
// down a second time is how that branch is reached, and it is not a contrivance
// — "stop expecting an agent that is already gone" is exactly when a human
// reaches for it, which is why the response has a sentence of its own at all.
console.log('\n   the same stand-down again, now that the agent really is gone:');
const goneResponse = standDown('task', KEY);
show('deactivate_response:', goneResponse);

const note = typeof goneResponse?.note === 'string' ? goneResponse.note : '';
verdict(
  goneResponse?.alreadyGone === true &&
    // The claim as written until now. It is false: the registry is intent, the
    // last word wins, and any later `activated` overwrites this record —
    // which is what happened to butchr-task-kan-39 for two days.
    !note.includes('so it will not be restored') &&
    // What the record does buy, named as the restore pass rather than as
    // permanence.
    /restor/i.test(note) &&
    // And what can still undo it, so a reader is not left to discover it.
    /explicit activation/i.test(note),
  `the note claims only what the record delivers: "${note}"`,
  `the note promises a durability the registry does not provide: "${note}"`
);

// ---------------------------------------------------------- 3. baseline restore --

rule('3. baseline: reconcile leaves the stood-down agent down (this passes on origin/main too)');

console.log(`\n   expected(): ${JSON.stringify(expectedNames())}`);
console.log(`   census before: ${JSON.stringify(census())}`);
console.log('\n   reconcileAgents:');
const baseline = await runReconcile();
console.log(`\n   census after: ${JSON.stringify(census())}`);

verdict(
  !expectedNames().includes(agentNameFor('task', KEY)) &&
    baseline.result.outcomes.every((o) => o.agentName !== agentNameFor('task', KEY)) &&
    !census().includes(agentNameFor('task', KEY)),
  `expected() omits ${agentNameFor('task', KEY)}, reconcile never touches it, and it is not in the census`,
  'reconcile restored an agent whose last event is `deactivated` — the restore path really is the defect'
);

// --------------------------------------------------------------- 4. the revocation --

rule('4. the degraded URL activation — what actually revoked the stand-down');

const issueUrl = `${SITE}/browse/${KEY}`;

// 4a. the resolution itself, both ways round.
console.log('\n   4a. what the URL resolves to, with and without an answer from Jira');
const whenJiraAnswers = await atlassianRegistry(lookupAnswers).resolve(issueUrl);
const whenJiraTimesOut = await atlassianRegistry(lookupTimedOut).resolve(issueUrl);
show(`${issueUrl} resolves to:`, {
  'Jira answers "Epic"': whenJiraAnswers?.config?.type,
  'the lookup times out': whenJiraTimesOut?.config?.type,
  'live agents at this key right now': census().filter((n) => n.endsWith(KEY.toLowerCase()))
});
verdict(
  whenJiraAnswers?.config?.type === 'epic' && whenJiraTimesOut?.config?.type === 'task',
  'the same URL is `epic` when Jira answers and `task` when it does not — the type is a guess',
  'the degraded resolution could not be reproduced; sections 4b–4d below prove nothing'
);

// 4b. the panel's automatic re-attach, which is what sent the real one.
//
// The wire first, because everything after it is this script talking to itself.
// A daemon that honours `reattachOnly` and an extension that never sends it
// would leave both halves passing their own tests and the defect untouched, so
// the three files that have to agree on the spelling are read here. Static, and
// said to be: it establishes that the field is on the re-attach path and only
// there, not that Chrome delivered it.
console.log('\n   4b(i). the wire: the three places that must agree on `reattachOnly`');
console.log('        (reads the repo\'s extension sources, not the dist under test —');
console.log('         so this section reads the same in the red run as in the green one)');
const hookSource = fs.readFileSync(
  path.join(repoRoot, 'extension', 'src', 'hooks', 'useWorkspaceSession.js'), 'utf8'
);
const workerSource = fs.readFileSync(
  path.join(repoRoot, 'extension', 'public', 'background', 'service_worker.js'), 'utf8'
);
// The re-attach effect is the one that must carry it; the deliberate starts —
// the On switch, Reconnect, [Start anyway], [Stand down … and start] — must not,
// or the guard would refuse a person.
const reattachSend = /reattachSentRef\.current = true;\s*chrome\.runtime\.sendMessage\(\{[^}]*reattachOnly:\s*true/s.test(hookSource);
const deliberateSends = [...hookSource.matchAll(/chrome\.runtime\.sendMessage\(\{[^}]*type:\s*'ACTIVATE_BUTCHR'[^}]*\}/gs)]
  .map((m) => m[0])
  .filter((s) => s.includes('reattachOnly'));
const workerForwards = /message\.reattachOnly \? \{ reattachOnly: true \}/.test(workerSource);
show('the wire:', {
  'useWorkspaceSession.js: re-attach effect sends it': reattachSend,
  'useWorkspaceSession.js: ACTIVATE_BUTCHR sends carrying it': deliberateSends.length,
  'service_worker.js forwards it to the daemon': workerForwards
});
verdict(
  reattachSend && workerForwards && deliberateSends.length === 1,
  'the re-attach path sends `reattachOnly`, the service worker forwards it, and no deliberate start carries it',
  'the extension and the daemon disagree about this field, so the daemon-side guard below guards nothing in production'
);

console.log('\n   4b(ii). the panel re-attaching — `reattachOnly`, because that is all it means to do');
const reattach = await activateByUrl(issueUrl, { reattachOnly: true });
show('activate_response:', {
  success: reattach?.success, type: reattach?.type, key: reattach?.key,
  refusedBy: reattach?.refusedBy, error: reattach?.error, sessionId: reattach?.sessionId
});
console.log(`\n   intent for ${agentNameFor('task', KEY)}: ${intentOf('task', KEY)}`);
console.log(`   census: ${JSON.stringify(census())}`);
verdict(
  reattach?.success === false &&
    reattach?.refusedBy === 'reattach-only' &&
    intentOf('task', KEY) === 'deactivated' &&
    !census().includes(agentNameFor('task', KEY)),
  'the re-attach found nothing to re-attach to and started nothing; the stand-down is untouched',
  `the re-attach started ${agentNameFor('task', KEY)} — this is the revocation, and everything after it follows`
);

// 4c. a deliberate URL activation, guessing the same wrong type.
console.log('\n   4c. a deliberate activation from the same page, still guessing the type');
const deliberate = await activateByUrl(issueUrl);
show('activate_response:', {
  success: deliberate?.success, type: deliberate?.type, key: deliberate?.key,
  refusedBy: deliberate?.refusedBy, error: deliberate?.error, sessionId: deliberate?.sessionId
});
console.log(`\n   intent for ${agentNameFor('task', KEY)}: ${intentOf('task', KEY)}`);
verdict(
  deliberate?.success === false &&
    deliberate?.refusedBy === 'stood-down-collision' &&
    intentOf('task', KEY) === 'deactivated' &&
    census().includes(agentNameFor('epic', KEY)),
  `refused: task/${KEY} is stood down and ${agentNameFor('epic', KEY)} holds the key — and the epic agent is untouched`,
  'a guessed type revived a stood-down agent beside a live sibling, which is invariant 5\'s collision'
);

// 4d. THE CONTROL. A guard that refused everything would have passed 4b and 4c.
console.log(`\n   4d. control: task/${LONE_KEY} is stood down but has no live sibling — it must still start`);
const loneUp = await activateByKey('task', LONE_KEY);
standDown('task', LONE_KEY);
console.log(`   intent for ${agentNameFor('task', LONE_KEY)} after stand-down: ${intentOf('task', LONE_KEY)}`);
const loneRestart = await activateByUrl(`${SITE}/browse/${LONE_KEY}`);
show('activate_response:', {
  success: loneRestart?.success, type: loneRestart?.type, key: loneRestart?.key,
  verified: loneRestart?.verified, refusedBy: loneRestart?.refusedBy, error: loneRestart?.error
});
verdict(
  loneUp?.success === true &&
    loneRestart?.success === true &&
    loneRestart?.refusedBy === undefined &&
    intentOf('task', LONE_KEY) === 'activated',
  'an ordinary stood-down agent is still startable from its own page — the guard is narrow',
  'the guard refuses ordinary activations too, which would make 4b and 4c prove nothing'
);

// ------------------------------------------------------------ 5. the consequence --

rule('5. the reboot after all that — the section the ticket was filed about');

console.log(`\n   expected(): ${JSON.stringify(expectedNames())}`);
console.log('\n   reconcileAgents:');
const after = await runReconcile();
const restoredArtifact = after.result.outcomes.find((o) => o.agentName === agentNameFor('task', KEY));
console.log(`\n   census after: ${JSON.stringify(census())}`);
show('reconcile outcomes:', after.result.outcomes.map((o) => ({ agentName: o.agentName, result: o.result })));

verdict(
  restoredArtifact === undefined &&
    !census().includes(agentNameFor('task', KEY)) &&
    intentOf('task', KEY) === 'deactivated' &&
    census().includes(agentNameFor('epic', KEY)),
  `${agentNameFor('task', KEY)} stayed down across the restore, and ${agentNameFor('epic', KEY)} came through it alive`,
  `${agentNameFor('task', KEY)} was restored — the reboot re-created the collision, exactly as observed on 2026-08-05 and 2026-08-06`
);

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
