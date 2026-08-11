// Live proof for KAN-23: `activate` reports success only for an agent that
// verifiably exists.
//
// WHAT FAILURE THIS WOULD CATCH: `activate` answering success for an agent
// that was never created — herdr reporting a start that started nothing — or
// the existence check losing the distinction between "not there yet" and "not
// there at all", which is what turns a bounded wait into either a false alarm
// or an unbounded hang.
//
// CI-RUNNABLE: no — shells out to `which herdr` and activates a real agent
// through it; it throws outright when herdr is not on PATH.
//
// The ticket's symptom was a response of `success: true` with a plausible
// session id for an agent that was never created. KAN-24's PR #21 closed the
// half of that where herdr *told* us the spawn failed and we discarded the
// answer. This proves the other half — herdr reports success and no agent is
// there afterwards — and the two failure kinds it has to be kept apart from.
//
// Five sections:
//
//   1. happy path   — a normal activation, and the agent present in list_agents
//   2. injected     — herdr reports the start succeeded and starts nothing
//   3. timeout      — what bounds the wait when the agent never appears
//   4. unverifiable — herdr does not answer: not the same claim as "absent"
//   5. not sticky   — a refused activation can still be retried afterwards
//
// Everything here is the real code: the real HerdrBridge, the real
// MessageRouter, a real herdr 0.6.4, real panes. What is injected is a `herdr`
// shim on PATH that intercepts one subcommand and passes every other call to
// the real binary — so the failure being reported is a real absent agent
// observed through the real census, not a mock of our own code answering a
// question we asked it to answer.
//
// The server is private, on its own socket and state dir, so none of this can
// disturb a live session. Usage:
//
//   node daemon/scripts/verify-activate-verified-existence.mjs [distDir]
//
// Run it after `npm run build` in daemon/.

import { execFileSync, spawn } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');

const TYPE = 'k23proof';

// sockaddr_un.sun_path is ~108 bytes, so the socket cannot live under a long
// TMPDIR. /tmp directly is the only reliably short option.
const runDir = mkdtempSync('/tmp/herdr-k23-');
const stateDir = mkdtempSync(path.join(tmpdir(), 'k23-state-'));
const workspaceRoot = path.join(
  process.env.HOME, '.local', 'share', 'butchr', 'workspaces', TYPE
);

process.env.HERDR_SOCKET_PATH = path.join(runDir, 'h.sock');
process.env.XDG_CONFIG_HOME = path.join(stateDir, 'config');
process.env.XDG_STATE_HOME = path.join(stateDir, 'state');
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realHerdr = execFileSync('which', ['herdr'], { encoding: 'utf8' }).trim();

// ------------------------------------------------------------- the shim --
//
// One script, three behaviours, chosen at call time by BUTCHR_K23_MODE:
//
//   (unset)       every call goes to the real herdr
//   swallow-start `agent start` answers in herdr's own success shape and
//                 starts nothing. This is the ticket's exact scenario.
//   blind-list    `agent start` is swallowed as above AND `agent list` fails,
//                 so the census cannot answer either way.
//   refuse-close  `pane close` fails for a reason that is not "already gone",
//                 which is the failure deactivate used to swallow.
//
// Only the intercepted subcommand is fake. `agent get`, `tab create`,
// `pane close`, `agent attach` — everything HerdrBridge does around the start
// — reaches the real server, so the absence the daemon observes is real.
const shimDir = path.join(runDir, 'bin');
mkdirSync(shimDir, { recursive: true });
writeFileSync(path.join(shimDir, 'herdr'), `#!/bin/bash
if [ "$1" = "pane" ] && [ "$2" = "close" ] && [ "$BUTCHR_K23_MODE" = "refuse-close" ]; then
  echo '{"error":{"code":"internal","message":"stub: the herdr server refused the close"}}' >&2
  exit 1
fi
if [ "$1" = "agent" ] && [ "$2" = "start" ] && [ "$BUTCHR_K23_MODE" != "refuse-close" ] && [ -n "$BUTCHR_K23_MODE" ]; then
  echo "{\\"result\\":{\\"agent\\":{\\"name\\":\\"$3\\",\\"pane_id\\":\\"999\\"}}}"
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ] && [ "$BUTCHR_K23_MODE" = "blind-list" ]; then
  echo '{"error":{"code":"unavailable","message":"stub: the herdr server did not answer"}}' >&2
  exit 1
fi
exec ${realHerdr} "$@"
`);
chmodSync(path.join(shimDir, 'herdr'), 0o755);

let server;
function cleanup() {
  // Close the panes this proof created before the server goes, so nothing of
  // ours is left in a session that outlives the script.
  try {
    delete process.env.BUTCHR_K23_MODE;
    const listed = JSON.parse(execFileSync(realHerdr, ['agent', 'list'], { encoding: 'utf8' }));
    for (const agent of listed?.result?.agents ?? []) {
      if (agent?.name?.startsWith(`butchr-${TYPE}-`) && agent.pane_id) {
        try { execFileSync(realHerdr, ['pane', 'close', String(agent.pane_id)]); } catch {}
      }
    }
  } catch {}
  server?.kill('SIGKILL');
  rmSync(runDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
process.on('exit', cleanup);

console.log('== starting a private herdr server ==');
server = spawn(realHerdr, ['server'], { detached: true, stdio: 'ignore', env: process.env });
for (let i = 0; i < 20; i++) {
  try {
    const out = execFileSync(realHerdr, ['pane', 'list'], { encoding: 'utf8', timeout: 10000 });
    if (out.includes('"panes"')) break;
  } catch {}
  await sleep(500);
}
console.log(`   pid ${server.pid}, socket ${process.env.HERDR_SOCKET_PATH}`);
console.log(`   real herdr ${realHerdr}, shim ${path.join(shimDir, 'herdr')}`);

// Only now, so the server itself was started by the real binary.
process.env.PATH = `${shimDir}:${process.env.PATH}`;

// ---------------------------------------------------------- the harness --

const { HerdrBridge, agentNameFor, AGENT_CONFIRM_TIMEOUT_MS, HERDR_CLI_TIMEOUT_MS } =
  await import(path.join(distDir, 'herdr.js'));
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
    path.join(mkdtempSync(path.join(tmpdir(), 'kan85-state-')), 'integrations.json')
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

// A prompt for the unregistered proof type. Agents here run `bash` — the
// explicitly requested `shell` launcher — so nothing in this script starts a
// real coding agent.
const promptRoot = path.join(stateDir, 'promptroot');
mkdirSync(path.join(promptRoot, 'prompts'), { recursive: true });
writeFileSync(path.join(promptRoot, 'prompts', `${TYPE}.md`), 'KAN-23 proof workspace.\n');

const bridge = new HerdrBridge();
const agentRegistry = new AgentRegistry(path.join(stateDir, 'agents.jsonl'));
let sent;
const router = new MessageRouter(
  atlassianRegistry(async () => 'Task'),
  new PromptLoader(promptRoot),
  bridge,
  (msg) => { sent = msg; },
  () => {},
  { agentRegistry }
);

// The capacity gate reads the real machine, and whether this box is busy
// decides nothing about whether activate tells the truth. Overriding it is the
// same thing the sidepanel's [Start anyway] sends, and it is recorded.
const OVERRIDE = { override: true };

// These agents really are shells — the `shell` launcher, `bash` — so nothing
// here starts a coding agent. Said explicitly because it must be: since
// KAN-53 omission means `claude`, and `shell` is reachable only by name. It
// also keeps list_agents honest, which reads the recorded launcher to decide
// whether a pane with no runtime in it is a dead agent or a shell working as
// asked.
const AS_SHELL = { defaultAgent: 'shell' };

/** Drive the real handler and return exactly what the caller would receive. */
async function activate(key, extra = {}) {
  sent = undefined;
  const startedAt = Date.now();
  await router.handleActivateByKey(
    { action: 'activate_by_key', type: TYPE, key, ...OVERRIDE, ...AS_SHELL, ...extra },
    (msg) => { sent = msg; }
  );
  return { response: sent, elapsedMs: Date.now() - startedAt };
}

/** herdr's own census, read with the real binary — the ground truth here. */
function herdrAgentNames() {
  const mode = process.env.BUTCHR_K23_MODE;
  delete process.env.BUTCHR_K23_MODE;
  try {
    const out = execFileSync(realHerdr, ['agent', 'list'], { encoding: 'utf8', timeout: 10000 });
    return (JSON.parse(out)?.result?.agents ?? []).map((a) => a.name);
  } catch (e) {
    return [`<herdr agent list failed: ${e.message}>`];
  } finally {
    if (mode) process.env.BUTCHR_K23_MODE = mode;
  }
}

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const show = (label, value) =>
  console.log(`   ${label}\n${JSON.stringify(value, null, 2).replace(/^/gm, '     ')}`);
let failures = 0;
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};

// -------------------------------------------------------- 1. happy path --

rule('1. happy path — a normal activation, verified before it is claimed');

const happy = await activate('HAPPY');
show('activate_by_key response:', happy.response);

sent = undefined;
router.handle({ action: 'list_agents' });
const listed = (sent?.agents ?? []).filter((a) => a.type === TYPE || a.agentName.startsWith(`butchr-${TYPE}-`));
show('butchr_list_agents, immediately afterwards:', listed);
console.log(`\n   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);
console.log(`   verification cost: ${happy.elapsedMs}ms for the whole activation`);

verdict(
  happy.response?.success === true &&
    happy.response?.verified === true &&
    listed.some((a) => a.agentName === agentNameFor(TYPE, 'HAPPY')),
  'success: true, and the agent is genuinely in list_agents',
  'a normal activation no longer succeeds or is not listed'
);

// ----------------------------------------------------------- 2. injected --

rule('2. injected failure — herdr reports the start succeeded and starts nothing');

console.log('   `herdr agent start` now answers {"result":{"agent":...}} and does nothing.');
console.log('   Every other herdr call in the activate path is the real server.\n');

process.env.BUTCHR_K23_MODE = 'swallow-start';
const ghost = await activate('GHOST');
delete process.env.BUTCHR_K23_MODE;

show('activate_by_key response:', ghost.response);
console.log(`\n   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);
console.log(`   durable registry recorded: ${JSON.stringify([...agentRegistry.intents().keys()])}`);

verdict(
  ghost.response?.success === false &&
    ghost.response?.verified === false &&
    typeof ghost.response?.error === 'string' &&
    ghost.response.error.includes(agentNameFor(TYPE, 'GHOST')) &&
    !herdrAgentNames().includes(agentNameFor(TYPE, 'GHOST')) &&
    !agentRegistry.intents().has(agentNameFor(TYPE, 'GHOST')),
  'success: false, naming the agent that is not there — and nothing was recorded as active',
  'the false success is still reachable'
);

// ------------------------------------------------------------ 3. timeout --

rule('3. timeout — the verification cannot hang activate');

console.log(`   Section 2's activation returned in ${ghost.elapsedMs}ms, having waited out the`);
console.log('   whole confirmation window for an agent that never appeared.\n');

// What this section bounds — decided under KAN-66. Every agent in this proof
// is a `shell` launcher, so what "exists" means for them is a name
// registration: there is no runtime to wait for, and activate confirms these
// very sessions with requireRuntime: false (initPty sets expectsRuntime false
// for `shell`). The probe asks the same question, so the tight
// AGENT_CONFIRM_TIMEOUT_MS budget is the right one here. The longer
// RUNTIME_CONFIRM_TIMEOUT_MS ceiling (KAN-58) belongs to runtime-delivering
// launchers, which this proof deliberately never starts — passing the budget
// positionally where requireRuntime now lives is how this section once ended
// up asserting the old ceiling against the new one.
const PROBE_BUDGET_MS = 1000;
const t0 = Date.now();
const shortBound = await bridge.confirmAgentPresent(
  agentNameFor(TYPE, 'never-exists'),
  false,
  PROBE_BUDGET_MS
);
const shortMs = Date.now() - t0;
show(`confirmAgentPresent(..., requireRuntime: false, timeoutMs: ${PROBE_BUDGET_MS}):`,
  { ...shortBound, measuredMs: shortMs });

console.log('\n   The bound: for these shell agents activate polls the census for at most');
console.log(`   AGENT_CONFIRM_TIMEOUT_MS (${AGENT_CONFIRM_TIMEOUT_MS}ms, every 250ms), and the census call in`);
console.log(`   flight is itself capped by HERDR_CLI_TIMEOUT_MS (${HERDR_CLI_TIMEOUT_MS}ms) — so the worst case`);
console.log('   is those two added together, and the ordinary case is one call because a');
console.log('   started agent is listable immediately.');

// Both budgets are asserted from the daemon's own exported constants, so the
// assertion tracks future ceiling changes instead of failing on them — while
// still failing if the confirmation genuinely overruns its documented bound.
// The probe's worst case is its explicit budget plus one census in flight;
// the activation's is the confirmation's documented worst case plus slack
// for the activate path around it (the swallowed start, the tab
// bookkeeping), none of which polls.
verdict(
  shortBound.present === false &&
    shortMs < PROBE_BUDGET_MS + HERDR_CLI_TIMEOUT_MS &&
    ghost.elapsedMs < AGENT_CONFIRM_TIMEOUT_MS + HERDR_CLI_TIMEOUT_MS + 2000,
  `bounded: ${PROBE_BUDGET_MS}ms budget honoured in ${shortMs}ms, and activate returned in ${ghost.elapsedMs}ms`,
  'the confirmation ran past its budget'
);

// ------------------------------------------------------- 4. unverifiable --

rule('4. unverifiable is not absent — herdr does not answer');

console.log('   Section 1\'s agent is alive and this daemon is attached to it. `agent list` now');
console.log('   fails, so the census cannot answer either way about an agent that is');
console.log('   demonstrably fine. The activation must be reported as unverified — and the');
console.log('   working agent must survive it, because silence is not evidence.\n');

const beforeBlind = bridge.getSessionByKey('HAPPY');
process.env.BUTCHR_K23_MODE = 'blind-list';
const blind = await activate('HAPPY');
delete process.env.BUTCHR_K23_MODE;

show('activate_by_key response:', blind.response);

const afterBlind = bridge.getSession(beforeBlind?.sessionId);
console.log(`\n   session ${beforeBlind?.sessionId}: ${afterBlind?.status ?? 'gone'}` +
  `, spawnError ${afterBlind?.spawnError ? 'set' : 'unset'}`);
console.log(`   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);

verdict(
  blind.response?.success === false &&
    /did not answer/.test(blind.response?.error ?? '') &&
    afterBlind?.status === 'active' &&
    !afterBlind?.spawnError &&
    herdrAgentNames().includes(agentNameFor(TYPE, 'HAPPY')),
  'reported as unverified rather than as a dead agent, and the live agent was left alone',
  'an unreachable herdr was mistaken for evidence the agent is gone'
);

// --------------------------------------------------------- 5. not sticky --

rule('5. a refused activation is reported, not latched');

console.log('   The same key from section 2, activated again against the real herdr. A session');
console.log('   left active for an agent known not to exist would be the one getSessionByKey');
console.log('   hands back, and no later activation could ever spawn past it.\n');

const retry = await activate('GHOST');
show('activate_by_key response:', retry.response);
console.log(`\n   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);

verdict(
  retry.response?.success === true &&
    herdrAgentNames().includes(agentNameFor(TYPE, 'GHOST')),
  'the retry produced a real agent — the earlier failure locked nothing out',
  'the failed activation poisoned the session map'
);

// -------------------------------------------------------- 6. the siblings --

rule('6. the sibling audit — deactivate, reset, send');

console.log('   deactivate, on a session whose pane close herdr refuses. The stand-down is');
console.log('   issued; what comes back must not be success.\n');

// `pane close` fails for a reason that is not "already gone" — the one case
// the old code logged and swallowed on its way to returning true.
process.env.BUTCHR_K23_MODE = 'refuse-close';
sent = undefined;
router.handle({ action: 'deactivate_by_key', key: 'GHOST', type: TYPE });
const refusedOff = sent;
delete process.env.BUTCHR_K23_MODE;

show('deactivate_by_key response:', refusedOff);
console.log(`\n   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);

verdict(
  refusedOff?.success === false &&
    /may still be running/.test(refusedOff?.error ?? '') &&
    herdrAgentNames().includes(agentNameFor(TYPE, 'GHOST')),
  'a refused stand-down is reported as one — and the agent is indeed still there',
  'deactivate still reports success for a teardown that did not happen'
);

console.log('\n   The same stand-down with herdr answering, for the contrast:\n');
sent = undefined;
router.handle({ action: 'deactivate_by_key', key: 'GHOST', type: TYPE });
const realOff = sent;
show('deactivate_by_key response:', realOff);
console.log(`\n   herdr agent list: ${JSON.stringify(herdrAgentNames())}`);

verdict(
  realOff?.success === true && !herdrAgentNames().includes(agentNameFor(TYPE, 'GHOST')),
  'success: true only when the agent actually went away',
  'the honest failure came at the cost of the working path'
);

console.log('\n   send, to an agent that does not exist. It resolves the pane through herdr');
console.log('   before it types anything, so there is nothing to confirm afterwards:\n');

sent = undefined;
router.handle({ action: 'send_to_agent', key: 'NOSUCH', type: TYPE, message: 'hello' });
await sleep(1500);
show('send_to_agent response:', sent);

verdict(
  sent?.success === false,
  'send already fails on an agent it cannot address — no change was needed',
  'send reported success with no agent to send to'
);

console.log('\n   reset, on a workspace that is not there. success describes the delete,');
console.log('   which is what reset is, and the agent outcome rides alongside it:\n');

sent = undefined;
router.handle({ action: 'reset_by_key', type: TYPE, key: 'NOSUCH' });
show('reset_by_key response:', sent);

verdict(
  sent?.success === false,
  'reset already reports the real outcome of the delete — no change was needed',
  'reset claimed to have deleted a workspace that was not there'
);

// ------------------------------------------------------------------ done --

rule(failures === 0 ? 'all sections passed' : `${failures} section(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
