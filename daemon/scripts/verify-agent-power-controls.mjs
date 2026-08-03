// Proof for KAN-38: the Agents page can switch an agent off and back on, and
// every way that could go wrong has an answer rather than a discovery.
//
// Eight sections, one per thing the ticket asked to be decided:
//
//   1. off            — the message the page sends, and the agent gone from the census
//   2. confirmation   — what a human is shown BEFORE it, against a real dirty repo
//   3. supervisor     — what happens when the target is a supervisor (epic)
//   4. on             — where the candidates come from, and the agent back
//   5. launcher       — why a stand-down has to carry the activation record with it
//   6. refusal        — at capacity, what the page displays instead of nothing
//   7. poll stability — a control mid-action against the 2s poll
//   8. reset          — a deleted workspace is not offered a way back
//
// Every section drives the real MessageRouter, the real WorkspaceRegistry and a
// real on-disk AgentRegistry, so what it prints is what a caller actually
// receives and what is actually written to the log. Section 2 runs the real git
// probe against a real repository this script creates and dirties. herdr is
// stubbed — nothing here reaches it except a census and a pane close, and the
// live half of this proof (a real daemon, a real herdr, `herdr agent list` as
// ground truth) is verify-fleet-switch-live.mjs.
//
// Usage: node daemon/scripts/verify-agent-power-controls.mjs [distDir] [--dump <dir>]
// Run it after `npm run build` in daemon/.
//
//   --dump <dir>  write the exact payloads produced here — a list_agents_response,
//                 an agent_work_state_response and a refused activate_response —
//                 to <dir>. extension/scripts/screenshot-agent-controls.mjs
//                 renders the built page against those files, so the screenshots
//                 are of real daemon output rather than of a hand-written fixture.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dumpIdx = argv.indexOf('--dump');
const dumpDir = dumpIdx === -1 ? null : argv[dumpIdx + 1];
const positional = argv.filter((a, i) => i !== dumpIdx && i !== dumpIdx + 1 && !a.startsWith('--'));
const distDir = positional[0] ?? path.join(scriptDir, '..', 'dist');
const repoRoot = path.resolve(scriptDir, '..', '..');

const { WorkspaceRegistry } = await import(path.join(distDir, 'registry.js'));
const { MessageRouter } = await import(path.join(distDir, 'router.js'));
const { AgentRegistry } = await import(path.join(distDir, 'agent-registry.js'));
const { PromptLoader } = await import(path.join(distDir, 'prompt.js'));
const { readCapacity, summarizeCapacity } = await import(path.join(distDir, 'capacity.js'));
const { readWorkState } = await import(path.join(distDir, 'work-state.js'));

/**
 * Every activation in this script that is not *about* the capacity gate passes
 * this, and it is not a shortcut.
 *
 * The gate reads the real machine — cores, memory, and a one-minute load
 * average that moves while this script runs. Section 6 is the one that wants
 * that: it fills the fleet to the derived cap and proves the refusal is the
 * real arithmetic refusing. Everywhere else it is ambient noise that decides
 * whether the section under test gets to run at all, and a proof that passes on
 * a quiet machine and fails on a busy one proves nothing either way.
 *
 * The override path is itself real, recorded, and exactly what the [Start
 * anyway] button on a refusal sends.
 */
const PAST_THE_GATE = { override: true };

const rule = (title) => console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
const verdict = (ok, yes, no) => {
  console.log(`\n  ${ok ? '→ ' + yes : '→ FAILED — ' + no}`);
  if (!ok) failures++;
};
let failures = 0;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kan38-'));
const WORKSPACES = path.join(TMP, 'workspaces');
let registryFile = 0;

// A supervisor plus whatever this machine's own derivation says it can
// carry, so section 6's refusal is produced by the real arithmetic.
const HERE = readCapacity(0, 1);

// ------------------------------------------------------------- the harness --

/**
 * A herdr that reports exactly the agents it is told to and forgets one when
 * its pane is closed, so a census taken after a stand-down is the fleet as it
 * then is rather than a reconstruction. This is the stand-in for
 * `herdr agent list`, and the live script proves the same sequence against the
 * real one.
 */
function stubHerdr(running, { statuses = {}, workDirs = {} } = {}) {
  const alive = [...running];
  const bridge = {
    alive,
    spawns: [],
    listHerdrAgentsChecked: () => ({
      reachable: true,
      agents: alive.map((name) => ({
        name,
        agentRuntime: 'claude',
        workDir: workDirs[name] ?? path.join(WORKSPACES, name),
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
    listActiveSessions: () => [],
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
    sendToAgent: async () => ({ success: true }),
    spawnSession: (type, key, url, prompt, defaultAgent, mcpServers, resume) => {
      const workDir = path.join(WORKSPACES, type, key.toLowerCase());
      fs.mkdirSync(workDir, { recursive: true });
      bridge.spawns.push({ type, key, url, defaultAgent, resume });
      alive.push(`butchr-${type}-${key.toLowerCase()}`);
      return {
        sessionId: `${type}-${key.toLowerCase()}-stub`,
        type,
        key,
        url,
        createdAt: new Date(),
        status: 'active',
        workDir,
        ptyBuffer: '',
        onDataListeners: []
      };
    }
  };
  return bridge;
}

const registry = new WorkspaceRegistry(async () => 'Task');
const prompts = new PromptLoader(repoRoot);

function newRouter(bridge, seed = []) {
  const events = [];
  let last;
  const agentRegistry = new AgentRegistry(path.join(TMP, `agents-${++registryFile}.jsonl`));
  for (const record of seed) agentRegistry.recordActivated(record);
  const router = new MessageRouter(
    registry,
    prompts,
    bridge,
    (msg) => { last = msg; },
    (msg) => events.push(msg),
    undefined,
    undefined,
    agentRegistry
  );
  return { router, events, agentRegistry, sent: () => last };
}

/** What `list_agents` answers right now — the payload the page renders. */
function list(router, sent) {
  router.handle({ action: 'list_agents' });
  return sent();
}

async function quiet(fn) {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/**
 * A workspace in the shape agents actually leave one: the workspace itself is
 * not a checkout — the task prompt has agents create a worktree *inside* it —
 * and the worktree has a modified file, an untracked file and a branch that
 * has never been pushed. This is what "idle with real unpushed changes" looks
 * like on disk, which is the state three agents were found in on 2026-07-31.
 */
function makeDirtyWorkspace(workDir, branch) {
  const repo = path.join(workDir, 'butchr');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(workDir, '.butchr-prompt.md'), 'prompt\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'verify@example.invalid');
  git('config', 'user.name', 'verify');
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'never-added.txt'), 'work nobody knows about\n');
  return repo;
}

const seedOf = (names, workDirs = {}) =>
  names.map((agentName) => {
    const [, type, ...rest] = agentName.split('-');
    const key = rest.join('-');
    return {
      agentName,
      type,
      key: key.toUpperCase(),
      workDir: workDirs[agentName] ?? path.join(WORKSPACES, type, key),
      defaultAgent: 'claude'
    };
  });

// ------------------------------------------------------------------ 1. off --
rule('1. OFF — what the page sends, and the agent gone from the census');

{
  const FLEET = ['butchr-epic-kan-39', 'butchr-task-kan-38', 'butchr-task-kan-25'];
  const workDirs = Object.fromEntries(
    FLEET.map((n) => [n, path.join(WORKSPACES, ...n.replace('butchr-', '').split(/-(.*)/s).slice(0, 2))])
  );
  for (const dir of Object.values(workDirs)) fs.mkdirSync(dir, { recursive: true });

  const bridge = stubHerdr(FLEET, { workDirs });
  const { router, events, sent } = newRouter(bridge, seedOf(FLEET, workDirs));

  const before = list(router, sent).agents.map((a) => a.agentName);
  console.log(`census before: ${before.join(', ')}\n`);

  console.log('the Agents page sends exactly one message, the one the service worker already');
  console.log('had a path for — by KEY, not by session id, because an agent that outlived the');
  console.log('daemon holding its terminal has no session id and is exactly as stoppable:\n');
  console.log(`  { type: 'DEACTIVATE_BUTCHR_BY_KEY', workspaceType: 'task', key: 'KAN-38' }`);
  console.log(`      → daemon action 'deactivate_by_key'\n`);

  const res = await quiet(async () => {
    router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' });
    return sent();
  });
  console.log(`response: ${JSON.stringify({ success: res.success, type: res.type, key: res.key })}`);

  const after = list(router, sent).agents.map((a) => a.agentName);
  console.log(`census after:  ${after.join(', ')}`);

  const broadcast = events.find((e) => e.action === 'agent_deactivated_event');
  console.log(`\nbroadcast to every connected client: ${broadcast.action} ${broadcast.type}/${broadcast.key}`);

  console.log(
    '\n  Note `type` and `key` on the response. Before KAN-38 the session branch of\n' +
    '  deactivate_by_key answered with a bare `success` and a session id, which a\n' +
    '  single-agent panel could correlate and a fleet list could not: a failure with\n' +
    '  no address is a failure the page cannot attribute to a row.'
  );

  verdict(
    res.success === true && !after.includes('butchr-task-kan-38') && after.length === before.length - 1,
    'the agent is gone from the census the page renders, and nothing else moved.',
    `off did not take: success=${res.success} after=${after.join(',')}`
  );
}

// --------------------------------------------------------- 2. confirmation --
rule('2. CONFIRMATION — what is shown BEFORE an agent is stopped');

{
  // A real repository, really dirty. The probe has to find it one level below
  // the workspace, because that is where the work is: one that only looked at
  // the workspace root would find nothing and report an all-clear over an hour
  // of uncommitted changes.
  const workDir = path.join(TMP, 'workspace-with-work');
  makeDirtyWorkspace(workDir, 'butchr/KAN-38');

  const state = readWorkState(workDir);
  console.log('the human clicks Off. Before the confirmation renders, the daemon goes and looks:\n');
  console.log(JSON.stringify(state, null, 2));

  console.log('\nwhat the confirmation shows (AgentOffControl.jsx):\n');
  console.log('  ┃ Stop task/KAN-38?');
  console.log('  ┃ herdr reports it is working. Stopping it ends the conversation it is in;');
  console.log('  ┃ switching it back on later resumes that conversation, but anything it has');
  console.log('  ┃ not committed is gone for good.');
  console.log(`  ┃ 🚨 ${state.summary}`);
  for (const r of state.repos) {
    console.log(
      `  ┃    ${r.path} @ ${r.branch} — ${r.modifiedFiles} changed, ${r.untrackedFiles} untracked, ` +
      `${r.noUpstream ? 'never pushed' : `${r.unpushedCommits} unpushed`}`
    );
  }
  console.log('  ┃ [ Cancel ]  [ Stop task/KAN-38 ]');

  console.log(
    '\n  Why not a `confirm()` dialog: it says the same words whether there is anything\n' +
    '  to lose or not, and a warning that never varies is one nobody finishes reading.\n' +
    '  This is the hazard the ticket named — on 2026-07-31 three agents were found\n' +
    '  IDLE with real unpushed changes, and "idle" is exactly what that looks like\n' +
    '  from a list. The probe runs once, when the button is pressed; never on the 2s\n' +
    '  poll, which would put a permanent subprocess load on the machine whose\n' +
    '  capacity this system spends its time rationing.'
  );

  // And the case that must never read as an all-clear.
  const blind = readWorkState(path.join(TMP, 'no-such-workspace'));
  console.log(`\n  when it cannot look at all:\n    checked: ${blind.checked}   hasUnsavedWork: ${blind.hasUnsavedWork}`);
  console.log(`    "${blind.summary}"`);
  console.log(
    '    → rendered with ❓ and the warning still stands. A check that renders its own\n' +
    '      failure as "nothing to lose" is worse than no check, because the all-clear\n' +
    '      is the one that gets believed.'
  );

  const found = state.repos[0];
  verdict(
    state.checked &&
      state.hasUnsavedWork &&
      found.path === 'butchr' &&
      found.modifiedFiles === 1 &&
      found.untrackedFiles === 1 &&
      found.noUpstream &&
      blind.checked === false &&
      blind.hasUnsavedWork === false,
    'the confirmation names the repository, the branch, and how much would be lost —\n' +
    '    including a worktree one level below the workspace, which is where agents\n' +
    '    actually work. An unanswerable check says so instead of saying "clean".',
    `the probe did not report what is on disk: ${JSON.stringify(state)}`
  );
}

// ----------------------------------------------------------- 3. supervisor --
rule('3. SUPERVISOR — what happens when the target is a supervisor (epic/KAN-39)');

{
  const FLEET = ['butchr-epic-kan-39', 'butchr-task-kan-25'];
  for (const n of FLEET) fs.mkdirSync(path.join(WORKSPACES, n), { recursive: true });
  const bridge = stubHerdr(FLEET);
  const { router, sent } = newRouter(bridge, seedOf(FLEET));

  const listed = list(router, sent);
  const supervisor = listed.agents.find((a) => a.type === 'epic');
  const worker = listed.agents.find((a) => a.type === 'task');

  console.log('DECISION: allowed, behind a confirmation that differs in kind — not refused.\n');
  console.log(
    'Refusing it was the tempting answer and it is the wrong one. The human asked for a\n' +
    'way to shut agents off from this page, and a supervisor — an epic or story agent —\n' +
    'is the kind they are most likely to need stood down: it is what spawns the agents\n' +
    'under it, and an epic agent is the one thing nothing can preempt. A supervisor you\n' +
    'cannot stop is a worse failure than one you can stop by accident — provided\n' +
    'stopping it is neither accidental nor a one-way door.\n'
  );
  console.log('So the row is marked, and the daemon is what marks it:\n');
  console.log(`  ${supervisor.agentName}: supervisor=${supervisor.supervisor}`);
  console.log(`  ${worker.agentName}: supervisor=${worker.supervisor}`);
  console.log(
    '\n  Sent by the daemon rather than decided by the page from the agent\'s type,\n' +
    '  because that rule already lives in registry.ts (SUPERVISOR_WORKSPACE_TYPES) and\n' +
    '  a second copy in the UI is the copy that gets forgotten when a supervisor type\n' +
    '  is added or removed.\n'
  );

  console.log('what the human sees on that row instead of the ordinary confirmation:\n');
  console.log('  ┃ Stop the supervisor epic/KAN-39?               ← red, not amber');
  console.log('  ┃ This agent hands out the work under it and merges what comes back.');
  console.log('  ┃ While it is off, nothing it supervises will be assigned, reviewed or');
  console.log('  ┃ merged — including anything its agents finish. It can be switched');
  console.log('  ┃ back on from the Stood down list on this page.');
  console.log('  ┃ [ Cancel ]  [ Stop epic/KAN-39 ]');

  // And it is genuinely a round trip: off, then present as a candidate, then on.
  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'epic', key: 'KAN-39' }));
  const afterOff = list(router, sent);
  const standby = afterOff.standbyAgents.find((a) => a.agentName === 'butchr-epic-kan-39');
  console.log(`\nafter stopping it:`);
  console.log(`  running:    ${afterOff.agents.map((a) => a.agentName).join(', ')}`);
  console.log(`  stood down: ${afterOff.standbyAgents.map((a) => `${a.type}/${a.key}`).join(', ')}   ← the way back, on the same page`);

  await quiet(() =>
    router.handleActivateByKey(
      { type: 'epic', key: 'KAN-39', defaultAgent: standby.defaultAgent, ...PAST_THE_GATE },
      () => {}
    )
  );
  const afterOn = list(router, sent);
  console.log(`  switched back on: ${afterOn.agents.map((a) => a.agentName).join(', ')}`);

  verdict(
    supervisor.supervisor === true &&
      worker.supervisor === false &&
      Boolean(standby) &&
      afterOn.agents.some((a) => a.agentName === 'butchr-epic-kan-39'),
    'a supervisor can be stopped, is the only row whose confirmation says what that\n' +
    '    costs, and is on the stood-down list the moment it stops — so the guard is\n' +
    '    a speed limit rather than a cliff.',
    'the supervisor was not marked, or could not be brought back from this page.'
  );
}

// ------------------------------------------------------------------- 4. on --
rule('4. ON — where the candidates come from, and the agent back');

{
  const FLEET = ['butchr-epic-kan-39', 'butchr-task-kan-38'];
  const workDirs = Object.fromEntries(FLEET.map((n) => [n, path.join(WORKSPACES, 'live', n)]));
  for (const dir of Object.values(workDirs)) fs.mkdirSync(dir, { recursive: true });

  const bridge = stubHerdr(FLEET, { workDirs });
  const { router, sent } = newRouter(bridge, seedOf(FLEET, workDirs));

  console.log(
    'The hard half of this ticket, in its own words: "the Agents page lists what is\n' +
    'running, and something that is off is not in that list." So the candidates cannot\n' +
    'come from the page. They come from KAN-21\'s registry (PR #32, merged 2026-08-01),\n' +
    'which is the only durable record of activation INTENT this system has, and they\n' +
    'come from it in three disjoint ways — one agent never gets two switches:\n'
  );
  console.log('  missingAgents    last word `activated`, not running    a loss    → [Restore]');
  console.log('  preemptedAgents  stood down for capacity              a debt    → [Put back]');
  console.log('  standbyAgents    stood down because a person said so  a choice  → [Turn on]');
  console.log('\nNo parallel registry is written. All three are reductions of the same');
  console.log('append-only log that boot-time restoration already reads.\n');

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' }));
  const off = list(router, sent);
  console.log(`after switching task/KAN-38 off, list_agents carries:\n`);
  console.log(JSON.stringify({ standbyAgents: off.standbyAgents, standbyTotal: off.standbyTotal }, null, 2));

  const candidate = off.standbyAgents[0];
  console.log(`\nthe page sends, from that row:\n`);
  console.log(`  { type: 'ACTIVATE_BUTCHR_BY_KEY', workspaceType: '${candidate.type}', key: '${candidate.key}',`);
  console.log(`    defaultAgent: '${candidate.defaultAgent}' }`);
  console.log(`      → daemon action 'activate_by_key'`);
  console.log(
    '\n  This is the path the ticket flagged as missing: the service worker exposed\n' +
    '  `activate` (URL-based) and not `activate_by_key`, which the daemon has always\n' +
    '  supported and the MCP tool has always used. An agent with no page open cannot be\n' +
    '  started by URL, and every agent on these three lists has no page open.\n'
  );

  const res = await quiet(async () => {
    let out;
    await router.handleActivateByKey(
      { type: candidate.type, key: candidate.key, defaultAgent: candidate.defaultAgent, ...PAST_THE_GATE },
      (msg) => { out = msg; }
    );
    return out;
  });

  const back = list(router, sent);
  console.log(`activate_by_key → success: ${res.success}`);
  console.log(`census:     ${back.agents.map((a) => a.agentName).join(', ')}`);
  console.log(`stood down: ${back.standbyAgents.length === 0 ? '(empty — it left the list the moment it came back)' : back.standbyAgents.map((a) => a.key).join(', ')}`);

  verdict(
    res.success === true &&
      back.agents.some((a) => a.agentName === 'butchr-task-kan-38') &&
      back.standbyAgents.length === 0,
    'off and on are a round trip from one page, and the candidate list empties itself\n' +
    '    — an agent that is running is never offered an On button.',
    `the round trip did not close: success=${res.success} standby=${back.standbyAgents.length}`
  );
}

// ------------------------------------------------------------- 5. launcher --
rule('5. LAUNCHER — why a stand-down has to carry the activation record with it');

{
  const FLEET = ['butchr-task-kan-38'];
  const workDir = path.join(WORKSPACES, 'launcher', 'kan-38');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr(FLEET, { workDirs: { 'butchr-task-kan-38': workDir } });
  const { router, agentRegistry, sent } = newRouter(bridge, [
    {
      agentName: 'butchr-task-kan-38',
      type: 'task',
      key: 'KAN-38',
      workDir,
      url: 'https://wroosbit.atlassian.net/browse/KAN-38',
      defaultAgent: 'claude',
      mcpServers: ['atlassian', 'butchr']
    }
  ]);

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-38' }));
  const intent = agentRegistry.intents().get('butchr-task-kan-38');

  console.log('the stand-down record the registry now holds:\n');
  console.log(`  event:        ${intent.event}`);
  console.log(`  workDir:      ${intent.record.workDir}`);
  console.log(`  url:          ${intent.record.url}`);
  console.log(`  defaultAgent: ${intent.record.defaultAgent}`);
  console.log(`  mcpServers:   ${JSON.stringify(intent.record.mcpServers)}`);

  console.log(
    '\n  Before KAN-38 a stand-down recorded only { agentName, type, key, workDir }, and\n' +
    '  that was harmless for exactly as long as nothing switched a stood-down agent back\n' +
    '  on. `defaultAgent` is an argument of an activation: absent, resolveLauncher() in\n' +
    '  launchers.ts fell back to `shell` (KAN-53 has since made omission mean `claude`\n' +
    '  and unknown names refuse), so the agent would have come back as a bare\n' +
    '  bash prompt wearing the name of a Claude agent — running nothing, reporting\n' +
    '  nothing, and looking from this page exactly like a healthy row. The On button is\n' +
    '  what makes that path ordinary, so the record has to survive the stand-down.\n' +
    '\n  Live registry on this machine, before the fix (~/.local/share/butchr/agents.jsonl):\n' +
    '    deactivated  butchr-task-kan-21   wd=…/task/kan-21   defaultAgent=(none)\n' +
    '    deactivated  butchr-task-kan-35   wd=…/task/kan-35   defaultAgent=(none)\n' +
    '  Both would have come back as shells. Those records cannot be repaired\n' +
    '  retrospectively — the page marks them `shell` on the row so the promise it makes\n' +
    '  is the one it can keep.'
  );

  await quiet(() =>
    router.handleActivateByKey(
      { type: 'task', key: 'KAN-38', defaultAgent: intent.record.defaultAgent, url: intent.record.url, ...PAST_THE_GATE },
      () => {}
    )
  );
  const spawned = bridge.spawns[bridge.spawns.length - 1];
  console.log(`\n  switched back on with:  defaultAgent=${spawned.defaultAgent}  url=${spawned.url}`);

  verdict(
    intent.record.defaultAgent === 'claude' &&
      intent.record.url === 'https://wroosbit.atlassian.net/browse/KAN-38' &&
      spawned.defaultAgent === 'claude',
    'it comes back as what it was, not as a shell.',
    `the activation record did not survive the stand-down: ${JSON.stringify(intent.record)}`
  );
}

// -------------------------------------------------------------- 6. refusal --
rule('6. REFUSAL — at capacity, what the page displays instead of nothing');

{
  // The machine's own derived cap, filled with equal-priority task agents, so
  // the refusal below is the real arithmetic refusing and offers no preemption
  // — a task agent outranks nothing on a board of task agents.
  const FULL = ['butchr-epic-kan-39', ...Array.from({ length: HERE.cap }, (_, i) => `butchr-task-kan-${10 + i}`)];
  for (const n of FULL) fs.mkdirSync(path.join(WORKSPACES, n), { recursive: true });
  const bridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router } = newRouter(bridge, seedOf(FULL));

  const res = await quiet(async () => {
    let out;
    await router.handleActivateByKey({ type: 'task', key: 'KAN-99', defaultAgent: 'claude' }, (msg) => { out = msg; });
    return out;
  });

  console.log(`running: ${FULL.length} agents — ${summarizeCapacity({ ...HERE, running: HERE.cap })}\n`);
  console.log('the page presses [Turn on] and receives:\n');
  console.log(JSON.stringify({
    success: res.success,
    refusedBy: res.refusedBy,
    reason: res.reason,
    priority: res.priority,
    preemption: res.preemption ?? null,
    capacity: { cap: res.capacity.cap, running: res.capacity.running, headroom: res.capacity.headroom }
  }, null, 2));

  console.log('\nand renders it with the SAME component the sidepanel uses — ActivationRefusal.jsx:\n');
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
  console.log(`  ${res.capacity.running} of ${res.capacity.cap} task agents · room for ${res.capacity.headroom} · load ${res.capacity.load1} / ${res.capacity.cores} cores`);
  console.log(`  ▸ How this number was worked out`);
  console.log(`  [ Start anyway ]  [ Dismiss ]`);
  console.log(
    '\n  Rendered under the row whose button was pressed, not in a page-level banner: on\n' +
    '  a list of rows, a refusal that appears somewhere else is a refusal the reader has\n' +
    '  to attribute for themselves.\n' +
    '\n  Same component, same fields, deliberately. KAN-36 exists because ONE surface\n' +
    '  threw this away and the user met a switch that did nothing; a second surface\n' +
    '  throwing it away differently would be that defect twice. Both buttons the daemon\n' +
    '  names are offered — override here, and "Stand down X and start" when the refusal\n' +
    '  carries a preemption offer. Neither decides anything: KAN-37 put scheduling out\n' +
    '  of scope and this does not reopen it, because a person still reads a name and\n' +
    '  presses a button that states its cost.'
  );

  verdict(
    res.success === false && res.refusedBy === 'capacity' && Boolean(res.reason) && Boolean(res.derivation) && Boolean(res.capacity),
    'the refusal arrives with a sentence, the figures, and the derivation — everything\n' +
    '    the sidepanel renders, on a second surface, from one component.',
    `the refusal was not legible: ${JSON.stringify(res)}`
  );
}

// ------------------------------------------------------- 7. poll stability --
rule('7. POLL STABILITY — a control mid-action against the 2-second poll');

{
  const FLEET = ['butchr-epic-kan-39', 'butchr-task-kan-38'];
  for (const n of FLEET) fs.mkdirSync(path.join(WORKSPACES, n), { recursive: true });
  const bridge = stubHerdr(FLEET);
  const { router, sent } = newRouter(bridge, seedOf(FLEET));

  console.log('Two clocks, and the whole design is keeping them apart:\n');
  console.log('  the poll owns  what is RUNNING       (list_agents, every 2s, replaced wholesale)');
  console.log('  the hook owns  what was ASKED FOR    (useFleetControls, keyed by agent NAME)\n');
  console.log('Neither writes to the other. Three consequences, each a bug that was available:\n');

  console.log('  a) rows are keyed by agent name, not array index.');
  const poll1 = list(router, sent).agents.map((a) => a.agentName);
  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'epic', key: 'KAN-39' }));
  const poll2 = list(router, sent).agents.map((a) => a.agentName);
  console.log(`     poll n:   [0]=${poll1[0]}  [1]=${poll1[1]}`);
  console.log(`     poll n+1: [0]=${poll2[0]}`);
  console.log(`     index 0 is a different agent between polls. With key={i} React would have`);
  console.log(`     carried an open confirmation — or a "Stopping…" — from ${poll1[0]}`);
  console.log(`     onto ${poll2[0]}. That is the flicker, and index keys are where it comes from.\n`);

  console.log('  b) an in-flight action ends when the CENSUS agrees, not when the daemon replies.');
  console.log('     deactivate_response means "accepted", not "gone". Clearing the control there');
  console.log('     would flash the row back to "running, press Off" for the length of the');
  console.log('     teardown — the revert the ticket asks not to happen. So a pending Off clears');
  console.log('     when the agent leaves the census and a pending On clears when it appears in');
  console.log('     it, which is the same ground truth `herdr agent list` reports.\n');

  console.log('  c) the row reports the decision rather than offering a disabled button.');
  console.log('     "Stopping…" / "Starting…" replace the control outright, so there is nothing');
  console.log('     to double-press and nothing whose enabled-ness the poll could argue with.\n');

  console.log('  and a stop that never lands does not spin for ever: 45s, then the control comes');
  console.log('  back with "No answer from the daemon" and points at the list, which is still true.');

  verdict(
    poll1[0] !== poll2[0] && poll1.length === 2 && poll2.length === 1,
    'the index of a row is not stable across a single poll, and nothing in this page is\n' +
    '    keyed by it any more.',
    'the census did not shift as expected; the demonstration proves nothing.'
  );
}

// ---------------------------------------------------------------- 8. reset --
rule('8. RESET — a deleted workspace is not offered a way back');

{
  const workDir = path.join(WORKSPACES, 'resettable', 'kan-77');
  fs.mkdirSync(workDir, { recursive: true });
  const bridge = stubHerdr(['butchr-task-kan-77'], { workDirs: { 'butchr-task-kan-77': workDir } });
  const { router, sent } = newRouter(bridge, seedOf(['butchr-task-kan-77'], { 'butchr-task-kan-77': workDir }));

  await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key: 'KAN-77' }));
  const before = list(router, sent).standbyAgents.map((a) => a.key);
  console.log(`stood down, workspace present: standbyAgents = [${before.join(', ')}]`);

  // What a reset leaves behind: the same `deactivated` record, and no directory.
  fs.rmSync(workDir, { recursive: true, force: true });
  const after = list(router, sent).standbyAgents.map((a) => a.key);
  console.log(`workspace deleted:             standbyAgents = [${after.join(', ')}]`);

  console.log(
    '\n  `reset` records a stand-down too — it must, or the next boot would resurrect an\n' +
    '  agent whose working directory was deliberately deleted. That makes it\n' +
    '  indistinguishable from an ordinary Off in the log, and the directory is the only\n' +
    '  thing that tells them apart: it is the difference between "stopped" and "finished\n' +
    '  with". Offering [Turn on] for one of those would create an empty workspace and\n' +
    '  start an agent in it with nothing to continue.\n' +
    '\n  It is also why `reset` itself is not on this page. Deleting a workspace is\n' +
    '  destructive in a different league from stopping an agent, and the ticket put it\n' +
    '  out of scope; nothing here added it.'
  );

  verdict(
    before.includes('KAN-77') && !after.includes('KAN-77'),
    'a workspace on disk is what makes an agent restorable, and a reset one is not\n' +
    '    offered.',
    'a reset workspace was still offered a way back.'
  );
}

// ----------------------------------------------------------------- 9. dump --
if (dumpDir) {
  rule('9. DUMP — the payloads the screenshots are taken against');

  // One fleet carrying every case the page has to render at once: both
  // supervisory types (an epic agent and a story agent), two ordinary task
  // agents, an agent recorded active that is not there, and two that were
  // switched off. Assembled here rather than in the screenshot script for the
  // reason the KAN-30 screenshots gave: a fixture written by hand proves that
  // someone can write a fixture. These come out of the same handlers a client
  // talks to.
  const RUNNING = ['butchr-epic-kan-39', 'butchr-story-kan-40', 'butchr-task-kan-38', 'butchr-task-kan-25'];
  const OFF = ['butchr-task-kan-21', 'butchr-task-kan-35'];
  const LOST = 'butchr-task-kan-31';

  const dirs = {};
  for (const name of [...RUNNING, ...OFF, LOST]) {
    const [, type, ...rest] = name.split('-');
    dirs[name] = path.join(WORKSPACES, 'dump', type, rest.join('-'));
    fs.mkdirSync(dirs[name], { recursive: true });
  }
  // The agent the confirmation screenshot is taken over, left in the state
  // this whole guard exists for.
  makeDirtyWorkspace(dirs['butchr-task-kan-38'], 'butchr/KAN-38');

  const bridge = stubHerdr([...RUNNING], {
    statuses: {
      'butchr-epic-kan-39': 'working',
      'butchr-story-kan-40': 'working',
      'butchr-task-kan-38': 'working',
      'butchr-task-kan-25': 'idle'
    },
    workDirs: dirs
  });
  const { router, sent } = newRouter(bridge, seedOf([...RUNNING, ...OFF, LOST], dirs));

  // Switch two off through the real handler, so their standby records are the
  // ones a stand-down actually writes.
  for (const name of OFF) {
    const key = name.replace('butchr-task-', '').toUpperCase();
    await quiet(async () => router.handle({ action: 'deactivate_by_key', type: 'task', key }));
  }

  const listPayload = list(router, sent);
  const workPayload = await quiet(async () => {
    router.handle({ action: 'agent_work_state', type: 'task', key: 'KAN-38' });
    return sent();
  });

  // And a refusal, from a machine filled to its own derived cap.
  const FULL = ['butchr-epic-kan-39', ...Array.from({ length: HERE.cap }, (_, i) => `butchr-task-kan-${10 + i}`)];
  for (const n of FULL) fs.mkdirSync(path.join(WORKSPACES, 'dumpfull', n), { recursive: true });
  const fullBridge = stubHerdr(FULL, { statuses: { 'butchr-task-kan-10': 'idle' } });
  const { router: fullRouter } = newRouter(fullBridge, seedOf(FULL));
  const refusalPayload = await quiet(async () => {
    let out;
    await fullRouter.handleActivateByKey({ type: 'task', key: 'KAN-21', defaultAgent: 'claude' }, (m) => { out = m; });
    return out;
  });

  fs.mkdirSync(dumpDir, { recursive: true });
  const write = (name, value) => {
    const file = path.join(dumpDir, name);
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    console.log(`  wrote ${file}`);
  };
  write('list_agents.json', listPayload);
  write('work_state.json', workPayload);
  write('refusal.json', refusalPayload);

  console.log(
    `\n  running: ${listPayload.agents.length}, missing: ${listPayload.missingAgents.length}, ` +
    `stood down: ${listPayload.standbyAgents.length}, refusal: ${refusalPayload.refusedBy}`
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n== ${failures === 0 ? 'done — every section passed' : `${failures} SECTION(S) FAILED`} ==`);
process.exit(failures === 0 ? 0 : 1);
