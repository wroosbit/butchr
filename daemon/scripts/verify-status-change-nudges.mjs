// Proof for KAN-77: the daemon records who activated each agent, and tells that
// party — once — when the agent's runtime changes state without saying so.
//
// WHAT FAILURE THIS WOULD CATCH: a supervisor woken by an agent's ordinary turn
// boundary — herdr reports `done` at the end of *every* turn, so wiring that to
// a nudge would make each one an interruption — or woken twice for a single
// loss, or not woken at all when a child's runtime dies. It also catches the
// quieter halves: a notice that names neither the child nor what it was doing,
// a supervisor of record that was invented, self-referential, or dropped on
// restore, and an Enter lost mid-tool-call so the nudge is typed into the pane
// and never submitted — the failure a substring check over the scrollback
// passes rather than catches, which is why section 3 exists.
//
// CI-RUNNABLE: yes — imports the built daemon modules and asserts against them
// in process; no live daemon, no herdr, no credential, no peer, no terminal.
//
// Six sections, one per thing the ticket asks to be true:
//
//   1. supervisor of record  — written at activation from the caller's own
//                              identity, `null` when nobody's, never invented,
//                              never itself, and carried through a stand-down
//                              and a restore
//   2. what `done` means     — read off herdr's own reporting, and why
//                              `working` → `done` is not wired
//   3. delivery confirmed    — the observed send-race frame, and why a
//                              substring check passes on the failure it is
//                              supposed to catch
//   4. the nudge             — a child's runtime is killed; its supervisor's
//                              pane receives exactly one notice naming the
//                              child and its last status, and a second sweep
//                              sends nothing
//   5. the send race         — an Enter lost mid-tool-call is retried exactly
//                              once, and the retry is confirmed against the pane
//   6. storm guards          — no supervisor, a supervisor that is not running,
//                              a self-referential parent, and blocked→unblocked
//                              →blocked as two events rather than one
//
// Sections 1 and 4-6 drive the real MessageRouter, the real WorkspaceRegistry
// and the real on-disk AgentRegistry, so what is printed is what is actually
// written to the log and what a supervisor's terminal actually receives. herdr
// is stubbed — but stubbed as a *pane*, with a composer and a scrollback, so
// the delivery check is exercised against the same frame the failure produced
// rather than against a boolean this script chose.
//
// Usage: node daemon/scripts/verify-status-change-nudges.mjs [distDir]
//        Run from the repo root, after `cd daemon && npx tsc`.
//
//        --live  additionally runs section 7: two REAL herdr panes, a real
//                pane close, and a real nudge typed into a real terminal. Opt-in
//                because it starts two agents on the machine you run it on and
//                the machine is usually full. Sections 1-6 need nothing but a
//                build, which is what makes them the repeatable half.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
/** Leave the live panes standing, so the acceptance proof can tail them. */
const KEEP = args.includes('--keep');
const distDir = args.find((a) => !a.startsWith('--')) ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { WorkspaceRegistry, isSupervisorType } = await import(path.join(distDir, 'registry.js'));
const { AgentRegistry, toSupervisorOfRecord, sameSupervisorOfRecord } = await import(
  path.join(distDir, 'agent-registry.js')
);
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { createAtlassianIntegration } = await import(
  path.join(distDir, 'integrations', 'atlassian-integration.js')
);
const { IntegrationStateStore } = await import(
  path.join(distDir, 'integrations', 'enablement.js')
);
const {
  SupervisionNotifier,
  deliverToAgent,
  deliveryFingerprint,
  messageLanded,
  supervisionNudgeText
} = await import(path.join(distDir, 'nudge.js'));

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  if (!ok) process.exitCode = 1;
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
};
const row = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan77-'));
const WORKSPACES = path.join(TMP, 'workspaces');
let registryFiles = 0;

// ------------------------------------------------------------- the harness --

/**
 * A message as Claude Code echoes it once submitted: the same `❯` caret the
 * composer uses, hard-wrapped to the pane's width with the continuation
 * indented. Copied from a real 80-column pane — see AC3.
 */
const wrap = (text) =>
  (text.match(/.{1,76}(\s|$)/g) ?? [text])
    .map((line, i) => (i === 0 ? `❯ ${line.trim()}` : `  ${line.trim()}`))
    .join('\n');

/**
 * A herdr whose agents have *panes*: a scrollback of what has been submitted
 * and a composer holding what has been typed but not sent.
 *
 * The distinction is the point. `sendToAgent` returning success only means the
 * keystrokes were typed; whether the Enter took is visible nowhere except here,
 * in which of the two places the text ends up — which is exactly what the
 * production tail sees and exactly what the delivery check reads.
 *
 * `swallowEnter` reproduces the observed failure: the Ctrl+C lands while the
 * target is mid-tool-call, the message is typed, and the submit is lost.
 */
function stubHerdr(running, { statuses = {}, swallowEnter = {} } = {}) {
  const alive = [...running];
  const panes = new Map();
  const sends = [];

  const paneFor = (agentName) => {
    if (!panes.has(agentName)) {
      panes.set(agentName, { scrollback: ['bypass permissions on'], composer: '' });
    }
    return panes.get(agentName);
  };

  const nameFor = (key, type) =>
    type ? `butchr-${type}-${String(key).toLowerCase()}` : `butchr-task-${String(key).toLowerCase()}`;

  /**
   * The pane as herdr actually renders it, copied from a real one.
   *
   * Two details are load-bearing and were both got wrong before a live run
   * corrected them: a submitted message is echoed with the *same* `❯` caret the
   * composer uses, so the two can only be told apart by position; and the echo
   * is hard-wrapped to the pane width with the continuation indented, so it
   * does not appear in the buffer as the one line that was sent.
   */
  const render = (pane) =>
    [
      ...pane.scrollback,
      '─'.repeat(80),
      `❯ ${pane.composer}`,
      '─'.repeat(80),
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
    ].join('\n');

  const bridge = {
    alive,
    panes,
    sends,
    paneFor,
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: path.join(TMP, name),
        herdrStatus: statuses[name] ?? 'working'
      }))
    }),
    listHerdrAgents: () => bridge.listHerdrAgentsChecked().agents,
    listHerdrStatuses: () =>
      new Map(bridge.listHerdrAgents().map((a) => [a.name, a.herdrStatus])),
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
    confirmAgentPresent: async (agentName) =>
      alive.includes(agentName)
        ? { present: true, waitedMs: 0, checks: 1 }
        : {
            present: false,
            reason: 'absent',
            waitedMs: 0,
            checks: 1,
            error: `stub herdr has no agent '${agentName}'`
          },
    abandonSession: () => {},
    terminateSession: () => ({ success: true }),
    closeAgentByKey: (key, type) => {
      const name = nameFor(key, type);
      const i = alive.indexOf(name);
      if (i === -1) return { success: false, error: `No agent found for key '${key}'` };
      alive.splice(i, 1);
      return { success: true, agentName: name };
    },
    tailAgent: (key, type) => {
      const name = nameFor(key, type);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      return { success: true, text: render(paneFor(name)) };
    },
    sendToAgent: async (key, message, type) => {
      const name = nameFor(key, type);
      if (!alive.includes(name)) return { success: false, error: `No agent found for key '${key}'` };
      const pane = paneFor(name);
      sends.push({ agentName: name, message });

      // One Ctrl+C, then the text — both of which always land.
      pane.composer = message;
      const swallowed = (swallowEnter[name] ?? 0) > 0;
      if (swallowed) {
        swallowEnter[name]--;
        // The failure: `success: true`, and the message sitting in the composer.
        return { success: true };
      }
      pane.scrollback.push(wrap(message), '● Noted.');
      pane.composer = '';
      return { success: true };
    },
    spawnSession: (type, key, url) => {
      const workDir = path.join(WORKSPACES, type, String(key).toLowerCase());
      fs.mkdirSync(workDir, { recursive: true });
      // herdr registers a name once. A second copy would survive `kill` and
      // make a dead agent look alive — a bug in the stub that would quietly
      // pass the section it is meant to prove.
      if (!alive.includes(nameFor(key, type))) alive.push(nameFor(key, type));
      return {
        sessionId: `${type}-${String(key).toLowerCase()}-stub`,
        type,
        key,
        url,
        createdAt: new Date(),
        status: 'active',
        workDir,
        ptyBuffer: '',
        onDataListeners: []
      };
    },
    /** What a killed runtime looks like from outside: herdr stops listing it. */
    kill: (agentName) => {
      for (let i = alive.length - 1; i >= 0; i--) if (alive[i] === agentName) alive.splice(i, 1);
    },
    /** Everything this pane has actually received, as submitted output. */
    submitted: (agentName) =>
      paneFor(agentName).scrollback.filter((line) => line.startsWith('❯ ')),
    setStatus: (agentName, status) => {
      statuses[agentName] = status;
    }
  };
  return bridge;
}

// The real registry carrying the real Atlassian integration, so `story` is a
// supervisor type and `task` is not because the integration says so.
const registry = new WorkspaceRegistry(
  new IntegrationStateStore(path.join(TMP, 'integrations.json'))
);
registry.registerIntegration(
  createAtlassianIntegration({ issueTypeLookup: async () => 'Task' })
);
registry.setEnabled('jira', true);
const prompts = new PromptLoader(repoRoot);

function newRouter(bridge, seed = []) {
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFiles}.jsonl`));
  for (const record of seed) agentRegistry.recordActivated(record);
  const router = new MessageRouter(
    registry,
    prompts,
    bridge,
    () => {},
    () => {},
    { agentRegistry }
  );
  return { router, agentRegistry };
}

/**
 * Activate through the real handler, the way a caller on the wire would.
 *
 * `override: true` so the gate's answer does not depend on what else this
 * machine happens to be running, and the capacity derivation it logs is muted:
 * it is real and correct and it is about a different ticket, and this proof is
 * read by someone checking what was recorded, not what the machine can carry.
 */
async function activate(router, data) {
  let response = null;
  const chatter = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    await router.handleActivateByKey({ override: true, ...data }, (msg) => {
      response = msg;
    });
  } finally {
    console.log = chatter.log;
    console.warn = chatter.warn;
  }
  return response;
}

const parentOf = (agentRegistry, agentName) =>
  agentRegistry.intents().get(agentName)?.record.activatedBy;
const show = (parent) =>
  parent === undefined ? '(field absent)' : parent === null ? 'null' : `${parent.type}/${parent.key}`;

// ------------------------------------------- 1. the supervisor of record --

rule('AC1 — the activating agent is recorded as the supervisor of record, and nothing else is');

{
  const bridge = stubHerdr(['butchr-story-kan-75', 'butchr-epic-kan-39']);
  const { router, agentRegistry } = newRouter(bridge);

  // A story agent staffing a task: the identity the butchr MCP attaches to
  // every request it makes is the only thing it has to send, and it already
  // sends it.
  await activate(router, {
    type: 'task',
    key: 'KAN-90',
    defaultAgent: 'claude',
    workspaceType: 'story',
    workspaceKey: 'KAN-75'
  });
  // A human, from the sidepanel: no identity on the request at all.
  await activate(router, { type: 'task', key: 'KAN-91', defaultAgent: 'claude' });
  // An agent re-activating itself is nobody's child.
  await activate(router, {
    type: 'task',
    key: 'KAN-92',
    defaultAgent: 'claude',
    workspaceType: 'task',
    workspaceKey: 'KAN-92'
  });
  // Half an address is not an address.
  await activate(router, {
    type: 'task',
    key: 'KAN-93',
    defaultAgent: 'claude',
    workspaceType: 'story',
    workspaceKey: '   '
  });

  console.log('');
  row('story/KAN-75 activates task/KAN-90', show(parentOf(agentRegistry, 'butchr-task-kan-90')));
  row('a human activates task/KAN-91', show(parentOf(agentRegistry, 'butchr-task-kan-91')));
  row('task/KAN-92 activates itself', show(parentOf(agentRegistry, 'butchr-task-kan-92')));
  row('a request with a blank workspaceKey', show(parentOf(agentRegistry, 'butchr-task-kan-93')));

  // KAN-78's note: the re-activation dedupe must compare `activatedBy`, or an
  // agent activated parentless and later adopted never records its parent.
  await activate(router, {
    type: 'task',
    key: 'KAN-91',
    defaultAgent: 'claude',
    workspaceType: 'story',
    workspaceKey: 'KAN-75'
  });
  const adopted = parentOf(agentRegistry, 'butchr-task-kan-91');
  row('…then story/KAN-75 re-activates KAN-91', show(adopted));

  // The sidepanel calls `activate` every time a human opens the agent's Jira
  // tab, with no caller identity on the request. That must not orphan it.
  await activate(router, { type: 'task', key: 'KAN-90', defaultAgent: 'claude' });
  const afterVisit = parentOf(agentRegistry, 'butchr-task-kan-90');
  row('a human opens task/KAN-90\'s tab (re-attach)', show(afterVisit));

  // A stand-down keeps it: standby and preempted rows hang in the same tree.
  let deactivated = null;
  router.handleDeactivateByKey({ type: 'task', key: 'KAN-90' }, (msg) => (deactivated = msg));
  const afterStandDown = agentRegistry.intents().get('butchr-task-kan-90');
  row('after task/KAN-90 is switched off', show(afterStandDown?.record.activatedBy));

  // The JSON on disk, which is the interface two other tickets are written
  // against: an explicit null, never an omitted key.
  const line = fs
    .readFileSync(path.join(TMP, `agents-${registryFiles}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .find((l) => JSON.parse(l).agentName === 'butchr-task-kan-91');
  const parsed = JSON.parse(line);
  console.log(`\n  the two parentless activations, as written to the log:`);
  console.log(`    ${JSON.stringify({ agentName: parsed.agentName, activatedBy: parsed.activatedBy })}`);
  const humanLine = fs
    .readFileSync(path.join(TMP, `agents-${registryFiles}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .find((r) => r.agentName === 'butchr-task-kan-92');
  console.log(`    ${JSON.stringify({ agentName: humanLine.agentName, activatedBy: humanLine.activatedBy })}`);

  // A record written by a daemon that predates the field reads as `null`, not
  // as an absent key — normalised once, on the way in.
  const legacyFile = path.join(TMP, 'legacy.jsonl');
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      agentName: 'butchr-task-kan-1',
      type: 'task',
      key: 'KAN-1',
      workDir: '/tmp/old',
      event: 'activated',
      at: new Date().toISOString()
    }) + '\n'
  );
  const legacy = new AgentRegistry(legacyFile).intents().get('butchr-task-kan-1');
  row('a pre-KAN-77 record read back', show(legacy?.record.activatedBy));

  verdict(
    sameSupervisorOfRecord(parentOf(agentRegistry, 'butchr-task-kan-90'), { type: 'story', key: 'KAN-75' }) &&
      parentOf(agentRegistry, 'butchr-task-kan-92') === null &&
      parentOf(agentRegistry, 'butchr-task-kan-93') === null &&
      sameSupervisorOfRecord(adopted, { type: 'story', key: 'KAN-75' }) &&
      sameSupervisorOfRecord(afterVisit, { type: 'story', key: 'KAN-75' }) &&
      sameSupervisorOfRecord(afterStandDown?.record.activatedBy, { type: 'story', key: 'KAN-75' }) &&
      'activatedBy' in humanLine &&
      humanLine.activatedBy === null &&
      legacy?.record.activatedBy === null,
    'the activating agent is recorded, a human activation records an explicit null, ' +
      'self-parentage is refused, adoption is not swallowed by the dedupe, and neither a ' +
      'sidepanel re-attach nor a stand-down loses the parent.',
    'see the rows above — one of the four activations recorded the wrong parent.'
  );
}

// A restore is not a new activation: boot-time reconciliation passes the
// parentage it read out of the registry, so a reboot does not orphan a fleet.
{
  const bridge = stubHerdr(['butchr-story-kan-75']);
  const { router, agentRegistry } = newRouter(bridge);
  await activate(router, {
    type: 'task',
    key: 'KAN-94',
    defaultAgent: 'claude',
    activatedBy: { type: 'story', key: 'KAN-75' },
    resume: 'reboot'
  });
  console.log('');
  row('reconciliation restores task/KAN-94', show(parentOf(agentRegistry, 'butchr-task-kan-94')));
  verdict(
    sameSupervisorOfRecord(parentOf(agentRegistry, 'butchr-task-kan-94'), { type: 'story', key: 'KAN-75' }),
    'a restored agent keeps the parent it had before the machine went away.',
    'restoration dropped the supervisor of record, orphaning the agent on reboot.'
  );
}

// --------------------------------------------------- 2. what `done` means --

rule('AC2 — `working` → `done` is NOT wired, and this is what it is read off');

console.log(`
  herdr's status is not this daemon's judgement. \`toAgentStatus\` (herdr.ts)
  whitelists whatever \`herdr agent list\` puts in \`agent_status\` and nothing
  here corroborates it, so \`done\` is the agent's own hook-reported turn
  boundary — which fires at the end of every turn, and was observed on
  2026-08-03 reporting \`done\` for task/KAN-72 while a tail of the same agent
  showed a live diff scrolling under "Merging KAN-71 and re-wiring registry
  seams…".

  Of the two options the ticket offered — (a) unambiguous transitions only, or
  (b) keep \`done\` with corroboration across two sweeps — this implements (a).
  (b) does not help: an agent between turns is still \`done\` a minute later, so
  corroborating would confirm the wrong reading rather than filter it.

  Wired:     newly missing per findMissingAgents, and \`working\` → \`blocked\`
  Not wired: \`working\` → \`done\`, and every transition into \`idle\`
`);

{
  const bridge = stubHerdr(['butchr-story-kan-75', 'butchr-task-kan-95'], {
    statuses: { 'butchr-story-kan-75': 'working', 'butchr-task-kan-95': 'working' }
  });
  const { router } = newRouter(bridge, [
    {
      agentName: 'butchr-task-kan-95',
      type: 'task',
      key: 'KAN-95',
      workDir: path.join(TMP, 'kan-95'),
      activatedBy: { type: 'story', key: 'KAN-75' }
    }
  ]);
  const notifier = new SupervisionNotifier({
    herdrBridge: bridge,
    supervisorFor: (name) => router.supervisorFor(name),
    recordedKeyFor: (name) => router.recordedKeyFor(name),
    // KAN-301 made this seam's default a REFUSAL rather than the composer, so a
    // harness that reads delivery off a pane now has to ask for the composer by
    // name. Deliberate, not a red made to go away: this proof is about WHICH
    // transitions are recognised and WHO is told, and the composer is the only
    // carrier whose delivery can be confirmed as submitted output (C3).
    // Production rides the channel; `verify-notifications-never-type.mjs` §1b
    // asserts that this injection has no counterpart in `daemon/src`.
    deliver: deliverToAgent,
    log: () => {}
  });

  await notifier.onSweep(census(router));
  bridge.setStatus('butchr-task-kan-95', 'done');
  const second = await notifier.onSweep(census(router));

  row('sweep sees task/KAN-95 go working → done', `${second.changes.length} change(s) recognised`);
  row('messages sent to story/KAN-75', String(bridge.submitted('butchr-story-kan-75').length));

  verdict(
    second.changes.length === 0 && bridge.submitted('butchr-story-kan-75').length === 0,
    'a turn boundary reported as `done` wakes nobody.',
    '`done` produced a nudge — every turn boundary is now an interruption.'
  );
}

/** The census the daemon's sweep hands the notifier, from the real router. */
function census(router) {
  const fleet = router.surveyFleet();
  return {
    agents: fleet.agents.map((a) => ({
      agentName: a.agentName,
      type: a.type,
      key: a.key,
      herdrStatus: a.herdrStatus
    })),
    missing: fleet.missing.map((a) => ({ agentName: a.agentName, type: a.type, key: a.key }))
  };
}

// ------------------------------------------------- 3. delivery, confirmed --

rule('AC3 — delivery is confirmed against the pane, and a substring check is not enough');

{
  const message = supervisionNudgeText({
    agentName: 'butchr-task-kan-90',
    type: 'task',
    key: 'KAN-90',
    from: 'working',
    to: 'missing'
  });
  // Both frames are the real thing, transcribed from 80-column panes on
  // 2026-08-04: the unsent one from task/KAN-116, whose composer was holding
  // somebody's nudge while herdr reported the agent `done`; the landed one from
  // this ticket's own first live run.
  const unsent = [
    '✻ Churned for 9m 12s',
    '',
    '─'.repeat(80),
    wrap(message),
    '─'.repeat(80),
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
  ].join('\n');

  const landed = [
    wrap(message),
    '',
    '● Noted — no action taken, as instructed.',
    '',
    '✻ Baked for 1s',
    '',
    '─'.repeat(80),
    '❯ ',
    '─'.repeat(80),
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
  ].join('\n');

  console.log('');
  row('naive tail.includes(message) — unsent frame', String(unsent.includes(message)));
  row('naive tail.includes(message) — landed frame', String(landed.includes(message)));
  row('messageLanded() — unsent frame', String(messageLanded(unsent, message)));
  row('messageLanded() — landed frame', String(messageLanded(landed, message)));
  console.log(`\n  (the fingerprint it matches on: "${deliveryFingerprint(message)}")`);
  console.log(`
  The naive check is wrong in both directions at once. It reports the landed
  frame as undelivered, because the echo is hard-wrapped and the sent message
  is one line; and on an unwrapped pane it would report the unsent frame as
  delivered, because typed-but-unsent text is in the buffer too. The first live
  run of this code hit the first half and re-sent a notice an agent had already
  answered.`);

  verdict(
    unsent.includes(message) === false &&
      landed.includes(message) === false &&
      messageLanded(unsent, message) === false &&
      messageLanded(landed, message) === true,
    'the delivery check reads the wrapped echo as delivered and the composer as not.',
    'the delivery check does not distinguish typed-but-unsent from submitted.'
  );
}

// ------------------------------------------------------------ 4. the nudge --

rule('AC4 — kill a child\'s runtime: its supervisor is told once, and only once');

{
  const bridge = stubHerdr(['butchr-story-kan-75', 'butchr-task-kan-96'], {
    statuses: { 'butchr-story-kan-75': 'working', 'butchr-task-kan-96': 'working' }
  });
  const { router } = newRouter(bridge);
  const log = [];

  // Both agents activated for real, the child by the supervisor, so the
  // parentage under test is the one the router wrote rather than one seeded.
  await activate(router, {
    type: 'task',
    key: 'KAN-96',
    defaultAgent: 'claude',
    workspaceType: 'story',
    workspaceKey: 'KAN-75'
  });

  const notifier = new SupervisionNotifier({
    herdrBridge: bridge,
    supervisorFor: (name) => router.supervisorFor(name),
    recordedKeyFor: (name) => router.recordedKeyFor(name),
    // KAN-301 made this seam's default a REFUSAL rather than the composer, so a
    // harness that reads delivery off a pane now has to ask for the composer by
    // name. Deliberate, not a red made to go away: this proof is about WHICH
    // transitions are recognised and WHO is told, and the composer is the only
    // carrier whose delivery can be confirmed as submitted output (C3).
    // Production rides the channel; `verify-notifications-never-type.mjs` §1b
    // asserts that this injection has no counterpart in `daemon/src`.
    deliver: deliverToAgent,
    log: (...args) => log.push(args.join(' '))
  });

  // Sweep one: everything healthy. This is where the last-known status is
  // learned, and it is the fact the loss notice will carry.
  const first = await notifier.onSweep(census(router));
  row('sweep 1 — both agents healthy', `${first.changes.length} change(s), ${bridge.sends.length} send(s)`);

  bridge.kill('butchr-task-kan-96');
  const second = await notifier.onSweep(census(router));
  row('sweep 2 — the child\'s runtime is killed', `${second.changes.length} change(s), ${second.delivered} delivered`);

  const third = await notifier.onSweep(census(router));
  row('sweep 3 — nothing has changed since', `${third.changes.length} change(s), ${bridge.sends.length} total send(s)`);

  const received = bridge.submitted('butchr-story-kan-75');
  console.log(`\n  story/KAN-75's pane, as submitted output:\n`);
  for (const line of received) console.log(`    ${line}`);

  const one = received.length === 1;
  const namesChild = one && received[0].includes('task/KAN-96') && received[0].includes('butchr-task-kan-96');
  const namesStatus = one && received[0].includes('working');

  verdict(
    one && namesChild && namesStatus && second.changes.length === 1 && third.changes.length === 0,
    'exactly one notice reached the supervisor, naming the child and its last status, ' +
      'and a second sweep over the same loss sent nothing.',
    `the supervisor received ${received.length} notice(s); one, naming task/KAN-96 and \`working\`, was required.`
  );
}

// -------------------------------------------------------- 5. the send race --

rule('AC5 — an Enter lost mid-tool-call is retried exactly once, and confirmed');

{
  const bridge = stubHerdr(['butchr-story-kan-75'], {
    // The first send to this pane is typed and never submitted, exactly as
    // observed on 2026-08-03; the second takes.
    swallowEnter: { 'butchr-story-kan-75': 1 }
  });
  const log = [];
  const outcome = await deliverToAgent({
    herdrBridge: bridge,
    type: 'story',
    key: 'KAN-75',
    message: supervisionNudgeText({
      agentName: 'butchr-task-kan-97',
      type: 'task',
      key: 'KAN-97',
      from: 'working',
      to: 'missing'
    }),
    log: (...args) => log.push(args.join(' ')),
    confirmTimeoutMs: 300,
    pollMs: 100
  });

  console.log('');
  row('herdr reported the first send as', 'success: true');
  row('attempts', String(outcome.attempts));
  row('delivered (confirmed on the pane)', String(outcome.delivered));
  row('notices actually submitted to the pane', String(bridge.submitted('butchr-story-kan-75').length));
  console.log('');
  for (const line of log) console.log(`    ${line}`);

  // And the other half: a pane that never submits is reported undelivered
  // rather than reported as sent.
  const deaf = stubHerdr(['butchr-story-kan-75'], {
    swallowEnter: { 'butchr-story-kan-75': 99 }
  });
  const dropped = await deliverToAgent({
    herdrBridge: deaf,
    type: 'story',
    key: 'KAN-75',
    message: 'a message that will never be submitted',
    log: () => {},
    confirmTimeoutMs: 300,
    pollMs: 100
  });
  console.log('');
  row('a pane that never submits — attempts', String(dropped.attempts));
  row('a pane that never submits — delivered', String(dropped.delivered));

  verdict(
    outcome.attempts === 2 &&
      outcome.delivered === true &&
      bridge.submitted('butchr-story-kan-75').length === 1 &&
      dropped.attempts === 2 &&
      dropped.delivered === false,
    'a lost Enter costs one retry and lands once; a pane that never submits is ' +
      'reported undelivered rather than reported sent.',
    'the retry did not happen, happened more than once, or a lost send was reported as delivered.'
  );
}

// ------------------------------------------------------- 6. the storm guards --

rule('AC6 — nobody to tell, nobody home, and one event per event');

{
  const bridge = stubHerdr(['butchr-story-kan-75', 'butchr-task-kan-98', 'butchr-task-kan-99'], {
    statuses: {
      'butchr-story-kan-75': 'working',
      'butchr-task-kan-98': 'working',
      'butchr-task-kan-99': 'working'
    }
  });
  const { router } = newRouter(bridge);
  const log = [];

  // KAN-98 has a supervisor; KAN-99 was started by a human and has none.
  await activate(router, {
    type: 'task', key: 'KAN-98', defaultAgent: 'claude',
    workspaceType: 'story', workspaceKey: 'KAN-75'
  });
  await activate(router, { type: 'task', key: 'KAN-99', defaultAgent: 'claude' });

  const notifier = new SupervisionNotifier({
    herdrBridge: bridge,
    supervisorFor: (name) => router.supervisorFor(name),
    recordedKeyFor: (name) => router.recordedKeyFor(name),
    // KAN-301 made this seam's default a REFUSAL rather than the composer, so a
    // harness that reads delivery off a pane now has to ask for the composer by
    // name. Deliberate, not a red made to go away: this proof is about WHICH
    // transitions are recognised and WHO is told, and the composer is the only
    // carrier whose delivery can be confirmed as submitted output (C3).
    // Production rides the channel; `verify-notifications-never-type.mjs` §1b
    // asserts that this injection has no counterpart in `daemon/src`.
    deliver: deliverToAgent,
    log: (...args) => log.push(args.join(' '))
  });

  await notifier.onSweep(census(router));

  // Both go blocked. Only the one with a parent produces a notice.
  bridge.setStatus('butchr-task-kan-98', 'blocked');
  bridge.setStatus('butchr-task-kan-99', 'blocked');
  const blocked = await notifier.onSweep(census(router));
  console.log('');
  row('two agents go blocked, one is parentless', `${blocked.changes.length} recognised, ${blocked.delivered} delivered`);
  row('  reason the parentless one was dropped', blocked.skipped.map((s) => s.reason).join(', ') || '(none)');

  // Still blocked a sweep later: not news twice.
  const stillBlocked = await notifier.onSweep(census(router));
  row('still blocked on the next sweep', `${stillBlocked.changes.length} change(s)`);

  // Unblocked, then blocked again: that is a second event, not a repeat.
  bridge.setStatus('butchr-task-kan-98', 'working');
  await notifier.onSweep(census(router));
  bridge.setStatus('butchr-task-kan-98', 'blocked');
  const reblocked = await notifier.onSweep(census(router));
  row('unblocked, then blocked again', `${reblocked.changes.length} change(s)`);

  // A supervisor that is not running: logged, and stopped.
  bridge.kill('butchr-story-kan-75');
  bridge.setStatus('butchr-task-kan-98', 'working');
  await notifier.onSweep(census(router));
  bridge.setStatus('butchr-task-kan-98', 'blocked');
  const orphaned = await notifier.onSweep(census(router));
  row('supervisor not running', `${orphaned.changes.length} recognised, ${orphaned.delivered} delivered`);
  row('  reason', orphaned.skipped.map((s) => s.reason).join(', ') || '(none)');

  const received = bridge.submitted('butchr-story-kan-75');
  console.log(`\n  story/KAN-75 received ${received.length} notice(s) in total:\n`);
  for (const line of received) console.log(`    ${line.slice(0, 150)}…`);

  verdict(
    blocked.changes.length === 2 &&
      blocked.delivered === 1 &&
      blocked.skipped.some((s) => s.reason === 'no supervisor of record') &&
      stillBlocked.changes.length === 0 &&
      reblocked.changes.length === 1 &&
      orphaned.delivered === 0 &&
      orphaned.skipped.some((s) => s.reason === 'supervisor of record is not running') &&
      received.length === 2,
    'a parentless agent wakes nobody, a standing condition is announced once, ' +
      'a genuine second event is announced again, and a supervisor that is not running is only logged.',
    'a storm guard did not hold — see the counts above.'
  );
}

// ------------------------------------------------------- 7. the live proof --

if (LIVE) {
  rule('AC7 (--live) — two real panes: kill the child, read the supervisor\'s terminal');

  const { HerdrBridge } = await import(path.join(distDir, 'herdr.js'));
  const { waitForAgentReady } = await import(path.join(distDir, 'nudge.js'));

  const SUP = { type: 'story', key: 'KAN77SUP', agentName: 'butchr-story-kan77sup' };
  const CHILD = { type: 'task', key: 'KAN77CHILD', agentName: 'butchr-task-kan77child' };

  // Two panes that are told, in words, to do nothing. They exist to be a
  // delivery target and a corpse; an agent that went and did work off the back
  // of a proof run would be a worse outcome than an unproven ticket.
  const INERT =
    'You are a stand-in pane for a Butchr proof run (KAN-77). Do nothing at all: ' +
    'no tools, no files, no messages to anyone, no tickets. If text arrives in this ' +
    'pane, acknowledge it in one short sentence and take no other action. ' +
    'This pane is closed automatically within a few minutes.';

  const bridge = new HerdrBridge();
  const agentRegistry = new AgentRegistry(path.join(TMP, 'live.jsonl'));
  const router = new MessageRouter(
    registry, prompts, bridge, () => {}, () => {}, { agentRegistry }
  );
  const log = [];
  const notifier = new SupervisionNotifier({
    herdrBridge: bridge,
    supervisorFor: (name) => router.supervisorFor(name),
    recordedKeyFor: (name) => router.recordedKeyFor(name),
    log: (...a) => { const line = a.join(' '); log.push(line); console.log(`    ${line}`); }
  });

  /**
   * The census, narrowed to the two agents this proof owns.
   *
   * The real herdr census carries the machine's whole live fleet, and a proof
   * script has no business being the reason somebody else's supervisor is
   * interrupted. The registry seeded below already makes every other agent
   * parentless, so this is the second of two guards rather than the only one.
   */
  const liveCensus = () => {
    const fleet = router.surveyFleet();
    const mine = (a) => a.agentName === SUP.agentName || a.agentName === CHILD.agentName;
    return {
      agents: fleet.agents.filter(mine).map((a) => ({
        agentName: a.agentName, type: a.type, key: a.key, herdrStatus: a.herdrStatus
      })),
      missing: fleet.missing.filter(mine).map((a) => ({
        agentName: a.agentName, type: a.type, key: a.key
      }))
    };
  };

  const workspaces = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');
  try {
    console.log('\n  starting two real agents…\n');
    bridge.spawnSession(SUP.type, SUP.key, undefined, INERT, 1, 'claude', {});
    bridge.spawnSession(CHILD.type, CHILD.key, undefined, INERT, 1, 'claude', {});

    // The durable record, exactly as the router writes it on an activation by a
    // supervisor — section 1 proves that write path against the real handler;
    // here the interest is what the notifier does with what it finds.
    agentRegistry.recordActivated({
      agentName: SUP.agentName, type: SUP.type, key: SUP.key,
      workDir: path.join(workspaces, SUP.type, SUP.key.toLowerCase()),
      defaultAgent: 'claude', activatedBy: null
    });
    agentRegistry.recordActivated({
      agentName: CHILD.agentName, type: CHILD.type, key: CHILD.key,
      workDir: path.join(workspaces, CHILD.type, CHILD.key.toLowerCase()),
      defaultAgent: 'claude', activatedBy: { type: SUP.type, key: SUP.key }
    });

    const ready = await Promise.all([
      waitForAgentReady(bridge, SUP.key, SUP.type),
      waitForAgentReady(bridge, CHILD.key, CHILD.type)
    ]);
    row('both panes reached a prompt', ready.every(Boolean) ? 'yes' : 'NO — see the tails below');

    const first = await notifier.onSweep(liveCensus());
    row('sweep 1 — both alive', `${first.changes.length} change(s); child status ${notifier.knownStatus(CHILD.agentName)}`);

    console.log('\n  killing the child\'s runtime (herdr pane close)…');
    const killed = bridge.closeAgentByKey(CHILD.key, CHILD.type);
    row('herdr closed the pane', JSON.stringify(killed));
    // herdr's census is what "missing" is measured against, and it is not
    // instantaneous about a pane that has just gone.
    await new Promise((r) => setTimeout(r, 3000));

    const second = await notifier.onSweep(liveCensus());
    row('sweep 2 — the child is gone', `${second.changes.length} recognised, ${second.delivered} delivered`);

    const third = await notifier.onSweep(liveCensus());
    row('sweep 3 — same loss, one sweep later', `${third.changes.length} change(s)`);

    const tail = bridge.tailAgent(SUP.key, SUP.type, 40);
    console.log(`\n  ${SUP.agentName}'s terminal, read back through the real herdr:\n`);
    console.log((tail.text ?? tail.error ?? '(no output)').split('\n').map((l) => `    ${l}`).join('\n'));

    const notice = (tail.text ?? '').includes('task/KAN77CHILD');
    verdict(
      second.changes.length === 1 && second.delivered === 1 && third.changes.length === 0 && notice,
      'the supervisor\'s real terminal received one notice naming the dead child and its last status.',
      'the live nudge did not arrive, arrived twice, or did not name the child.'
    );
  } finally {
    if (KEEP) {
      console.log(
        `\n  --keep: leaving ${SUP.agentName} open so its terminal can be read back ` +
        `through butchr_tail_agent. Close its pane when you are done with it.`
      );
      // The PTYs this script attached are still open, and an open PTY keeps the
      // event loop alive: without this, --keep hangs forever instead of leaving
      // the panes and exiting. The panes are herdr's and outlive us either way.
      fs.rmSync(TMP, { recursive: true, force: true });
      console.log(`\n== ${process.exitCode ? 'FAILURES ABOVE' : 'all sections passed'} ==`);
      process.exit(process.exitCode ?? 0);
    } else {
      const alive = new Set(bridge.listHerdrAgents().map((a) => a.name));
      for (const agent of [SUP, CHILD]) {
        if (alive.has(agent.agentName)) {
          try { bridge.closeAgentByKey(agent.key, agent.type); } catch {}
        }
        try {
          fs.rmSync(path.join(workspaces, agent.type, agent.key.toLowerCase()), {
            recursive: true, force: true
          });
        } catch {}
      }
      console.log('\n  both proof panes closed and their workspaces removed.');
    }
  }
}

// --------------------------------------------------------------------------

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${process.exitCode ? 'FAILURES ABOVE' : 'all sections passed'} ==`);
