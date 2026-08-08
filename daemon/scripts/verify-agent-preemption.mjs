// Proof for KAN-37: a higher-priority agent can take a lower-priority one's
// slot when the machine is full — visibly, reversibly, and never automatically.
//
// WHAT FAILURE THIS WOULD CATCH: a preemption that takes the wrong agent (a
// working one over an idle one, or an epic supervisor at all), that happens
// without the caller asking for it, that leaves no record of who took whose
// slot, or that brings the victim back cold — resumed with no conversation and
// no word of what happened to it, which is KAN-21's idle-forever failure
// reached by a new route. It also catches the reverse: an equal-priority
// activation being *offered* a victim it is not entitled to.
//
// Reworked for KAN-57. When KAN-37 was written, `story` was a charged worker
// type and the natural demonstration of preemption; KAN-46/KAN-52 then made
// epic and story uncharged supervisors, and KAN-57 made the gate honour that —
// a supervisor activation is never refused, so it never has anything to
// preempt for. The ordering, the consent flow, the record and the resume all
// still exist and still work; they are exercised here through a registered
// priority-2 worker type (`hotfix`, synthetic to this script), which is the
// shape of any future type that outranks `task` without being a supervisor.
// Section 6 now also proves the KAN-57 half directly: an epic activation on a
// full board starts without standing anything down.
//
// Nine sections, one per acceptance criterion plus the two design questions the
// ticket asked to be decided rather than assumed:
//
//   1. the scale        — where priority comes from, read off the real registry
//   2. ordering         — which agent is chosen as victim, and why that one
//   3. refusal          — equal or lower priority is still refused, and told why
//   4. consent          — what is shown BEFORE anything is killed
//   5. preemption       — capacity before and after, and the record of what went
//   6. supervisor safety — the highest possible activation cannot touch `epic`
//   7. survival         — a preempted agent, re-activated, resumes
//   8. ticket status    — what the preempted ticket becomes, and who moves it
//   9. the registry     — why a reboot does NOT bring a preempted agent back
//
// Sections 3 through 9 drive the real MessageRouter, the real WorkspaceRegistry
// and the real on-disk AgentRegistry, so what they print is what a caller
// actually receives and what is actually written to the log. herdr is stubbed —
// this proves the gate, the ordering and the record, and none of those reach
// herdr for anything but a census and a pane close. Jira is stubbed to one
// issue-type answer, which is the only thing the registry asks it.
//
// Usage: node daemon/scripts/verify-agent-preemption.mjs [distDir]

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = process.argv[2] ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const {
  PRIORITY_EPIC,
  PRIORITY_STORY,
  PRIORITY_TASK,
  DEFAULT_WORKSPACE_PRIORITY,
  compareVictims,
  outranks,
  selectVictim
} = await import(path.join(distDir, 'priority.js'));
const { WorkspaceRegistry, isSupervisorType } = await import(path.join(distDir, 'registry.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
// A throwaway state file: integrations are disabled until turned on, and a
// proof script must neither write into nor depend on the machine's real
// ~/.local/share/butchr/integrations.json.
const scratchState = () =>
  new IntegrationStateStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kan85-state-')), 'integrations.json')
  );
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { computeCapacity, readCapacity, readMachineFacts, summarizeCapacity } =
  await import(path.join(distDir, 'capacity.js'));
const { claudeTranscriptDir, hasRestorableConversation, resumeNudge } =
  await import(path.join(distDir, 'resume.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

// Every section ends in a verdict, and a failed verdict is counted here and
// carried to the exit code. It renders `FAILED` *and* propagates: this helper
// printed the word and returned undefined until KAN-119, so nine real
// assertions were evaluated, rendered, and thrown away — a script that showed a
// human its own failure while telling every automated reader it had passed.
const failures = [];
const verdict = (ok, yes, no) => {
  if (!ok) failures.push(no);
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};

// A supervisor plus however many task agents this machine's own derivation
// says it can carry. Filling to the derived cap rather than to a number this
// script picked means the refusals below are produced by the real arithmetic.
const HERE = readCapacity(0, 1);

// ------------------------------------------------------------- the harness --

/**
 * A herdr that reports exactly the agents it is told to, and forgets one when
 * its pane is closed — so the capacity report *after* a preemption is the
 * machine as it then is, not a reconstruction.
 *
 * `tailAgent` answers with a Claude Code prompt marker immediately, which is
 * what lets section 7 watch the interrupted-work nudge actually be delivered
 * instead of waiting two minutes for a pane that will never exist.
 */
function stubHerdr(running, { statuses = {}, sessions = [] } = {}) {
  const alive = [...running];
  const sent = [];
  const spawns = [];

  const bridge = {
    sent,
    spawns,
    alive,
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: `/tmp/${name}`,
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    // The post-spawn existence check (KAN-23), answered from the same list the
    // census is built from — which is the rule the real one follows.
    confirmAgentPresent: async (agentName) =>
      alive.includes(agentName)
        ? { present: true, waitedMs: 0, checks: 1 }
        : { present: false, reason: 'absent', waitedMs: 0, checks: 1,
            error: `stub herdr has no agent '${agentName}'` },
    abandonSession: () => {},
    listHerdrStatuses: () => new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
    listActiveSessions: () => sessions,
    getSessionByKey: () => undefined,
    getSessionByAddress: () => undefined,
    terminateSession: () => ({ success: true }),
    closeAgentByKey: (key) => {
      const i = alive.findIndex((n) => n.endsWith(`-${key.toLowerCase()}`));
      if (i === -1) return { success: false, error: `No agent found for key '${key}'` };
      const [agentName] = alive.splice(i, 1);
      return { success: true, agentName };
    },
    tailAgent: () => ({ success: true, text: 'bypass permissions on\n❯ ' }),
    sendToAgent: async (key, message, type) => {
      sent.push({ key, type, message });
      return { success: true };
    },
    spawnSession: (type, key, url, prompt, defaultAgent, mcpServers, resume) => {
      const workDir = path.join(WORKSPACES, type, key.toLowerCase());
      fs.mkdirSync(workDir, { recursive: true });
      const session = {
        sessionId: `${type}-${key.toLowerCase()}-stub`,
        type,
        key,
        url,
        createdAt: new Date(),
        status: 'active',
        workDir,
        ptyBuffer: '',
        onDataListeners: [],
        // The real spawnSession's own rule, run against the real function: a
        // resume asks the disk whether there is a conversation to continue.
        ...(resume ? { resume, resumedConversation: hasRestorableConversation(workDir) } : {})
      };
      spawns.push({ type, key, defaultAgent, resume, resumedConversation: session.resumedConversation });
      alive.push(`butchr-${type}-${key.toLowerCase()}`);
      return session;
    }
  };
  return bridge;
}

/**
 * The running fleet as priority candidates, read off whatever the stub herdr is
 * currently reporting.
 */
function fleetNow(bridge) {
  return bridge.listHerdrAgents().map((a) => {
    const [, type, ...rest] = a.name.split('-');
    return {
      agentName: a.name,
      type,
      key: rest.join('-'),
      priority: registry.priorityFor(type),
      herdrStatus: a.herdrStatus,
      activatedAt: null
    };
  });
}

/**
 * Capacity as the router computes it, from that same census. Used for the
 * before/after pair in section 5, so those two lines are readings of the fleet
 * as it then is rather than numbers this script chose and then asserted.
 */
function capacityOfFleet(bridge) {
  let fleet = 0;
  let supervisors = 0;
  for (const c of fleetNow(bridge)) {
    if (isSupervisorType(c.type)) supervisors++;
    else fleet++;
  }
  return readCapacity(fleet, supervisors);
}

// The real registry carrying the real Atlassian integration, whose lookup answers
// the one question resolution asks Jira: is this issue a Task or a Story?
// Everything downstream of that answer is real code — including which types
// count as supervisors, which the integration declares and `isSupervisorType`
// reads back below.
const registry = new WorkspaceRegistry(scratchState());
registry.registerIntegration(
  createAtlassianIntegration({
    issueTypeLookup: async (key) => (key === 'KAN-50' ? 'Story' : 'Task')
  })
);
registry.setEnabled('jira', true);

// The priority-2 worker this proof drives preemption with since KAN-57 (see
// the header). Registered through the real `register`, so `priorityFor` and
// `countsAsAgent` treat it exactly as they would a future real type; it
// borrows the task prompt because the prompt's content is irrelevant here.
registry.register({
  type: 'hotfix',
  name: 'Synthetic priority-2 worker (this script only)',
  urlPatterns: [],
  keyExtractor: () => null,
  promptTemplateFile: 'prompts/task.md',
  priority: PRIORITY_STORY
});

const prompts = new PromptLoader(repoRoot);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan37-'));
const WORKSPACES = path.join(TMP, 'workspaces');
let registryFile = 0;
/** Transcript directories this script creates outside TMP, to remove at the end. */
const TRANSCRIPTS = [];

function newRouter(bridge, seed = []) {
  const events = [];
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFile}.jsonl`));
  // Whatever herdr is reporting was, in real life, activated through this
  // daemon — so the registry holds an `activated` record for each. Seeding it
  // matters for more than realism: that record is where the agent's key keeps
  // its Jira casing (KAN-10, not the kan-10 an agent *name* is built from), and
  // that casing is what a person reads next to a ticket.
  for (const record of seed) agentRegistry.recordActivated(record);
  const router = new MessageRouter(
    registry,
    prompts,
    bridge,
    () => {},
    (msg) => events.push(msg),
    { agentRegistry }
  );
  return { router, events, agentRegistry };
}

/**
 * Run something with the daemon's own console output suppressed.
 *
 * Section 5 deliberately does NOT use this: the `[capacity] preemption:` line
 * it prints is part of what is being proved — the decision reaches the daemon
 * log with its full derivation, not only the caller. Everywhere else the same
 * line is a repeat.
 */
async function quiet(fn) {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

const call = async (router, action, data) => {
  let response;
  const respond = (msg) => { response = msg; };
  if (action === 'activate') await router.handleActivate(data, respond);
  else if (action === 'activate_by_key') await router.handleActivateByKey(data, respond);
  else router.handle({ ...data, action });
  return response;
};

// handleActivate is private; reached the same way the daemon reaches every
// handler, through handle(), with the response captured off the send channel.
function routerWithCapture(bridge, seed = []) {
  const built = newRouter(bridge, seed);
  let last;
  const router = new MessageRouter(
    registry,
    prompts,
    bridge,
    (msg) => { last = msg; },
    (msg) => built.events.push(msg),
    { agentRegistry: built.agentRegistry }
  );
  return { ...built, router, sent: () => last };
}

// ----------------------------------------------------------- 1. the scale --
rule('1. THE SCALE — where priority comes from');

console.log(
  'Priority is a property of the WORKSPACE TYPE, not of the Jira ticket. The type\n' +
  'is already resolved before activation, so no Jira lookup is added to the\n' +
  'activation path and both callers — the sidepanel toggle and the supervisor\n' +
  'agents that activate over MCP — get the same answer by the same route.\n'
);
console.log('  type      priority   registered in registry.ts');
for (const type of ['epic', 'story', 'task']) {
  console.log(`  ${type.padEnd(9)} ${String(registry.priorityFor(type)).padStart(4)}       ${registry.get(type).name}`);
}
console.log(`  ${'(unknown)'.padEnd(9)} ${String(registry.priorityFor('nonesuch')).padStart(4)}       falls to the floor, so it can preempt nothing`);

const scaleOk =
  registry.priorityFor('epic') === PRIORITY_EPIC &&
  registry.priorityFor('story') === PRIORITY_STORY &&
  registry.priorityFor('task') === PRIORITY_TASK &&
  registry.priorityFor('nonesuch') === DEFAULT_WORKSPACE_PRIORITY;
verdict(scaleOk, 'epic 3 > story 2 > task 1, as specified.', 'the scale is not what was specified.');

console.log(
  '\n  Strictly-greater, not greater-or-equal:\n' +
  `    task(1) over task(1):    ${outranks(PRIORITY_TASK, PRIORITY_TASK)}   ← the common case, and a refusal\n` +
  `    story(2) over task(1):   ${outranks(PRIORITY_STORY, PRIORITY_TASK)}\n` +
  `    epic(3) over epic(3):    ${String(outranks(PRIORITY_EPIC, PRIORITY_EPIC)).padStart(5)}   ← nothing can outrank the top of the scale`
);

// ------------------------------------------------------------ 2. ordering --
rule('2. ORDERING — which agent is chosen, and why that one');

const fleet = [
  { agentName: 'butchr-epic-kan-39',    type: 'epic',   key: 'KAN-39', priority: 3, herdrStatus: 'working', activatedAt: '2026-08-01T09:00:00Z' },
  { agentName: 'butchr-story-kan-50',   type: 'story',  key: 'KAN-50', priority: 2, herdrStatus: 'idle',    activatedAt: '2026-08-01T10:00:00Z' },
  { agentName: 'butchr-task-kan-10',    type: 'task',   key: 'KAN-10', priority: 1, herdrStatus: 'working', activatedAt: '2026-08-01T11:00:00Z' },
  { agentName: 'butchr-task-kan-11',    type: 'task',   key: 'KAN-11', priority: 1, herdrStatus: 'idle',    activatedAt: '2026-08-01T12:00:00Z' },
  { agentName: 'butchr-task-kan-12',    type: 'task',   key: 'KAN-12', priority: 1, herdrStatus: 'idle',    activatedAt: '2026-08-01T08:00:00Z' }
];

console.log('victim order (best victim first), over a fleet of five:\n');
for (const c of [...fleet].sort(compareVictims)) {
  console.log(`  ${String(c.priority)}  ${c.herdrStatus.padEnd(8)} ${c.activatedAt}  ${c.agentName}`);
}
console.log(
  '\n  Lowest priority first; among equals, whatever has least in flight. There is no\n' +
  '  last-active timestamp in this daemon — but herdr already reports what each agent\n' +
  '  is DOING, which is what "least recently active" was reaching for. done → idle →\n' +
  '  blocked → unknown → working. Remaining ties break on oldest, then name, purely so\n' +
  '  the same fleet always yields the same victim: a refusal that names one agent and\n' +
  '  a preemption that kills another would be the same request.\n'
);

for (const incoming of [1, 2, 3]) {
  const v = selectVictim(fleet, incoming);
  console.log(`  an activation at priority ${incoming} would take: ${v ? v.agentName : '(nothing — it outranks nothing)'}`);
}
const orderOk =
  selectVictim(fleet, 1) === null &&
  selectVictim(fleet, 2)?.agentName === 'butchr-task-kan-12' &&
  selectVictim(fleet, 3)?.agentName === 'butchr-task-kan-12';
verdict(
  orderOk,
  'priority 1 takes nothing; 2 and 3 both take the oldest idle task agent, not the working one.',
  'the ordering did not choose as documented.'
);

// ------------------------------------------------------------- 3. refusal --
rule(`3. REFUSAL — a task agent at capacity, on a board of task agents`);

// Filled to the machine's own derived cap, plus an epic supervisor, which is
// reserved off the top and does not occupy one of those slots.
const FULL = [
  'butchr-epic-kan-39',
  ...Array.from({ length: HERE.cap }, (_, i) => `butchr-task-kan-${10 + i}`)
];

const SEED = FULL.map((agentName) => {
  const [, type, ...rest] = agentName.split('-');
  const key = rest.join('-');
  return {
    agentName,
    type,
    key: key.toUpperCase(),
    workDir: `/tmp/${agentName}`
  };
});

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router } = newRouter(bridge, SEED);
  const res = await quiet(() => call(router, 'activate_by_key', { type: 'task', key: 'KAN-99' }));

  console.log(`running: ${FULL.join(', ')}\n`);
  console.log(res.error);
  console.log(`\n  capacity: ${summarizeCapacity({ ...HERE, running: HERE.cap })}`);
  console.log(`  refusedBy: ${res.refusedBy}   priority of the refused activation: ${res.priority}`);
  console.log(`  preemption offered: ${res.preemption ? 'yes' : 'no'}`);

  const namesFleet = /priority 1/.test(res.error) && /task\/kan-1\d \(priority 1/i.test(res.error);
  verdict(
    res.success === false && !res.preemption && namesFleet,
    'refused, and the message names what is running and what each one is worth — so the\n' +
    '    person who lost the slot can see who they lost it to. Equal priority offers no\n' +
    '    preemption at all: the button is not merely disabled, it is not there.',
    'an equal-priority activation was not refused, or the refusal did not name the fleet.'
  );
}

// ------------------------------------------------------------- 4. consent --
rule('4. CONSENT — what is shown BEFORE anything is killed');

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const captured = routerWithCapture(bridge, SEED);
  // A story activation would sail through the gate since KAN-57 — supervisors
  // are never refused, so they are never offered a victim. The consent flow is
  // reached by a priority-2 *worker*, which is what `hotfix` stands in for.
  const res = await quiet(() => call(captured.router, 'activate_by_key', { type: 'hotfix', key: 'KAN-50' }));

  console.log('a priority-2 worker activation arrives while the machine is full.\n');
  console.log('what the caller receives:\n');
  console.log(JSON.stringify({ success: res.success, type: res.type, key: res.key, priority: res.priority, preemption: res.preemption }, null, 2));
  console.log('\nwhat a panel renders from it (ActivationRefusal.jsx):\n');
  // The same headline rule the component applies (KAN-60): the binding
  // constraint leads, and "at capacity" is said only when the count bound.
  const headline =
    res.capacity.headroomBoundBy === 'load'
      ? 'Load is too high'
      : res.capacity.headroomBoundBy === 'memory'
        ? 'Not enough memory'
        : 'This machine is at capacity';
  console.log(`  ⚠️  Can't start this agent`);
  console.log(`  ${headline} — ${res.reason}.`);
  console.log(`  ┃ This agent outranks one that is running`);
  console.log(`  ┃ Starting hotfix/KAN-50 (priority ${res.priority}) can free a slot by standing down`);
  console.log(`  ┃ ${res.preemption.type}/${res.preemption.key} (priority ${res.preemption.priority}), which is currently ${res.preemption.herdrStatus}.`);
  console.log(`  ┃ That interrupts whatever ${res.preemption.type}/${res.preemption.key} has not committed. …`);
  console.log(`  [ Stand down ${res.preemption.type}/${res.preemption.key} and start ]  [ Start anyway ]  [ Dismiss ]`);

  const nothingDied = bridge.alive.length === FULL.length;
  verdict(
    res.success === false && res.preemption && nothingDied,
    `nothing was killed. The activation was REFUSED and the panel was handed the name\n` +
    `    of the agent that would be stopped, its priority, and what it is doing right now.\n` +
    `    ${bridge.alive.length} agents were running before and ${bridge.alive.length} after. Preemption happens only when a\n` +
    `    human presses a button that says whose work it ends.`,
    'something was stood down without consent, or no offer was made.'
  );
}

// ---------------------------------------------------------- 5. preemption --
rule('5. PREEMPTION — capacity before and after, and the record of what went');

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router, events, agentRegistry } = newRouter(bridge, SEED);

  const before = capacityOfFleet(bridge);
  console.log(`BEFORE  ${summarizeCapacity(before)}`);
  console.log(`        at capacity: ${before.atCapacity}`);
  console.log(`        running, in the order they would be taken:`);
  for (const c of [...fleetNow(bridge)].sort(compareVictims)) {
    console.log(`          ${c.priority}  ${c.herdrStatus.padEnd(8)} ${c.agentName}`);
  }

  const res = await call(router, 'activate_by_key', {
    type: 'hotfix',
    key: 'KAN-50',
    defaultAgent: 'claude',
    preempt: true
  });

  console.log(`\nactivate hotfix/KAN-50 (priority 2) with preempt: true\n`);
  console.log('what was preempted, and why:\n');
  console.log(JSON.stringify(res.preempted, null, 2).split('\n').slice(0, 14).join('\n'));

  const after = capacityOfFleet(bridge);
  console.log(`\nAFTER   ${summarizeCapacity(after)}`);
  console.log(`        at capacity: ${after.atCapacity}`);
  console.log(`        alive: ${bridge.alive.join(', ')}`);

  const broadcast = events.find((e) => e.action === 'agent_preempted_event');
  console.log(`\nbroadcast to every connected client:\n`);
  console.log(`  ${broadcast.action}: ${broadcast.victim.type}/${broadcast.victim.key} ` +
    `(priority ${broadcast.victim.priority}, ${broadcast.victim.herdrStatus}) ` +
    `stood down for ${broadcast.by.type}/${broadcast.by.key} (priority ${broadcast.by.priority})`);

  console.log(`\nwritten to the durable registry:\n`);
  for (const line of fs.readFileSync(agentRegistry.file ?? path.join(TMP, `agents-${registryFile}.jsonl`), 'utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    console.log(`  ${e.at}  ${e.event.padEnd(11)} ${e.agentName}` +
      (e.preemption ? `  ← preempted by ${e.preemption.byType}/${e.preemption.byKey} (${e.preemption.byPriority} vs ${e.preemption.priority})` : ''));
  }

  const startedIt = res.success === true;
  const tookTheIdleOne = res.preempted?.victim?.key?.toUpperCase() === 'KAN-10';
  const gone = !bridge.alive.includes('butchr-task-kan-10');
  const started = bridge.alive.includes('butchr-hotfix-kan-50');
  verdict(
    startedIt && tookTheIdleOne && gone && started,
    'the low-priority agent was stood down and the higher-priority one started. The\n' +
    '    victim chosen was the idle one, not either of the working ones, and the whole\n' +
    '    decision — who, for whom, and the capacity arithmetic that forced it — is on\n' +
    '    disk, on the wire, and in the activate response.',
    `preemption did not do what it claimed: started=${startedIt} victim=${res.preempted?.victim?.key} gone=${gone} new=${started}`
  );
}

// -------------------------------------------------- 6. supervisor safety --
rule('6. SUPERVISOR SAFETY — the highest possible activation cannot touch `epic`');

{
  // A fleet where an epic supervisor is the ONLY thing running, and an
  // activation at the very top of the scale asking for room.
  const epicOnly = [{ ...fleet[0] }];
  const topOfScale = selectVictim(epicOnly, PRIORITY_EPIC);
  console.log(`fleet: butchr-epic-kan-39 (priority ${PRIORITY_EPIC})`);
  console.log(`an activation at the highest priority the scale has (${PRIORITY_EPIC}) would take: ${topOfScale ?? '(nothing)'}\n`);

  // And through the real router, on a full board. Since KAN-57 a supervisor
  // activation never consults the gate at all: the epic agent starts alongside
  // the full fleet, preempt: true notwithstanding, and nothing is stood down
  // for it — its cost was never charged, so there is no slot to free.
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router } = newRouter(bridge, SEED);
  const res = await quiet(() => call(router, 'activate_by_key', { type: 'epic', key: 'KAN-77', defaultAgent: 'claude', preempt: true }));

  console.log(`on a full board including butchr-epic-kan-39, a priority-${PRIORITY_EPIC} epic activation`);
  console.log(`with preempt: true → success: ${res.success}, stood down: ${res.preempted?.victim?.agentName ?? '(nothing)'}`);
  console.log(`  butchr-epic-kan-39 still running: ${bridge.alive.includes('butchr-epic-kan-39')}`);
  console.log(`  every task agent still running:   ${FULL.every((n) => bridge.alive.includes(n))}`);

  console.log(
    '\n  Two protections, one of which has become the whole answer. The ordering half\n' +
    '  is unchanged: `epic` is the top of the scale and the comparison is strictly-\n' +
    '  greater, so no activation at any priority can select an epic agent as victim.\n' +
    '  And since KAN-57 the gate half is absolute: a supervisor activation is never\n' +
    '  refused and never preempts, because the capacity model has never charged\n' +
    '  supervisors a slot — standing something down would free room it does not take:'
  );
  const facts = readMachineFacts();
  const withSup = computeCapacity(facts, HERE.cap, { supervisorsRunning: 1 });
  const withoutSup = computeCapacity(facts, HERE.cap, { supervisorsRunning: 0 });
  console.log(`    supervisor running:     cap ${withSup.cap}, running ${withSup.running}, headroom by count ${withSup.headroomByCap}`);
  console.log(`    supervisor stood down:  cap ${withoutSup.cap}, running ${withoutSup.running}, headroom by count ${withoutSup.headroomByCap}  ← unchanged`);

  verdict(
    topOfScale === null &&
      bridge.alive.includes('butchr-epic-kan-39') &&
      res.success === true &&
      !res.preempted &&
      FULL.every((n) => bridge.alive.includes(n)),
    'an epic agent cannot be selected at any priority, and a top-of-scale epic\n' +
    '    activation on a full board started without standing anything down (KAN-57).',
    'the epic activation was refused, or something was stood down for it.'
  );
}

// ------------------------------------------------------------ 7. survival --
rule('7. SURVIVAL — a preempted agent, re-activated, resumes rather than starts cold');

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router, agentRegistry } = newRouter(bridge, SEED);

  // Preempt it, exactly as section 5 did.
  await quiet(() => call(router, 'activate_by_key', { type: 'hotfix', key: 'KAN-50', defaultAgent: 'claude', preempt: true }));
  console.log(`task/KAN-10 was preempted. The registry's last word on it:`);
  const intent = agentRegistry.intents().get('butchr-task-kan-10');
  console.log(`  event: ${intent.event}   preemption recorded: ${Boolean(intent.preemption)}\n`);

  // Give it a conversation on disk, at the path Claude Code actually keys by,
  // so `--continue` would have something to restore. This is the real function
  // that decides it, not a flag this script set.
  const workDir = path.join(WORKSPACES, 'task', 'kan-10');
  fs.mkdirSync(workDir, { recursive: true });
  const transcript = claudeTranscriptDir(workDir);
  fs.mkdirSync(transcript, { recursive: true });
  fs.writeFileSync(path.join(transcript, 'session.jsonl'), '{"type":"user"}\n');
  TRANSCRIPTS.push(transcript);
  console.log(`a conversation exists on disk for it: ${hasRestorableConversation(workDir)}`);
  console.log(`  (${transcript})\n`);

  // Make room, then switch it back on the ordinary way — no resume flag, no
  // reconciliation, just a person turning the switch back to On. `override`
  // passes the capacity gate, not the resume machinery: the gate reads this
  // machine's live one-minute load, and this section is about what a
  // re-activation restores, not about whether the machine is quiet while the
  // script runs. verify-agent-power-controls.mjs makes the same argument as
  // PAST_THE_GATE.
  bridge.alive.splice(bridge.alive.indexOf('butchr-hotfix-kan-50'), 1);
  const back = await quiet(() => call(router, 'activate_by_key', { type: 'task', key: 'KAN-10', defaultAgent: 'claude', override: true }));

  console.log('re-activated with no resume flag of any kind. What the daemon did with it:\n');
  console.log(`  resume cause:          ${back.resume}`);
  console.log(`  conversation restored: ${back.resumedConversation}`);

  // The nudge is fire-and-forget; let it land.
  await new Promise((r) => setTimeout(r, 50));
  console.log(`\n  and it was told, in words, what happened to it:\n`);
  const nudge = bridge.sent.find((s) => s.key === 'KAN-10');
  console.log(nudge ? nudge.message.replace(/(.{76}\s)/g, '$1\n    ').replace(/^/gm, '    ') : '  (nothing was sent)');
  console.log(`\n  the sentence that distinguishes this from a crash:\n    "${resumeNudge('task', 'KAN-10', 'preempted').split('. ')[1]}."`);

  verdict(
    back.resume === 'preempted' && back.resumedConversation === true && Boolean(nudge),
    'it came back with its own conversation AND an instruction to carry on. Without\n' +
    '    the second half this would be KAN-21\'s idle-forever failure reached by a new\n' +
    '    route: Claude Code resumes at an empty prompt and waits, so a restored agent\n' +
    '    nobody speaks to is indistinguishable from a finished one. Nobody rebooted\n' +
    '    anything here — a person flipped a switch, and the daemon worked out for itself\n' +
    '    that this was interrupted work rather than new work.',
    `resume=${back.resume} restored=${back.resumedConversation} nudged=${Boolean(nudge)}`
  );
}

// ------------------------------------------------------- 8. ticket status --
rule('8. TICKET STATUS — what the preempted ticket becomes, and who moves it');

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  // One router, one registry: the preemption below and the list_agents that
  // reports it are the same daemon answering about the same event.
  const { router, sent } = routerWithCapture(bridge, SEED);
  await quiet(async () => {
    await router.handleActivateByKey(
      { type: 'hotfix', key: 'KAN-50', defaultAgent: 'claude', preempt: true },
      () => {}
    );
  });

  console.log('The daemon does NOT write to Jira — that is out of scope by the ticket, and stays');
  console.log('out of scope. What it does instead is make the fact impossible to miss, to the');
  console.log('one party that does hold the Jira write.\n');
  console.log('butchr_list_agents, on every poll, until the agent is put back:\n');

  router.handle({ action: 'list_agents' });
  const listed = sent();
  const entry = listed.preemptedAgents[0];
  console.log(
    JSON.stringify(
      {
        preemptedAgents: [
          {
            agentName: entry.agentName,
            type: entry.type,
            key: entry.key,
            priority: entry.priority,
            herdrStatusWhenPreempted: entry.herdrStatusWhenPreempted,
            by: entry.by,
            at: entry.at,
            reason: entry.reason
          }
        ]
      },
      null,
      2
    )
  );
  console.log(
    `\n  and butchr_list_agents returns isError for it, exactly as it does for a missing\n` +
    `  agent — a supervisor skimming tool output for problems must not skim past this.`
  );

  console.log('\nand `prompts/epic.md` — the supervisor that holds the Jira write — now says:\n');
  const epicPrompt = fs.readFileSync(path.join(repoRoot, 'prompts', 'epic.md'), 'utf8');
  const section = epicPrompt.slice(epicPrompt.indexOf('**A preempted agent'));
  console.log(section.split('\n').slice(0, 16).map((l) => '  ' + l).join('\n'));

  verdict(
    Boolean(entry) && /should not read In Progress/.test(entry.reason) && /back to \*\*To Do\*\*/.test(section),
    'the ticket goes back to To Do, with a comment naming what took its slot. Leaving\n' +
    '    it In Progress with nothing behind it is precisely the lie KAN-21 exists to end,\n' +
    '    and a preemption reintroduces it by a different door if nobody moves the ticket.\n' +
    '    The daemon cannot move it and says so; the supervising epic agent can, is told\n' +
    '    to, and is handed the list on every poll it already makes.',
    'the preempted agent was not reported, or no status rule was recorded.'
  );
}

// -------------------------------------------------------- 9. the registry --
rule('9. THE REGISTRY — why a reboot does NOT bring a preempted agent back');

{
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router, agentRegistry } = newRouter(bridge, SEED);
  await quiet(() => call(router, 'activate_by_key', { type: 'hotfix', key: 'KAN-50', defaultAgent: 'claude', preempt: true }));

  const expected = agentRegistry.expected().map((r) => r.agentName);
  const preempted = agentRegistry.preempted().map((p) => p.agentName);

  console.log('This was the sharpest question on the ticket: record the preemption so the next');
  console.log('daemon restart resurrects the agent, or so it does not?\n');
  console.log(`  reconciliation would restore: ${expected.length ? expected.join(', ') : '(nothing this script activated)'}`);
  console.log(`  reported as preempted:        ${preempted.join(', ') || '(none)'}\n`);
  console.log(
    '  NOT resurrected, and the reason is in reconcile.ts: restoration starts the whole\n' +
    '  expected fleet at once and does so with override: true — deliberately, because a\n' +
    '  boot-time load average is high *because the machine is booting*. So an agent left\n' +
    '  recorded as expected would come back alongside the agent that took its slot, past\n' +
    '  a gate that has been told not to argue, on a machine that has just demonstrated it\n' +
    '  cannot hold both. A restart must not overturn a decision a person made.\n\n' +
    '  The event stays `deactivated`, so intents() needs no new rule and there is nothing\n' +
    '  to get wrong. What is added is the annotation on the same record — who took the\n' +
    '  slot, both priorities, the arithmetic — because "deactivated" alone throws away\n' +
    '  the difference between a human switching an agent off and work being taken from\n' +
    '  an agent in the middle of it. That difference is what section 7 reads to decide\n' +
    '  it is resuming rather than starting.'
  );

  verdict(
    !expected.includes('butchr-task-kan-10') && preempted.includes('butchr-task-kan-10'),
    'a preempted agent is not in the restore set, and is in the owed set.',
    'a preempted agent would be resurrected by the next boot.'
  );
}

// Both temporary trees, including the fake Claude Code transcript section 7
// wrote at the path the real one would use.
fs.rmSync(TMP, { recursive: true, force: true });
for (const dir of TRANSCRIPTS) fs.rmSync(dir, { recursive: true, force: true });

console.log(
  failures.length
    ? `\n${failures.length} of 9 sections FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nALL PASS — all 9 sections.'
);
console.log('\n== done ==');
process.exit(failures.length ? 1 : 0);
